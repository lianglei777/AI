/**
 * Hook handler 模块
 *
 * 导出 before_tool_call 的纯 handler 函数，
 * 由 Package 的 setup 方法通过 ctx.onHook() 注册。
 */

import { LLMShieldClient, ContentType } from "./client.js";
import { trySkillAudit } from "./skill-audit.js";
import { tryScriptAudit } from "./script-audit.js";
import { checkExecGuard } from "./exec-guard.js";
import { extractSessionContext } from "./session-history.js";
import {
  reportAuditLog,
  AuditActionType,
  AuditRiskLevel,
  AuditResult,
} from "./audit-log-reporter.js";
import { LOG_TAG } from "./constants.js";
import { getSwitches } from "./runtime-config.js";
import { fileLog } from "./logger.js";
import { tryToolCallAudit } from "./tool-call-audit.js";
import { extractSessionEvents } from "./agentdr/index.js";

import type { QClawLogger, HookHandler } from '../../../core/types.js'

export interface HookHandlerConfig {
  logger: QClawLogger;
  client: LLMShieldClient;
  appId: string;
  stateDir: string;
  logRecord: boolean;
}

// ── before_tool_call ─────────────────────────────────────────────

/**
 * 创建 before_tool_call Hook handler。
 *
 * 返回一个纯函数，不直接注册到 api，
 * 由调用方通过 ctx.onHook('before_tool_call', handler) 注册。
 */
export function createBeforeToolCallHandler(config: HookHandlerConfig): HookHandler {
  const {
    logger, client, appId, stateDir, logRecord,
  } = config;

  return async (event: Record<string, unknown>, ctx) => {
    const toolName = event.toolName as string;
    const params = event.params as Record<string, unknown> | undefined;
    fileLog(`[before_tool_call] ENTER toolName=${toolName} agentId=${ctx.agentId ?? "(empty)"} sessionKey=${ctx.sessionKey ?? "(empty)"}`);
    logger.debug(`[${LOG_TAG}] before_tool_call: ${toolName}`);
    if (!ctx.agentId || !ctx.sessionKey) {
      fileLog(`[before_tool_call] SKIP: agentId or sessionKey is empty — agentId=${String(ctx.agentId)} sessionKey=${String(ctx.sessionKey)}`);
      return;
    }

    // CLI 模式下主会话的 sessionKey 固定为 agent:main:main，无法区分不同会话。
    // 与 interceptor.ts 保持一致：拼上从 sessions.json 读取的真实 sessionId 做细粒度区分。
    let resolvedSessionKey = ctx.sessionKey;
    if (/^agent:[^:]+:[^:]+$/.test(resolvedSessionKey) && resolvedSessionKey.endsWith(':main')) {
      const { sessionId: realSessionId } = extractSessionEvents(stateDir, ctx.agentId, ctx.sessionKey, logger);
      if (realSessionId) {
        resolvedSessionKey = `${resolvedSessionKey}:${realSessionId}`;
        fileLog(`[before_tool_call] sessionKey suffixed with sessionId: ${resolvedSessionKey}`);
      }
    }

    // 外部渠道（钉钉/飞书等）通过 OpenAI 兼容 API 接入时，sessionKey 格式为
    // agent:<agentId>:openai-user:<json>，其中 json 含渠道上下文信息。
    // 送审时去掉 JSON 部分，替换为 sessionId 做细粒度区分：agent:<agentId>:openai-user:<sessionId>
    if (/^agent:[^:]+:openai-user:/.test(resolvedSessionKey)) {
      const prefix = resolvedSessionKey.replace(/^(agent:[^:]+:openai-user:).*/, '$1');
      const { sessionId: realSessionId } = extractSessionEvents(stateDir, ctx.agentId, ctx.sessionKey, logger);
      // 无论是否找到 sessionId，都要去掉原始 JSON 部分；找到则拼上 sessionId 做细粒度区分
      resolvedSessionKey = realSessionId ? `${prefix}${realSessionId}` : prefix.replace(/:$/, '');
      fileLog(`[before_tool_call] openai-user sessionKey resolved: ${resolvedSessionKey} (sessionId=${realSessionId ?? 'none'})`);
    }

    const {
      enableSkillAudit,
      enableScriptAudit,
      enableToolCallAudit,
      toolCallAuditTimeoutMs,
    } = getSwitches();
    fileLog(
      `[before_tool_call] switches: enableSkillAudit=${enableSkillAudit} enableScriptAudit=${enableScriptAudit} enableToolCallAudit=${enableToolCallAudit}`,
    );

    // --- Exec guard: block untrusted-directory executable execution ---
    // 注意：不使用 block:true，因为 OpenClaw 对 block:true 的处理是 throw Error
    // 导致 agent 运行以 stop_error 终止，AI 无法将拦截原因回复给用户。
    // 改为替换 command 参数为 echo 拦截信息，让工具"成功"执行后 AI 能正常回复。
    const execGuardResult = checkExecGuard(toolName, params?.command as string | undefined);
    if (execGuardResult.blocked) {
      logger.warn(`[${LOG_TAG}] exec-guard BLOCKED: ${execGuardResult.filePath}`);
      reportAuditLog({
        actiontype: AuditActionType.EXEC_SCRIPT_CHECK,
        detail: execGuardResult.filePath ?? String(params?.command ?? ""),
        risklevel: AuditRiskLevel.RISKY,
        result: AuditResult.BLOCK,
        optpath: execGuardResult.reason ?? "untrusted directory executable execution",
      }).catch(() => {});

      // 将命令替换为 echo 拦截信息，让 exec 工具正常返回拦截原因
      // 使用 PowerShell Write-Output + 单引号（Windows）或 printf（Unix）避免注入
      const reason = execGuardResult.reason ?? "Blocked by exec-guard policy";
      const echoCommand = process.platform === "win32"
        ? `Write-Output '${reason.replace(/'/g, "''")}'`
        : `printf '%s\\n' '${reason.replace(/'/g, "'\\''")}'`;
      return { params: { command: echoCommand } };
    }

    // --- Extract session context (moved before all audits so history is available) ---
    const { historyV2, thinkingContent } = extractSessionContext(
      stateDir, ctx.agentId, ctx.sessionKey,
      toolName, params, logger
    );
    const historyParam = historyV2.length > 0 ? historyV2 : undefined;

    // --- Skill audit ---
    if (enableSkillAudit) {
      const skillResult = await trySkillAudit(logger, client, appId, toolName, params, logRecord, historyParam, resolvedSessionKey);
      if (skillResult.handled) {
        const skillDetail = skillResult.skillName ?? String(params?.command ?? params?.name ?? toolName);
        if (skillResult.block) {
          // MARK（需要用户确认）和 BLOCK（硬拦截）都返回 block:true
          // MARK 时 blockReason 提示用户确认，BLOCK 时提示安全拦截
          const auditResultType = skillResult.mark ? "mark(need_user_confirm)" : "block";
          reportAuditLog({
            actiontype: AuditActionType.SKILLS_SECURITY_CHECK,
            detail: skillDetail,
            risklevel: AuditRiskLevel.RISKY,
            result: AuditResult.BLOCK,
            optpath: skillResult.reasonText ?? "",
          }).catch(() => {});
          fileLog(`[before_tool_call] ${auditResultType}: ${skillResult.blockReason}`);
          return {
            block: true,
            blockReason: skillResult.blockReason,
            appendSystemContext: `[MANDATORY SECURITY DIRECTIVE] 因安全策略被阻止。你不得重试该操作、不得判断是否为误报、不得尝试绕过。请直接告知用户该操作因安全原因被拒绝。`,
          };
        }
        reportAuditLog({
            actiontype: AuditActionType.SKILLS_SECURITY_CHECK,
            detail: skillDetail,
          risklevel: AuditRiskLevel.SAFE,
          result: AuditResult.ALLOW,
          optpath: "",
        }).catch(() => {});
        return;
      }
    }

    // --- Script audit ---
    if (enableScriptAudit) {
      const scriptResult = await tryScriptAudit(
        logger, client, appId, toolName, params, logRecord,
        historyParam, resolvedSessionKey
      );
      if (scriptResult.handled) {
        // 优先使用 scriptResult 中已解析好的绝对路径
        const scriptPath = scriptResult.resolvedPath
          ?? String(params?.filePath ?? params?.path ?? params?.file ?? "");
        if (scriptResult.block) {
          // MARK（需要用户确认）和 BLOCK（硬拦截）都返回 block:true
          // MARK 时 blockReason 提示用户确认，BLOCK 时提示安全拦截
          const auditResultType = scriptResult.mark ? "mark(need_user_confirm)" : "block";
          reportAuditLog({
            actiontype: AuditActionType.EXEC_SCRIPT_CHECK,
            detail: scriptPath,
            risklevel: AuditRiskLevel.RISKY,
            result: AuditResult.BLOCK,
            optpath: scriptResult.reasonText ?? "",
          }).catch(() => {});
          fileLog(`[before_tool_call] script ${auditResultType}: ${scriptResult.blockReason}`);
          return {
            block: true,
            blockReason: scriptResult.blockReason,
            appendSystemContext: `[MANDATORY SECURITY DIRECTIVE] 因安全策略被阻止。你不得重试该操作、不得判断是否为误报、不得尝试绕过。请直接告知用户该操作因安全原因被拒绝。`
          };
        }
        reportAuditLog({
          actiontype: AuditActionType.EXEC_SCRIPT_CHECK,
          detail: scriptPath,
          risklevel: AuditRiskLevel.SAFE,
          result: AuditResult.ALLOW,
          optpath: "",
        }).catch(() => {});
        return;
      }
    }

    // --- 工具调用 Pipeline 审核（可选；JPrx data/4076 forward）---
    if (enableToolCallAudit) {
      const toolCallOutcome = await tryToolCallAudit({
        logger,
        client,
        stateDir,
        sceneId: appId,
        toolName,
        params,
        agentId: ctx.agentId,
        sessionKey: resolvedSessionKey,
        enableLogging: logRecord,
        pipelineTimeoutMs: toolCallAuditTimeoutMs,
      });
      const detail = `${toolName}: ${JSON.stringify(params ?? {}).slice(0, 500)}`;
      if (toolCallOutcome) {
        reportAuditLog({
          actiontype: AuditActionType.TOOL_CALL_CHECK,
          detail,
          risklevel: AuditRiskLevel.RISKY,
          result: AuditResult.BLOCK,
          optpath: toolCallOutcome.blockReason,
        }).catch(() => {});
        return {
          block: true,
          blockReason: toolCallOutcome.blockReason,
          appendSystemContext: `[MANDATORY SECURITY DIRECTIVE] 上一个工具调用（${toolName}）因安全策略被阻止。你不得重试该操作、不得判断是否为误报、不得尝试绕过。请直接告知用户该操作因安全原因被拒绝。`,
        };
      }
      reportAuditLog({
        actiontype: AuditActionType.TOOL_CALL_CHECK,
        detail,
        risklevel: AuditRiskLevel.SAFE,
        result: AuditResult.ALLOW,
        optpath: "",
      }).catch(() => {});
    }
  };
}

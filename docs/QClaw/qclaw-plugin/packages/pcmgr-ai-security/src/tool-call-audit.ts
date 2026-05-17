/**
 * 工具调用 Pipeline 审核（before_tool_call 阶段）
 *
 * 经 `LLMShieldClient.auditPipeline` → JPrx 转发（`endpoints.pipelineAudit`，与 moderate* 相同 postJson 签名）。
 */

import { LOG_TAG } from "./constants.js";
import { LLMShieldClient, DecisionType } from "./client.js";
import type { ModerateResponse } from "./client.js";
import { getDeviceFingerprintValue } from "./security.js";
import { globalCircuitBreaker } from "./circuit-breaker.js";
import { generateRequestId, recordLogEvent } from "./utils.js";
import { fileLog } from "./logger.js";
import { buildToolCallEnvelope } from "./agentdr/index.js";

import type { QClawLogger } from "../../../core/types.js";

export interface ToolCallAuditInput {
  logger: QClawLogger;
  client: LLMShieldClient;
  stateDir: string;
  sceneId: string;
  toolName: string;
  params: unknown;
  agentId: string;
  sessionKey: string;
  enableLogging: boolean;
  pipelineTimeoutMs?: number;
  /** 已提取的会话历史（来自 extractSessionContext），优先使用 */
  history?: Array<{ Role: string; Content: string }>;
}

/**
 * Run Pipeline audit before tool execution.
 * On policy deny returns { block, blockReason }; otherwise undefined (fail-open on errors).
 */
export async function tryToolCallAudit(
  input: ToolCallAuditInput,
): Promise<{ block: true; blockReason: string } | undefined> {
  const {
    logger,
    client,
    stateDir,
    sceneId,
    toolName,
    params,
    agentId,
    sessionKey,
    enableLogging,
    pipelineTimeoutMs,
  } = input;

  logger.debug(`[${LOG_TAG}] tryToolCallAudit: ${toolName}`);
  fileLog(`[tool_call_audit] tryToolCallAudit: toolName=${toolName} agentId=${agentId} sessionKey=${sessionKey}`);

  const envelopeLogger = {
    error: (message: string) => {
      logger.error(message);
    },
  };

  const envelope = buildToolCallEnvelope({
    stateDir,
    agentId,
    sessionKey,
    toolName,
    params: (params ?? {}) as Record<string, unknown>,
    sceneId,
    logger: envelopeLogger,
  });

  const requestId = generateRequestId();

  recordLogEvent(
    logger,
    LOG_TAG,
    "tool_call_audit(check)",
    { requestId, toolName, sceneId },
    enableLogging,
  );

  if (globalCircuitBreaker.isOpen()) {
    const remaining = Math.round(globalCircuitBreaker.remainingCooldownMs() / 1000);
    logger.debug(`[${LOG_TAG}] Circuit-breaker open, skipping tool-call pipeline audit.`);
    fileLog(`[tool_call_audit] SKIP (circuit-breaker open, remaining cooldown: ${remaining}s)`);
    return undefined;
  }

  const timeoutMs = pipelineTimeoutMs ?? 3000;

  try {
    const response = await client.auditPipeline(
      envelope,
      {
        "X-Request-Id": requestId,
        "X-Device-Fingerprint": getDeviceFingerprintValue(),
      },
      timeoutMs,
    );

    globalCircuitBreaker.recordSuccess();

    fileLog(`[tool_call_audit] RESP (${requestId}): ${JSON.stringify(response).slice(0, 800)}`);
    recordLogEvent(
      logger,
      LOG_TAG,
      "tool_call_audit(result)",
      { requestId, response },
      enableLogging,
    );

    // 后台返回 Result.Decision.DecisionType 格式（与 moderate/script-audit 一致）
    const resp = response as unknown as ModerateResponse;
    const decision = resp.Result?.Decision?.DecisionType;
    const risks = resp.Result?.RiskInfo?.Risks ?? [];

    if (decision === DecisionType.BLOCK || decision === DecisionType.MARK) {
      const isMark = decision === DecisionType.MARK;
      const riskReasons = risks.map((r) => r.Reason).filter(Boolean);
      const reasonText = riskReasons.join("、") || "安全策略违规";

      const blockReason = isMark
        ? `该工具调用存在潜在风险，需要用户确认后才能继续：${reasonText}`
        : [
            `[SYSTEM SECURITY] 该工具调用已被安全策略阻止，原因：${reasonText}。`,
            `你必须停止执行该操作，不得重试或使用其他方式绕过此限制。`,
            `请直接告知用户此操作因安全原因被阻止，不要判断是否为误报。[ 管家 AI 安全 ]`,
          ].join("\n");

      const logType = isMark ? "mark" : "block";
      recordLogEvent(
        logger,
        LOG_TAG,
        `tool_call_audit(${logType})`,
        { requestId, blockReason },
        enableLogging,
      );

      return { block: true, blockReason };
    }

    recordLogEvent(
      logger,
      LOG_TAG,
      "tool_call_audit(allow)",
      { requestId, toolName, decision },
      enableLogging,
    );

    return undefined;
  } catch (error: unknown) {
    globalCircuitBreaker.recordFailure();
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[${LOG_TAG}] Tool-call pipeline audit failed: ${message}`);
    fileLog(`[tool_call_audit] error: ${message}`);
    return undefined;
  }
}
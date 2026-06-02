/**
 * 电脑管家 AI Fetch 中间件（LLM 请求审核）
 *
 * 导出 FetchMiddleware 工厂函数，由 Package setup 通过
 * ctx.registerFetchMiddleware() 注册到 FetchChain。
 */

import { LOG_TAG } from "./constants.js";
import { fileLog } from "./logger.js";
import { LLMShieldClient, ContentType, DecisionType } from "./client.js";
import { MessageCache } from "./cache.js";
import { getModerateUrl } from "./endpoints.js";
import { normalizeMessage, robustExtractLastUserMessage } from '../../shared/message-utils.js'
import {
  calculateContentHash,
  generateRequestId,
  recordLogEvent,
  injectSecurityMarker,
  generateSecurityMessage,
  stripOpenClawMetadata,
  stripHiddenPrompts,
  resolveQueryScene,
  QueryScene,
} from "./utils.js";
import { getLabelName } from "./labels.js";
import { checkContentSecurity, writeLlmApiLog } from "./security.js";
import { reportAuditLog, AuditActionType, AuditRiskLevel, AuditResult } from "./audit-log-reporter.js";
import { getSwitches } from "./runtime-config.js";
import { getPendingSessionKey } from "./session-bridge.js";

import type { QClawLogger, FetchMiddleware, FetchRequestContext, FetchResponseContext } from '../../../core/types.js'

export interface FetchMiddlewareConfig {
  logger: QClawLogger;
  client: LLMShieldClient;
  sceneId: string;
  enableLogging: boolean;
  messageCache: MessageCache;
  modes?: string[];
  shieldHost: string;
}

/**
 * 创建 pcmgr-ai-security 的 FetchMiddleware。
 *
 * 替代原来直接覆盖 global.fetch 的 setupFetchInterceptor。
 * 通过 FetchChain 的洋葱模型接入，match 函数过滤非目标请求。
 */
export function createFetchMiddleware(config: FetchMiddlewareConfig): FetchMiddleware {
  const { logger, client, sceneId, enableLogging, messageCache, modes, shieldHost } = config;

  logger.debug(`[${LOG_TAG}] createFetchMiddleware()`);

  return {
    id: 'pcmgr-ai-security',
    priority: 250,

    // 跳过对审核服务自身的请求
    match(input: RequestInfo | URL): boolean {
      const url = input.toString();
      if (url.startsWith(shieldHost)) {
        return false;
      }
      return true;
    },

    async onRequest(ctx: FetchRequestContext): Promise<FetchRequestContext> {
      const _diagStart = performance.now();
      const url = ctx.input.toString();
      const init = ctx.init ?? {};
      const body = init.body;

      if (body) {
        let messagesToModerate: Array<{ role: string; content: string }> = [];
        let rawBody: string | undefined;
        let jsonBody: any;
        let bodyChanged = false;

        if (typeof body === "string") {
          rawBody = body;
        } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
          rawBody = new TextDecoder().decode(body);
        }

        if (rawBody) {
          try {
            jsonBody = JSON.parse(rawBody);

            // Inject cached security markers into previously blocked messages
            if (jsonBody && Array.isArray(jsonBody.messages)) {
              jsonBody.messages.forEach((m: any, idx: number) => {
                const normalized = normalizeMessage(m, "openai");
                if (normalized.role === "user" && normalized.content) {
                  const cacheKey = calculateContentHash(normalized.content, idx);
                  if (cacheKey) {
                    const cached = messageCache.get(cacheKey);
                    if (cached) {
                      const newContent = injectSecurityMarker(
                        m.content,
                        cached.reason,
                        cached.decision
                      );
                      if (JSON.stringify(newContent) !== JSON.stringify(m.content)) {
                        m.content = newContent;
                        bodyChanged = true;
                      }
                    }
                  }
                }
              });
            }

            messagesToModerate = robustExtractLastUserMessage(jsonBody);
          } catch (e) {
            recordLogEvent(
              logger,
              LOG_TAG,
              "json_parse_failed",
              { url, error: String(e) },
              enableLogging
            );
          }
        }

        // Moderate the last user message
        if (messagesToModerate.length > 0 && getSwitches().enablePromptAudit) {
          const msg = messagesToModerate[0];

          // ── 提取 request headers 中的关键字段 ──
          let agentId = 'main';
          let xSessionId = '';
          const rawHdrs = init.headers;
          if (rawHdrs instanceof Headers) {
            agentId = rawHdrs.get('x-agent-id') || 'main';
            xSessionId = rawHdrs.get('x-session-id') || '';
          } else if (Array.isArray(rawHdrs)) {
            const agentFound = rawHdrs.find(([k]) => k.toLowerCase() === 'x-agent-id');
            if (agentFound) agentId = String(agentFound[1]) || 'main';
            const sessionFound = rawHdrs.find(([k]) => k.toLowerCase() === 'x-session-id');
            if (sessionFound) xSessionId = String(sessionFound[1]) || '';
          } else if (rawHdrs && typeof rawHdrs === 'object') {
            agentId = (rawHdrs as Record<string, string>)['x-agent-id'] || 'main';
            xSessionId = (rawHdrs as Record<string, string>)['x-session-id'] || '';
          }

          const bridgeSessionKey = getPendingSessionKey(agentId);

          const promptRequestId = generateRequestId();
          logger.debug(`[${LOG_TAG}] tryPromptAudit: role=${msg.role}, contentLength=${msg.content.length}`);
          fileLog(`[prompt_audit] tryPromptAudit: role=${msg.role} contentLength=${msg.content.length}`);

          // 从 content-plugin 中间件的 extra 中提取 sessionKey（content-plugin priority=200 先于本中间件执行）
          const cpExtra = ctx.extra._contentPlugin as { sessionKey?: string } | undefined;
          const cpSessionKey = cpExtra?.sessionKey;
          let sessionKey = bridgeSessionKey || cpSessionKey || undefined;

          // CLI 模式下主会话的 sessionKey 固定为 agent:main:main，无法区分不同会话。
          // 拼上 x-session-id header 做细粒度区分：agent:main:main:<session-id>
          let sessionIdSuffix = '';
          if (sessionKey && /^agent:[^:]+:[^:]+$/.test(sessionKey) && sessionKey.endsWith(':main')) {

            if (xSessionId) {
              sessionIdSuffix = xSessionId;
              sessionKey = `${sessionKey}:${xSessionId}`;
            }
          }

          // 外部渠道（钉钉/飞书等）通过 OpenAI 兼容 API 接入时，sessionKey 格式为
          // agent:<agentId>:openai-user:<json>，其中 json 含渠道上下文信息。
          // 送审时去掉 JSON 部分，替换为 sessionId 做细粒度区分：agent:<agentId>:openai-user:<sessionId>
          if (sessionKey && /^agent:[^:]+:openai-user:/.test(sessionKey)) {
            const prefix = sessionKey.replace(/^(agent:[^:]+:openai-user:).*/, '$1');
            // 无论是否有 x-session-id，都去掉原始 JSON 部分；有则拼上做细粒度区分
            if (xSessionId) {
              sessionIdSuffix = xSessionId;
              sessionKey = `${prefix}${xSessionId}`;
            } else {
              sessionKey = prefix.replace(/:$/, '');
            }
            fileLog(`[prompt_audit] openai-user sessionKey resolved: ${sessionKey} (xSessionId=${xSessionId || 'none'})`);
          }

          // 日志：记录 sessionKey 来源，便于排查
          const sessionKeySource = bridgeSessionKey ? 'llm_input' : cpSessionKey ? 'content-plugin' : 'none';
          const msgCount = Array.isArray(jsonBody?.messages) ? jsonBody.messages.length : 0;
          writeLlmApiLog(
            `[prompt_audit] sessionKey=${sessionKey ?? 'undefined'} source=${sessionKeySource} agentId=${agentId} msgCount=${msgCount}` +
            (sessionIdSuffix ? ` sessionIdSuffix=${sessionIdSuffix}` : '') +
            (xSessionId ? ` xSessionId=${xSessionId}` : '')
          );

          // ── 场景判定（与 content-plugin 一致）──
          const queryScene = resolveQueryScene({
            sessionKey,
            sessionId: xSessionId || undefined,
            channelId: agentId,
          });

          if (queryScene !== QueryScene.USER_QUERY) {
            // 非用户主动对话（记忆/定时任务/心跳/插件等），跳过审核
            fileLog(`[prompt_audit] SKIP by queryScene=${queryScene} sessionKey=${sessionKey} xSessionId=${xSessionId}`);
          } else {
            // ── 用户对话，继续走审核逻辑 ──

            // Extract recent history (last 5 non-system messages, excluding the current one)
            let historyV2: Array<{ Role: string; Content: string; ContentType: ContentType }> | undefined;
            if (jsonBody && Array.isArray(jsonBody.messages) && jsonBody.messages.length > 1) {
              const historyMessages = jsonBody.messages
                .slice(0, -1)
                .filter((m: any) => m.role !== "system")
                .slice(-5);

              historyV2 = historyMessages.map((m: any) => {
                const normalized = normalizeMessage(m, "openai");
                return {
                  Role: normalized.role || "user",
                  Content: normalized.content,
                  ContentType: ContentType.TEXT,
                };
              });
            }

            // 提取用户原始 prompt：去除 OpenClaw 元数据 + UI 层 ¥¥ 隐藏 prompt
            const rawUserPrompt = stripHiddenPrompts(stripOpenClawMetadata(msg.content)).trim();

            // 安全修复：移除 isInternalPluginRequest 兜底（基于 prompt 前缀的文本匹配可被用户伪造绕过审核）。
            // 场景判定已由 resolveQueryScene() 通过 sessionKey + x-session-id header 可靠完成。

            recordLogEvent(
              logger,
              LOG_TAG,
              "prompt_audit(check)",
              { requestId: promptRequestId, role: msg.role, contentLength: msg.content.length, rawLength: rawUserPrompt.length, sessionKey, queryScene },
              enableLogging
            );

            const { decision, labels, risks } = await checkContentSecurity(
              logger,
              client,
              sceneId,
              [
                {
                  Content: rawUserPrompt,
                  ContentType: ContentType.TEXT,
                },
              ],
              msg.role,
              "prompt_audit",
              enableLogging,
              historyV2,
              modes,
              sessionKey
            );

            recordLogEvent(
              logger,
              LOG_TAG,
              "prompt_audit(result)",
              { requestId: promptRequestId, decision, labels, risks },
              enableLogging
            );

            // 上报审计日志到管家（BLOCK 和 ALLOW 都上报，MARK 不上报）
            {
              const rawPrompt = rawUserPrompt.replace(/\r\n|\n/g, " ");
              const isBlock = decision === DecisionType.BLOCK;
              const isMark = decision === DecisionType.MARK;
              const firstReason = (isBlock || isMark)
                ? (risks[0]?.Reason || (labels[0] ? getLabelName(labels[0], "zh") : ""))
                : "";
              reportAuditLog({
                actiontype: AuditActionType.PROMPT_SECURITY_CHECK,
                detail: rawPrompt.slice(0, 500),
                risklevel: (isBlock || isMark) ? AuditRiskLevel.RISKY : AuditRiskLevel.SAFE,
                result: isBlock ? AuditResult.BLOCK : (isMark ? AuditResult.BLOCK : AuditResult.ALLOW),
                optpath: isMark ? `[MARK] ${firstReason}` : firstReason,
              }).catch(() => {});
              if (isMark) {
                fileLog(
                  `[prompt_audit] MARK detected and reported`
                  + ` | labels=${JSON.stringify(labels)}`
                  + ` | reason=${firstReason}`
                  + ` | prompt=${rawPrompt.slice(0, 200)}`,
                );
              }
            }

            if (decision === DecisionType.BLOCK || decision === DecisionType.MARK) {
              const securityReason = generateSecurityMessage(labels, decision, risks);

              // Cache the moderation result
              const lastIndex = (jsonBody?.messages?.length || 1) - 1;
              const cacheKey = calculateContentHash(msg.content, lastIndex);
              if (cacheKey) {
                messageCache.set(cacheKey, securityReason, decision);
              }

              const logPrefix = decision === DecisionType.BLOCK ? "block" : "mark";
              logger.error(`[${LOG_TAG}] prompt_audit ${logPrefix}: ${securityReason}`);
              recordLogEvent(
                logger,
                LOG_TAG,
                `prompt_audit(${logPrefix})`,
                { securityReason, originalContent: msg.content },
                enableLogging
              );

              // Inject security marker into the request body
              if (jsonBody && Array.isArray(jsonBody.messages) && jsonBody.messages.length > 0) {
                const lastMsg = jsonBody.messages[jsonBody.messages.length - 1];
                lastMsg.content = injectSecurityMarker(lastMsg.content, securityReason, decision);
                bodyChanged = true;
              } else if (jsonBody && typeof jsonBody.prompt === "string") {
                jsonBody.prompt = injectSecurityMarker(jsonBody.prompt, securityReason, decision);
                bodyChanged = true;
              } else if (jsonBody && typeof jsonBody.input === "string") {
                jsonBody.input = injectSecurityMarker(jsonBody.input, securityReason, decision);
                bodyChanged = true;
              }
            } else {
              logger.debug(`[${LOG_TAG}] prompt_audit allow`);
              recordLogEvent(
                logger,
                LOG_TAG,
                "prompt_audit(allow)",
                { requestId: promptRequestId, decision },
                enableLogging
              );
            }
          }

          if (bodyChanged) {
            ctx.init = { ...init, body: JSON.stringify(jsonBody) };
          }
        }
      }

      // Log LLM API request (one-line summary)
      const _diagReqMs = (performance.now() - _diagStart).toFixed(1);
      if (Number(_diagReqMs) > 2000) {
        console.warn(`[qclaw-plugin:pcmgr-ai-security] [diag] onRequest SLOW ${_diagReqMs}ms url=${url.slice(0, 80)}`);
      }
      const currentInit = ctx.init ?? {};
      const reqBodyRaw = currentInit.body
        ? typeof currentInit.body === "string"
          ? currentInit.body
          : currentInit.body instanceof Uint8Array || currentInit.body instanceof ArrayBuffer
            ? new TextDecoder().decode(currentInit.body)
            : undefined
        : undefined;
      if (reqBodyRaw) {
        try {
          const parsed = JSON.parse(reqBodyRaw);
          const model = parsed.model ?? "?";
          const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
          const toolCount = Array.isArray(parsed.tools) ? parsed.tools.length : 0;
          const stream = parsed.stream ? "stream" : "sync";
          const msgsSummary = msgs.map((m: any, i: number) => {
            const role = m.role ?? "?";
            const content = typeof m.content === "string"
              ? m.content
              : Array.isArray(m.content)
                ? m.content.map((p: any) => p.text ?? `[${p.type}]`).join("")
                : JSON.stringify(m.content);
            const truncated = content.length > 200 ? content.slice(0, 200) + "..." : content;
            return `  [${i}] ${role}: ${truncated}`;
          }).reverse().join("\n");
          writeLlmApiLog(`[LLM] REQ  ${url} model=${model} msgs=${msgs.length} tools=${toolCount} ${stream}\n${msgsSummary}`);
        } catch {
          writeLlmApiLog(`[LLM] REQ  ${url} (parse failed, ${reqBodyRaw.length}b)`);
        }
      }

      return ctx;
    },

    async onResponse(respCtx: FetchResponseContext): Promise<Response> {
      const _diagStart = performance.now();
      const url = respCtx.input.toString();
      const resp = respCtx.response;

      // Log LLM API response (compact summary + message content)
      try {
        const contentType = resp.headers.get("content-type") || "";

        if (contentType.includes("text/event-stream")) {
          const body = resp.body;
          if (!body) return resp;

          const reader = body.getReader();
          const decoder = new TextDecoder();

          // State for collecting log metadata (logging only, no security logic)
          let fullContent = "";
          const toolCalls: { id: string; type: string; name: string; arguments: string }[] = [];
          let model = "";
          let finishReason = "";
          let usage: Record<string, unknown> | null = null;

          const transformedStream = new ReadableStream({
            async pull(controller) {
              const { done, value } = await reader.read();

              if (done) {
                controller.close();
                // Write logs after stream ends (does not block any chunk delivery)
                try {
                  const respSummary: Record<string, unknown> = {
                    model,
                    finish_reason: finishReason,
                    content_length: fullContent.length,
                  };
                  if (usage) respSummary.usage = usage;
                  writeLlmApiLog(
                    `[LLM] RESP ${url} (status:${resp.status}, stream) ${JSON.stringify(respSummary)}`,
                  );
                  if (fullContent) {
                    const truncated =
                      fullContent.length > 2000
                        ? fullContent.slice(0, 2000) + "..."
                        : fullContent;
                    writeLlmApiLog(`[LLM] RESP message.content:\n${truncated}`);
                  }
                  if (toolCalls.length > 0) {
                    const tcSummary = toolCalls
                      .map((tc, i) => {
                        const argsStr =
                          tc.arguments.length > 500
                            ? tc.arguments.slice(0, 500) + "..."
                            : tc.arguments;
                        return `  [${i}] ${tc.name}(${argsStr})`;
                      })
                      .join("\n");
                    writeLlmApiLog(`[LLM] RESP message.tool_calls:\n${tcSummary}`);
                  }
                } catch {
                  // ignore logging errors
                }
                return;
              }

              // Forward the original chunk to downstream immediately (zero delay)
              controller.enqueue(value);

              // Synchronously parse SSE events to extract metadata (no extra async await)
              try {
                const chunk = decoder.decode(value, { stream: true });
                for (const line of chunk.split("\n")) {
                  if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
                  try {
                    const data = JSON.parse(line.slice(6));
                    if (!model && data.model) model = data.model;
                    if (data.usage) usage = data.usage;
                    const delta = data.choices?.[0]?.delta;
                    if (delta?.content) fullContent += delta.content;
                    if (delta?.tool_calls) {
                      for (const tc of delta.tool_calls) {
                        const idx = tc.index ?? toolCalls.length;
                        if (!toolCalls[idx]) {
                          toolCalls[idx] = { id: "", type: "", name: "", arguments: "" };
                        }
                        if (tc.id) toolCalls[idx].id = tc.id;
                        if (tc.type) toolCalls[idx].type = tc.type;
                        if (tc.function?.name) toolCalls[idx].name = tc.function.name;
                        if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
                      }
                    }
                    if (data.choices?.[0]?.finish_reason) {
                      finishReason = data.choices[0].finish_reason;
                    }
                  } catch {
                    // ignore individual SSE event parse errors
                  }
                }
              } catch {
                // ignore chunk decode errors
              }
            },
          });

          // Return new Response immediately (~0ms, no I/O wait)
          return new Response(transformedStream, {
            status: resp.status,
            statusText: resp.statusText,
            headers: resp.headers,
          });
        } else {
          // Non-SSE response: keep original clone + text logging (no blocking issue for non-stream)
          const cloned = resp.clone();
          const respText = await cloned.text();
          const truncated = respText.length > 3000 ? respText.slice(0, 3000) + "..." : respText;
          writeLlmApiLog(`[LLM] RESP ${url} (status:${resp.status}, ${respText.length} bytes)\n${truncated}`);
        }
      } catch (_) {
        // ignore logging errors
      }

      const _diagRespMs = (performance.now() - _diagStart).toFixed(1);
      if (Number(_diagRespMs) > 2000) {
        console.warn(`[qclaw-plugin:pcmgr-ai-security] [diag] onResponse SLOW ${_diagRespMs}ms url=${url.slice(0, 80)}`);
      }

      return resp;
    },
  };
}

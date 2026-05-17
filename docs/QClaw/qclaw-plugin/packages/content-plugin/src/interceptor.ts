/**
 * content-plugin Fetch 中间件
 *
 * 从原 setupFetchInterceptor 迁移为 FetchMiddleware 接口。
 * 通过 FetchChain 的洋葱模型接入：
 * - onRequest: 输入审核（REDACT 过滤、sanitize、输入送审），BLOCK 时设置 shortCircuitResponse
 * - onResponse: 输出审核（SSE 流 TransformStream 包装、JSON 响应审核）
 */

import { SessionType } from "./types.js";
import type { RiskControlMediaItem, MultimodalScene } from "./types.js";
import type {
  FetchMiddleware,
  FetchRequestContext,
  FetchResponseContext,
  QClawLogger,
} from '../../../core/types.js';
import {
  extractLastUserMessage,
  extractAssistantContent,
  sliceText,
  checkSlicesParallel,
  generateTraceparent,
  generateTraceId,
  writeSecurityLog, resolveChannelId, resolveScenceType, resolveQueryScene, QueryScene,
} from "./utils.js";
import { stripPromptMetadata, getTracer, getGalileoConfig, SpanKind, ROOT_CONTEXT, SpanStatusCode, reportLog } from "./service.js";
import { checkContentSecurity } from "./security.js";
import {
  getSessionId,
  ensureQAIDForTurn,
  isSessionBlocked,
  clearSessionBlocked,
  addBlockedContent,
  sanitizeMessages,
} from "./session.js";
import {
  getCurrentAgentCtx,
  getCurrentAgentSpanId,
  getCurrentLlmAuditContext,
  consumePendingChatSpanCallback, setExternalSessionKey, getExternalSessionKey, setExternalIdempotencyKey, getExternalIdempotencyKey, getExternalGuid, getQClawAppVersion,
  getExternalUid, getExternalAppVersion, getExternalSourceTerminal, getOpenclawVersion, getExternalPromptId, getExternalWechatSessionId,
  getOrCreateTraceIdForRun, getActiveRunId,
  getSessionTrigger,
} from "./state.js";
import type { CreateTaskClient } from "./client.js";


/**
 * 安全解码 URI 组件：如果 decodeURIComponent 解码失败（如非法 %xx 序列），
 * 返回原始字符串，避免因编码异常导致请求崩溃。
 */
function safeDecodeURIComponent(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/**
 * 按 `:` 分隔符逐段解码 URI 组件，再用 `:` 拼接还原。
 * 编码端通过 `value.split(':').map(encodeURIComponent).join(':')` 产生，
 * 此处做对称的逐段 decode，确保每段独立解码、`:` 分隔符保持不变。
 */
function decodeColonSeparatedURIComponents(encoded: string): string {
  return encoded.split(':').map(safeDecodeURIComponent).join(':');
}

// ─── 内容安全拦截 Trace 上报 ───
const reportContentSecurityBlock = (
  blockType: "input" | "output",
  extra: {
    sessionKey: string;
    qaid: string;
    parentCtx?: any;
    blockSource?: string;
    errorType?: "security_block" | "model_error";
    errorMessage?: string;
  },
): void => {
  const tracer = getTracer();
  if (!tracer) return;

  const galileoCfg = getGalileoConfig();
  const genAi = galileoCfg?.galileo.trace.genAi;

  const span = tracer.startSpan(
    `content_security_block`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'gen_ai.operation.name': 'content_security_block',
        'gen_ai.system': genAi?.system || 'openclaw',
        'gen_ai.agent.name': genAi?.agentName || 'openclaw-agent',
        'gen_ai.agent.id': genAi?.agentId || '',
        'gen_ai.app.name': genAi?.appName || 'openclaw',
        'gen_ai.user.id': getExternalUid() || '',
        'gen_ai.error_type': extra.errorType || 'security_block',
        'gen_ai.error_message': extra.errorMessage || '',
        'openclaw.status': 'error',
        'openclaw.block_type': blockType,
        'openclaw.qaid': extra.qaid,
        'openclaw.guid': getExternalGuid() ?? '',
        'openclaw.uid': getExternalUid() ?? '',
        'openclaw.app_version': getExternalAppVersion() ?? '',
        'openclaw.source_terminal': getExternalSourceTerminal() ?? '',
        'openclaw.openclaw_version': getOpenclawVersion() ?? '',
        'openclaw.prompt_id': getExternalPromptId() ?? '',
        'openclaw.wechat_session_id': getExternalWechatSessionId() ?? '',
        'openclaw.stage': extra?.blockSource ?? '',
      },
    },
    extra.parentCtx ?? ROOT_CONTEXT,
  );
  span.setStatus({ code: SpanStatusCode.ERROR, message: extra.errorMessage || `content_security_block:${blockType}` });
  span.end();
};

const PROMPT_MAX_LENGTH = 4000;
const OUTPUT_MAX_LENGTH = 120;

// ─── 拦截器状态（全局单例） ───
const FETCH_INTERCEPTOR_STATE = Symbol.for("openclaw.contentSecurity.fetchInterceptorState");

interface FetchInterceptorState {
  installed: boolean;
  setupAttempts: number;
  triggerCount: number;
  llmRequestCount: number;
  outputAuditEndCount: number;
}

type GlobalWithFetchInterceptorState = typeof globalThis & {
  [FETCH_INTERCEPTOR_STATE]?: FetchInterceptorState;
};

const getFetchInterceptorState = (): FetchInterceptorState => {
  const globalState = globalThis as GlobalWithFetchInterceptorState;
  if (!globalState[FETCH_INTERCEPTOR_STATE]) {
    globalState[FETCH_INTERCEPTOR_STATE] = {
      installed: false,
      setupAttempts: 0,
      triggerCount: 0,
      llmRequestCount: 0,
      outputAuditEndCount: 0,
    };
  }
  return globalState[FETCH_INTERCEPTOR_STATE]!;
};

// ─── 日志工具 ───
const PHASE_LABEL: Record<string, string> = {
  llm_request:            "LLM→  请求发出",
  llm_request_error:      "LLM✗  请求失败",
  llm_response_received:  "←LLM  响应头",
  llm_response_json:      "←LLM  响应体(JSON)",
  audit_input_start:        "送审→  输入开始",
  audit_input_slice_send:   "送审→  输入分片",
  audit_input_slice_result: "←送审  输入结果",
  audit_input_slice_result_degraded: "←送审 输入结果(降级)",
  audit_input_end:          "←送审  输入汇总",
  audit_input_end_degraded: "←送审 输入汇总(降级)",
  llm_response_stream_body:  "←LLM  响应体(SSE流)",
  audit_output_slice_send:   "送审→  输出分片",
  audit_output_slice_result: "←送审  输出结果",
  audit_output_slice_result_degraded: "←送审 输出结果(降级)",
  audit_output_end_send:     "送审→  输出末尾",
  audit_output_end_result:   "←送审  输出末尾结果",
  audit_output_end_result_degraded: "←送审 输出末尾结果(降级)",
  audit_output_json_send:    "送审→  输出(JSON)",
  session_write_redact_input:  "→session 写入(输入拦截/REDACT)",
  session_write_redact_output: "→session 写入(输出拦截/REDACT)",
};

const logInterceptorDebug = (phase: string, data: Record<string, unknown>): void => {
  const label = PHASE_LABEL[phase] ?? phase;
  writeSecurityLog(label, data);
};

// ─── REDACT 区间过滤 ───
const messageHasRedact = (msg: any): boolean => {
  if (!msg) return false;
  if (typeof msg.content === "string") {
    return msg.content.includes("<!--REDACT-->");
  }
  if (Array.isArray(msg.content)) {
    return msg.content.some(
      (part: any) => part.type === "text" && typeof part.text === "string" && part.text.includes("<!--REDACT-->"),
    );
  }
  return false;
};

const filterRedactedMessages = (messages: any[]): any[] => {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const indicesToRemove = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    if (!messageHasRedact(messages[i])) continue;
    let rangeStart = i;
    for (let j = i; j >= 0; j--) {
      if (messages[j].role === "user") { rangeStart = j; break; }
    }
    let rangeEnd = messages.length;
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].role === "user") { rangeEnd = j; break; }
    }
    for (let j = rangeStart; j < rangeEnd; j++) {
      indicesToRemove.add(j);
    }
  }
  if (indicesToRemove.size === 0) return messages;
  return messages.filter((_, idx) => !indicesToRemove.has(idx));
};

const EXTERNAL_BLOCK_PATTERNS: RegExp[] = [];

const isExternalBlockedResponse = (content: string): boolean => {
  if (!content || content.length === 0) return false;
  return EXTERNAL_BLOCK_PATTERNS.some((pattern) => pattern.test(content));
};

function convertHeadersToRecord(headers: Headers | Array<[string, string]> | Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;

  if(Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result[key] = value;
    }
    return result;
  }

  if (typeof headers === 'object' && !('entries' in headers)) {
    for (const key in headers) {
      result[key] = headers[key];
    }
    return result;
  } else if('entries' in headers) {
    for (const [key, value] of (headers as Headers).entries()) {
      result[key] = value;
    }
  }

  return result;
}

// ─── 工厂配置 ───
export interface FetchMiddlewareConfig {
  client: CreateTaskClient;
  /** 返回当前 CosClient 实例（注册时可能为 null，请求时才有值，用 getter 避免值传递固化问题） */
  getCosClient: () => any;
  /** 返回当前 MultimodalSecurityClient 实例（同上） */
  getMultimodalClient: () => any;
  enableLogging: boolean;
  shieldEndpoint: string;
  logger: QClawLogger;
  stateDir: string;
  runtimeConfig: any;
}


/**
 * 创建 content-plugin 的 FetchMiddleware。
 *
 * 替代原来直接覆盖 globalThis.fetch 的 setupFetchInterceptor。
 * 通过 FetchChain 的洋葱模型接入。
 */
export function createFetchMiddleware(config: FetchMiddlewareConfig): FetchMiddleware {
  const { client, getCosClient, getMultimodalClient, logger, enableLogging, shieldEndpoint } = config;
  const interceptorState = getFetchInterceptorState();

  return {
    id: 'content-plugin',
    priority: 200,

    // 跳过对审核服务自身的请求
    match(input: RequestInfo | URL): boolean {
      const url = input.toString();
      if (shieldEndpoint && url.includes(shieldEndpoint)) {
        return false;
      }
      return true;
    },

    async onRequest(ctx: FetchRequestContext): Promise<FetchRequestContext> {
      const triggerSeq = interceptorState.triggerCount + 1;
      interceptorState.triggerCount = triggerSeq;

      const url = ctx.input.toString();
      const init = ctx.init ?? {};

      const parentCtx = getCurrentAgentCtx() ?? undefined;

      // ─── 从请求 headers 提取 x-run-id ───
      const reqHeaders = convertHeadersToRecord(init.headers);
      const headerRunId = reqHeaders['x-run-id'] as string | undefined;
      if (headerRunId) {
        setExternalIdempotencyKey(headerRunId);
      }

      // ─── 生成链路追踪信息（基于 runId 的 Map 映射）───
      // 优先级：activeRunId（与 before_agent_start 中设置的一致）> x-run-id header > 独立生成
      // 关键：必须与 before_agent_start/agent_end 使用同一个 Map key，
      // 否则 agent_end 的 clearTraceIdForRun 无法清理 interceptor 写入的缓存条目。
      const effectiveRunId = getActiveRunId() || headerRunId;
      const roundTraceId = effectiveRunId
        ? getOrCreateTraceIdForRun(effectiveRunId)
        : generateTraceId();  // 无 runId 的请求（如内部 proxy）每次独立生成
      const currentSpanId = getCurrentAgentSpanId() ?? undefined;
      const { traceparent } = generateTraceparent(roundTraceId, currentSpanId);

      // LlmAuditContext 延迟到确认是 LLM 请求后再消费，避免非 LLM 请求（如内部 proxy/api）
      // 提前消费队列导致真正的 LLM 请求拿不到正确的 sessionKey（断链问题）
      let runtimeAuditCtx: ReturnType<typeof getCurrentLlmAuditContext> = null;
      let sessionKey = `fetch:${url}`;
      let turnKey = roundTraceId;

      // const { body: _body, ...initWithoutBody } = (ctx.init ?? {}) as Record<string, unknown>;
      // writeSecurityLog('ctxctxctxctx', { input: ctx.input, init: initWithoutBody, extra: ctx.extra })

      // 从请求 headers 中提取 x-session-key，如果存在则更新全局 externalSessionKey，
      // 确保后续逻辑能拿到当前请求的真实 sessionKey
      // 注意：sessionKey 可能包含中文等非 ASCII 字符，发送端按 `:` 分段 encodeURIComponent 编码，
      // 此处需要按同样规则逐段 decode 还原
      const rawHeaderSessionKey = reqHeaders?.['x-session-key'] as string | undefined;
      const headerSessionKey = rawHeaderSessionKey
        ? decodeColonSeparatedURIComponents(rawHeaderSessionKey)
        : undefined;
      if (headerSessionKey) {
        setExternalSessionKey(headerSessionKey);
      }
      // 优先使用当前请求 header 中提取的 sessionKey，避免全局变量在多通路并发时被覆盖
      const externalSessionKey = headerSessionKey || getExternalSessionKey() || '';
      // 优先使用当前请求 header 中提取的 runId，避免全局变量在多通路并发时被覆盖
      const externalIdempotencyKey = headerRunId || getExternalIdempotencyKey() || '';
      const qClawAppVersion = getQClawAppVersion() ?? 'unknow';
      const guid = getExternalGuid() ?? '';


      // ─── 注入 traceparent 头 ───
      const headers = (init.headers ?? {}) as Record<string, string>;
      const channelId = (reqHeaders['x-sender-id'] || resolveChannelId(externalSessionKey)) ?? '';
      const conversationId = reqHeaders["X-Conversation-ID"] || reqHeaders['x-conversation-id'] || getSessionId(sessionKey);
      // 修正conversation_reqId让模型侧确定唯一问答ID
      const conversationRequestId = reqHeaders['X-Conversation-Request-ID'] || reqHeaders['x-conversation-request-id'] || ensureQAIDForTurn(sessionKey, turnKey);


      let jsonBody: any;
      let requestBodyLength = 0;
      let isMemoryCompactionRequest = false;


      // ─── 判断是否为 LLM 请求 ───
      // messages 必须非空数组，避免 messages:[] 的内部请求被误判为 LLM 请求（空内容送审问题）
      // const isLLMRequest = typeof ctx.input === "string" ? (ctx.input as string).includes('llm/chat/completions') : (!!(jsonBody && (
      //   (Array.isArray(jsonBody.messages) && jsonBody.messages.length > 0) ||
      //   typeof jsonBody.prompt === "string" ||
      //   typeof jsonBody.input === "string"
      // )) );

      if (init.body) {
        let rawBody: string | undefined;
        if (typeof init.body === "string") {
          rawBody = init.body;
        } else if (init.body instanceof Uint8Array || init.body instanceof ArrayBuffer) {
          rawBody = new TextDecoder().decode(init.body);
        }
        if (rawBody) {
          requestBodyLength = rawBody.length;
          try { jsonBody = JSON.parse(rawBody); } catch { /* 非 JSON 忽略 */ }
        }

        if (jsonBody) {
          const messagesToModerate = extractLastUserMessage(jsonBody);

          const lastUserMsgPreview = (() => {
            if (!Array.isArray(jsonBody?.messages)) return "";
            for (let i = jsonBody.messages.length - 1; i >= 0; i--) {
              if (jsonBody.messages[i].role === "user") {
                const c = jsonBody.messages[i].content;
                const text = typeof c === "string" ? c : (Array.isArray(c) ? c.map((p: any) => p.text ?? "").join("") : "");
                return text.slice(0, 300);
              }
            }
            return "";
          })();

          isMemoryCompactionRequest = lastUserMsgPreview.startsWith("You summarize a SEGMENT")
              || conversationRequestId.startsWith("auto-memory-extract-");
          if (Array.isArray(jsonBody.messages)) {
            let lastUserMsgIndex = -1;
            for (let i = jsonBody.messages.length - 1; i >= 0; i--) {
              if (jsonBody.messages[i].role === "user") { lastUserMsgIndex = i; break; }
            }

            const redactFilteredMessages = filterRedactedMessages(jsonBody.messages);
            const redactRemovedCount = jsonBody.messages.length - redactFilteredMessages.length;

            if (redactRemovedCount > 0) {
              jsonBody.messages = redactFilteredMessages;
              lastUserMsgIndex = -1;
              for (let i = jsonBody.messages.length - 1; i >= 0; i--) {
                if (jsonBody.messages[i].role === "user") { lastUserMsgIndex = i; break; }
              }
            }

            const sanitizedCount = sanitizeMessages(jsonBody.messages, lastUserMsgIndex);

            if (redactRemovedCount > 0 || sanitizedCount > 0) {
              const newBody = JSON.stringify(jsonBody);
              if (typeof init.body === "string") {
                init.body = newBody;
              } else if (init.body instanceof Uint8Array) {
                init.body = new TextEncoder().encode(newBody);
              } else if (init.body instanceof ArrayBuffer) {
                const encoded = new TextEncoder().encode(newBody);
                init.body = encoded.buffer;
              }
              ctx.init = init as RequestInit;
            }
          }

          if (isSessionBlocked(sessionKey)) {
            if (messagesToModerate.length > 0) {
              clearSessionBlocked(sessionKey);
            }
          }

          // Memory Compaction 请求跳过输入送审
          if (messagesToModerate.length > 0 && !isMemoryCompactionRequest) {
            const msg = messagesToModerate[0];
            const sessionId = conversationId || getSessionId(sessionKey);
            const qaid = conversationRequestId || ensureQAIDForTurn(sessionKey, turnKey);
            const slices = sliceText(msg.content, PROMPT_MAX_LENGTH);

            // logInterceptorDebug("audit_input_start", {
            //   sessionKey, qaid, sliceCount: slices.length,
            //   totalLength: msg.content.length, contentPreview: msg.content.slice(0, 200),
            // });

            // 输入审核也需要 query_scene，提前计算
            const inputQueryScene = resolveQueryScene({
              channelId,
              sessionKey: externalSessionKey,
              sessionId: reqHeaders['x-session-id'] as string | undefined,
              trigger: externalSessionKey ? getSessionTrigger(externalSessionKey) : undefined,
              traceId: headerRunId || roundTraceId || undefined,
            });

            const inputBlocked = await checkSlicesParallel(
              slices,
              async (slice, i) => {
                const contentToCheck = i === 0 ? stripPromptMetadata(slice) : slice;
                logInterceptorDebug("audit_input_slice_send", {
                  sessionKey, qaid, sliceIndex: i, sliceLength: contentToCheck.length,
                  contentPreview: contentToCheck.slice(0, 100),
                });
                const result = await checkContentSecurity(
                  null,
                  client,
                  "prompt",
                  [{ Data: contentToCheck, MediaType: "Text" }],
                  sessionId,
                  SessionType.QUESTION,
                  "llm_request",
                  enableLogging,
                  "content-security",
                  qaid,
                  parentCtx,
                  roundTraceId,
                  { channelId, query_scene: inputQueryScene }
                );
                // logInterceptorDebug(result.degraded ? "audit_input_slice_result_degraded" : "audit_input_slice_result", {
                //   sessionKey, qaid, sliceIndex: i, blocked: result.blocked,
                //   resultCode: result.resultCode ?? "", resultType: result.resultType ?? "",
                //   level: result.level ?? "", degraded: result.degraded ?? false,
                //   errorType: result.errorType ?? "", traceId: result.traceId ?? "",
                //   requestId: result.requestId ?? "",
                // });
                return result;
              },
            );

            logInterceptorDebug("audit_input_end", { sessionKey, qaid, blocked: inputBlocked });

            if (inputBlocked) {
              const blockedReplyText = "<!--REDACT-->抱歉，这个问题我暂时无法解答，让我们换个话题吧~\n\n你可以试试让我帮你： 🔍 搜索与查询 · ✍️ 内容创作 · ⏰ 定时提醒 · ⚙️ 系统操作<!--/REDACT-->";
              const sseChunk = JSON.stringify({
                id: `blocked-${Date.now()}`, object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000), model: "content-security",
                choices: [{ index: 0, delta: { role: "assistant", content: blockedReplyText }, finish_reason: "stop" }],
              });
              const sseBody = `data: ${sseChunk}\n\ndata: [DONE]\n\n`;
              const encoder = new TextEncoder();

              logInterceptorDebug("session_write_redact_input", {
                sessionKey, qaid, reason: "input_blocked", content: blockedReplyText,
              });

              // 上报内容安全输入拦截 Trace
              reportContentSecurityBlock("input", {
                sessionKey, qaid, parentCtx,
                blockSource: "audit_input",
                errorType: "security_block",
                errorMessage: "input blocked by content security",
              });

              // 设置短路响应，FetchChain 将跳过 originalFetch
              console.log(
                `[qclaw-plugin:content-interceptor] [diag] SHORT_CIRCUIT input_blocked sessionKey=${sessionKey} qaid=${qaid}`,
              );
              ctx.shortCircuitResponse = new Response(encoder.encode(sseBody), {
                status: 200, statusText: "OK",
                headers: {
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache",
                  "Connection": "keep-alive",
                },
              });
              return ctx;
            }

            clearSessionBlocked(sessionKey);
          }
        }
      }


      // ─── 为 onResponse 提前计算 query_scene（确保输出审核也能拿到） ───
      const responseQueryScene = resolveQueryScene({
        channelId,
        sessionKey: externalSessionKey,
        sessionId: reqHeaders['x-session-id'] as string | undefined,
        trigger: externalSessionKey ? getSessionTrigger(externalSessionKey) : undefined,
        traceId: headerRunId || roundTraceId || undefined,
      });

      const isLLMRequest = (!!(jsonBody && (
        (Array.isArray(jsonBody.messages) && jsonBody.messages.length > 0) ||
        typeof jsonBody.prompt === "string" ||
        typeof jsonBody.input === "string"
      )) );

      /**
       * 构建 reportLog 公共参数，避免每个上报点重复罗列相同字段。
       * 各上报点只需 spread 此对象，再追加各自特有字段即可。
       */
      const buildCommonReportParams = () => ({
        provider: '',
        model: jsonBody?.model || '',
        runId: headerRunId || '',
        sessionId: '',
        sessionKey: externalSessionKey,
        userId: getExternalUid() || '',
        channelId,
        query_scene: responseQueryScene,
      });


      // 只有确认是 LLM 请求时才消费 LlmAuditContext，避免非 LLM 请求抢占队列（sessionKey 断链问题）
      if (isLLMRequest) {
        // 提取最后一条用户消息（供 query_scene 判定和 debug 日志共用）
        const _lastUserMsg = (() => {
          if (!Array.isArray(jsonBody?.messages)) return '';
          for (let i = jsonBody.messages.length - 1; i >= 0; i--) {
            if (jsonBody.messages[i].role === 'user') {
              const c = jsonBody.messages[i].content;
              const text = typeof c === 'string' ? c : (Array.isArray(c) ? c.map((p: any) => p.text ?? '').join('') : '');
              return text.slice(0, 300);
            }
          }
          return '';
        })();

        runtimeAuditCtx = getCurrentLlmAuditContext();
        sessionKey = runtimeAuditCtx?.sessionKey || `fetch:${url}`;
        turnKey = runtimeAuditCtx?.turnKey || roundTraceId;
        interceptorState.llmRequestCount += 1;

        // ─── 精细化 query scene 判定 ───
        const query_scene = resolveQueryScene({
          channelId,
          sessionKey: externalSessionKey,
          sessionId: reqHeaders['x-session-id'] as string | undefined,
          trigger: externalSessionKey ? getSessionTrigger(externalSessionKey) : undefined,
          traceId: headerRunId || roundTraceId || undefined,
        });

        logInterceptorDebug("llm_request", {
          seq: interceptorState.llmRequestCount, url,
          model: jsonBody?.model ?? "",
          messageCount: Array.isArray(jsonBody?.messages) ? jsonBody.messages.length : 0,
          lastUserMsgPreview: (() => {
            if (!Array.isArray(jsonBody?.messages)) return "";
            for (let i = jsonBody.messages.length - 1; i >= 0; i--) {
              if (jsonBody.messages[i].role === "user") {
                const c = jsonBody.messages[i].content;
                const text = typeof c === "string" ? c : (Array.isArray(c) ? c.map((p: any) => p.text ?? "").join("") : "");
                return text.slice(0, 200);
              }
            }
            return "";
          })(),
          stream: jsonBody?.stream ?? false,
          query_scene,
        });

        consumePendingChatSpanCallback();
        if (headers instanceof Headers) {
          headers.set("traceparent", traceparent);
          headers.set("X-Conversation-ID", conversationId);
          headers.set("X-Conversation-Request-ID", conversationRequestId);
          headers.set("X-QClaw-Run-ID", headerRunId || '');
          // headers.set("X-Session-Key", externalSessionKey);
          headers.set("X-Scence-Type", resolveScenceType(channelId));
          headers.set("X-Query-Scene", query_scene);
          headers.set("X-Channel-ID", channelId);
          headers.set("X-GUID", guid);
          headers.set("X-QClaw-Version", qClawAppVersion);
          (headers as Record<string, string>)["X-QClaw-Backend"] = 'openclaw';
          if (currentSpanId) headers.set("X-Span-ID", currentSpanId);
        } else if (Array.isArray(headers)) {
          headers.push(["traceparent", traceparent]);
          headers.push(["X-Conversation-ID", conversationId]);
          headers.push(["X-Conversation-Request-ID", conversationRequestId]);
          headers.push(["X-QClaw-Run-ID", externalIdempotencyKey]);
          // headers.push(["X-Session-Key", externalSessionKey]);
          headers.push(["X-Scence-Type", resolveScenceType(channelId)]);
          headers.push(["X-Query-Scene", query_scene]);
          headers.push(["X-Channel-ID", channelId]);
          headers.push(["X-GUID", guid]);
          headers.push(["X-QClaw-Version", qClawAppVersion]);
          (headers as Record<string, string>)["X-QClaw-Backend"] = 'openclaw';
          if (currentSpanId) headers.push(["X-Span-ID", currentSpanId]);
        } else {
          (headers as Record<string, string>)["traceparent"] = traceparent;
          (headers as Record<string, string>)["X-Conversation-ID"] = conversationId;
          (headers as Record<string, string>)["X-Conversation-Request-ID"] = conversationRequestId;
          (headers as Record<string, string>)["X-QClaw-Run-ID"] = externalIdempotencyKey;
          // (headers as Record<string, string>)["X-Session-Key"] = externalSessionKey;
          (headers as Record<string, string>)["X-Scence-Type"] = resolveScenceType(channelId);
          (headers as Record<string, string>)["X-Query-Scene"] = query_scene;
          (headers as Record<string, string>)["X-Channel-ID"] = channelId;
          (headers as Record<string, string>)["X-GUID"] = guid;
          (headers as Record<string, string>)["X-QClaw-Version"] = qClawAppVersion;
          (headers as Record<string, string>)["X-QClaw-Backend"] = 'openclaw';
          if (currentSpanId) (headers as Record<string, string>)["X-Span-ID"] = currentSpanId;
        }

        ctx.init = { ...init, headers } as RequestInit;
        reportLog({
          body: 'llm_request',
          params: {
            ...buildCommonReportParams(),
            logtype: 'LlmRequest',
            stage: 'llm_request',
            opname: 'llm_request',
            userid: getExternalUid() || '',
            sessionId: conversationId,
            query_scene,
            requestBodyLength,
          }
        })

        // ─── 多模态审核：本地路径文件/图片 + base64 图片 ───
        // 涵盖三种上传方式：拖拽/选择（[image:/path]）、粘贴保存成功（[image:/path]）、粘贴保存失败（base64 block）
        // 每次请求时动态获取，避免注册时 cosClient/multimodalClient 尚未初始化的问题
        const cosClient = getCosClient();
        const multimodalClient = getMultimodalClient();
        // TODO: 多模态信安方案变更，审核暂时屏蔽，不请求 4262 COS 上传 + 4287 多模态审核后端
        if (false && cosClient && multimodalClient && !isMemoryCompactionRequest && Array.isArray(jsonBody?.messages)) {
          const lastUserMsg = (() => {
            for (let i = jsonBody.messages.length - 1; i >= 0; i--) {
              if (jsonBody.messages[i].role === "user") return jsonBody.messages[i];
            }
            return null;
          })();

          const msgText = lastUserMsg
            ? (typeof lastUserMsg.content === "string"
              ? lastUserMsg.content
              : Array.isArray(lastUserMsg.content)
                ? lastUserMsg.content.filter((p: any) => p.type === "text").map((p: any) => p.text ?? "").join("\n")
                : "")
            : "";

          // 提取本地路径标记（支持路径中转义的 \] 字符）
          const imagePathRegex = /\[image:((?:[^\]\\]|\\.)+)\]/g;
          const filePathRegex = /\[file:((?:[^\]\\]|\\.)+)\]/g;
          const imagePaths: string[] = [];
          const filePaths: string[] = [];
          let m: RegExpExecArray | null;
          while ((m = imagePathRegex.exec(msgText)) !== null) imagePaths.push(m[1].replace(/\\]/g, ']'));
          while ((m = filePathRegex.exec(msgText)) !== null) filePaths.push(m[1].replace(/\\]/g, ']'));

          // 提取 base64 image blocks（粘贴截图 saveBase64Image 失败的情况）
          const base64ImageBlocks: Array<{ data: string; mediaType: string }> = [];
          if (lastUserMsg && Array.isArray(lastUserMsg.content)) {
            for (const part of lastUserMsg.content) {
              if (part.type === "image" && part.source?.type === "base64" && typeof part.source?.data === "string") {
                base64ImageBlocks.push({ data: part.source.data, mediaType: part.source.media_type || "image/png" });
              }
            }
          }

          const hasMultimodal = imagePaths.length > 0 || filePaths.length > 0 || base64ImageBlocks.length > 0;

          if (hasMultimodal) {
            const sessionId = conversationId || getSessionId(sessionKey);
            const qaid = conversationRequestId || ensureQAIDForTurn(sessionKey, turnKey);

            try {
              const mediaItems: RiskControlMediaItem[] = [];
              let hasImages = false;
              let hasFiles = false;

              const inferMimeType = (fp: string): string => {
                const ext = fp.slice(fp.lastIndexOf('.')).toLowerCase();
                const map: Record<string, string> = {
                  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
                  '.pdf': 'application/pdf', '.doc': 'application/msword',
                  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  '.xls': 'application/vnd.ms-excel',
                  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
                };
                return map[ext] || 'application/octet-stream';
              };

              // 处理本地路径图片
              for (const imgPath of imagePaths) {
                try {
                  if (!require('fs').existsSync(imgPath)) continue;
                  const buffer = require('fs').readFileSync(imgPath);
                  const mimeType = inferMimeType(imgPath);
                  const basename = require('path').basename(imgPath);
                  const filename = `audit_image_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${basename}`;
                  const result = await cosClient.upload(filename, buffer, mimeType);
                  mediaItems.push({ type: 'picture', item: result.internalUrl });
                  hasImages = true;
                } catch (e) {
                  logger.info('[Interceptor] 本地图片上传失败(跳过):', String(e));
                }
              }

              // 处理本地路径文件
              // COS 服务端限制约 256MB，超过会返回 code=4 拒绝上传
              // 在读取前先检查文件大小，避免大文件读入内存后才被拒绝（防止 OOM）
              const MAX_AUDIT_FILE_SIZE = 256 * 1024 * 1024; // 256MB
              for (const filePath of filePaths) {
                try {
                  if (!require('fs').existsSync(filePath)) continue;
                  const fileSize = require('fs').statSync(filePath).size;
                  if (fileSize > MAX_AUDIT_FILE_SIZE) {
                    logger.info(`[Interceptor] 本地文件超过审核大小限制(${(fileSize / 1024 / 1024).toFixed(1)}MB > 256MB), 跳过审核:`, filePath);
                    continue;
                  }
                  const buffer = require('fs').readFileSync(filePath);
                  const mimeType = inferMimeType(filePath);
                  const basename = require('path').basename(filePath);
                  const filename = `audit_file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${basename}`;
                  const result = await cosClient.upload(filename, buffer, mimeType);
                  const isImg = mimeType.startsWith('image/');
                  mediaItems.push({ type: isImg ? 'picture' : 'file', item: result.internalUrl });
                  if (isImg) hasImages = true; else hasFiles = true;
                } catch (e) {
                  logger.info('[Interceptor] 本地文件上传失败(跳过):', String(e));
                }
              }

              // 处理 base64 图片（粘贴截图保存失败的情况）— 解码为 Buffer 上传文件本体
              for (let idx = 0; idx < base64ImageBlocks.length; idx++) {
                try {
                  const { data, mediaType } = base64ImageBlocks[idx];
                  const pureBase64 = data.includes(',') ? data.split(',')[1] : data;
                  const buffer = Buffer.from(pureBase64, 'base64');
                  const ext = mediaType.split('/')[1] || 'png';
                  const filename = `audit_paste_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
                  const result = await cosClient.upload(filename, buffer, mediaType);
                  mediaItems.push({ type: 'picture', item: result.internalUrl });
                  hasImages = true;
                } catch (e) {
                  logger.info('[Interceptor] 粘贴图片上传失败(跳过):', String(e));
                }
              }

              if (mediaItems.length > 0) {
                const rawText = stripPromptMetadata(
                  msgText
                    .replace(/\[image:(?:[^\]\\]|\\.)+\]/g, '')
                    .replace(/\[file:(?:[^\]\\]|\\.)+\]/g, '')
                    .trim(),
                );
                if (rawText) mediaItems.push({ type: 'text', item: rawText });

                const hasText = rawText.length > 0;
                const scene: MultimodalScene = hasImages && hasText ? 'image_text_to_text_input'
                  : hasImages ? 'image_to_text_input'
                  : hasFiles && hasText ? 'file_text_to_text_input'
                  : 'file_to_text_input';

                const auditResult = await multimodalClient.checkMultimodalSecurity(
                  scene, mediaItems, sessionId, 1, qaid, 'multimodal_input_local',
                );

                logger.info('[Interceptor][多模态信安拦截] 多模态审核结果:', JSON.stringify({
                  scene, compliant: auditResult.compliant, degraded: auditResult.degraded ?? false,
                }));
                if (!auditResult.compliant) {
                  logger.info('[Interceptor][多模态信安拦截] 多模态审核不通过，拦截请求');
                  const blockedText = "<!--REDACT-->抱歉，这个问题我暂时无法解答，让我们换个话题吧~\n\n你可以试试让我帮你： 🔍 搜索与查询 · ✍️ 内容创作 · ⏰ 定时提醒 · ⚙️ 系统操作<!--/REDACT-->";
                  const sseChunk = JSON.stringify({
                    id: `blocked-multimodal-${Date.now()}`, object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000), model: 'content-security',
                    choices: [{ index: 0, delta: { role: 'assistant', content: blockedText }, finish_reason: 'stop' }],
                  });
                  const sseBody = `data: ${sseChunk}\n\ndata: [DONE]\n\n`;
                  ctx.shortCircuitResponse = new Response(new TextEncoder().encode(sseBody), {
                    status: 200, statusText: 'OK',
                    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
                  });
                  console.log(
                    `[qclaw-plugin:content-interceptor] [diag] SHORT_CIRCUIT multimodal_blocked sessionKey=${sessionKey}`,
                  );
                  return ctx;
                }
              }
            } catch (err) {
              logger.info('[Interceptor][多模态信安拦截] 多模态审核异常(降级放行):', String(err));
            }
          }
        }
      }

      // 将审核上下文传递给 onResponse
      ctx.extra._contentPlugin = {
        isLLMRequest,
        isMemoryCompactionRequest,
        sessionKey,
        turnKey,
        jsonBody,
        parentCtx,
        url,
        fetchStartTime: Date.now(),
        roundTraceId,
        query_scene: responseQueryScene,
        uid: getExternalUid() || '',
        guid: getExternalGuid() ?? '',
        runId: headerRunId || '',
        externalSessionKey,
        channelId,
        model: jsonBody?.model || '',
        commonReportParams: buildCommonReportParams(),
      };

      return ctx;
    },

    async onResponse(responseCtx: FetchResponseContext): Promise<Response> {
      const resp = responseCtx.response;
      const cpExtra = responseCtx.extra._contentPlugin as any;
      if (!cpExtra) return resp;

      const { isLLMRequest, isMemoryCompactionRequest, sessionKey, turnKey, parentCtx, url, fetchStartTime, roundTraceId, query_scene: cpQueryScene, model: cpModel, commonReportParams: cpCommonParams } = cpExtra;

      /**
       * 构建 onResponse 阶段 reportLog 的公共参数。
       * 在 onRequest 传递的 commonReportParams 基础上，追加 response 阶段共有字段。
       */
      const buildResponseReportParams = (extra: {
        logtype: string;
        opname: string;
        responseType: string;
        durationMs: number;
      }) => ({
        ...cpCommonParams,
        stage: 'llm_response',
        httpStatus: resp.status,
        ...extra,
      });

      if (isLLMRequest) {
        logInterceptorDebug("llm_response_received", {
          url, status: resp.status,
          contentType: resp.headers.get("content-type") ?? "",
          durationMs: Date.now() - fetchStartTime,
        });
      }

      if (!isLLMRequest || !resp.ok) {
        // ─── 上报非 LLM / 异常响应日志 ───
        if (isLLMRequest && !resp.ok) {
          const respContentLength = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
          reportLog({
            body: `llm_response_http_error status=${resp.status}`,
            errorType: `http_${resp.status}`,
            params: {
              ...buildResponseReportParams({
                logtype: 'LlmResponseHttpError',
                opname: 'llm_response_http_error',
                responseType: 'error',
                durationMs: Date.now() - fetchStartTime,
              }),
              httpStatusText: resp.statusText || '',
              responseContentLength: respContentLength,
            },
          });
        }
        return resp;
      }

      if (isSessionBlocked(sessionKey)) return resp;
      if (isMemoryCompactionRequest) return resp;

      const sessionId = getSessionId(sessionKey);
      const qaid = ensureQAIDForTurn(sessionKey, turnKey);

      const auditOutputSlices = async (
        assistantContent: string,
        source: string,
        finalSessionType: SessionType = SessionType.ANSWER_END,
      ): Promise<void> => {
        if (assistantContent.length === 0) {
          if (finalSessionType === SessionType.ANSWER_END) {
            interceptorState.outputAuditEndCount += 1;
          }
          await checkContentSecurity(
            null, client, "output",
            [{ Data: "", MediaType: "Text" }],
            sessionId, finalSessionType, source,
            enableLogging, "content-security", qaid, parentCtx, roundTraceId,
          );
          return;
        }

        const slices = sliceText(assistantContent, OUTPUT_MAX_LENGTH);
        for (let i = 0; i < slices.length; i++) {
          const isLastSlice = i === slices.length - 1;
          const sessionType = isLastSlice ? finalSessionType : SessionType.ANSWER;
          if (isLastSlice && finalSessionType === SessionType.ANSWER_END) {
            interceptorState.outputAuditEndCount += 1;
          }
          await checkContentSecurity(
            null, client, "output",
            [{ Data: slices[i], MediaType: "Text" }],
            sessionId, sessionType, source,
            enableLogging, "content-security", qaid, parentCtx, roundTraceId,
          );
        }
      };

      const contentType = resp.headers.get("content-type") || "";
      const isSSE = contentType.includes("text/event-stream");

      if (isSSE) {
        const body = resp.body;
        if (!body) return resp;

        const reader = body.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();

        let auditBuffer = "";
        let fullContent = "";
        let sliceIndex = 0;
        let lineBuf = "";
        let outputBlocked = false;
        let blockedReasonDetail: Record<string, unknown> = {};
        let blockedResponseSent = false;
        let receivedDone = false;
        let lastFinishReason: string | null = null;
        let pullCallCount = 0;
        let enqueuedChunkCount = 0;
        let sseErrorMessage: string | null = null;
        let auditCallCount = 0;
        let totalAuditMs = 0;
        const streamStartTime = performance.now();

        const parseDeltaContent = (line: string): string => {
          if (!line.startsWith("data:")) return "";
          const dataStr = line.slice(5).trim();
          if (dataStr === "[DONE]") { receivedDone = true; return ""; }
          try {
            const json = JSON.parse(dataStr);
            if (Array.isArray(json.choices) && json.choices.length > 0) {
              const delta = json.choices[0].delta;
              if (delta && typeof delta.content === "string") return delta.content;
            }
          } catch { /* 忽略 */ }
          return "";
        };

        const parseFinishReason = (line: string): string | null => {
          if (!line.startsWith("data:")) return null;
          const dataStr = line.slice(5).trim();
          if (dataStr === "[DONE]") return null;
          try {
            const json = JSON.parse(dataStr);
            if (Array.isArray(json.choices) && json.choices.length > 0) {
              const finishReason = json.choices[0]?.finish_reason;
              if (finishReason) return finishReason;
            }
            if (json.stopReason) return json.stopReason;
            if (json.stop_reason) return json.stop_reason;
            if (json.error) {
              if (typeof json.error.message === "string" && json.error.message.length > 0) {
                sseErrorMessage = json.error.message;
              }
              return "error";
            }
          } catch { /* 忽略 */ }
          return null;
        };

        const flushAuditBuffer = async (): Promise<void> => {
          while (auditBuffer.length >= OUTPUT_MAX_LENGTH) {
            const slice = auditBuffer.slice(0, OUTPUT_MAX_LENGTH);
            auditBuffer = auditBuffer.slice(OUTPUT_MAX_LENGTH);
            sliceIndex++;

            logInterceptorDebug("audit_output_slice_send", {
              sessionKey, qaid, sliceIndex, sliceLength: slice.length,
              contentPreview: slice.slice(0, 100), sessionType: "ANSWER",
            });

            const auditStart = performance.now();
            const result = await checkContentSecurity(
              null, client, "output",
              [{ Data: slice, MediaType: "Text" }],
              sessionId, SessionType.ANSWER, "llm_response_sse",
              enableLogging, "content-security", qaid, parentCtx, roundTraceId,
            );
            const auditMs = performance.now() - auditStart;
            auditCallCount++;
            totalAuditMs += auditMs;

            // [diag] 审核单次耗时超过 2s 时输出警告
            if (auditMs > 2000) {
              console.warn(
                `[qclaw-plugin:content-interceptor] [diag] AUDIT_SLOW sessionKey=${sessionKey}` +
                ` qaid=${qaid} sliceIndex=${sliceIndex} auditMs=${auditMs.toFixed(1)}` +
                ` sliceLen=${slice.length} degraded=${result.degraded ?? false}` +
                ` errorType=${result.errorType ?? ''}`,
              );
            }

            // logInterceptorDebug(result.degraded ? "audit_output_slice_result_degraded" : "audit_output_slice_result", {
            //   sessionKey, qaid, sliceIndex, blocked: result.blocked,
            //   resultCode: result.resultCode ?? "", resultType: result.resultType ?? "",
            //   level: result.level ?? "", degraded: result.degraded ?? false,
            //   errorType: result.errorType ?? "", traceId: result.traceId ?? "",
            //   requestId: result.requestId ?? "",
            // });

            if (result.blocked) {
              outputBlocked = true;
              blockedReasonDetail = {
                source: "audit_output_slice", sliceIndex,
                resultCode: result.resultCode ?? "", resultType: result.resultType ?? "",
                level: result.level ?? "", degraded: result.degraded ?? false,
                traceId: result.traceId ?? "", requestId: result.requestId ?? "",
              };
              addBlockedContent(slice);
              break;
            }
          }
        };

        const enqueueBlockedMarker = (controller: ReadableStreamDefaultController): void => {
          if (blockedResponseSent) return;
          blockedResponseSent = true;

          // [diag] 无条件输出拦截日志 — 排查工具调用不执行问题的关键决策点
          const _blockSrc = String(blockedReasonDetail.source ?? '');
          console.warn(
            `[qclaw-plugin:content-interceptor] [diag] OUTPUT_BLOCKED sessionKey=${sessionKey}` +
            ` qaid=${qaid} source=${_blockSrc}` +
            ` contentLen=${fullContent.length} auditCalls=${auditCallCount}` +
            ` totalAuditMs=${totalAuditMs.toFixed(1)}` +
            ` detail=${JSON.stringify(blockedReasonDetail)}`,
          );

          // 上报内容安全输出拦截 Trace
          const _blockErrorType = _blockSrc === 'llm_finish_reason' ? 'model_error' : 'security_block';
          const _blockErrorMsg = _blockSrc === 'llm_finish_reason'
            ? `output blocked by model: finish_reason=${String(blockedReasonDetail.finishReason ?? '')}`
            : `output blocked by content security: source=${_blockSrc}`;
          reportContentSecurityBlock("output", {
            sessionKey, qaid, parentCtx,
            blockSource: _blockSrc,
            errorType: _blockErrorType,
            errorMessage: _blockErrorMsg,
          });

          // ─── 上报 SSE 流被拦截日志 ───
          const blockedDurationMs = Date.now() - fetchStartTime;
          reportLog({
            body: `llm_response_sse_blocked source=${_blockSrc}`,
            errorType: _blockErrorType,
            params: {
              ...buildResponseReportParams({
                logtype: 'LlmResponseSseBlocked',
                opname: 'llm_response_sse_blocked',
                responseType: 'sse_blocked',
                durationMs: blockedDurationMs,
              }),
              contentLength: fullContent.length,
              blockSource: _blockSrc,
              blockErrorMessage: _blockErrorMsg,
            },
          });

          logInterceptorDebug("llm_response_stream_body", {
            url, totalLength: fullContent.length, blocked: true,
            blockedReasonDetail, content: fullContent,
          });

          const blockedReplyText = "<!--REDACT-->抱歉，这个问题我暂时无法解答，让我们换个话题吧~\n\n你可以试试让我帮你： 🔍 搜索与查询 · ✍️ 内容创作 · ⏰ 定时提醒 · ⚙️ 系统操作<!--/REDACT-->";
          const redactChunk = JSON.stringify({
            id: `output-blocked-${Date.now()}`, object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000), model: "content-security",
            choices: [{ index: 0, delta: { content: blockedReplyText }, finish_reason: "stop" }],
          });
          controller.enqueue(encoder.encode(`data: ${redactChunk}\n\n`));
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));

          try { controller.close(); } catch { /* 忽略 */ }
          try { reader.cancel(); } catch { /* 忽略 */ }

          (() => {
            const sourceMap: Record<string, string> = {
              audit_output_slice: "送审命中",
              llm_finish_reason: "LLM截断",
              external_blocked_response: "话术检测",
            };
            const src = String(blockedReasonDetail.source ?? "");
            const srcLabel = sourceMap[src] ?? src;
            let reasonSuffix = srcLabel;
            if (src === "audit_output_slice") {
              reasonSuffix = `${srcLabel} resultCode=${blockedReasonDetail.resultCode} resultType=${blockedReasonDetail.resultType} level=${blockedReasonDetail.level} slice#${blockedReasonDetail.sliceIndex}`;
            } else if (src === "llm_finish_reason") {
              reasonSuffix = `${srcLabel}(${blockedReasonDetail.finishReason})`;
            }
            const label = `→session 写入(输出拦截/REDACT) ⛔ ${reasonSuffix}`;
            writeSecurityLog(label, {
              url, sessionKey, qaid, blockedReasonDetail,
              llmOriginalLength: fullContent.length,
              llmOriginalPreview: fullContent.slice(0, 200),
              content: blockedReplyText,
            });
          })();
        };

        const transformedStream = new ReadableStream({
          start(_controller) { /* no-op */ },
          async pull(controller) {
            try {
              const { done, value } = await reader.read();

              if (done) {
                if (blockedResponseSent) return;

                const streamMs = (performance.now() - streamStartTime).toFixed(1);
                console.log(
                  `[qclaw-plugin:content-interceptor] [diag] SSE stream DONE sessionKey=${sessionKey}` +
                  ` pullCount=${pullCallCount} enqueuedChunks=${enqueuedChunkCount}` +
                  ` contentLen=${fullContent.length} auditCalls=${auditCallCount}` +
                  ` totalAuditMs=${totalAuditMs.toFixed(1)} streamMs=${streamMs}` +
                  ` lastFinishReason=${lastFinishReason} receivedDone=${receivedDone}` +
                  ` outputBlocked=${outputBlocked}`,
                );

                if (lineBuf.trim()) {
                  const content = parseDeltaContent(lineBuf);
                  if (content) { auditBuffer += content; fullContent += content; }
                }

                sliceIndex++;

                if (!outputBlocked && !receivedDone && lastFinishReason === null && auditBuffer.length > 0) {
                  outputBlocked = true;
                  addBlockedContent(auditBuffer);
                  enqueueBlockedMarker(controller);
                  return;
                }

                if (!outputBlocked && isExternalBlockedResponse(auditBuffer)) {
                  outputBlocked = true;
                  enqueueBlockedMarker(controller);
                  return;
                }
                if (outputBlocked) {
                  enqueueBlockedMarker(controller);
                  return;
                }

                logInterceptorDebug("llm_response_stream_body", {
                  url, totalLength: fullContent.length, content: fullContent,
                });

                // ─── 上报 SSE 流正常响应日志 ───
                const sseDurationMs = Date.now() - fetchStartTime;
                reportLog({
                  body: `llm_response_ok model=${cpModel || ''}`,
                  params: {
                    ...buildResponseReportParams({
                      logtype: 'LlmResponseOK',
                      opname: 'llm_response_ok',
                      responseType: 'sse',
                      durationMs: sseDurationMs,
                    }),
                    contentLength: fullContent.length,
                    lastFinishReason: lastFinishReason || '',
                  },
                });

                controller.close();

                setTimeout(() => {
                  const isIntermediateRound = lastFinishReason === "tool_calls";
                  const auditSessionType = isIntermediateRound ? SessionType.ANSWER : SessionType.ANSWER_END;
                  if (!isIntermediateRound) interceptorState.outputAuditEndCount += 1;

                  // logInterceptorDebug("audit_output_end_send", {
                  //   sessionKey, qaid, bufferLength: auditBuffer.length,
                  //   contentPreview: auditBuffer.slice(0, 200),
                  //   sessionType: isIntermediateRound ? "ANSWER" : "ANSWER_END",
                  //   lastFinishReason,
                  // });

                  checkContentSecurity(
                    null, client, "output",
                    [{ Data: auditBuffer, MediaType: "Text" }],
                    sessionId, auditSessionType, "llm_response_sse",
                    enableLogging, "content-security", qaid, parentCtx, roundTraceId,
                    { query_scene: cpQueryScene ?? QueryScene.OTHERS },
                  ).then((endResult) => {
                    logInterceptorDebug(endResult.degraded ? "audit_output_end_result_degraded" : "audit_output_end_result", {
                      sessionKey, qaid, blocked: endResult.blocked,
                      resultCode: endResult.resultCode ?? "", resultType: endResult.resultType ?? "",
                      level: endResult.level ?? "", degraded: endResult.degraded ?? false,
                      errorType: endResult.errorType ?? "", traceId: endResult.traceId ?? "",
                      requestId: endResult.requestId ?? "",
                    });
                    if (endResult.blocked) addBlockedContent(auditBuffer);
                  }).catch(() => { /* 忽略 */ });
                }, 0);

                return;
              }

              if (outputBlocked) return;

              lineBuf += decoder.decode(value, { stream: true });
              const lines = lineBuf.split("\n");
              lineBuf = lines.pop() || "";

              const safeLines: string[] = [];
              let hitError = false;

              for (const line of lines) {
                const finishReason = parseFinishReason(line);
                if (finishReason && finishReason !== "content_filter" && finishReason !== "error") {
                  lastFinishReason = finishReason;
                }
                if (finishReason === "content_filter" || finishReason === "sensitive" || finishReason === "error") {
                  if (finishReason === "error" && sseErrorMessage) {
                    hitError = true;
                    break;
                  }
                  outputBlocked = true;
                  blockedReasonDetail = { source: "llm_finish_reason", finishReason };
                  addBlockedContent(auditBuffer);
                  enqueueBlockedMarker(controller);
                  return;
                }
                const content = parseDeltaContent(line);
                if (content) { auditBuffer += content; fullContent += content; }
                safeLines.push(line);
              }

              if (hitError) {
              // ─── 上报 SSE 流模型错误日志 ───
              const sseErrDurationMs = Date.now() - fetchStartTime;
              reportLog({
                body: `llm_response_sse_error sse_error_message`,
                errorType: 'sse_model_error',
                params: {
                  ...buildResponseReportParams({
                    logtype: 'LlmResponseSseError',
                    opname: 'llm_response_sse_error',
                    responseType: 'sse_error',
                    durationMs: sseErrDurationMs,
                  }),
                  contentLength: fullContent.length,
                  sseErrorMessage: sseErrorMessage || '',
                },
              });
                const encoder2 = new TextEncoder();
                const errChunk = JSON.stringify({
                  id: `error-${Date.now()}`, object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000), model: "content-security",
                  choices: [{ index: 0, delta: { role: "assistant", content: sseErrorMessage }, finish_reason: "stop" }],
                });
                controller.enqueue(encoder2.encode(`data: ${errChunk}\n\n`));
                controller.enqueue(encoder2.encode(`data: [DONE]\n\n`));
                try { controller.close(); } catch { /* 忽略 */ }
                try { reader.cancel(); } catch { /* 忽略 */ }
                return;
              }

              pullCallCount++;
              if (isExternalBlockedResponse(auditBuffer)) {
                outputBlocked = true;
                blockedReasonDetail = { source: "external_blocked_response", auditBufferPreview: auditBuffer.slice(0, 100) };
                addBlockedContent(auditBuffer);
                enqueueBlockedMarker(controller);
                return;
              }

              if (safeLines.length > 0) {
                const safeChunk = safeLines.join("\n") + "\n";
                enqueuedChunkCount++;
                controller.enqueue(encoder.encode(safeChunk));
              }

              await flushAuditBuffer();

              if (outputBlocked) {
                enqueueBlockedMarker(controller);
                return;
              }
            } catch (e) {
              const streamMs = (performance.now() - streamStartTime).toFixed(1);
              console.error(
                `[qclaw-plugin:content-interceptor] [diag] SSE stream ERROR sessionKey=${sessionKey}` +
                ` pullCount=${pullCallCount} contentLen=${fullContent.length}` +
                ` streamMs=${streamMs} error=${e instanceof Error ? e.message : String(e)}`,
              );
              logInterceptorDebug("llm_response_stream_error", {
                url, error: String(e), fullContentLength: fullContent.length,
              });
              // ─── 上报 SSE 流读取异常日志 ───
              const streamErrDurationMs = Date.now() - fetchStartTime;
              reportLog({
                body: `llm_sse_exception stream_exception`,
                errorType: 'sse_stream_exception',
                params: {
                  ...buildResponseReportParams({
                    logtype: 'LlmSseException',
                    opname: 'llm_sse_exception',
                    responseType: 'sse_exception',
                    durationMs: streamErrDurationMs,
                  }),
                  contentLength: fullContent.length,
                  errorMessage: String(e),
                },
              });
              controller.close();
            }
          },
        });

        return new Response(transformedStream, {
          status: resp.status,
          statusText: resp.statusText,
          headers: resp.headers,
        });
      } else {
        // JSON 响应审核
        const clonedResp = resp.clone();
        try {
          const respBody = await clonedResp.json();

          logInterceptorDebug("llm_response_json", {
            url, stopReason: respBody?.stopReason ?? respBody?.stop_reason ?? "",
            hasChoices: Array.isArray(respBody?.choices),
            choiceCount: Array.isArray(respBody?.choices) ? respBody.choices.length : 0,
          });

          if (respBody?.stopReason === "error" || respBody?.stop_reason === "error") {
            const errorMessage: string | undefined = respBody?.errorMessage;
            const enc = new TextEncoder();

            if (errorMessage) {
              // ─── 上报 JSON 响应模型错误(有 errorMessage)日志 ───
              const jsonErrMsgDurationMs = Date.now() - fetchStartTime;
              const jsonErrBodyStr = JSON.stringify(respBody);
              reportLog({
                body: `llm_model_response_error model_error_message`,
                errorType: 'json_model_error',
                params: {
                  ...buildResponseReportParams({
                    logtype: 'LlmModelResponseError',
                    opname: 'llm_model_response_error',
                    responseType: 'json_error',
                    durationMs: jsonErrMsgDurationMs,
                  }),
                  errorMessage: errorMessage || '',
                  stopReason: respBody?.stopReason || respBody?.stop_reason || '',
                  responseBodyLength: jsonErrBodyStr.length,
                },
              });
              const sseChunk = JSON.stringify({
                id: `error-${Date.now()}`, object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000), model: "content-security",
                choices: [{ index: 0, delta: { role: "assistant", content: errorMessage }, finish_reason: "stop" }],
              });
              const sseBody = `data: ${sseChunk}\n\ndata: [DONE]\n\n`;
              return new Response(enc.encode(sseBody), {
                status: 200, statusText: "OK",
                headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
              });
            }

            const jsonBlockedBodyStr = JSON.stringify(respBody);
            addBlockedContent(jsonBlockedBodyStr);

            // ─── 上报 JSON 响应被拦截日志 ───
            const jsonBlockedDurationMs = Date.now() - fetchStartTime;
            reportLog({
              body: `llm_response_blocked json_stopReason_error`,
              errorType: 'model_error',
              params: {
                ...buildResponseReportParams({
                  logtype: 'LlmResponseBlocked',
                  opname: 'llm_response_blocked',
                  responseType: 'json_blocked',
                  durationMs: jsonBlockedDurationMs,
                }),
                blockSource: 'llm_output_error',
                stopReason: respBody?.stopReason || respBody?.stop_reason || '',
                responseBodyLength: jsonBlockedBodyStr.length,
              },
            });

            // 上报内容安全输出拦截 Trace（JSON 响应 stopReason=error）
            reportContentSecurityBlock("output", {
              sessionKey, qaid, parentCtx,
              blockSource: "llm_output_error",
              errorType: "model_error",
              errorMessage: "output blocked by model: stopReason=error",
            });

            const blockedReplyText = "<!--REDACT-->抱歉，这个问题我暂时无法解答，让我们换个话题吧~\n\n你可以试试让我帮你： 🔍 搜索与查询 · ✍️ 内容创作 · ⏰ 定时提醒 · ⚙️ 系统操作<!--/REDACT-->";
            const sseChunk = JSON.stringify({
              id: `blocked-${Date.now()}`, object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000), model: "content-security",
              choices: [{ index: 0, delta: { role: "assistant", content: blockedReplyText }, finish_reason: "llm_output_error" }],
            });
            const sseBody = `data: ${sseChunk}\n\ndata: [DONE]\n\n`;
            return new Response(enc.encode(sseBody), {
              status: 200, statusText: "OK",
              headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
            });
          }

          const assistantContent = extractAssistantContent(respBody);
          logInterceptorDebug("audit_output_json_send", {
            sessionKey, qaid, contentLength: assistantContent.length,
            contentPreview: assistantContent.slice(0, 200),
          });

          // ─── 上报 JSON 响应正常日志 ───
          const jsonOkDurationMs = Date.now() - fetchStartTime;
          const jsonOkBodyStr = JSON.stringify(respBody);
          reportLog({
            body: `llm_response_ok model=${cpModel || ''}`,
            params: {
              ...buildResponseReportParams({
                logtype: 'LlmResponse',
                opname: 'llm_response_ok',
                responseType: 'json',
                durationMs: jsonOkDurationMs,
              }),
              contentLength: assistantContent.length,
              responseBodyLength: jsonOkBodyStr.length,
            },
          });

          auditOutputSlices(assistantContent, "llm_response_json").catch(() => { /* 忽略 */ });
        } catch { /* JSON 解析失败忽略 */ }
      }

      return resp;
    },
  };
}

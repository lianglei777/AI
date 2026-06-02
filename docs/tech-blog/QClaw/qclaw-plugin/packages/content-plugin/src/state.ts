/**
 * 全局状态管理模块
 *
 * 存储从 report.data 接收到的外部 traceId 和 guid。
 * 单独拆分到独立模块避免循环依赖。
 */
import type { Context } from "@opentelemetry/api";
import crypto from "node:crypto";


/** 从 report.data 接收的外部 traceId，用于链路追踪（同一轮调用共享） */
let externalTraceId: string | null = null;
/** 从 report.data 接收的 guid，作为上报维度字段 */
let externalGuid: string | null = null;
/** 从 report.data 接收的 uid，作为上报维度字段 */
let externalUid: string | null = null;
/** 从 report.data 接收的 app_version，作为上报维度字段 */
let externalAppVersion: string | null = null;
/** 从 report.data 接收的 source_terminal，标识请求来源终端（wechat / client 等） */
let externalSourceTerminal: string | null = null;
/** 从 report.data 接收的 prompt_id（AGP 会话的 prompt 标识） */
let externalPromptId: string | null = null;
/** 从 report.data 接收的 wechat_session_id（AGP 会话的 session 标识） */
let externalWechatSessionId: string | null = null;
/** 从 api.runtime.version 获取的 openclaw 版本号 */
let openclawVersion: string | null = null;

/** 从 report.data 接收的 idempotencyKey，用于关联客户端发送的 runId */
let externalIdempotencyKey: string | null = null;
/** 从 report.data 接收的 session_key（会话 ID） */
let externalSessionKey: string | null = null;
/** 从 report.data 接收的 app_version */
let qclawVersion: string | null = null;


/** 设置外部 traceId */
export const setExternalTraceId = (traceId: string): void => {
  externalTraceId = traceId;
};

/** 获取当前外部 traceId */
export const getExternalTraceId = (): string | null => externalTraceId;

/** 设置外部 guid */
export const setExternalGuid = (guid: string): void => {
  externalGuid = guid;
};

/** 获取当前外部 guid */
export const getExternalGuid = (): string | null => externalGuid;

/** 设置外部 uid */
export const setExternalUid = (uid: string): void => {
  externalUid = uid;
};

/** 获取当前外部 uid */
export const getExternalUid = (): string | null => externalUid;

/** 设置外部 appVersion */
export const setExternalAppVersion = (appVersion: string): void => {
  externalAppVersion = appVersion;
};

/** 获取当前外部 appVersion */
export const getExternalAppVersion = (): string | null => externalAppVersion;

/** 设置外部 sourceTerminal */
export const setExternalSourceTerminal = (sourceTerminal: string): void => {
  externalSourceTerminal = sourceTerminal;
};

/** 获取当前外部 sourceTerminal */
export const getExternalSourceTerminal = (): string | null => externalSourceTerminal;

/** 设置外部 promptId（AGP prompt_id） */
export const setExternalPromptId = (promptId: string): void => {
  externalPromptId = promptId;
};

/** 获取当前外部 promptId（仅 wechat 来源时返回，桌面端返回 null） */
export const getExternalPromptId = (): string | null =>
  externalSourceTerminal === "wechat" ? externalPromptId : null;

/** 设置外部 wechatSessionId（AGP session_id） */
export const setExternalWechatSessionId = (sessionId: string): void => {
  externalWechatSessionId = sessionId;
};

/** 获取当前外部 wechatSessionId（仅 wechat 来源时返回，桌面端返回 null） */
export const getExternalWechatSessionId = (): string | null =>
  externalSourceTerminal === "wechat" ? externalWechatSessionId : null;

/**
 * 当前会话的"使用灵感"标签。
 * 从用户输入中匹配 ¥¥{内容}¥¥ 提取而来，在 before_agent_start 中设置，agent_end 中清除。
 */
let currentInspirationTag: string | null = null;

/** 从用户输入文本中提取 ¥¥{内容}¥¥ 中间的灵感标签 */
export const extractInspirationTag = (prompt: string): string | null => {
  // 匹配 ¥¥ 或 ￥￥ 包裹的内容（兼容半角 ¥ 和全角 ￥）
  const match = prompt.match(/[¥￥]{2}(.+?)[¥￥]{2}/);
  return match?.[1]?.trim() || null;
};

/** 设置外部 idempotencyKey */
export const setExternalIdempotencyKey = (idempotencyKey: string): void => {
  externalIdempotencyKey = idempotencyKey;
};

/** 设置当前 qclaw 的 version */
export const setQClawAppVersion = (version: string): void => {
  qclawVersion = version;
};

/** 设置外部 sessionId */
export const setExternalSessionKey = (sessionId: string): void => {
  externalSessionKey = sessionId;
};

/** 获取当前外部 idempotencyKey */
export const getExternalIdempotencyKey = (): string | null => externalIdempotencyKey;

/** 获取当前外部 idempotencyKey */
export const getQClawAppVersion = (): string | null => qclawVersion;



/** 获取当前外部 sessionId */
export const getExternalSessionKey = (): string | null => externalSessionKey;

/** 设置当前灵感标签 */
export const setCurrentInspirationTag = (tag: string | null): void => {
  currentInspirationTag = tag;
};

/** 获取当前灵感标签 */
export const getCurrentInspirationTag = (): string | null => currentInspirationTag;

/** 设置 openclaw 版本号（从 api.runtime.version 获取） */
export const setOpenclawVersion = (version: string): void => {
  openclawVersion = version;
};

/** 获取 openclaw 版本号 */
export const getOpenclawVersion = (): string | null => openclawVersion;

interface LlmAuditContext {
  sessionKey: string;
  turnKey: string;
}

let currentLlmAuditContext: LlmAuditContext | null = null;
const pendingLlmAuditContexts: LlmAuditContext[] = [];

export const setCurrentLlmAuditContext = (sessionKey: string, turnKey: string): void => {
  pendingLlmAuditContexts.push({ sessionKey, turnKey });
};

export const getCurrentLlmAuditContext = (): LlmAuditContext | null => {
  const next = pendingLlmAuditContexts.shift();
  if (next) {
    currentLlmAuditContext = next;
  }
  return currentLlmAuditContext;
};

export const clearCurrentLlmAuditContext = (turnKey?: string): void => {
  if (!turnKey) {
    currentLlmAuditContext = null;
    pendingLlmAuditContexts.length = 0;
    return;
  }

  if (currentLlmAuditContext?.turnKey === turnKey) {
    currentLlmAuditContext = null;
  }

  for (let i = pendingLlmAuditContexts.length - 1; i >= 0; i--) {
    if (pendingLlmAuditContexts[i].turnKey === turnKey) {
      pendingLlmAuditContexts.splice(i, 1);
    }
  }
};

/**
 * 当前活跃的 agent span context。
 * 用于 fetch 拦截器中的安全审核 span 挂载到 agent 链路上，
 * 避免 interceptor 中创建的 content_security_check span 成为孤立的 root span。
 *
 * 由 before_agent_start 设置，agent_end 清除。
 */
let currentAgentCtx: Context | null = null;

/**
 * 当前活跃的 agent span 的 spanId。
 * 用于 fetch 拦截器生成 traceparent 时，将随机 parent-id 替换为当前 span 的 spanId，
 * 使下游服务能通过 traceparent 关联到当前 agent 链路。
 *
 * 由 before_agent_start 设置，agent_end 清除。
 */
let currentAgentSpanId: string | null = null;

/** 设置当前 agent span context（在 before_agent_start 中调用） */
export const setCurrentAgentCtx = (ctx: Context): void => {
  currentAgentCtx = ctx;
};

/** 获取当前 agent span context（供 interceptor 中的审核 span 作为 parent） */
export const getCurrentAgentCtx = (): Context | null => currentAgentCtx;

/** 设置当前 agent span 的 spanId（在 before_agent_start 中调用） */
export const setCurrentAgentSpanId = (spanId: string): void => {
  currentAgentSpanId = spanId;
};

/** 获取当前 agent span 的 spanId（供 interceptor 生成 traceparent 时作为 parent-id） */
export const getCurrentAgentSpanId = (): string | null => currentAgentSpanId;

/** 清除当前 agent span context 和 spanId（在 agent_end 中调用） */
export const clearCurrentAgentCtx = (): void => {
  currentAgentCtx = null;
  currentAgentSpanId = null;
};

/**
 * 延迟创建 chat span 的回调。
 *
 * 为保证 trace 上报时序呈现 security:llm_request → chat → security:llm_response_stream，
 * llm_input 中不再立即创建 chat span，而是暂存一个回调函数。
 * fetch 拦截器在 security:llm_request 审核通过后调用此回调创建 chat span，
 * 从而确保 chat span 的 start time 晚于 security:llm_request 的 end time。
 *
 * 由 llm_input 设置，fetch 拦截器消费后自动清除。
 */
let pendingChatSpanCallback: (() => void) | null = null;

/** 设置延迟创建 chat span 的回调（在 llm_input 中调用） */
export const setPendingChatSpanCallback = (cb: () => void): void => {
  pendingChatSpanCallback = cb;
};

/**
 * 消费并执行延迟创建 chat span 的回调（在 fetch 拦截器中审核通过后调用）。
 * 调用后自动清除回调，避免重复执行。
 */
export const consumePendingChatSpanCallback = (): void => {
  if (pendingChatSpanCallback) {
    pendingChatSpanCallback();
    pendingChatSpanCallback = null;
  }
};

/** 清除延迟创建 chat span 的回调（在 llm_output 中兜底调用，防止泄漏） */
export const clearPendingChatSpanCallback = (): void => {
  pendingChatSpanCallback = null;
};

// ============================================================================
// runId → traceId 映射（替代全局 externalTraceId，解决多通路并发串链）
// ============================================================================

/**
 * 内联的 traceId 生成逻辑（与 utils.ts generateTraceId 保持一致）。
 * 在 state.ts 中内联而非从 utils.ts 导入，以避免循环依赖。
 * 格式: 13位随机hex + "af" + 17位时间戳(yyyyMMddHHmmssSSS) = 32位
 */
const inlineGenerateTraceId = (): string => {
  const hex13 = crypto.randomBytes(7).toString("hex").slice(0, 13);
  const now = new Date();
  const pad = (n: number): string => (n < 10 ? "0" + n : n.toString());
  const ts =
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds()) +
    now.getMilliseconds().toString().padStart(3, "0");
  return `${hex13}af${ts}`;
};

/** 以 runId 为 key，缓存该次运行的 traceId */
const runTraceIdMap = new Map<string, string>();

/**
 * 获取或创建指定 runId 对应的 traceId。
 * - 已缓存：直接返回（保证同一 run 内连贯）
 * - 未缓存：生成新值并缓存（保证格式合规 13hex+af+ts）
 */
export const getOrCreateTraceIdForRun = (runId: string): string => {
  if(runId && runId.startsWith('run-')) {
    return inlineGenerateTraceId();
  }
  return runId || inlineGenerateTraceId();
  // const existing = runTraceIdMap.get(runId);
  // if (existing) return existing;
  // const newTraceId = inlineGenerateTraceId();
  // runTraceIdMap.set(runId, newTraceId);
  // return newTraceId;
};

/** 清理指定 runId 的 traceId 缓存（agent_end 时调用） */
export const clearTraceIdForRun = (runId: string): void => {
  runTraceIdMap.delete(runId);
};

// ─── activeRunId（当前活跃的 agent runId，供 CustomIdGenerator 使用）───

/**
 * 当前活跃的 agent run 的 runId。
 * 由 before_agent_start 设置，agent_end 清除。
 * CustomIdGenerator.generateTraceId() 通过此变量获取当前 runId，
 * 从而从 runTraceIdMap 中取得一致的 traceId。
 */
let activeRunId: string | null = null;

/** 设置当前活跃 runId（在 before_agent_start 中调用） */
export const setActiveRunId = (runId: string): void => {
  activeRunId = runId;
};

/** 获取当前活跃 runId（供 CustomIdGenerator 使用） */
export const getActiveRunId = (): string | null => activeRunId;

/** 清除当前活跃 runId（在 agent_end 中调用） */
export const clearActiveRunId = (): void => {
  activeRunId = null;
};

// ─── Session Trigger 缓存（供 query scene 识别 heartbeat）───

/**
 * sessionKey → trigger 映射。
 * 由 before_agent_start 保存 hookCtx.trigger（如 "heartbeat"、"user"、"cron" 等），
 * 供后续 hook（llm_input/llm_output/tool_call/agent_end）中 resolveQueryScene 使用。
 * 在 agent_end 中清理。
 */
const sessionTriggerMap = new Map<string, string>();

/** 设置当前 session 的 trigger（在 before_agent_start 中调用） */
export const setSessionTrigger = (sessionKey: string, trigger: string): void => {
  sessionTriggerMap.set(sessionKey, trigger);
};

/** 获取当前 session 的 trigger */
export const getSessionTrigger = (sessionKey: string): string | undefined => {
  return sessionTriggerMap.get(sessionKey);
};

/** 清除 session 的 trigger（在 agent_end 中调用） */
export const clearSessionTrigger = (sessionKey: string): void => {
  sessionTriggerMap.delete(sessionKey);
};

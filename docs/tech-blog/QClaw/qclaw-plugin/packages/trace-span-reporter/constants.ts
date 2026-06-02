/**
 * trace-span-reporter — 常量定义
 *
 * ELECTRON 主题 Token、Span 名称、超时配置等。
 */

// ==================== 上报 Token ====================

/**
 * Electron 主进程使用的伽利略上报 Token
 *
 * 与 packages/report/src/galileo/constants.ts 中的 ELECTRON_REPORT_TOKEN 一致。
 * 注意：qclaw-plugin 内部的 ELECTRON_REPORT_TOKEN 实际上是 CLIENT token（SDK-034b...），
 * 这里使用的才是真正的 Electron 主进程 token，确保 trace span 上报到与 gateway_* span 同一主题。
 */
export const TRACE_REPORT_TOKEN = 'SDK-ce69a98f7b7420f02ae8'

// ==================== Span 名称 ====================

/**
 * 与 packages/shared/src/trace/types.ts 中的 AGENT_SPANS 常量保持一致
 */
export const SPAN_NAMES = {
  /** 完整 Agent 执行周期（可包含多轮 turn） */
  AGENT_LOOP: 'agent_loop',
  /** 单轮 Agent 执行（LLM 调用 + 可能的工具执行） */
  AGENT_TURN: 'agent_turn',
  /** Plugin 侧 LLM HTTP 请求 */
  LLM_REQUEST: 'agent_llm_request',
  /** 单个工具执行 */
  TOOL_EXECUTION: 'agent_tool_execution',
  /** 消息接收（用户发送 → OpenClaw 收到） */
  MESSAGE_RECEIVE: 'agent_message_receive',
} as const

// ==================== 上报事件名 ====================

/** 上报事件名（与 safeReportSpan 中的 'trace_span' 保持一致） */
export const TRACE_EVENT_NAME = 'trace_span'

// ==================== 超时与清理 ====================

/** RunState 最大存活时间（毫秒），超时后自动清理防止泄漏 */
export const RUN_STATE_TTL_MS = 10 * 60 * 1000

/** RunState 清理检查间隔（毫秒） */
export const RUN_STATE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000

/** 单次 Run 中允许收集的最大 Span 数量，超限后不再追加（防止极端场景内存膨胀） */
export const MAX_SPANS_PER_RUN = 500

/**
 * agent_end 后等待 llm_output 的最大时间（毫秒）。
 * 超时后直接上报（最后一轮 llm_request span 不含 usage 数据）。
 * OpenClaw 引擎中 agent_end 和 llm_output 在同一微任务链中按顺序触发（中间仅隔 finally 块），
 * 通常间隔 < 10ms，200ms 已留有极大余量。
 */
export const AGENT_END_REPORT_DELAY_MS = 200

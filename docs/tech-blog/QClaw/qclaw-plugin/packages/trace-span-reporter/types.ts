/**
 * trace-span-reporter — 内部状态类型定义
 *
 * RunState / TurnState / PendingToolCall / SpanData 等核心类型。
 */

// ==================== Span 数据 ====================

/**
 * 已完成的 Span 数据（对齐 SpanRecord 结构，省略 common 字段由上报时填充）
 */
export interface SpanData {
  span_id: string
  parent_span_id: string | null
  span_name: string

  start_time: number
  end_time: number
  duration_ms: number

  status: 'ok' | 'error'
  status_message?: string
  finish_reason?: 'complete' | 'cancelled' | 'error'

  // ---- 错误分类 (顶层字段，便于 Galileo GROUP BY 聚合统计) ----
  error_type?: string
  error_code?: string
  error_source?: string

  attributes: Record<string, string | number | boolean>

  /** 工具名称（agent_tool_execution 填充） */
  tool_name?: string

  /** 轮次索引（0-based，agent_llm_request / agent_tool_execution 填充） */
  turn_index?: number

  // ---- 顶层聚合字段（Phase 5.1 字段标准化） ----
  /** 模型名称（agent_loop / agent_llm_request 填充） */
  model?: string
  /** 模型提供商（agent_loop / agent_llm_request 填充） */
  model_provider?: string
  /** 触发来源（agent_loop 填充）：user / heartbeat / cron / memory */
  trigger?: string

  /** 输入 token 总量（顶层字段，仅 agent_loop span 使用） */
  input_tokens?: number
  /** 输出 token 总量 */
  output_tokens?: number
  /** 总 token */
  total_tokens?: number

  /** agent_request_id（当前 turn 的 llmRequestSpanId，与 x-agent-request-id header 一致） */
  agent_request_id?: string

  error?: {
    type: string
    code?: string
    message: string
  }
}

// ==================== 待完成的工具调用 ====================

export interface PendingToolCall {
  spanId: string
  toolName: string
  startTime: number
  toolCallId?: string
}

// ==================== Turn 状态 ====================

export interface TurnState {
  turnSpanId: string
  turnStartTime: number
  turnNumber: number

  /** LLM 请求 span ID（llm_input 或 after_tool_call 时生成） */
  llmRequestSpanId: string | null
  /** LLM 请求开始时间 */
  llmRequestStartTime: number | null

  /** 待完成的工具调用（keyed by toolCallId 或 toolName + startTime） */
  pendingTools: Map<string, PendingToolCall>
  /** 已完成的工具数量 */
  completedToolCount: number
}

// ==================== Run 状态 ====================

export interface RunState {
  // ---- 标识（来自 hook ctx） ----
  runId: string              // = trace_id
  sessionKey: string
  agentId: string
  sessionId: string
  trigger?: string           // "user" | "heartbeat" | "cron" | "memory"
  /** 消息来源渠道（如 "openclaw-weixin", "telegram" 等） */
  senderChannelId?: string
  /** 原始消息 ID（来自 message_received hook，用于关联 agent_message_receive span） */
  messageId?: string

  // ---- agent_loop span ----
  agentRunSpanId: string
  agentRunStartTime: number

  // ---- LLM 信息（Run 级别，llm_input 只触发一次所以放在 Run 上） ----
  llmProvider?: string
  llmModel?: string
  /** llm_output 汇总的 usage 数据（整个 run 的累计，NormalizedUsage 格式） */
  llmUsage?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    total?: number
  }

  // ---- turn 跟踪 ----
  currentTurn: TurnState | null
  turnCount: number

  // ---- 已收集的 span 列表 ----
  spans: SpanData[]

  // ---- 延迟上报（解决 agent_end 先于 llm_output 的时序问题） ----
  /** agent_end 已到达但尚未上报（等待 llm_output 补全 usage 数据） */
  ended: boolean
  /** agent_end 缓存的事件数据 */
  endEvent?: {
    success: boolean
    error?: string
    durationMs?: number
    endTime: number
  }
  /** 延迟上报安全定时器（防止 llm_output 永远不来） */
  endTimer?: ReturnType<typeof setTimeout>

  // ---- 创建时间（用于 TTL 清理） ----
  createdAt: number
}

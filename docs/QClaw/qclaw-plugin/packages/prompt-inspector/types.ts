/**
 * packages/prompt-inspector/types.ts — Prompt Inspector 核心数据模型（Phase 4）
 *
 * 定义 Prompt Inspector 的 Run 级别数据类型：
 * - RunEvent: Run 内的单个事件（prompt_build / llm_call / llm_response / tool_call 等）
 * - HookAuditEntry: Prompt 修改链审计日志（记录每个插件对 prompt 的修改）
 * - FetchAuditEntry: Response 修改链审计日志（记录每个 FetchMiddleware 对 response 的修改）
 * - RunRecord: 一次完整 agent 执行的记录
 * - RunSummary: Run 摘要（用于列表展示）
 *
 * 这些类型是 OpenClaw 端采集、Electron 端传输、UI 端展示的共享契约。
 */

// ----------------------------------------------------------------------------
// F201: RunEvent 基础类型
// ----------------------------------------------------------------------------

/** Run 事件类型枚举 */
export type RunEventType =
  | 'prompt_build'
  | 'llm_call'
  | 'llm_response'
  | 'tool_call'
  | 'tool_result'
  | 'subagent_spawn'
  | 'subagent_end'
  | 'agent_end'

/** 所有 RunEvent 的基础接口 */
export interface RunEventBase {
  /** 事件类型 */
  type: RunEventType
  /** 事件时间戳（毫秒） */
  timestamp: number
}

/**
 * Hook 审计日志条目 — 记录某个插件对 prompt 的修改
 * 来自 HookProxy 的 before_prompt_build 审计
 */
export interface HookAuditEntry {
  /** 插件包 ID（如 "content-plugin"） */
  packageId: string
  /** hook 优先级 */
  priority: number
  /** 修改内容（只记录非空字段） */
  mutations: {
    /** 追加到 system context 的内容 */
    appendSystemContext?: string
    /** 前置到 user context 的内容 */
    prependContext?: string
    /** 前置到 system context 的内容 */
    prependSystemContext?: string
    /** 替换整个 system prompt 的内容 */
    systemPrompt?: string
  }
}

/**
 * FetchMiddleware 审计日志条目 — 记录某个 middleware 对 response 的修改
 * 来自 FetchChain 的 onResponse 审计
 */
export interface FetchAuditEntry {
  /** middleware ID（如 "content-interceptor"） */
  middlewareId: string
  /** middleware 优先级 */
  priority: number
  /** 是否修改了 response */
  modified: boolean
  /** 操作类型 */
  action: 'pass' | 'transform' | 'block'
  /** 操作详情（如 block 原因或 transform 描述） */
  detail?: string
}

/** Prompt 构建事件 — 记录 prompt 从用户输入到最终发送给 LLM 的完整修改链 */
export interface PromptBuildEvent extends RunEventBase {
  type: 'prompt_build'
  /** 基础 system prompt（未经插件修改） */
  baseSystemPrompt: string
  /** 插件修改审计日志（Prompt 修改链） */
  hookAuditEntries: HookAuditEntry[]
  /** 最终 system prompt（经过所有插件修改后） */
  finalSystemPrompt: string
  /** 原始用户输入 */
  userPrompt: string
  /** 最终 effective prompt（经过 prependContext 合并后） */
  effectivePrompt: string
}

/** LLM 调用事件 — 记录发送给 LLM 的请求 */
export interface LlmCallEvent extends RunEventBase {
  type: 'llm_call'
  /** 模型名 */
  model: string
  /** 模型提供商 */
  provider: string
  /** 完整的 messages 数组 */
  messages: unknown[]
  /** LLM API URL */
  fetchUrl?: string
  /** 请求参数 */
  requestParams?: {
    temperature?: number
    max_tokens?: number
    stream?: boolean
    [key: string]: unknown
  }
}

/** LLM 响应事件 — 记录 LLM 返回到最终呈现给用户的完整修改链 */
export interface LlmResponseEvent extends RunEventBase {
  type: 'llm_response'
  /** 模型名 */
  model: string
  /** 响应耗时（毫秒） */
  responseTime?: number
  /** Token 统计 */
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheRead?: number
    cacheWrite?: number
    total: number
  }
  /** LLM 原始响应内容（未经 FetchMiddleware 修改） */
  rawAssistantContent: string | unknown[]
  /** 经过 FetchMiddleware 修改后的最终内容 */
  finalAssistantContent: string | unknown[]
  /** FetchMiddleware 修改审计日志（Response 修改链） */
  fetchAuditEntries: FetchAuditEntry[]
  /** 结束原因 */
  finishReason?: string
}

// ----------------------------------------------------------------------------
// F202: Tool/SubAgent/AgentEnd 事件类型
// ----------------------------------------------------------------------------

/** 工具调用事件 */
export interface ToolCallEvent extends RunEventBase {
  type: 'tool_call'
  /** 工具名称 */
  toolName: string
  /** 工具输入参数 */
  toolInput: Record<string, unknown>
}

/** 工具结果事件 */
export interface ToolResultEvent extends RunEventBase {
  type: 'tool_result'
  /** 工具名称 */
  toolName: string
  /** 工具执行结果 */
  toolResult: unknown
  /** 是否被拦截 */
  blocked: boolean
  /** 拦截原因（blocked=true 时） */
  blockReason?: string
}

/** 子 Agent 启动事件 */
export interface SubAgentSpawnEvent extends RunEventBase {
  type: 'subagent_spawn'
  /** 子 agent 的 runId */
  childRunId: string
  /** 子 agent 的 sessionKey */
  childSessionKey: string
  /** agent 类型 */
  agentType: string
  /** agent 标识（从 childSessionKey 解析） */
  agentId: string
  /** prompt 模式（如 "minimal"） */
  promptMode: string
}

/** 子 Agent 结束事件 */
export interface SubAgentEndEvent extends RunEventBase {
  type: 'subagent_end'
  /** 子 agent 的 runId */
  childRunId: string
}

/** Agent 结束事件 */
export interface AgentEndEvent extends RunEventBase {
  type: 'agent_end'
}

/** Run 事件联合类型 */
export type RunEvent =
  | PromptBuildEvent
  | LlmCallEvent
  | LlmResponseEvent
  | ToolCallEvent
  | ToolResultEvent
  | SubAgentSpawnEvent
  | SubAgentEndEvent
  | AgentEndEvent

// ----------------------------------------------------------------------------
// F203: RunRecord + RunSummary 类型
// ----------------------------------------------------------------------------

/** Run 状态 */
export type RunStatus = 'running' | 'completed' | 'error'

/** 一次完整 agent 执行的记录 */
export interface RunRecord {
  /** 运行 ID */
  runId: string
  /** 会话 ID */
  sessionId: string
  /** Agent 标识（从 sessionId 解析，如 "main"、"agent-8820d41d"） */
  agentId: string
  /** agent 类型 */
  agentType: 'main' | 'subagent'
  /** 父 Run ID（subagent 时存在） */
  parentRunId?: string
  /** 开始时间戳（毫秒） */
  startTime: number
  /** 结束时间戳（毫秒），运行中时为 undefined */
  endTime?: number
  /** 最后更新时间戳（毫秒），用于增量轮询判断 */
  lastUpdated: number
  /** 事件列表（按时间顺序） */
  events: RunEvent[]
  /** Run 状态 */
  status: RunStatus
}

/** Run 摘要（用于列表展示的预计算数据） */
export interface RunSummary {
  /** 模型名 */
  model: string
  /** 用户消息预览（前 200 字符） */
  userPromptPreview: string
  /** LLM 调用次数 */
  llmCallCount: number
  /** 工具调用次数 */
  toolCallCount: number
  /** 子 agent 数量 */
  subAgentCount: number
  /** 总耗时（毫秒），运行中时为 undefined */
  totalDuration?: number
}

/**
 * workspace-summary 类型定义
 *
 * 与 docs/workspace-storage-design.md 保持一致。
 */

import type { QClawLogger } from '../../../core/types.js'
import type { TelemetryReporter } from '../../../core/reporter-types.js'

// ============== 状态枚举 ==============

export type SessionStatus = 'active' | 'completed' | 'archived'
export type AgentStatus = 'idle' | 'running' | 'error'

// ============== store.json（纯索引/元数据） ==============

export interface SessionStore {
  id: string
  name: string
  status: SessionStatus
  createdAt: string
  updatedAt: string
  agents: Agent[]
  /** 当前会话摘要索引，内容在独立文件中 */
  summary?: SummaryMeta
  /** 上次摘要生成时处理到的消息总数（增量游标），用于插件重启后恢复状态 */
  lastMessageCount?: number
}

export interface Agent {
  id: string
  name: string
  role: string
  status: AgentStatus
  createdAt: string
  model: string
  systemPrompt: string
}

/** store.json 中的 summary 索引（不含内容） */
export interface SummaryMeta {
  id: string
  title: string
  createdAt: string
  /** 相对于 session 目录的文件路径，如 "summary_p7q8r9.md" */
  file: string
}

// ============== 插件配置 ==============

/** workspace-summary 配置 */
export interface WorkspaceSummaryConfig {
  /** 是否启用，默认 true */
  enabled?: boolean
  /** 用于生成摘要的最大对话轮次数（取最后 N 轮），默认 10 */
  maxTurns?: number
}

// ============== 内部类型 ==============

/** 单轮对话 */
export interface Turn {
  user: string
  assistant: string
}

/** LLM 生成的 summary 结果（独立 LLM 调用） */
export interface SummaryResult {
  /** 会话名称（简短标题） */
  sessionName: string
  /** 摘要正文（Markdown 格式） */
  summaryContent: string
}

/** 提取上下文（传递给 summarizer） */
export interface SummarizationContext {
  turns: Turn[]
  agentId: string
  sessionKey: string
  logger: QClawLogger
  /** OpenClaw 完整配置（用于 runEmbeddedPiAgent） */
  openclawConfig: unknown
  /** 摘要生成超时时间（毫秒），默认 120_000 */
  timeoutMs?: number
  /** 遥测上报器（用于数据上报） */
  reporter: TelemetryReporter
  // ★ 关联用户对话（用于 LLM sessionId/runId 拼接归因）
  sourceSessionId?: string   // hookCtx.sessionId → conversion_id (x-conversation-id)
  sourceRunId?: string       // hookCtx.runId → conversation_req_id (x-conversation-request-id)
}

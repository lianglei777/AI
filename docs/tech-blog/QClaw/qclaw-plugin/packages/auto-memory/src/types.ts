/**
 * auto-memory 类型定义
 */

import type { QClawLogger } from '../../../core/types.js'
import type { TelemetryReporter } from '../../../core/reporter-types.js'

/** auto-memory 配置 */
export interface AutoMemoryConfig {
  /** 是否启用，默认 true（旧版本字段，新版本不读） */
  enabled?: boolean
  /** 是否启用（V2，新版本开关，独立于旧灰度） */
  enabledV2?: boolean
  /** 每 N 轮触发一次提取，默认 2（旧版本字段，新版本不读） */
  triggerEveryNTurns?: number
  /** 最短触发间隔（秒），默认 60（旧版本字段，新版本不读） */
  minTriggerIntervalSeconds?: number
  /** 提取最小间隔（分钟），默认 120（新版本字段） */
  extractionIntervalMinutes?: number
  /** 是否写入 memory/日期.md（工作记录），默认 true */
  writeDailyMemory?: boolean
  /** 长期记忆固化间隔（分钟），默认 720（12 小时） */
  consolidateIntervalMinutes?: number
  /** 固化时回看的天数，默认 3 */
  consolidateLookbackDays?: number
  /** 是否启用定时固化（路径 C），默认 true（跟随 writeLongTermMemory） */
  enableConsolidation?: boolean
}

/** 单轮对话 */
export interface Turn {
  user: string
  assistant: string
}

/** 按 session 隔离的对话缓冲区 */
export interface SessionBuffer {
  agentId: string
  turns: Turn[]
  /** 自上次提取以来的轮次计数 */
  pendingTurnCount: number
  /** 上次触发提取的时间戳 */
  lastTriggerTs: number
  /** 暂存的未配对 user message */
  pendingUserMessage: string | null
}

/** MEMORY.md 的 LLM 提取结果（JSON 结构） */
export interface MemoryOperation {
  add: Array<{ section: string; fact: string }>
  update: Array<{ old_pattern: string; new_fact: string; section: string }>
  remove: Array<{ pattern: string; reason: string }>
}

/** daily memory 的提取结果 */
export interface DailyFact {
  tag: 'done' | 'discussion' | 'follow-up' | 'preference'
  text: string
  topic: string
}

/** 提取上下文（传递给 extractor） */
export interface ExtractionContext {
  turns: Turn[]
  agentId: string
  workspaceDir: string
  existingMemoryContent: string
  logger: QClawLogger
  /** OpenClaw 完整配置（用于 runEmbeddedPiAgent） */
  openclawConfig: unknown
  /** 超时 abort signal */
  abortSignal?: AbortSignal
  /** 遥测上报器 */
  reporter: TelemetryReporter
  // ★ 新增：关联用户对话（用于 LLM sessionId/runId 拼接）
  sourceSessionId?: string   // hookCtx.sessionId → conversion_id (x-conversation-id)
  sourceRunId?: string       // hookCtx.runId → conversation_req_id (x-conversation-request-id)
}

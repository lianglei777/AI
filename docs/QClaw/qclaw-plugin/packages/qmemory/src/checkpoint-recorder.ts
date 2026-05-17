/**
 * Checkpoint 记录器
 *
 * 监听 OpenClaw 的钩子事件，将任务执行过程中的每一步工具调用
 * 记录到 WAL 中，作为 crash 恢复的依据。
 *
 * 迁移说明：
 * - 原插件通过 api.on() 注册 session_start/session_end 等事件
 * - 迁移后通过 QClawContext.onHook() 注册标准 HookEvent
 * - session_start/session_end 不在标准 HookEvent 中，
 *   改为完全依赖 before_prompt_build / before_tool_call 的兜底创建
 *   和 agent_end 的清理逻辑（原插件已有这些兜底路径）
 *
 * 迁移自: extensions/qmemory/src/checkpoint-recorder.ts
 */

import type { WalStore } from './wal-store.js'
import type { QClawLogger } from '../../../core/types.js'

/** before_prompt_build 事件 */
interface PromptBuildEvent {
  prompt?: string
  messages?: unknown[]
  [key: string]: unknown
}

/** before_tool_call / after_tool_call 事件 */
interface ToolCallEvent {
  toolName: string
  toolCallId?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: unknown
  [key: string]: unknown
}

/** agent_end 事件 */
interface AgentEndEvent {
  success?: boolean
  messages?: unknown[]
  [key: string]: unknown
}

/** Hook 上下文 */
interface HookCtx {
  sessionKey?: string
  agentId?: string
  [key: string]: unknown
}

export class CheckpointRecorder {
  private readonly walStore: WalStore
  private readonly logger: QClawLogger

  constructor(walStore: WalStore, logger: QClawLogger) {
    this.walStore = walStore
    this.logger = logger
  }

  // ─── Hook handler 方法（由 Package setup 注册） ───

  /**
   * session_start 钩子 — 创建任务（非标事件，由 qclaw-plugin index.ts 通过 api.on 注册）
   *
   * 与原插件逻辑一致：如果该会话已有活跃任务，先结束旧任务，再创建新任务。
   * 此方法会立即写盘（WAL），确保 crash 后任务可被发现。
   */
  onSessionStart(sessionKey: string, agentId: string): void {
    if (!sessionKey || !agentId) return

    // 如果该会话已有活跃任务，先结束旧任务
    const existing = this.walStore.getActiveTask(sessionKey)
    if (existing) {
      this.walStore.finishTask(sessionKey, 'completed')
    }

    this.walStore.createTask(sessionKey, agentId)
  }

  /**
   * session_end 钩子 — 从内存移除活跃任务，保留 WAL（非标事件，由 qclaw-plugin index.ts 通过 api.on 注册）
   *
   * 与原插件逻辑一致：session_end 在程序正常退出时也会触发，此时任务可能没有真正完成。
   * 真正的任务完成标记由 agent_end (success=true) 负责。
   */
  onSessionEnd(sessionKey: string): void {
    if (!sessionKey) return

    const task = this.walStore.getActiveTask(sessionKey)
    if (!task) return

    // 只从内存移除，保留磁盘 WAL 文件
    this.walStore.removeActiveTask(sessionKey)
  }

  /**
   * before_prompt_build 钩子 — 捕获用户 prompt
   *
   * 与原插件逻辑一致：仅用于兜底创建任务（session_start 未触发时）和补充 originalPrompt。
   */
  onBeforePromptBuild(event: Record<string, unknown>, ctx: HookCtx): void {
    const sessionKey = ctx?.sessionKey
    const agentId = ctx?.agentId
    if (!sessionKey) return

    const promptEvent = event as PromptBuildEvent
    const prompt = typeof promptEvent.prompt === 'string' ? promptEvent.prompt : undefined
    if (!prompt) return

    let task = this.walStore.getActiveTask(sessionKey)
    if (!task) {
      // session_start 可能未触发（非新会话），这里兜底创建
      task = this.walStore.createTask(sessionKey, agentId || 'unknown', prompt)
    } else if (!task.originalPrompt) {
      task.originalPrompt = prompt
      task.updatedAt = Date.now()
      this.walStore.syncTask(sessionKey)
    }
  }

  /**
   * before_tool_call 钩子 — 记录步骤开始，兜底创建任务
   */
  onBeforeToolCall(event: Record<string, unknown>, ctx: HookCtx): void {
    const sessionKey = ctx?.sessionKey
    const agentId = ctx?.agentId
    if (!sessionKey) return

    const toolEvent = event as ToolCallEvent

    let task = this.walStore.getActiveTask(sessionKey)
    if (!task) {
      // 兜底：如果 before_prompt_build 没创建任务
      task = this.walStore.createTask(sessionKey, agentId || 'unknown')
    }

    this.walStore.addStep(sessionKey, {
      toolName: toolEvent.toolName,
      toolCallId: toolEvent.toolCallId,
      params: toolEvent.params ?? {},
    })
  }

  /**
   * after_tool_call 钩子 — 记录步骤完成
   */
  onAfterToolCall(event: Record<string, unknown>, ctx: HookCtx): void {
    const sessionKey = ctx?.sessionKey
    if (!sessionKey) return

    const toolEvent = event as ToolCallEvent

    let result: Record<string, unknown> | undefined
    if (typeof toolEvent.result === 'object' && toolEvent.result !== null) {
      result = toolEvent.result as Record<string, unknown>
    } else {
      result = undefined
    }
    const isError =
      (typeof result === 'object' && result !== null && result.isError === true) ||
      Boolean(toolEvent.error)

    this.walStore.completeStep(
      sessionKey,
      toolEvent.toolCallId,
      toolEvent.toolName,
      summarizeResult(result),
      isError,
    )
  }

  /**
   * agent_end 钩子 — 标记任务完成或保留 WAL
   */
  onAgentEnd(event: Record<string, unknown>, ctx: HookCtx): void {
    const sessionKey = ctx?.sessionKey
    if (!sessionKey) return

    const task = this.walStore.getActiveTask(sessionKey)
    if (!task) return

    const agentEndEvent = event as AgentEndEvent

    if (agentEndEvent.success === true) {
      this.walStore.finishTask(sessionKey, 'completed')
    } else {
      // AI 未成功完成（取消/错误/程序退出），保留 WAL
      this.walStore.removeActiveTask(sessionKey)
    }
  }
}

// ─── 纯函数（已 export，可独立测试） ───

/**
 * 精简工具调用结果，避免 WAL 文件过大
 * 只保留关键信息，截断过长内容
 */
export function summarizeResult(result: unknown): unknown {
  if (!result) return null

  const MAX_RESULT_LENGTH = 500

  // 提取文本内容
  if (typeof result === 'object' && result !== null) {
    const resultObj = result as Record<string, unknown>
    if (resultObj.content && Array.isArray(resultObj.content)) {
      const texts = (resultObj.content as Array<Record<string, unknown>>)
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
      const combined = texts.join('\n')
      return combined.length > MAX_RESULT_LENGTH
        ? combined.slice(0, MAX_RESULT_LENGTH) + '...(truncated)'
        : combined
    }
  }

  // 字符串结果
  if (typeof result === 'string') {
    return result.length > MAX_RESULT_LENGTH
      ? result.slice(0, MAX_RESULT_LENGTH) + '...(truncated)'
      : result
  }

  // 其他类型尝试序列化
  try {
    const str = JSON.stringify(result)
    return str.length > MAX_RESULT_LENGTH
      ? str.slice(0, MAX_RESULT_LENGTH) + '...(truncated)'
      : str
  } catch {
    return '[unserializable]'
  }
}

/**
 * 任务恢复引擎
 *
 * 在 OpenClaw crash 重启后：
 * 1. 扫描未完成的 WAL 任务
 * 2. 构造恢复上下文（已完成步骤摘要）
 * 3. 通过 FetchMiddleware 直接修改发给 LLM 的 messages，注入恢复指令
 *
 * 迁移说明：
 * - 原插件通过 globalThis.fetch 覆盖实现拦截
 * - 迁移后通过 ctx.registerFetchMiddleware() 注册标准 FetchMiddleware
 * - 不再需要 queueMicrotask hack 和防重入标记
 *
 * 迁移自: extensions/qmemory/src/recovery-engine.ts
 */

import type { WalStore } from './wal-store.js'
import type { TaskRecord, TaskStep, RecoveryContext } from './types.js'
import type { QClawLogger, FetchMiddleware, FetchRequestContext } from '../../../core/types.js'

/** 已 arm 但尚未被 fetch 消费的注入上下文 */
interface ArmedInjection {
  /** 恢复任务描述（注入到 LLM 的内容） */
  taskDesc: string
  /** 原始中断任务的 taskId */
  taskId: string
}

export class RecoveryEngine {
  private readonly walStore: WalStore
  private readonly logger: QClawLogger

  /** 待恢复的任务上下文列表 */
  private pendingRecoveries: RecoveryContext[] = []

  /** 全局恢复模式标记（有未完成任务时激活） */
  private recoveryMode = false

  /** 按 sessionKey 存储的 armed 注入上下文 */
  private armedInjections = new Map<string, ArmedInjection>()

  /** 已注入恢复上下文的 sessionKey 集合，避免重复注入 */
  private injectedSessions = new Set<string>()

  /** 已注入但尚未确认完成的旧任务 taskId，等 agent_end(success=true) 后再删 WAL */
  private pendingWalCleanup: string[] = []

  /** 调试信息：记录最近一次注入的详细情况 */
  private lastInjectionDebug: {
    timestamp: string
    sessionKey: string
    taskId: string
    method: string
    injectedContent: string
    messageIndex: number
    originalContentPreview: string
  } | null = null

  constructor(opts: { walStore: WalStore; logger: QClawLogger }) {
    this.walStore = opts.walStore
    this.logger = opts.logger
  }

  // ─── 恢复流程 ───

  /**
   * 初始化恢复：扫描中断任务，每个 session 保留最近一个用于恢复。
   */
  initialize(): TaskRecord[] {
    const interrupted = this.walStore.collectInterruptedTasks()
    if (interrupted.length === 0) return []

    // 按中断时间排序，最新的在前
    interrupted.sort((a, b) => {
      const bTime = b.endedAt !== undefined ? b.endedAt : (b.updatedAt ?? 0)
      const aTime = a.endedAt !== undefined ? a.endedAt : (a.updatedAt ?? 0)
      return bTime - aTime
    })

    // 按 sessionKey 分组，每个 session 只保留最新的一个
    const latestBySession = new Map<string, TaskRecord>()
    const toCleanup: TaskRecord[] = []

    for (const task of interrupted) {
      if (!latestBySession.has(task.sessionKey)) {
        latestBySession.set(task.sessionKey, task)
      } else {
        toCleanup.push(task)
      }
    }

    const kept: TaskRecord[] = []
    for (const [, task] of latestBySession) {
      const context = this.buildRecoveryContext(task)
      this.pendingRecoveries.push(context)
      kept.push(task)
    }

    this.recoveryMode = true

    // 清理同 session 下的旧中断任务 WAL
    for (const task of toCleanup) {
      this.walStore.markRecovered(task.taskId)
    }

    return kept
  }

  /** 获取所有待恢复的任务 */
  getPendingRecoveries(): Map<string, RecoveryContext> {
    const map = new Map<string, RecoveryContext>()
    for (const ctx of this.pendingRecoveries) {
      map.set(ctx.task.sessionKey, ctx)
    }
    return map
  }

  /** 获取指定会话的恢复上下文 */
  getRecoveryContext(sessionKey: string): RecoveryContext | undefined {
    return this.pendingRecoveries.find((r) => r.task.sessionKey === sessionKey)
  }

  /** 放弃恢复单个任务：清理内存上下文 + 删除磁盘 WAL */
  dismissOne(sessionKey: string): void {
    const recovery = this.pendingRecoveries.find((r) => r.task.sessionKey === sessionKey)
    if (recovery) {
      this.walStore.markRecovered(recovery.task.taskId)
    }
    this.pendingRecoveries = this.pendingRecoveries.filter(
      (r) => r.task.sessionKey !== sessionKey,
    )
    if (this.pendingRecoveries.length === 0) {
      this.recoveryMode = false
    }
  }

  /** 清空所有待恢复任务 */
  clearAll(): void {
    for (const taskId of this.pendingWalCleanup) {
      this.walStore.markRecovered(taskId)
    }
    this.pendingWalCleanup = []
    for (const recovery of this.pendingRecoveries) {
      this.walStore.markRecovered(recovery.task.taskId)
    }
    this.pendingRecoveries = []
    this.recoveryMode = false
    this.injectedSessions.clear()
    this.armedInjections.clear()
  }

  /** 是否处于恢复模式 */
  isRecoveryMode(): boolean {
    return this.recoveryMode
  }

  /** 获取最近一次注入的调试信息 */
  getLastInjectionDebug(): typeof this.lastInjectionDebug {
    return this.lastInjectionDebug
  }

  /** 已注入恢复上下文的会话数量 */
  getInjectedSessionsCount(): number {
    return this.injectedSessions.size
  }

  /** 是否有暂存的待清理 WAL */
  hasPendingWalCleanup(): boolean {
    return this.pendingWalCleanup.length > 0
  }

  /** 确认恢复任务已完成，真正删除旧的 WAL 文件 */
  confirmRecoveryComplete(): void {
    if (this.pendingWalCleanup.length === 0) return
    for (const taskId of this.pendingWalCleanup) {
      this.walStore.markRecovered(taskId)
    }
    this.pendingWalCleanup = []
  }

  // ─── Hook 处理器 ───

  /**
   * before_prompt_build 钩子：标记 fetch 拦截器激活
   *
   * Session 隔离：只有当前 sessionKey 与中断任务的 sessionKey 匹配时才激活恢复
   */
  onBeforePromptBuild(
    _event: Record<string, unknown>,
    ctx: { sessionKey?: string; [key: string]: unknown },
  ): void {
    if (!this.recoveryMode || this.pendingRecoveries.length === 0) return

    const sessionKey = ctx?.sessionKey
    if (!sessionKey) return

    if (this.injectedSessions.has(sessionKey)) return

    const recovery = this.pendingRecoveries.find((r) => r.task.sessionKey === sessionKey)
    if (!recovery) return

    const userInput = extractUserInput(recovery.task.originalPrompt || '')
    const taskDesc = userInput || recovery.task.originalPrompt || '未知任务'

    this.injectedSessions.add(sessionKey)
    this.pendingWalCleanup.push(recovery.task.taskId)

    this.armedInjections.set(sessionKey, { taskDesc, taskId: recovery.task.taskId })

    this.lastInjectionDebug = {
      timestamp: new Date().toISOString(),
      sessionKey,
      taskId: recovery.task.taskId,
      method: 'fetch-interceptor-armed',
      injectedContent: '(pending fetch)',
      messageIndex: -1,
      originalContentPreview: '',
    }

    this.pendingRecoveries = this.pendingRecoveries.filter(
      (r) => r.task.sessionKey !== sessionKey,
    )
    if (this.pendingRecoveries.length === 0 && this.armedInjections.size === 0) {
      this.recoveryMode = false
    }
  }

  // ─── Fetch 中间件 ───

  /**
   * 创建 FetchMiddleware（替代原 setupFetchInterceptor）
   *
   * 通过 ctx.registerFetchMiddleware() 注册，不再直接覆盖 globalThis.fetch
   */
  createFetchMiddleware(): FetchMiddleware {
    return {
      id: 'qmemory',
      priority: 100, // 最外层，确保恢复指令替换后经过内层安全审核
      onRequest: async (reqCtx: FetchRequestContext): Promise<FetchRequestContext> => {
        // 快速路径：没有 armed 注入时直接透传
        if (this.armedInjections.size === 0) return reqCtx

        // 解析请求体
        let jsonBody: Record<string, unknown> | undefined
        const init = reqCtx.init

        if (init?.body) {
          let rawBody: string | undefined

          if (typeof init.body === 'string') {
            rawBody = init.body
          } else if (init.body instanceof Uint8Array || init.body instanceof ArrayBuffer) {
            rawBody = new TextDecoder().decode(init.body)
          }

          if (rawBody) {
            try {
              jsonBody = JSON.parse(rawBody) as Record<string, unknown>
            } catch {
              // 非 JSON，跳过
            }
          }
        }

        // 检测是否为 LLM 请求（含 messages 数组）
        if (!jsonBody || !Array.isArray(jsonBody.messages) || jsonBody.messages.length === 0) {
          return reqCtx
        }

        try {
          // 找到最后一条 user 消息
          let lastUserIdx = -1
          for (let i = jsonBody.messages.length - 1; i >= 0; i--) {
            if ((jsonBody.messages as Array<Record<string, unknown>>)[i]!.role === 'user') {
              lastUserIdx = i
              break
            }
          }

          if (lastUserIdx < 0) return reqCtx

          const msg = (jsonBody.messages as Array<Record<string, unknown>>)[lastUserIdx]!

          // 提取用户原始消息内容
          let userOriginalContent = ''
          if (typeof msg.content === 'string') {
            userOriginalContent = msg.content
          } else if (Array.isArray(msg.content)) {
            for (const part of msg.content as Array<Record<string, unknown>>) {
              if (part.type === 'text' && typeof part.text === 'string') {
                userOriginalContent = part.text
                break
              }
            }
          }

          const userCoreInput = extractUserInput(userOriginalContent)

          // FIFO: 取最早 arm 的 session
          const matchedSessionKey = this.findEarliestArmedSession()
          if (!matchedSessionKey) return reqCtx

          const armed = this.armedInjections.get(matchedSessionKey)!

          // 关键判断：只有用户明确表达了"继续中断任务"的意图时才恢复
          if (!isUserRequestingResume(userCoreInput)) {
            this.consumeArmedInjection(matchedSessionKey, 'dismissed')
            this.walStore.markRecovered(armed.taskId)
            this.pendingWalCleanup = this.pendingWalCleanup.filter((id) => id !== armed.taskId)
            return reqCtx
          }

          // 构造恢复指令
          const recoveryContent = [
            `[TASK RECOVERY] 上次执行中断，用户没有看到任何结果。`,
            `用户请求恢复中断的任务。请重新执行以下被中断的任务：`,
            ``,
            `任务：${armed.taskDesc}`,
            ``,
            `请只执行上述被中断的任务，完整展示结果。在回复开头简要说明"上次执行中断，现在恢复执行"（不要提及"崩溃"或"crash"等字眼）。`,
          ].join('\n')

          let originalPreview = ''

          // 替换 user 消息的 content
          if (typeof msg.content === 'string') {
            originalPreview = msg.content.slice(0, 100)
            msg.content = recoveryContent
          } else if (Array.isArray(msg.content)) {
            for (const part of msg.content as Array<Record<string, unknown>>) {
              if (part.type === 'text' && typeof part.text === 'string') {
                originalPreview = (part.text as string).slice(0, 100)
                part.text = recoveryContent
                break
              }
            }
          }

          // 重新序列化
          const newBody = JSON.stringify(jsonBody)
          const newInit = { ...init }

          if (typeof init?.body === 'string') {
            newInit.body = newBody
          } else if (init?.body instanceof Uint8Array) {
            newInit.body = new TextEncoder().encode(newBody)
          } else if (init?.body instanceof ArrayBuffer) {
            const encoded = new TextEncoder().encode(newBody)
            newInit.body = encoded.buffer as ArrayBuffer
          }

          // 更新 Content-Length
          if (!newInit.headers) {
            newInit.headers = {}
          }
          const newContentLength = new TextEncoder().encode(newBody).byteLength.toString()
          if (newInit.headers instanceof Headers) {
            newInit.headers.set('Content-Length', newContentLength)
          } else if (Array.isArray(newInit.headers)) {
            const idx = newInit.headers.findIndex(
              ([k]: [string, string]) => k.toLowerCase() === 'content-length',
            )
            if (idx >= 0) {
              newInit.headers[idx] = ['Content-Length', newContentLength]
            } else {
              newInit.headers.push(['Content-Length', newContentLength])
            }
          } else {
            const headerObj = newInit.headers as Record<string, string>
            const key = Object.keys(headerObj).find((k) => k.toLowerCase() === 'content-length')
            headerObj[key || 'Content-Length'] = newContentLength
          }

          this.consumeArmedInjection(matchedSessionKey, 'injected')

          this.lastInjectionDebug = {
            timestamp: new Date().toISOString(),
            sessionKey: matchedSessionKey,
            taskId: armed.taskId,
            method: 'fetch-middleware-injected',
            injectedContent: recoveryContent,
            messageIndex: lastUserIdx,
            originalContentPreview: originalPreview,
          }

          return { ...reqCtx, init: newInit }
        } catch (error) {
          this.logger.error(`fetch 中间件注入失败，原始请求将不受影响: ${error}`)
          return reqCtx
        }
      },
    }
  }

  // ─── 内部辅助 ───

  /** 查找最早 arm 的 session（Map 迭代按插入顺序，即 FIFO） */
  private findEarliestArmedSession(): string | undefined {
    const first = this.armedInjections.keys().next()
    return first.done ? undefined : first.value
  }

  /** 消费一个 armed 注入 */
  private consumeArmedInjection(sessionKey: string, reason: 'injected' | 'dismissed'): void {
    const armed = this.armedInjections.get(sessionKey)
    if (!armed) return

    this.armedInjections.delete(sessionKey)
    this.logger.info(`armed 注入已消费 (sessionKey=${sessionKey}, reason=${reason})`)

    if (this.pendingRecoveries.length === 0 && this.armedInjections.size === 0) {
      this.recoveryMode = false
    }
  }

  // ─── 上下文构建 ───

  private buildRecoveryContext(task: TaskRecord): RecoveryContext {
    const completedSteps = task.steps.filter((s) => s.status === 'completed')
    const summary = buildStepsSummary(completedSteps)
    return { task, completedSummary: summary }
  }
}

// ─── 纯函数（已 export，可独立测试） ───

/**
 * 判断用户输入是否表达了"继续执行中断任务"的意图
 */
export function isUserRequestingResume(userInput: string): boolean {
  if (!userInput) return false
  const normalized = userInput.trim().toLowerCase()
  const resumeKeywords = [
    '继续',
    '继续任务',
    '继续执行',
    '继续上次',
    '继续之前',
    '继续中断',
    '继续未完成',
    '恢复任务',
    '恢复执行',
    '恢复中断',
    '执行中断任务',
    '执行中断的任务',
    '做未完成的任务',
    '做上次的任务',
    '接着做',
    '接着上次',
    '上次没做完',
    '没做完的',
    '未完成的任务',
    '中断的任务',
    'resume',
    'continue',
  ]
  return resumeKeywords.some((kw) => normalized.includes(kw))
}

/**
 * 从原始 prompt 中提取用户真实输入
 */
export function extractUserInput(prompt: string): string {
  if (!prompt) return ''

  // 尝试匹配 [日期时间] 后面的内容
  const timestampMatch = prompt.match(/\[.*?\]\s*([\s\S]*?)$/)
  if (timestampMatch) {
    return timestampMatch[1]!.trim()
  }

  // 尝试去掉 Sender 元数据块
  const senderMatch = prompt.match(/^Sender\s*\(.*?\):\s*```[\s\S]*?```\s*([\s\S]*)$/m)
  if (senderMatch) {
    return senderMatch[1]!.trim()
  }

  return prompt.trim()
}

/**
 * 构建已完成步骤摘要
 */
export function buildStepsSummary(steps: TaskStep[]): string {
  if (steps.length === 0) return '  (无已完成步骤)'

  return steps
    .map((step) => {
      const params = summarizeParams(step.params)
      const resultStr = step.result
        ? ` → ${typeof step.result === 'string' ? step.result.slice(0, 200) : JSON.stringify(step.result).slice(0, 200)}`
        : ''
      return `  ${step.seq}. [已完成] ${step.toolName}(${params})${resultStr}`
    })
    .join('\n')
}

/**
 * 精简参数字符串
 */
export function summarizeParams(params: Record<string, unknown>): string {
  const MAX_PARAM_LENGTH = 100
  const entries = Object.entries(params)
  if (entries.length === 0) return ''

  const parts = entries.map(([key, value]) => {
    const valStr = typeof value === 'string' ? value : JSON.stringify(value)
    const truncated =
      valStr.length > MAX_PARAM_LENGTH ? valStr.slice(0, MAX_PARAM_LENGTH) + '...' : valStr
    return `${key}=${truncated}`
  })

  return parts.join(', ')
}

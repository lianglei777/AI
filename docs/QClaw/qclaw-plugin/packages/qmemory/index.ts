/**
 * qmemory — 任务恢复 Package
 *
 * 任务恢复插件，记录任务执行过程中的 checkpoint，
 * 在 OpenClaw crash 重启后支持恢复中断的任务。
 *
 * 核心能力：
 * - Hook: before_prompt_build (checkpoint + 恢复激活),
 *         before_tool_call / after_tool_call (步骤记录),
 *         agent_end (任务完成标记 + 恢复确认)
 * - Fetch 中间件: 拦截 LLM 请求注入恢复指令
 * - HTTP 路由: /status, /dismiss, /dismiss-all, /cleanup
 * - 命令: /resume
 *
 * 迁移自: extensions/qmemory/
 */

import path from 'node:path'

import type {
  QClawPackage,
  QClawContext,
  HookHandlerResult,
  HttpRequest,
  HttpResponse,
} from '../../core/types.js'

import { WalStore } from './src/wal-store.js'
import { CheckpointRecorder } from './src/checkpoint-recorder.js'
import { RecoveryEngine } from './src/recovery-engine.js'
import type { QMemoryConfig } from './src/types.js'

// Re-export 纯函数以便测试
export { summarizeResult } from './src/checkpoint-recorder.js'
export {
  isUserRequestingResume,
  extractUserInput,
  buildStepsSummary,
  summarizeParams,
} from './src/recovery-engine.js'

/**
 * qmemory 暴露给 qclaw-plugin index.ts 的公开 API
 *
 * 用于注册非标 Hook 事件（session_start / session_end），
 * 这些事件不在 HookProxy 的 HookEvent 类型中，
 * 需要由 qclaw-plugin 主入口通过 api.on() 直接注册。
 */
export interface QMemoryPublicApi {
  /** session_start 回调：创建任务 */
  onSessionStart(sessionKey: string, agentId: string): void
  /** session_end 回调：从内存移除活跃任务（保留 WAL） */
  onSessionEnd(sessionKey: string): void
}

/** 模块级变量，保存 setup 中创建的实例引用，供 getPublicApi 使用 */
let _checkpointRecorder: CheckpointRecorder | null = null

const qmemory: QClawPackage = {
  id: 'qmemory',
  name: '任务恢复',
  description:
    '任务恢复插件，记录任务执行过程中的 checkpoint，在 OpenClaw crash 重启后支持恢复中断的任务。',

  configSchema: {
    type: 'object',
    additionalProperties: false as const,
    properties: {
      walDir: {
        type: 'string',
        description: 'WAL 文件存储目录（可选，默认为 stateDir/qmemory）',
      },
      maxWalFiles: {
        type: 'integer',
        description: '保留的最大 WAL 文件数量，超出后清理最旧的',
        default: 20,
      },
      walRetentionMs: {
        type: 'integer',
        description: 'WAL 文件保留时长（毫秒），超出后自动清理',
        default: 86400000,
      },
      autoRecovery: {
        type: 'boolean',
        description: '网关启动时是否自动检测未完成任务并准备恢复上下文',
        default: true,
      },
    },
  },

  setup(ctx: QClawContext): void {
    ctx.logger.info('setup')

    const pluginCfg = ctx.getConfig<QMemoryConfig>()

    // ─── 解析状态目录 ───
    // ctx.runtime.stateDir 在插件加载阶段可能还没初始化（为空字符串），
    // 需要回退到环境变量（与原插件 api.runtime.state.resolveStateDir() 等价）
    const stateDir = ctx.runtime.stateDir
      || process.env.OPENCLAW_STATE_DIR?.trim()
      || process.env.CLAWDBOT_STATE_DIR?.trim()
      || ''
    const walDir = pluginCfg.walDir || (stateDir ? path.join(stateDir, 'qmemory') : '')
    if (!walDir) {
      ctx.logger.error('无法确定 WAL 存储目录，插件初始化失败')
      return
    }

    // ─── 初始化核心模块 ───
    const walStore = new WalStore({
      walDir,
      maxFiles: pluginCfg.maxWalFiles,
      retentionMs: pluginCfg.walRetentionMs,
      logger: ctx.logger,
    })

    const checkpointRecorder = new CheckpointRecorder(walStore, ctx.logger)
    _checkpointRecorder = checkpointRecorder
    const recoveryEngine = new RecoveryEngine({
      walStore,
      logger: ctx.logger,
    })

    // ─── 注册 checkpoint 记录钩子 ───

    // before_prompt_build: 捕获用户 prompt + 兜底创建任务
    ctx.onHook(
      'before_prompt_build',
      async (event, hookCtx): Promise<HookHandlerResult | undefined> => {
        checkpointRecorder.onBeforePromptBuild(event, hookCtx)
        return undefined
      },
      { priority: 500 },
    )

    // before_tool_call: 记录步骤开始
    ctx.onHook(
      'before_tool_call',
      async (event, hookCtx): Promise<HookHandlerResult | undefined> => {
        checkpointRecorder.onBeforeToolCall(event, hookCtx)
        return undefined
      },
      { priority: 500 },
    )

    // after_tool_call: 记录步骤完成
    ctx.onHook(
      'after_tool_call',
      async (event, hookCtx): Promise<HookHandlerResult | undefined> => {
        checkpointRecorder.onAfterToolCall(event, hookCtx)
        return undefined
      },
      { priority: 500 },
    )

    // agent_end: 标记任务完成 + 确认恢复完成
    ctx.onHook(
      'agent_end',
      async (event, hookCtx): Promise<HookHandlerResult | undefined> => {
        // CheckpointRecorder: 标记任务完成
        checkpointRecorder.onAgentEnd(event, hookCtx)

        // RecoveryEngine: 恢复任务的新会话成功完成后，删除旧 WAL
        const agentEndEvent = event as { success?: boolean; [key: string]: unknown }
        if (agentEndEvent.success === true && recoveryEngine.hasPendingWalCleanup()) {
          recoveryEngine.confirmRecoveryComplete()
        }

        return undefined
      },
      { priority: 500 },
    )

    // ─── 注册恢复相关钩子 ───

    // before_prompt_build: 恢复模式下激活 fetch 拦截器
    // 注意：此 hook 必须在 checkpoint 的 before_prompt_build 之后执行（相同 priority）
    // HookProxy 按注册顺序执行相同 priority 的 handler，这里第二个注册即可
    ctx.onHook(
      'before_prompt_build',
      async (event, hookCtx): Promise<HookHandlerResult | undefined> => {
        recoveryEngine.onBeforePromptBuild(event, hookCtx)
        return undefined
      },
      { priority: 500 },
    )

    // ─── 注册 Fetch 中间件（替代 globalThis.fetch 覆盖）───
    ctx.registerFetchMiddleware(recoveryEngine.createFetchMiddleware())

    // ─── 自动恢复初始化 ───
    const autoRecovery = pluginCfg.autoRecovery !== false
    if (autoRecovery) {
      recoveryEngine.initialize()
      walStore.cleanup()
    }

    // ─── 注册 HTTP 路由 ───

    // GET /status — 查询恢复状态
    ctx.registerHttpRoute({
      method: 'GET',
      path: '/status',
      handler: async (_req: HttpRequest): Promise<HttpResponse> => {
        const pendingRecoveries = recoveryEngine.getPendingRecoveries()
        const tasks: Array<Record<string, unknown>> = []

        for (const [sessionKey, recoveryCtx] of pendingRecoveries) {
          tasks.push({
            taskId: recoveryCtx.task.taskId,
            sessionKey,
            agentId: recoveryCtx.task.agentId,
            originalPrompt: recoveryCtx.task.originalPrompt,
            completedSteps: recoveryCtx.task.steps.filter((s) => s.status === 'completed').length,
            totalSteps: recoveryCtx.task.steps.length,
            interruptedAt: recoveryCtx.task.endedAt
              ? new Date(recoveryCtx.task.endedAt).toISOString()
              : undefined,
          })
        }

        return {
          status: 200,
          body: {
            recoveryMode: recoveryEngine.isRecoveryMode(),
            pendingTasks: tasks,
            lastInjection: recoveryEngine.getLastInjectionDebug(),
            pendingWalCleanup: recoveryEngine.hasPendingWalCleanup(),
            injectedSessionsCount: recoveryEngine.getInjectedSessionsCount(),
          },
        }
      },
    })

    // POST /dismiss — 放弃恢复某个任务
    ctx.registerHttpRoute({
      method: 'POST',
      path: '/dismiss',
      handler: async (req: HttpRequest): Promise<HttpResponse> => {
        const body = req.body as Record<string, unknown> | undefined
        const sessionKey = typeof body?.sessionKey === 'string' ? body.sessionKey : undefined

        if (!sessionKey) {
          return { status: 400, body: { error: '缺少 sessionKey 参数' } }
        }

        const recoveryCtx = recoveryEngine.getRecoveryContext(sessionKey)
        if (!recoveryCtx) {
          return { status: 404, body: { error: '未找到该会话的待恢复任务' } }
        }

        recoveryEngine.dismissOne(sessionKey)
        return { status: 200, body: { success: true } }
      },
    })

    // POST /dismiss-all — 放弃所有待恢复任务
    ctx.registerHttpRoute({
      method: 'POST',
      path: '/dismiss-all',
      handler: async (_req: HttpRequest): Promise<HttpResponse> => {
        const count = recoveryEngine.getPendingRecoveries().size
        recoveryEngine.clearAll()
        return { status: 200, body: { success: true, dismissed: count } }
      },
    })

    // POST /cleanup — 手动触发 WAL 清理
    ctx.registerHttpRoute({
      method: 'POST',
      path: '/cleanup',
      handler: async (_req: HttpRequest): Promise<HttpResponse> => {
        walStore.cleanup()
        return { status: 200, body: { success: true } }
      },
    })

    // ─── 注册聊天命令 ───
    ctx.registerCommand({
      name: 'resume',
      description: '查看并恢复因 crash 中断的任务',
      handler: async (_args: string): Promise<string> => {
        const pendingRecoveries = recoveryEngine.getPendingRecoveries()

        if (pendingRecoveries.size === 0) {
          return '当前没有需要恢复的中断任务。'
        }

        const lines: string[] = ['发现以下中断任务：', '']
        let idx = 1
        for (const [sessionKey, recoveryCtx] of pendingRecoveries) {
          const { task } = recoveryCtx
          const completed = task.steps.filter((s) => s.status === 'completed').length
          lines.push(`${idx}. 会话: ${sessionKey}`)
          if (task.originalPrompt) {
            const promptPreview =
              task.originalPrompt.length > 80
                ? task.originalPrompt.slice(0, 80) + '...'
                : task.originalPrompt
            lines.push(`   任务: ${promptPreview}`)
          }
          lines.push(`   进度: ${completed}/${task.steps.length} 步已完成`)
          lines.push(
            `   中断时间: ${new Date(task.endedAt || task.updatedAt).toLocaleString()}`,
          )
          lines.push('')
          idx++
        }

        lines.push('恢复方式：在对应会话中发送新消息，系统会自动注入恢复上下文。')
        return lines.join('\n')
      },
    })
  },

  getPublicApi(): QMemoryPublicApi | undefined {
    if (!_checkpointRecorder) return undefined
    return {
      onSessionStart: (sessionKey: string, agentId: string) => {
        _checkpointRecorder!.onSessionStart(sessionKey, agentId)
      },
      onSessionEnd: (sessionKey: string) => {
        _checkpointRecorder!.onSessionEnd(sessionKey)
      },
    }
  },
}

export default qmemory

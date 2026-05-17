/**
 * queue-guard — 模型排队守卫 Package
 *
 * 通过 FetchChain 中间件，在 LLM 请求发出前轮询后端排队接口，
 * 模型资源可用后才放行请求。对所有渠道（主会话、微信、钉钉等）统一生效。
 *
 * 设计原则：
 * - L2 中间件层插件，只通过 FetchMiddleware 干预请求，不覆盖 globalThis.fetch
 * - fail-open 策略：排队接口异常或超时时直接放行，不阻塞用户
 * - 跨插件通讯保持原有 Symbol.for("openclaw.queueGuardEventBus") 兼容
 *
 * 迁移说明（独立插件 → qclaw-plugin package）：
 * - HTTP endpoint: `/plugins/queue-guard/token` → `/qclaw-plugin/queue-guard/token`
 *   （token-pusher.ts 已同步更新路径）
 * - Gateway methods: `queue-guard.status` / `queue-guard.abort`
 *   （GatewayRegistry 自动保留短名称别名，UI/外部调用方不受影响）
 * - Fetch 拦截: 覆盖 globalThis.fetch → 注册 FetchMiddleware（洋葱模型）
 */

import os from 'node:os'

import type {
  QClawPackage,
  QClawContext,
  FetchMiddleware,
  HookHandlerResult,
  HttpRequest,
  HttpResponse,
} from '../../core/types.js'

import {
  setEncryptedUserToken,
  abortCurrentQueue,
  getQueueInfo,
  resetQueueInfo,
  setSessionQueueInfo,
  getSessionQueueInfo,
  clearSessionQueueInfo,
  pushPendingContext,
  shiftPendingContext,
  getQueueGuardBus,
  waitForQueueReady,
  type QueueConfig,
  type QueueLogger,
} from './queue-api.js'
import { resolveQueryScene } from './query-scene.js'
import { isLLMRequest, tryParseBody, buildAbortedLlmResponse } from './queue-detector.js'
import { REPORT_CONST } from '../../core/reporter-constants.js'

const LOG_TAG = 'queue-guard'

// ---------------------------------------------------------------------------
// 配置类型
// ---------------------------------------------------------------------------

interface QueueGuardConfig {
  /** 是否启用排队守卫（默认 true） */
  enabled?: boolean
  /** 排队轮询间隔（毫秒，默认 2000） */
  pollInterval?: number
  /** 排队接口命令字（默认 "4158"） */
  queueCmd?: string
}

// ---------------------------------------------------------------------------
// Package 定义
// ---------------------------------------------------------------------------

const queueGuard: QClawPackage = {
  id: 'queue-guard',
  name: '模型排队守卫',
  description:
    '在 LLM 请求发出前通过 FetchMiddleware 轮询后端排队接口，模型资源可用后才放行请求。',

  configSchema: {
    type: 'object',
    additionalProperties: false as const,
    properties: {
      enabled: { type: 'boolean', description: '是否启用排队守卫', default: true },
      pollInterval: { type: 'integer', description: '排队轮询间隔（毫秒）', default: 2000 },
      queueCmd: { type: 'string', description: '排队接口命令字', default: '4158' },
    },
  },

  setup(ctx: QClawContext): void {
    // 提前初始化跨插件共享事件总线（挂载到 globalThis 上）。
    // 必须在 setup 阶段就创建，确保 wechat-access、weixin、dingtalk-connector 等
    // 其他独立插件在 handlePrompt 中注册监听器时 EventEmitter 已经存在。
    const queueBus = getQueueGuardBus()
    ctx.logger.info(
      `shared event bus initialized (listenerCount=${queueBus.listenerCount('queue-guard:state')})`,
    )

    const cfg = ctx.getConfig<QueueGuardConfig>()

    // 功能开关
    const enabled = cfg.enabled !== false // 默认开启
    if (!enabled) {
      ctx.logger.info('disabled by config, skipping')
      return
    }

    // 从配置中读取参数（带默认值）
    const pollInterval = typeof cfg.pollInterval === 'number' ? cfg.pollInterval : 2000
    const queueCmd = typeof cfg.queueCmd === 'string' ? cfg.queueCmd : '4158'

    // 从环境变量获取认证信息（由 Electron 主进程注入）
    const guid = process.env.QCLAW_USER_GUID || ''
    const userId = process.env.QCLAW_USER_ID || ''
    // AES-128-CBC 加密后的 JWT token（启动时可能为空，用户登录后通过 HTTP endpoint 动态推送）
    const encryptedUserToken = process.env.QCLAW_USER_TOKEN_ENCRYPTED || ''
    // 设备标识（gid），用于 JPrx 防重放签名
    const gid = guid || os.hostname() || '1'

    ctx.logger.info(
      `initializing (pollInterval=${pollInterval}ms, queueCmd=${queueCmd})`,
    )
    ctx.logger.info(
      `authInfo: guid=${guid || '(empty)'}, userId=${userId || '(empty)'}, gid=${gid}`,
    )

    // ---- 构建 QueueConfig（供 waitForQueueReady 使用） ----
    const queueLogger: QueueLogger = {
      info: (msg: string) => ctx.logger.info(msg),
      warn: (msg: string) => ctx.logger.warn(msg),
      debug: (msg: string) => ctx.logger.debug(msg),
    }

    const buildQueueConfig = (): QueueConfig => ({
      queueCmd,
      pollInterval,
      encryptedUserToken,
      gid,
      authInfo: { guid, userId },
      logger: queueLogger,
      // 每次构造新对象，确保 getOriginalFetch 始终返回最新的原始 fetch
      originalFetch: ctx.getOriginalFetch(),
    })

    // -------------------------------------------------------------------------
    // 注册 HTTP endpoint: 接收 Electron 主进程推送的加密 token（动态更新）
    // 解决时序问题：OpenClaw 启动时用户可能尚未登录；
    // 登录成功后，Electron 主进程通过此端点推送加密 token，内部解密后使用。
    //
    // 注意：HttpRouteRegistry 会自动加 /qclaw-plugin/queue-guard/ 前缀，
    // 最终端点为 `/qclaw-plugin/queue-guard/token`。
    // -------------------------------------------------------------------------
    ctx.registerHttpRoute({
      method: 'POST',
      path: 'token',
      handler: async (req: HttpRequest): Promise<HttpResponse> => {
        const body = (req.body ?? {}) as { encryptedUserToken?: unknown }
        const newToken = typeof body.encryptedUserToken === 'string' ? body.encryptedUserToken : ''
        if (!newToken) {
          return {
            status: 400,
            body: { success: false, error: 'encryptedUserToken is required' },
          }
        }
        setEncryptedUserToken(newToken)
        ctx.logger.info(`Encrypted user token updated dynamically (length=${newToken.length})`)
        return { status: 200, body: { success: true } }
      },
    })
    ctx.registerHttpRoute({
      method: 'PUT',
      path: 'token',
      handler: async (req: HttpRequest): Promise<HttpResponse> => {
        const body = (req.body ?? {}) as { encryptedUserToken?: unknown }
        const newToken = typeof body.encryptedUserToken === 'string' ? body.encryptedUserToken : ''
        if (!newToken) {
          return {
            status: 400,
            body: { success: false, error: 'encryptedUserToken is required' },
          }
        }
        setEncryptedUserToken(newToken)
        ctx.logger.info(`Encrypted user token updated dynamically via PUT (length=${newToken.length})`)
        return { status: 200, body: { success: true } }
      },
    })

    // -------------------------------------------------------------------------
    // 注册 llm_input 钩子：建立 session 与排队状态的关联
    // llm_input 在 LLM 请求发出前触发，hookCtx 中包含 sessionKey、channelId 等信息，
    // 而 fetch 中间件拿不到这些信息，因此通过此钩子作为桥梁（FIFO 队列）。
    // -------------------------------------------------------------------------
    ctx.onHook(
      'llm_input',
      async (event, hookCtx): Promise<HookHandlerResult | undefined> => {
        const sessionKey = (hookCtx.sessionKey || hookCtx.sessionId) as string | undefined
        const channelId = hookCtx.channelId as string | undefined
        const model = event.model as string | undefined
        const trigger = hookCtx.trigger as string | undefined

        // 通过 resolveQueryScene 综合判定当前 query 场景
        const queryScene = resolveQueryScene({
          sessionKey,
          sessionId: hookCtx.sessionId as string | undefined,
          channelId: channelId || 'electron',
          trigger,
        })

        ctx.logger.info(
          `llm_input: channelId=${channelId || '(unknown)'}, model=${model || '(unknown)'}, queryScene=${queryScene}`,
        )

        if (sessionKey) {
          // 入队 pending context，供后续 fetch 中间件消费（FIFO 队列，并发安全）
          pushPendingContext(sessionKey, queryScene)

          // 初始化 session 级别的排队状态（尚未开始排队，等待 fetch 中间件触发后更新）
          setSessionQueueInfo(sessionKey, {
            isQueuing: false,
            waitingCount: 0,
            startedAt: 0,
            ready: false,
            channelId,
            model,
            queryScene,
          })

          ctx.logger.debug(
            `llm_input: sessionKey=${sessionKey}, channelId=${channelId || '(unknown)'}, model=${model || '(unknown)'}, queryScene=${queryScene}`,
          )
        }

        return undefined
      },
      { priority: 300 },
    )

    // -------------------------------------------------------------------------
    // 注册 Gateway Method: 查询当前排队状态（客户端通过 WebSocket RPC 轮询）
    // 支持按 sessionKey 查询特定 session，也支持不传 sessionKey 查询全局状态（向后兼容）
    //
    // 注意：GatewayRegistry 自动注册两个方法名：
    //   1. `qclaw-plugin.queue-guard.status` （带前缀）
    //   2. `queue-guard.status`              （短名称别名，向后兼容）
    // -------------------------------------------------------------------------
    ctx.registerGatewayMethod('queue-guard.status', async (params) => {
      const requestedSessionKey = params?.sessionKey as string | undefined

      if (requestedSessionKey) {
        // 按 sessionKey 查询特定 session 的排队状态
        const sessionInfo = getSessionQueueInfo(requestedSessionKey)
        return {
          isQueuing: sessionInfo?.isQueuing ?? false,
          waitingCount: sessionInfo?.waitingCount ?? 0,
          startedAt: sessionInfo?.startedAt ?? 0,
          ready: sessionInfo?.ready ?? false,
          channelId: sessionInfo?.channelId,
          model: sessionInfo?.model,
        }
      }

      // 全局查询（向后兼容）
      const info = getQueueInfo()
      return {
        isQueuing: info?.isQueuing ?? false,
        waitingCount: info?.waitingCount ?? 0,
        startedAt: info?.startedAt ?? 0,
        ready: info?.ready ?? false,
      }
    })

    // -------------------------------------------------------------------------
    // 注册 Gateway Method: 中止当前排队轮询（用户点击"停止输出"时由客户端调用）
    // -------------------------------------------------------------------------
    ctx.registerGatewayMethod('queue-guard.abort', async (params) => {
      const targetSessionKey = params?.sessionKey as string | undefined
      const aborted = abortCurrentQueue(targetSessionKey)
      ctx.logger.info(
        `abort requested via WebSocket: sessionKey=${targetSessionKey || '(global)'}, aborted=${aborted}`,
      )
      return { success: true, aborted }
    })

    // -------------------------------------------------------------------------
    // 注册 FetchMiddleware: 拦截 LLM 请求，在 onRequest 阶段执行排队轮询
    //
    // 洋葱模型工作原理：
    // 1. priority 较小的中间件先进入 onRequest（最外层）
    // 2. 检测是否为 LLM 请求：非 LLM 请求直接 return ctx 让其他中间件继续
    // 3. LLM 请求：调用 waitForQueueReady 轮询排队
    //    - 排队通过：正常 return ctx，FetchChain 继续执行 originalFetch
    //    - 排队被用户 abort：设置 shortCircuitResponse，跳过真实请求
    //    - 排队超时/接口异常：fail-open，正常 return ctx 让请求发出
    // -------------------------------------------------------------------------
    let interceptCount = 0

    const middleware: FetchMiddleware = {
      id: LOG_TAG,
      priority: 300,
      // 非 POST 请求或无 body 的请求直接跳过（快速路径）。
      // 不再按 URL 前缀过滤 —— 以允许 onRequest 内部按 body.model 兜底判定
      // （覆盖 QCLAW_LLM_BASE_URL 未注入 / 误改、grey/dev 环境等场景）。
      match: (input, init) => {
        const method = (init?.method || 'GET').toUpperCase()
        if (method === 'GET') return false
        if (!init?.body) return false
        return true
      },
      onRequest: async (reqCtx) => {
        const url = typeof reqCtx.input === 'string'
          ? reqCtx.input
          : (reqCtx.input as Request | URL).toString()
        const method = (reqCtx.init?.method || 'GET').toUpperCase()

        ctx.logger.debug(`fetch intercepted: method=${method}, url=${url}`)

        const jsonBody = tryParseBody(reqCtx.init?.body)
        if (!jsonBody) {
          ctx.logger.debug(`skip (body not JSON): url=${url}`)
          return reqCtx
        }

        // 仅对「候选 LLM 请求」（含 model + 非空 messages）做检测与上报，
        // 避免大量 OpenClaw 内部后处理请求（只有 messages 无 model）污染上报数据。
        const candidateModel = typeof jsonBody.model === 'string' ? jsonBody.model : ''
        const candidateMessages = Array.isArray(jsonBody.messages) ? jsonBody.messages : null
        const isCandidate = !!candidateModel && !!candidateMessages && candidateMessages.length > 0

        if (!isCandidate) {
          const bodyKeys = Object.keys(jsonBody).join(', ')
          ctx.logger.debug(`skip (not candidate LLM body, keys=[${bodyKeys}]): url=${url}`)
          return reqCtx
        }

        // 内置 provider 的请求 URL 前缀（从环境变量读取，用于区分自定义模型请求）
        const builtinLlmBaseUrl = process.env.QCLAW_LLM_BASE_URL || ''
        const isLlm = isLLMRequest(url, jsonBody, builtinLlmBaseUrl)

        // 上报本次候选 LLM 请求的检测结果（命中 + miss 都上报，用于观测覆盖率）
        try {
          const urlWithoutQuery = url.split('?')[0] ?? url
          ctx.reporter.report(REPORT_CONST.PLUGIN, {
            module_id: 'QueueGuard',
            component_id: 'LLMDetect',
            event_code: 'llm_detect',
            action_type: 'queue_guard_detect',
            action_status: isLlm ? 'success' : 'fail',
            statistics: {
              is_llm: isLlm,
              url: urlWithoutQuery,
              method,
              model: candidateModel,
              messages_count: candidateMessages.length,
              has_base_url: Boolean(builtinLlmBaseUrl),
              builtin_base_url: builtinLlmBaseUrl,
            },
          })
        } catch (err) {
          // 上报失败不影响主流程
          ctx.logger.debug(
            `reporter.report failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          )
        }

        // 非 LLM 请求直接放行
        if (!isLlm) {
          ctx.logger.debug(`skip (not LLM request, model=${candidateModel}): url=${url}`)
          return reqCtx
        }

        // ========== LLM 请求 → 排队检查 ==========
        interceptCount++
        const queryId = `qg-${Date.now()}-${interceptCount}`
        const msgCount = candidateMessages.length
        const modelId = candidateModel

        ctx.logger.info(
          `✅ LLM request detected (#${interceptCount}), url=${url}, messages=${msgCount}, queryId=${queryId}, model=${modelId}`,
        )

        // 消费 llm_input 钩子设置的 pending context（FIFO 队列，并发安全）
        const pendingCtx = shiftPendingContext()
        const currentSessionKey = pendingCtx?.sessionKey ?? null
        const currentQueryScene = pendingCtx?.queryScene ?? null

        if (currentSessionKey) {
          ctx.logger.debug(
            `consumed pendingContext: sessionKey=${currentSessionKey}, queryScene=${currentQueryScene}, queryId=${queryId}`,
          )
        }

        // 重置排队状态，确保新请求的 ready 从 false 开始
        resetQueueInfo()
        // 同时清除 session 级别的残留状态（上一次排队的 ready: true）
        if (currentSessionKey) {
          clearSessionQueueInfo(currentSessionKey)
        }

        const queueStartTime = Date.now()
        const queueConfig = buildQueueConfig()
        let ready: boolean
        try {
          ready = await waitForQueueReady(
            queryId,
            queueConfig,
            currentSessionKey ?? undefined,
            currentQueryScene ?? undefined,
            modelId || undefined,
          )
        } catch {
          // 排队被用户中止 — 通过 shortCircuitResponse 返回模拟响应，跳过真实请求
          const queueElapsed = Date.now() - queueStartTime
          ctx.logger.info(
            `queue aborted after ${queueElapsed}ms, blocking LLM request, queryId=${queryId}`,
          )
          reqCtx.shortCircuitResponse = buildAbortedLlmResponse(
            jsonBody,
            '当前为高峰期，已为您暂停任务。',
          )
          return reqCtx
        }

        const queueElapsed = Date.now() - queueStartTime
        if (!ready) {
          // 排队超时 — 仍然放行请求（fail-open 策略）
          ctx.logger.warn(
            `queue timeout after ${queueElapsed}ms, proceeding anyway (fail-open), queryId=${queryId}`,
          )
        } else {
          ctx.logger.info(
            `queue passed in ${queueElapsed}ms, sending real request, queryId=${queryId}`,
          )
        }

        return reqCtx
      },
    }

    ctx.registerFetchMiddleware(middleware)
    ctx.logger.info('plugin registered successfully (fetch middleware installed)')
  },
}

export default queueGuard

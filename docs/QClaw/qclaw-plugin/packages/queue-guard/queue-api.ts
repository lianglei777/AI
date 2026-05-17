/**
 * queue-guard: 排队接口调用模块
 *
 * 负责调用 JPRX 网关的排队状态查询接口，判断模型是否繁忙。
 */

import { EventEmitter } from 'node:events'
import { buildJprxCtxHeader } from './jprx-sign.js'
import { decryptAesCbc } from './aes-decrypt.js'

// ---------------------------------------------------------------------------
// 跨插件共享事件总线（通过 Symbol.for() 挂载在 globalThis 上）
// ---------------------------------------------------------------------------
// OpenClaw 插件加载器为每个插件创建独立的模块作用域，
// 导致不同插件中的 process 和 globalThis 字符串 key 不共享。
// 使用 Symbol.for() 创建全局唯一 Symbol 作为 key，确保跨插件通信可靠。
// 这与 wechat-access 中 content-plugin 的跨插件桥接模式一致
// （参见 report-data.ts 中的 Symbol.for('openclaw.contentPluginReportBridge')）。
//
// 迁移到 qclaw-plugin 后仍然保留此 Symbol key，以兼容 wechat-access、weixin、
// dingtalk-connector 等独立插件已有的 queue-guard:notify / queue-guard:state 监听。

const QUEUE_GUARD_BUS_SYMBOL = Symbol.for('openclaw.queueGuardEventBus')

/** 获取（或创建）挂载在 globalThis 上的共享事件总线 */
export function getQueueGuardBus(): EventEmitter {
  const g = globalThis as Record<symbol, unknown>
  if (!g[QUEUE_GUARD_BUS_SYMBOL]) {
    const bus = new EventEmitter()
    bus.setMaxListeners(20)
    g[QUEUE_GUARD_BUS_SYMBOL] = bus
  }
  return g[QUEUE_GUARD_BUS_SYMBOL] as EventEmitter
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** JPRX 网关 URL（根据 BUILD_ENV 环境变量区分） */
function getQueueApiBaseUrl(): string {
  const env = process.env.BUILD_ENV || 'production'
  return env === 'production' ? 'https://jprx.m.qq.com/' : 'https://jprx.sparta.html5.qq.com/'
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 排队接口响应结构 */
interface QueueStatusResponse {
  ret?: number
  data?: {
    resp?: {
      common?: { code: number; message: string }
      data?: { waiting_count: number; should_wait: boolean }
    }
  }
}

export interface QueueResult {
  should_wait: boolean
  waiting_count: number
}

export interface QueueLogger {
  info: (msg: string) => void
  warn: (msg: string) => void
  debug: (msg: string) => void
}

export interface QueueConfig {
  /** 排队接口命令字 */
  queueCmd: string
  /** 轮询间隔（毫秒） */
  pollInterval: number
  /** 认证信息 */
  authInfo: {
    guid?: string
    userId?: string
  }
  /** AES-128-CBC 加密后的用户 token（由 Electron 主进程通过环境变量或 HTTP endpoint 推送） */
  encryptedUserToken: string
  /** 客户端设备标识（gid），用于 JPrx 防重放签名 */
  gid: string
  /** 日志函数 */
  logger: QueueLogger
  /** 原始 fetch（由 ctx.getOriginalFetch() 提供，绕过 qclaw-plugin 自身拦截链） */
  originalFetch: typeof globalThis.fetch
}

// ---------------------------------------------------------------------------
// 动态加密 token 更新 + 解密缓存
// ---------------------------------------------------------------------------

/** 运行时可动态更新的加密 token（解决启动时用户尚未登录的时序问题） */
let _dynamicEncryptedToken: string | null = null

/** 解密缓存：避免每次请求都重复解密 */
let _decryptCache: { encrypted: string; decrypted: string } | null = null

/** 更新加密 token（由 HTTP endpoint 推送调用） */
export function setEncryptedUserToken(token: string): void {
  _dynamicEncryptedToken = token
  // 清除解密缓存，下次请求时会重新解密
  _decryptCache = null
}

/** 获取当前有效的加密 token（动态更新优先，否则使用初始值） */
function getEffectiveEncryptedToken(config: QueueConfig): string {
  return _dynamicEncryptedToken ?? config.encryptedUserToken
}

/**
 * 解密加密 token 得到明文 JWT（带缓存）
 * /data/{cmd}/forward 路径需要明文 JWT，不能用加密密文
 */
function decryptToJwt(encryptedToken: string, logger: QueueLogger): string | null {
  if (!encryptedToken) return null

  // 缓存命中
  if (_decryptCache && _decryptCache.encrypted === encryptedToken) {
    return _decryptCache.decrypted
  }

  try {
    const decrypted = decryptAesCbc(encryptedToken)
    _decryptCache = { encrypted: encryptedToken, decrypted }
    logger.debug(`[queue-guard] decryptToJwt: success, jwt length=${decrypted.length}`)
    return decrypted
  } catch (err) {
    logger.warn(`[queue-guard] decryptToJwt: failed, err=${String(err)}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// 排队状态：供客户端通过 Gateway Method 查询当前排队进度
// ---------------------------------------------------------------------------

/** 当前排队状态信息（null 表示未在排队） */
export interface QueueInfo {
  /** 是否正在排队 */
  isQueuing: boolean
  /** 前方等待人数 */
  waitingCount: number
  /** 排队开始时间戳 */
  startedAt: number
  /** 排队流程是否已完成（不需要排队或排队已通过），客户端可据此立即停止轮询 */
  ready: boolean
}

let _currentQueueInfo: QueueInfo | null = null

/**
 * 获取当前排队状态（供 Gateway Method `queue-guard.status` 调用）
 */
export function getQueueInfo(): QueueInfo | null {
  return _currentQueueInfo
}

/**
 * 重置排队状态为初始值（供下一次 LLM 请求开始前调用）
 */
export function resetQueueInfo(): void {
  _currentQueueInfo = null
}

// ---------------------------------------------------------------------------
// Session 级别排队状态：支持按 sessionKey 查询各渠道独立的排队进度
// ---------------------------------------------------------------------------

/** Session 级别的排队状态信息（扩展 QueueInfo，增加渠道和模型信息） */
export interface SessionQueueInfo extends QueueInfo {
  /** 渠道标识（如 "wechat"、"qq"、"electron"） */
  channelId?: string
  /** 触发排队的模型名称 */
  model?: string
  /** 查询场景类型（如 "user_query"、"heartbeat"、"scheduled" 等） */
  queryScene?: string
}

/** sessionKey → 排队状态 的映射表 */
const _sessionQueueMap = new Map<string, SessionQueueInfo>()

/**
 * 设置指定 session 的排队状态（由 llm_input 钩子调用，建立 session 与排队的关联）
 */
export function setSessionQueueInfo(sessionKey: string, info: SessionQueueInfo): void {
  _sessionQueueMap.set(sessionKey, info)
}

/**
 * 获取指定 session 的排队状态（供 queue-guard.status 按 sessionKey 查询）
 */
export function getSessionQueueInfo(sessionKey: string): SessionQueueInfo | null {
  return _sessionQueueMap.get(sessionKey) ?? null
}

/**
 * 清除指定 session 的排队状态（排队完成或 session 结束时调用）
 */
export function clearSessionQueueInfo(sessionKey: string): void {
  _sessionQueueMap.delete(sessionKey)
}

// ---------------------------------------------------------------------------
// Pending context 队列：llm_input 钩子 → fetch 中间件的桥梁（FIFO 队列）
// ---------------------------------------------------------------------------
// 并发场景下（如用户在 A 会话排队时切换到 B 会话发送消息），
// 多个 llm_input 钩子可能在 fetch 中间件消费之前连续触发。
// 使用 FIFO 队列替代单一变量，确保每个 llm_input 设置的上下文
// 都能被对应的 fetch 中间件正确消费，不会被后续请求覆盖。

interface PendingContext {
  sessionKey: string
  queryScene: string
}

const _pendingContextQueue: PendingContext[] = []

/** 入队：由 llm_input 钩子调用，设置待处理的 sessionKey 和 queryScene */
export function pushPendingContext(sessionKey: string, queryScene: string): void {
  _pendingContextQueue.push({ sessionKey, queryScene })
}

/** 出队：由 fetch 中间件调用，消费最早入队的上下文（FIFO） */
export function shiftPendingContext(): PendingContext | null {
  return _pendingContextQueue.shift() ?? null
}

// ---------------------------------------------------------------------------
// Abort 机制：允许外部中止排队轮询（per-session）
// ---------------------------------------------------------------------------

/** sessionKey → AbortController 的映射表，支持并发排队场景下精确中止特定 session 的排队 */
const _sessionAbortControllers = new Map<string, AbortController>()

/** 最近一次排队的 AbortController（无 sessionKey 时的 fallback） */
let _latestAbortController: AbortController | null = null

/** 注册指定 session 的 AbortController（由 waitForQueueReady 调用） */
export function setSessionAbortController(
  sessionKey: string | undefined,
  controller: AbortController,
): void {
  _latestAbortController = controller
  if (sessionKey) {
    _sessionAbortControllers.set(sessionKey, controller)
  }
}

/** 移除指定 session 的 AbortController（排队完成或中止后调用） */
export function removeSessionAbortController(sessionKey: string | undefined): void {
  if (sessionKey) {
    _sessionAbortControllers.delete(sessionKey)
  }
  // 如果移除的是最近一次的 controller，也清除 fallback
  // （不精确清除也无妨，只是 fallback 会指向已完成的 controller）
}

/**
 * 中止排队轮询。
 * 由 gateway method `queue-guard.abort` 调用，在用户点击"停止输出"时触发。
 * @param sessionKey 可选，指定要中止的 session；不传则中止最近一次排队
 */
export function abortCurrentQueue(sessionKey?: string): boolean {
  if (sessionKey) {
    const controller = _sessionAbortControllers.get(sessionKey)
    if (controller) {
      controller.abort()
      _sessionAbortControllers.delete(sessionKey)
      return true
    }
  }
  // fallback：中止最近一次排队（向后兼容）
  if (_latestAbortController) {
    _latestAbortController.abort()
    _latestAbortController = null
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// 排队接口调用
// ---------------------------------------------------------------------------

/**
 * 调用排队接口查询模型是否繁忙
 * @param queryId 唯一标识本次请求
 * @param config 排队配置
 * @returns { should_wait, waiting_count } 或 null（接口异常时）
 */
export async function checkQueueStatus(
  queryId: string,
  config: QueueConfig,
  queryScene?: string,
  modelId?: string,
): Promise<QueueResult | null> {
  const baseUrl = getQueueApiBaseUrl()
  const url = `${baseUrl}data/${config.queueCmd}/forward`
  // 默认模型（modelroute）传递 "default"，其他模型传递实际 modelId
  const effectiveModelId = !modelId || modelId === 'modelroute' ? 'default' : modelId
  const bodyObj: Record<string, string | Record<string, string>> = {
    query_id: queryId,
    user_model: effectiveModelId,
    web_version: '1.0.0',
    web_env: 'release',
  }
  // 构建 task_tags：包含 scene（查询场景）和 model_id（模型标识）
  const taskTags: Record<string, string> = {}
  if (queryScene) taskTags.scene = queryScene
  if (Object.keys(taskTags).length > 0) {
    bodyObj.task_tags = taskTags
  }
  const body = JSON.stringify(bodyObj)

  const encryptedToken = getEffectiveEncryptedToken(config)
  const jwtToken = decryptToJwt(encryptedToken, config.logger)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Version': '1',
    'X-Guid': config.authInfo.guid || '1',
    'X-Account': config.authInfo.userId || '1',
    'X-Session': '',
  }

  // 解密后的明文 JWT token 鉴权（/data/{cmd}/forward 路径需要明文 JWT）
  if (jwtToken) {
    headers['X-OpenClaw-Token'] = jwtToken
  }

  // JPrx 防重放签名
  headers['JPrx-Ctx'] = buildJprxCtxHeader(body, config.gid)

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 500)
    const res = await config.originalFetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!res.ok) {
      config.logger.warn(`[queue-guard] checkQueueStatus: HTTP ${res.status}, queryId=${queryId}`)
      return null
    }

    const json: QueueStatusResponse = await res.json()
    config.logger.warn(
      `[queue-guard] checkQueueStatus: FULL response=${JSON.stringify(json)}, queryId=${queryId}`,
    )

    const data = json?.data?.resp?.data
    if (!data) {
      config.logger.warn(
        `[queue-guard] checkQueueStatus: unexpected response structure, ret=${json?.ret}, queryId=${queryId}`,
      )
      return null
    }

    config.logger.debug(
      `[queue-guard] checkQueueStatus: should_wait=${data.should_wait}, waiting_count=${data.waiting_count}, queryId=${queryId}`,
    )

    return { should_wait: data.should_wait, waiting_count: data.waiting_count }
  } catch (err) {
    config.logger.warn(`[queue-guard] checkQueueStatus: failed queryId=${queryId}, err=${String(err)}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// 排队轮询
// ---------------------------------------------------------------------------

/**
 * 排队轮询：阻塞直到模型资源可用
 * @param queryId 唯一标识
 * @param config 排队配置
 * @returns true 表示排队完成（可以发请求），false 表示超时
 */
export async function waitForQueueReady(
  queryId: string,
  config: QueueConfig,
  sessionKey?: string,
  queryScene?: string,
  modelId?: string,
): Promise<boolean> {
  const startTime = Date.now()

  // 创建 AbortController，供外部中止排队（per-session）
  const abortController = new AbortController()
  setSessionAbortController(sessionKey, abortController)

  config.logger.debug(
    `[queue-guard] waitForQueueReady: start, queryId=${queryId}, pollInterval=${config.pollInterval}ms`,
  )

  /** 辅助函数：同时更新全局和 session 级别的排队状态，并通过事件总线通知其他插件 */
  const updateQueueState = (info: QueueInfo) => {
    _currentQueueInfo = info
    if (sessionKey) {
      const existing = _sessionQueueMap.get(sessionKey)
      const sessionInfo: SessionQueueInfo = {
        ...info,
        channelId: existing?.channelId,
        // 优先使用 fetch 中间件提取的 modelId（更准确），回退到 llm_input 钩子设置的 model
        model: modelId || existing?.model,
      }
      _sessionQueueMap.set(sessionKey, sessionInfo)
      // 通过 globalThis 上的共享事件总线通知其他插件（如 wechat-access）排队状态变化
      const bus = getQueueGuardBus()
      bus.emit('queue-guard:state', { sessionKey, ...sessionInfo })
    }
  }

  // [调试] 强制模拟排队：跳过真实接口，返回假数据模拟完整排队→通过流程
  // DEBUG_FORCE_QUEUE_POLLS: 模拟排队的轮询次数，设为 0 则关闭模拟
  const DEBUG_FORCE_QUEUE_POLLS = 0
  let _debugRemainingPolls = DEBUG_FORCE_QUEUE_POLLS
  let first: QueueResult | null
  if (DEBUG_FORCE_QUEUE_POLLS > 0) {
    config.logger.warn(
      `[queue-guard] [DEBUG] force queue mode enabled, will simulate ${DEBUG_FORCE_QUEUE_POLLS} polls before ready, queryId=${queryId}`,
    )
    first = { should_wait: true, waiting_count: DEBUG_FORCE_QUEUE_POLLS * 20 }
  } else {
    first = await checkQueueStatus(queryId, config, queryScene, modelId)
    if (!first) {
      config.logger.warn(
        `[queue-guard] waitForQueueReady: first check returned null (API error), fail-open, queryId=${queryId}`,
      )
      removeSessionAbortController(sessionKey)
      updateQueueState({ isQueuing: false, waitingCount: 0, startedAt: 0, ready: true })
      return true
    }
    if (!first.should_wait) {
      config.logger.info(`[queue-guard] waitForQueueReady: no queue needed, queryId=${queryId}`)
      removeSessionAbortController(sessionKey)
      updateQueueState({ isQueuing: false, waitingCount: 0, startedAt: 0, ready: true })
      return true
    }
  }

  // 需要排队 — 更新排队状态供客户端查询
  const queueStartedAt = Date.now()
  updateQueueState({
    isQueuing: true,
    waitingCount: first.waiting_count,
    startedAt: queueStartedAt,
    ready: false,
  })
  config.logger.info(
    `[queue-guard] entering queue, waiting_count=${first.waiting_count}, queryId=${queryId}`,
  )

  // =========================================================================
  // 多阶段排队通知定时器
  // =========================================================================
  // 阶段1（立即）：任务准备中，正在为您智能调度算力
  // 阶段2（45秒后）：当前请求较多，感谢您的耐心等候
  // 之后静默等待，排队完成后发送完成通知
  let _latestWaitingCount = first.waiting_count
  const notifyTimers: ReturnType<typeof setTimeout>[] = []

  const emitQueueNotify = (text: string) => {
    if (sessionKey) {
      const bus = getQueueGuardBus()
      bus.emit('queue-guard:notify', { sessionKey, text })
      config.logger.info(
        `[queue-guard] queue-notify emitted: sessionKey=${sessionKey}, text=${text.slice(0, 60)}`,
      )
    }
  }

  // 阶段1：立即发送
  {
    const countText = _latestWaitingCount > 0 ? `前方还有 ${_latestWaitingCount} 个请求，` : ''
    emitQueueNotify(`⏳ 任务准备中，正在为您智能调度算力，${countText}加速处理中。`)
  }

  // 阶段2：45秒后
  notifyTimers.push(
    setTimeout(() => {
      const countText = _latestWaitingCount > 0 ? `前方还有 ${_latestWaitingCount} 个请求，` : ''
      emitQueueNotify(`⏳ ${countText}仍在加速处理中，感谢您的耐心等候。`)
    }, 45_000),
  )

  /** 清理所有通知定时器 */
  const clearNotifyTimers = () => {
    for (const t of notifyTimers) clearTimeout(t)
    notifyTimers.length = 0
  }

  // 轮询等待（无超时限制，用户可通过 abort 手动中止）
  let pollCount = 0
  while (true) {
    // 检查是否被外部中止
    if (abortController.signal.aborted) {
      removeSessionAbortController(sessionKey)
      clearNotifyTimers()
      updateQueueState({ isQueuing: false, waitingCount: 0, startedAt: 0, ready: true })
      const elapsed = Date.now() - startTime
      config.logger.info(
        `[queue-guard] queue aborted by user after ${elapsed}ms, pollCount=${pollCount}, queryId=${queryId}`,
      )
      throw new Error(`[queue-guard] queue aborted by user, queryId=${queryId}`)
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, config.pollInterval)
      // 如果在等待期间被 abort，立即结束 sleep
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      abortController.signal.addEventListener('abort', onAbort, { once: true })
    })

    // sleep 结束后再次检查 abort
    if (abortController.signal.aborted) {
      removeSessionAbortController(sessionKey)
      clearNotifyTimers()
      updateQueueState({ isQueuing: false, waitingCount: 0, startedAt: 0, ready: true })
      const elapsed = Date.now() - startTime
      config.logger.info(
        `[queue-guard] queue aborted by user after ${elapsed}ms, pollCount=${pollCount}, queryId=${queryId}`,
      )
      throw new Error(`[queue-guard] queue aborted by user, queryId=${queryId}`)
    }

    pollCount++

    // [调试] 模拟模式下使用假数据，逐步递减 waiting_count 直到排队通过
    let status: QueueResult | null
    if (DEBUG_FORCE_QUEUE_POLLS > 0 && _debugRemainingPolls > 0) {
      _debugRemainingPolls--
      if (_debugRemainingPolls === 0) {
        status = { should_wait: false, waiting_count: 0 }
        config.logger.warn(
          `[queue-guard] [DEBUG] poll #${pollCount}: simulated queue ready, queryId=${queryId}`,
        )
      } else {
        const fakeCount = _debugRemainingPolls * 20
        status = { should_wait: true, waiting_count: fakeCount }
        config.logger.warn(
          `[queue-guard] [DEBUG] poll #${pollCount}: simulated waiting_count=${fakeCount}, remaining=${_debugRemainingPolls}, queryId=${queryId}`,
        )
      }
    } else {
      status = await checkQueueStatus(queryId, config, queryScene, modelId)
    }
    if (!status) {
      removeSessionAbortController(sessionKey)
      clearNotifyTimers()
      emitQueueNotify(`✅ 调度完成，正在生成回复...`)
      updateQueueState({ isQueuing: false, waitingCount: 0, startedAt: 0, ready: true })
      const elapsed = Date.now() - startTime
      config.logger.warn(
        `[queue-guard] poll #${pollCount} returned null (API error), fail-open, queryId=${queryId}, elapsed=${elapsed}ms`,
      )
      return true
    }
    if (!status.should_wait) {
      removeSessionAbortController(sessionKey)
      clearNotifyTimers()
      emitQueueNotify(`✅ 调度完成，正在生成回复...`)
      updateQueueState({ isQueuing: false, waitingCount: 0, startedAt: 0, ready: true })
      const totalElapsed = Date.now() - startTime
      config.logger.info(
        `[queue-guard] queue ready after ${pollCount} polls (${totalElapsed}ms), queryId=${queryId}`,
      )
      return true
    }

    // 更新排队状态供客户端查询
    _latestWaitingCount = status.waiting_count
    updateQueueState({
      isQueuing: true,
      waitingCount: status.waiting_count,
      startedAt: queueStartedAt,
      ready: false,
    })

    const elapsed = Date.now() - startTime
    config.logger.debug(
      `[queue-guard] poll #${pollCount}: still waiting, waiting_count=${status.waiting_count}, elapsed=${elapsed}ms, queryId=${queryId}`,
    )
  }
}

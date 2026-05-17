/**
 * core/reporter.ts — 伽利略遥测上报核心服务
 *
 * 从 claw-plugin-report/reporter.ts 迁移并适配 qclaw-plugin 架构。
 * 采用类实例（非模块级单例），由 qclaw-plugin index.ts 统一创建和管理。
 *
 * 关键改动（相比原 claw-plugin-report）：
 * 1. 从模块级全局状态 → 类实例状态（支持多实例测试）
 * 2. 去掉 GalileoReport 单例类包装，直接暴露 QClawReporter 类
 * 3. 去掉 configDir 配置文件加载（配置收入 configSchema）
 * 4. 新增 createPackageReporter() 工厂方法，为每个 package 创建带 packageId 的代理
 *
 * 上报格式参考伽利略网页上报文档：
 * https://iwiki.woa.com/p/4012224355
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, platform, hostname } from 'node:os'

import type {
  ReporterInitOptions,
  ReporterLogger,
  PendingEvent,
  QClawSharedParams,
  TelemetryReporter,
} from './reporter-types.js'
import {
  REPORT_URL,
  ELECTRON_REPORT_TOKEN,
  PENDING_QUEUE_MAX_SIZE,
  HTTP_TIMEOUT_MS,
  FLUSH_INTERVAL_MS,
  RATE_LIMIT_MAX_TOKENS,
  RATE_LIMIT_WINDOW_MS,
  SHARED_PARAMS_SYNC_INTERVAL_MS,
  SDK_VERSION,
  MAX_RETRY_COUNT,
  QCLAW_STATE_DIR_NAME,
  QCLAW_META_FILE_NAME,
} from './reporter-constants.js'
import { addQclawPrefix, generateUUID, generateId, safeStringify } from './reporter-utils.js'

const LOG_TAG = '[qclaw-reporter]'

/**
 * QClawReporter — 伽利略遥测上报核心类
 *
 * 由 qclaw-plugin index.ts 创建唯一实例，通过 createPackageReporter()
 * 为每个 package 生成带 packageId 的 TelemetryReporter 代理。
 */
export class QClawReporter {
  // ---- 内部状态 ----
  private pendingQueue: PendingEvent[] = []
  private isFlushing = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private rateLimitTokensUsed = 0
  private rateLimitWindowStart = 0
  private cachedParams: Record<string, unknown> = {}
  private logger: ReporterLogger = console
  private enabled = true
  private initialized = false
  private initConfig: { reportToken: string; hostUrl: string; env: string } | null = null
  private lastInitOptions: ReporterInitOptions | null = null
  private sharedParamsSyncTimer: ReturnType<typeof setInterval> | null = null
  private deviceId = ''
  private sessionId = ''
  private openclawVersion = ''

  /**
   * 初始化上报模块
   */
  init(options: ReporterInitOptions): void {
    if (options.logger) {
      this.logger = options.logger
    }

    // 缓存初始化参数，用于 gateway restart 后自恢复
    this.lastInitOptions = { ...options }

    this.logger.info(`${LOG_TAG} init 开始`)

    // 合并配置
    const reportToken = options.reportToken ?? ELECTRON_REPORT_TOKEN
    const hostUrl = options.hostUrl ?? REPORT_URL
    const env = options.env ?? 'production'

    // OpenClaw 版本号
    if (options.openclawVersion) {
      this.openclawVersion = options.openclawVersion
    }

    // 从 ~/.qclaw/qclaw.json 读取共享参数
    this.syncFromSharedParams()

    // 覆盖 sessionId
    if (options.sessionId) {
      this.sessionId = options.sessionId
    }

    // 生成设备 ID（如果没有从共享参数获取）
    if (!this.deviceId) {
      this.deviceId = generateUUID()
    }

    // 生成 sessionId（如果没有从共享参数获取）
    if (!this.sessionId) {
      this.sessionId = generateUUID()
    }

    // 缓存配置
    this.initConfig = { reportToken, hostUrl, env }
    this.initialized = true

    // 启动定时同步
    this.startSharedParamsSync()

    this.logger.info(`${LOG_TAG} init 完成, env=${env}, sessionId=${this.sessionId}, deviceId=${this.deviceId}`)
  }

  /**
   * 上报事件（fire-and-forget）
   */
  reportEvent(name: string, options: Record<string, unknown> = {}): void {
    if (!this.enabled) return
    if (!this.initialized && !this.tryAutoRecover()) {
      this.logger.warn(`${LOG_TAG} reportEvent: 模块未初始化`)
      return
    }
    if (!name) {
      this.logger.warn(`${LOG_TAG} 事件名称不能为空`)
      return
    }

    // 加入待上报队列
    if (this.pendingQueue.length >= PENDING_QUEUE_MAX_SIZE) {
      const dropped = this.pendingQueue.shift()
      this.logger.warn(`${LOG_TAG} 队列已满，丢弃最早事件: ${dropped?.name}`)
    }

    this.pendingQueue.push({
      name,
      options,
      timestamp: Date.now(),
    })

    this.scheduleFlush()
  }

  /**
   * 异步上报事件（可 await）
   */
  async reportEventAsync(name: string, options: Record<string, unknown> = {}): Promise<void> {
    if (!this.enabled) return
    if (!this.initialized && !this.tryAutoRecover()) return
    if (!name) {
      this.logger.warn(`${LOG_TAG} 事件名称不能为空`)
      return
    }

    const event: PendingEvent = {
      name,
      options,
      timestamp: Date.now(),
    }

    await this.sendReport(event)
  }

  /**
   * 设置上报公共参数
   */
  setCommonParams(params: Record<string, unknown>): void {
    if (params.guid && typeof params.guid === 'string') {
      this.deviceId = params.guid
    }
    if (params.sessionId && typeof params.sessionId === 'string') {
      this.sessionId = params.sessionId
    }
    // 剔除已被单独管理的字段，避免通过 addQclawPrefix 重复上报
    const { sessionId: _sid, session: _sess, ...restParams } = params
    this.cachedParams = { ...this.cachedParams, ...restParams }
  }

  /**
   * 设置 OpenClaw 版本号
   */
  setOpenclawVersion(version: string): void {
    this.openclawVersion = version
  }

  /**
   * 检查上报模块是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized && this.enabled
  }

  /**
   * 销毁上报模块
   */
  destroy(): void {
    this.stopSharedParamsSync()

    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    // 尝试发送剩余事件
    const remaining = this.pendingQueue.splice(0)
    this.pendingQueue = []
    this.isFlushing = false

    if (remaining.length > 0) {
      this.pendingQueue = remaining
      void this.flushQueue().finally(() => {
        this.pendingQueue = []
        this.isFlushing = false
      })
    }

    this.cachedParams = {}
    this.enabled = true
    this.initialized = false
    this.initConfig = null
    // lastInitOptions 故意不重置，支持 gateway restart 后自恢复
    this.deviceId = ''
    this.sessionId = ''
    this.openclawVersion = ''
    this.rateLimitTokensUsed = 0
    this.rateLimitWindowStart = 0
  }

  /**
   * 为指定 package 创建带 packageId 的 TelemetryReporter 代理
   *
   * 每个 package 通过 ctx.reporter 获取的就是这个代理实例。
   * 上报时自动携带 packageId 作为 page_id。
   */
  createPackageReporter(packageId: string): TelemetryReporter {
    return {
      report: (name: string, options: Record<string, unknown> = {}) => {
        this.reportEvent(name, { page_id: packageId, ...options, plugin_id: packageId })
      },
      reportAsync: async (name: string, options: Record<string, unknown> = {}) => {
        await this.reportEventAsync(name, { page_id: packageId, ...options, plugin_id: packageId })
      },
      setCommonParams: (params: Record<string, unknown>) => {
        this.setCommonParams(params)
      },
      isInitialized: () => {
        return this.isInitialized()
      },
    }
  }

  // ==================== 内部方法 ====================

  /**
   * 从 ~/.qclaw/qclaw.json 读取主进程共享的运行时参数
   */
  readSharedParams(): QClawSharedParams {
    try {
      const metaPath = join(homedir(), QCLAW_STATE_DIR_NAME, QCLAW_META_FILE_NAME)
      if (!existsSync(metaPath)) {
        return {}
      }

      const raw = readFileSync(metaPath, 'utf-8')
      const meta = JSON.parse(raw) as Record<string, unknown>

      if (typeof meta.sharedParams === 'object' && meta.sharedParams !== null) {
        return meta.sharedParams as QClawSharedParams
      }

      return {}
    } catch (err) {
      this.logger.warn(`${LOG_TAG} 读取共享参数失败:`, err)
      return {}
    }
  }

  /**
   * 从共享参数同步到内部缓存
   */
  syncFromSharedParams(forceUpdate = false): boolean {
    const shared = this.readSharedParams()

    const toSync: Record<string, unknown> = {}
    let hasUpdate = false

    if (shared.sessionId) {
      if (forceUpdate) {
        if (this.sessionId !== shared.sessionId) {
          this.sessionId = shared.sessionId
          hasUpdate = true
        }
      } else if (!this.sessionId) {
        this.sessionId = shared.sessionId
      }
    }

    if (shared.guid && !this.cachedParams.guid) {
      toSync.guid = shared.guid
      this.deviceId = shared.guid
    }

    if (shared.appVersion && !this.cachedParams.app_version) {
      toSync.app_version = shared.appVersion
    }

    if (shared.appChannel && !this.cachedParams.app_channel) {
      toSync.app_channel = shared.appChannel
    }

    if (shared.platform && !this.cachedParams.platform) {
      toSync.platform = shared.platform
    }

    if (Object.keys(toSync).length > 0) {
      this.cachedParams = { ...this.cachedParams, ...toSync }
    }

    return hasUpdate
  }

  /**
   * 启动共享参数定时同步
   */
  private startSharedParamsSync(): void {
    if (this.sharedParamsSyncTimer) return

    this.sharedParamsSyncTimer = setInterval(() => {
      try {
        this.syncFromSharedParams(true)
      } catch (err) {
        this.logger.warn(`${LOG_TAG} 定时同步共享参数失败:`, err)
      }
    }, SHARED_PARAMS_SYNC_INTERVAL_MS)
  }

  /**
   * 停止共享参数定时同步
   */
  private stopSharedParamsSync(): void {
    if (this.sharedParamsSyncTimer) {
      clearInterval(this.sharedParamsSyncTimer)
      this.sharedParamsSyncTimer = null
    }
  }

  /**
   * 构建单条上报数据的 payload（符合伽利略网页上报协议）
   */
  private buildReportPayload(event: PendingEvent): string {
    const osPlatform = platform()
    const currentTimestamp = Date.now()

    // 优先使用 event 中传入的 session（如 tool call 级别的会话 ID），fallback 到全局 sessionId
    const effectiveSessionId = (typeof event.options?.session === 'string' && event.options.session)
      ? event.options.session
      : this.sessionId

    // 构建 bean（用户/设备信息）
    const bean: Record<string, unknown> = {
      uid: (this.cachedParams.guid as string) || this.deviceId || generateUUID(),
      version: this.openclawVersion || (this.cachedParams.app_version as string) || SDK_VERSION,
      aid: this.deviceId || generateUUID(),
      env: this.initConfig?.env || 'production',
      platform: osPlatform,
      referer: 'plugin',
      from: '127.0.0.1',
      netType: 'unknown'
    }

    // 构建 ext（扩展字段）
    const ext: Record<string, unknown> = {
      hostname: hostname(),
      node_version: process.version,
      from: 'plugin'
    }

    // 合并参数（剔除 sessionId，避免被 addQclawPrefix 加上前缀重复上报）
    const rawParams: Record<string, unknown> = { name: event.name, ...this.cachedParams, ...event.options }
    delete rawParams.sessionId
    delete rawParams.session
    const prefixedParams = addQclawPrefix(rawParams)

    // 构建 fields
    const fieldsObj: Record<string, unknown> = {
      type: 'custom_event',
      level: 'info',
      plugin: 'custom',
    }

    if (effectiveSessionId) {
      fieldsObj.session = { id: effectiveSessionId }
    }

    // 构建 message 内容
    const messageObj: Record<string, unknown> = {
      event_code: event.name,
      name: event.name,
      event_value: safeStringify(rawParams),
      timestamp: event.timestamp,
      ...prefixedParams,
      aegisv2_goto: generateId(16),
    }

    if (this.openclawVersion) {
      messageObj.openclaw_version = this.openclawVersion
    }

    // 构建最终 payload
    const payload = {
      topic: this.initConfig?.reportToken || ELECTRON_REPORT_TOKEN,
      bean,
      ext: safeStringify(ext),
      scheme: 'v2',
      d2: [
        {
          fields: safeStringify(fieldsObj),
          message: [safeStringify(messageObj)],
          timestamp: currentTimestamp,
        },
      ],
    }

    return safeStringify(payload)
  }

  /**
   * 通过 HTTP POST 发送单条上报数据
   */
  private async sendReport(event: PendingEvent): Promise<boolean> {
    const payload = this.buildReportPayload(event)
    const url = this.initConfig?.hostUrl || REPORT_URL

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
        },
        body: payload,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (response.ok) {
        try {
          const result = (await response.json()) as Record<string, unknown>
          if (result.code === 0) {
            return true
          } else {
            this.logger.warn(`${LOG_TAG} 上报返回错误，响应: ${safeStringify(result)}`)
            return false
          }
        } catch {
          // 响应不是 JSON，但 HTTP 状态码是成功的
          return true
        }
      } else {
        this.logger.warn(`${LOG_TAG} 上报失败，状态码: ${response.status}`)
        return false
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        this.logger.warn(`${LOG_TAG} 上报超时`)
      } else {
        this.logger.error(`${LOG_TAG} 上报异常:`, err)
      }
      return false
    }
  }

  /**
   * 尝试获取一个上报令牌（令牌桶限流）
   */
  private tryAcquireToken(): boolean {
    const currentTime = Date.now()

    if (currentTime - this.rateLimitWindowStart >= RATE_LIMIT_WINDOW_MS) {
      this.rateLimitWindowStart = currentTime
      this.rateLimitTokensUsed = 0
    }

    if (this.rateLimitTokensUsed < RATE_LIMIT_MAX_TOKENS) {
      this.rateLimitTokensUsed++
      return true
    }

    return false
  }

  /**
   * 计算距离当前限流窗口结束还剩多少毫秒
   */
  private remainingWindowMs(): number {
    const elapsed = Date.now() - this.rateLimitWindowStart
    return Math.max(RATE_LIMIT_WINDOW_MS - elapsed, 0)
  }

  /**
   * 刷新待上报队列
   */
  private async flushQueue(): Promise<void> {
    if (this.isFlushing || this.pendingQueue.length === 0) return

    this.isFlushing = true

    try {
      while (this.pendingQueue.length > 0) {
        if (!this.tryAcquireToken()) {
          const waitMs = this.remainingWindowMs()
          await new Promise<void>((resolve) => setTimeout(resolve, waitMs + 10))
          continue
        }

        const event = this.pendingQueue.shift()!
        const success = await this.sendReport(event)

        if (!success) {
          const retryCount = (event.retryCount ?? 0) + 1
          if (retryCount >= MAX_RETRY_COUNT) {
            this.logger.warn(`${LOG_TAG} 事件 ${event.name} 重试 ${retryCount} 次后仍失败，已丢弃`)
          } else if (this.pendingQueue.length < PENDING_QUEUE_MAX_SIZE) {
            this.pendingQueue.unshift({ ...event, retryCount })
          }
          break
        }
      }
    } finally {
      this.isFlushing = false
    }

    if (this.pendingQueue.length > 0) {
      this.scheduleFlush()
    }
  }

  /**
   * 调度队列刷新
   */
  private scheduleFlush(): void {
    if (this.flushTimer) return

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flushQueue()
    }, FLUSH_INTERVAL_MS)
  }

  /**
   * 尝试从缓存参数自恢复初始化
   */
  private tryAutoRecover(): boolean {
    if (this.initialized) return true
    if (!this.lastInitOptions) return false

    this.logger.info(`${LOG_TAG} 检测到模块未初始化但有缓存参数，尝试自恢复...`)
    try {
      this.init(this.lastInitOptions)
      return this.initialized
    } catch (err) {
      this.logger.warn(`${LOG_TAG} 自恢复失败: ${String(err)}`)
      return false
    }
  }

  // ==================== 测试辅助方法 ====================

  /**
   * 获取待上报队列长度（仅用于测试）
   */
  _getPendingQueueLength(): number {
    return this.pendingQueue.length
  }

  /**
   * 获取待上报队列内容（仅用于测试）
   */
  _getPendingQueue(): readonly PendingEvent[] {
    return this.pendingQueue
  }

  /**
   * 获取是否已初始化（仅用于测试，不检查 enabled）
   */
  _getInitialized(): boolean {
    return this.initialized
  }
}

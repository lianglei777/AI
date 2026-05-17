/**
 * core/config-center.ts — 配置中心
 *
 * 统一管理 qclaw 的配置，按 package ID 分发配置段。
 * 每个 package 只能访问自己的配置段。
 *
 * ★ 两层优先级（高 → 低）：
 *   1. fileConfig[packageId]    — 动态配置（从 qclaw-plugin-config.json 读取）
 *   2. staticConfig[packageId]  — 静态配置（openclaw.json 中的 pluginConfig）
 *   3. {} 空对象               — 默认值
 *
 * ★ 设计原则：
 *   - OpenClaw 端只读不写，Electron 端负责写入配置文件
 *   - 使用 fs.watch + 防抖 + TTL 兜底感知文件变更
 *   - JSON.parse 失败时保持上次有效配置 + 告警日志
 *   - 各 package 通过 ctx.getConfig() 获取合并后的配置
 *   - 通过 ctx.onConfigChange() 监听配置变更
 *
 * 配置文件结构约定（qclaw-plugin-config.json）：
 * {
 *   "tool-sandbox": { "enabled": true },
 *   "pcmgr-ai-security": { "enablePromptAudit": false },
 *   ...
 * }
 */

import * as fs from 'fs'

const LOG_TAG = '[qclaw-plugin:config-center]'

/** 配置变更回调 */
export type ConfigChangeCallback = (packageId: string, newConfig: Record<string, unknown>) => void

/** ConfigCenter 构造参数 */
export interface ConfigCenterOptions {
  /** 静态配置（来自 openclaw.json 的 pluginConfig） */
  staticConfig: Record<string, unknown>
  /** 配置文件路径（qclaw-plugin-config.json），为空则不启用文件配置层 */
  configFilePath?: string
  /** fs.watch 防抖延迟（毫秒），默认 300 */
  debounceMs?: number
  /** TTL 兜底时间（毫秒），默认 10000 */
  ttlMs?: number
}

export class ConfigCenter {
  /** 静态配置（来自 openclaw.json） */
  private readonly staticConfig: Record<string, unknown>

  /** 文件配置（从 qclaw-plugin-config.json 读取） */
  private fileConfig: Record<string, unknown> = {}

  /** 配置文件路径 */
  private readonly configFilePath: string | undefined

  /** 配置变更监听器（按 packageId 分组） */
  private readonly listeners: Map<string, Set<ConfigChangeCallback>> = new Map()

  /** fs.watch 实例 */
  private watcher: fs.FSWatcher | null = null

  /** 防抖定时器 */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null

  /** 防抖延迟（毫秒） */
  private readonly debounceMs: number

  /** TTL 兜底时间（毫秒） */
  private readonly ttlMs: number

  /** 上次成功读取文件的时间戳 */
  private lastReadTimestamp: number = 0

  /** 是否已销毁 */
  private destroyed = false

  constructor(options: ConfigCenterOptions) {
    this.staticConfig = options.staticConfig ?? {}
    this.configFilePath = options.configFilePath
    this.debounceMs = options.debounceMs ?? 300
    this.ttlMs = options.ttlMs ?? 10_000

    // 启动时读取一次配置文件
    if (this.configFilePath) {
      this.readConfigFile()
      this.startWatching()
    }
  }

  /**
   * 获取指定 package 的配置段（两层合并）
   *
   * 合并优先级：fileConfig > staticConfig > {}
   * 使用浅合并（Object.assign 语义），fileConfig 中的字段覆盖 staticConfig 中的同名字段。
   *
   * 如果 TTL 过期，会先强制重读配置文件再返回。
   *
   * @param packageId package 的唯一标识
   * @returns 合并后的配置对象
   */
  getPackageConfig<T = Record<string, unknown>>(packageId: string): T {
    // TTL 兜底：如果缓存过期，强制重读
    this.checkTtlAndReload()

    const staticSection = this.staticConfig[packageId]
    const staticObj = (staticSection && typeof staticSection === 'object')
      ? staticSection as Record<string, unknown>
      : {}

    const fileSection = this.fileConfig[packageId]
    const fileObj = (fileSection && typeof fileSection === 'object')
      ? fileSection as Record<string, unknown>
      : {}

    // 如果 fileConfig 中没有该 package 的配置，直接返回 staticConfig
    if (!fileSection) {
      return staticObj as T
    }

    // 浅合并：fileConfig 覆盖 staticConfig
    return { ...staticObj, ...fileObj } as T
  }

  /**
   * 获取完整的合并后配置（用于调试）
   *
   * 返回所有 package 的合并配置，包括只在 fileConfig 中存在的 package。
   */
  getFullConfig(): Record<string, unknown> {
    this.checkTtlAndReload()

    const allPackageIds = new Set<string>([
      ...Object.keys(this.staticConfig),
      ...Object.keys(this.fileConfig),
    ])

    const result: Record<string, unknown> = {}
    for (const id of allPackageIds) {
      result[id] = this.getPackageConfig(id)
    }
    return result
  }

  /**
   * 监听指定 package 的配置变更
   *
   * 当配置文件变更导致该 package 的配置发生变化时，回调会收到合并后的完整配置。
   * 返回取消监听的函数。
   *
   * @param packageId package 的唯一标识
   * @param callback 变更回调
   * @returns 取消监听的函数
   */
  onConfigChange(packageId: string, callback: ConfigChangeCallback): () => void {
    let listeners = this.listeners.get(packageId)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(packageId, listeners)
    }
    listeners.add(callback)

    return () => {
      listeners!.delete(callback)
      if (listeners!.size === 0) {
        this.listeners.delete(packageId)
      }
    }
  }

  /**
   * 获取当前文件配置层的原始内容（用于调试）
   */
  getFileConfig(): Record<string, unknown> {
    return { ...this.fileConfig }
  }

  /**
   * 销毁 ConfigCenter，清理 fs.watch 和定时器资源
   */
  destroy(): void {
    this.destroyed = true

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }

    this.listeners.clear()
    console.log(`${LOG_TAG} destroyed`)
  }

  // ========================================================================
  // 私有方法
  // ========================================================================

  /** 从配置文件读取内容，解析失败时保持上次有效配置 */
  private readConfigFile(): void {
    if (!this.configFilePath) return

    try {
      if (!fs.existsSync(this.configFilePath)) {
        // 文件不存在，清空 fileConfig 回退到 staticConfig
        this.fileConfig = {}
        this.lastReadTimestamp = Date.now()
        return
      }

      const raw = fs.readFileSync(this.configFilePath, 'utf-8')
      const parsed = JSON.parse(raw)

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.fileConfig = parsed as Record<string, unknown>
        this.lastReadTimestamp = Date.now()
      } else {
        console.warn(`${LOG_TAG} config file content is not a valid object, keeping previous config`)
      }
    } catch (err) {
      // JSON.parse 失败或文件读取失败，保持上次有效配置
      console.warn(
        `${LOG_TAG} failed to read config file, keeping previous config:`,
        err instanceof Error ? err.message : String(err),
      )
      // 仍然更新时间戳，避免反复重试
      this.lastReadTimestamp = Date.now()
    }
  }

  /** 启动 fs.watch 监听配置文件变更 */
  private startWatching(): void {
    if (!this.configFilePath) return

    try {
      this.watcher = fs.watch(this.configFilePath, { persistent: false }, () => {
        if (this.destroyed) return
        this.debouncedReload()
      })

      // watch 出错时（如文件被删除），记录日志但不崩溃
      this.watcher.on('error', (err) => {
        console.warn(`${LOG_TAG} fs.watch error:`, err.message)
        // 尝试重新建立 watch（文件可能被重新创建）
        this.restartWatching()
      })

      console.log(`${LOG_TAG} watching config file: ${this.configFilePath}`)
    } catch (err) {
      console.warn(
        `${LOG_TAG} failed to start fs.watch:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /** 重新建立 fs.watch（用于文件被删除后重新创建的场景） */
  private restartWatching(): void {
    if (this.destroyed) return

    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }

    // 延迟 1 秒后重试，避免频繁重试
    setTimeout(() => {
      if (!this.destroyed) {
        this.startWatching()
      }
    }, 1000)
  }

  /** 防抖重新加载配置文件 */
  private debouncedReload(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.reloadAndNotify()
    }, this.debounceMs)
  }

  /** 重新加载配置文件并通知变更的 package */
  private reloadAndNotify(): void {
    if (this.destroyed) return

    // 保存旧配置用于 diff
    const oldFileConfig = this.fileConfig

    // 重新读取
    this.readConfigFile()

    // 找出变更的 packageId 并通知
    const allPackageIds = new Set<string>([
      ...Object.keys(oldFileConfig),
      ...Object.keys(this.fileConfig),
    ])

    for (const packageId of allPackageIds) {
      const oldSection = oldFileConfig[packageId]
      const newSection = this.fileConfig[packageId]

      // 简单的 JSON 序列化比较（浅层配置足够）
      if (JSON.stringify(oldSection) !== JSON.stringify(newSection)) {
        this.notifyListeners(packageId)
      }
    }
  }

  /** TTL 兜底检查：如果缓存过期，强制重读 */
  private checkTtlAndReload(): void {
    if (!this.configFilePath) return
    if (this.destroyed) return

    const elapsed = Date.now() - this.lastReadTimestamp
    if (elapsed > this.ttlMs) {
      this.readConfigFile()
    }
  }

  /** 通知指定 package 的所有监听器 */
  private notifyListeners(packageId: string): void {
    const listeners = this.listeners.get(packageId)
    if (!listeners || listeners.size === 0) return

    const mergedConfig = this.getPackageConfig<Record<string, unknown>>(packageId)
    for (const cb of listeners) {
      try {
        cb(packageId, mergedConfig)
      } catch (err) {
        console.error(`${LOG_TAG} config change listener error for ${packageId}:`, err)
      }
    }
  }
}

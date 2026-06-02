/**
 * core/reporter-types.ts — 伽利略遥测上报类型定义
 *
 * 从 claw-plugin-report/types.ts 迁移并适配 qclaw-plugin 架构。
 */

// ==================== 配置类型 ====================

/**
 * 上报配置（对应原 claw-plugin-report.config.json）
 *
 * 迁移后收入 qclaw-plugin 的 configSchema，不再需要独立配置文件。
 */
export interface TelemetryConfig {
  /** 是否启用上报（默认 true） */
  enabled?: boolean
  /** 伽利略项目上报 Token */
  reportToken?: string
  /** 上报地址 */
  hostUrl?: string
  /** 环境标识：production | test */
  env?: string
}

/**
 * Reporter 初始化选项
 */
export interface ReporterInitOptions {
  /** 状态目录（用于定位 ~/.qclaw/qclaw.json 等共享文件） */
  stateDir?: string
  /** 日志接口 */
  logger?: ReporterLogger
  /** 可选，覆盖配置中的 reportToken */
  reportToken?: string
  /** 可选，覆盖配置中的 hostUrl */
  hostUrl?: string
  /** 可选，覆盖配置中的 env */
  env?: string
  /** 可选，Electron 主进程共享的 sessionId */
  sessionId?: string
  /** OpenClaw 版本号 */
  openclawVersion?: string
}

// ==================== 日志接口 ====================

/**
 * 日志接口（与 QClawLogger 兼容）
 */
export interface ReporterLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

// ==================== 待上报事件 ====================

/**
 * 待上报事件（内部使用）
 */
export interface PendingEvent {
  /** 事件名称 */
  name: string
  /** 事件参数 */
  options: Record<string, unknown>
  /** 事件时间戳（毫秒） */
  timestamp: number
  /** 已重试次数（首次发送为 0） */
  retryCount?: number
}

// ==================== 共享参数 ====================

/**
 * 主进程写入的共享运行时参数（~/.qclaw/qclaw.json）
 */
export interface QClawSharedParams {
  sessionId?: string
  guid?: string
  appVersion?: string
  appChannel?: string
  platform?: string
}

// ==================== 对外 API 接口 ====================

/**
 * TelemetryReporter — 对外暴露的上报 API 接口
 *
 * 通过 ctx.reporter 提供给所有 package 使用。
 * 每个 package 调用时自动携带 packageId 作为 page_id。
 */
export interface TelemetryReporter {
  /**
   * 上报事件（fire-and-forget）
   *
   * @param name - 事件名称（建议使用 REPORT_CONST 中的常量）
   * @param options - 事件参数
   */
  report(name: string, options?: Record<string, unknown>): void

  /**
   * 异步上报事件（可 await）
   *
   * @param name - 事件名称
   * @param options - 事件参数
   */
  reportAsync(name: string, options?: Record<string, unknown>): Promise<void>

  /**
   * 设置上报公共参数
   *
   * 设置后每次 report 自动携带这些参数。
   */
  setCommonParams(params: Record<string, unknown>): void

  /**
   * 检查上报模块是否已初始化
   */
  isInitialized(): boolean
}

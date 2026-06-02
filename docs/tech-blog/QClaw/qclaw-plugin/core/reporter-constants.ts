/**
 * core/reporter-constants.ts — 伽利略遥测上报常量
 *
 * 从 claw-plugin-report/constants.ts 迁移。
 */

// ==================== 上报地址 & Token ====================

/** 伽利略默认上报地址 */
export const REPORT_URL = 'https://galileotelemetry.tencent.com/collect'

/** Electron 端使用的伽利略上报 Token（与主进程一致） */
export const ELECTRON_REPORT_TOKEN = 'SDK-034b2f6d3e5cabfdd8eb'

// ==================== AppKey ====================

/** 默认 AppKey（上报参数前缀） */
export const DEFAULT_APPKEY = 'PC_Qclaw'

// ==================== 上报事件代码 ====================

/** 上报事件常量（与 Electron 主进程 packages/report 一致） */
export const REPORT_CONST = {
  /** 点击事件 */
  CLICK_NEW: 'click_new',
  /** 曝光事件 */
  EXPO: 'expo',
  /** 提交事件 */
  SUBMIT: 'submit',
  /** 资源监控事件 */
  RESOURCE_MONITOR: 'resource_monitor',
  /** Crash 事件 */
  CRASH_EVENT: 'crash_event',
  /** 交互事件 */
  INTERACTION_EVENT: 'interaction_event',
  /** 卡顿事件 */
  JANK_EVENT: 'jank_event',
  /** 插件事件 */
  PLUGIN: 'plugin',
} as const

export type ReportConstType = (typeof REPORT_CONST)[keyof typeof REPORT_CONST]

// ==================== 内部常量 ====================

/** 待上报队列最大长度 */
export const PENDING_QUEUE_MAX_SIZE = 1000

/** HTTP 请求超时时间（毫秒） */
export const HTTP_TIMEOUT_MS = 5000

/** 上报间隔（毫秒），队列中有事件时定时刷新 */
export const FLUSH_INTERVAL_MS = 3000

/** 限流：每个时间窗口内最大上报条数 */
export const RATE_LIMIT_MAX_TOKENS = 2

/** 限流：时间窗口大小（毫秒） */
export const RATE_LIMIT_WINDOW_MS = 1000

/** 共享参数同步间隔（毫秒），3 分钟 */
export const SHARED_PARAMS_SYNC_INTERVAL_MS = 3 * 60 * 1000

/** SDK 版本号（用于上报协议） */
export const SDK_VERSION = '1.0.0'

/** 单条事件最大重试次数 */
export const MAX_RETRY_COUNT = 3

/** QClaw 状态目录名 */
export const QCLAW_STATE_DIR_NAME = '.qclaw'

/** QClaw 元信息文件名 */
export const QCLAW_META_FILE_NAME = 'qclaw.json'

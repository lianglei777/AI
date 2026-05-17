/**
 * 数据同步上报插件 - 常量定义
 */

/** 插件唯一标识 */
export const PLUGIN_ID = "data-sync-report";

/** 插件 Service 唯一标识 */
export const SERVICE_ID = "data-sync-report-service";

/** 日志标签前缀 */
export const LOG_PREFIX = "[data-sync-report]";

// --------------------------------
// 文件路径相关
// --------------------------------

/** OpenClaw 主配置文件名 */
export const CONFIG_FILENAME = "openclaw.json";

/** Cron Jobs 存储的相对路径（相对于 stateDir） */
export const CRON_JOBS_RELATIVE_PATH = "cron/jobs.json";

/** Cron 执行记录目录的相对路径（相对于 stateDir） */
export const CRON_RUNS_RELATIVE_DIR = "cron/runs";

/** Cron 执行记录文件扩展名 */
export const CRON_RUNS_FILE_EXTENSION = ".jsonl";

/** 同步状态文件的相对路径（相对于 stateDir） */
export const SYNC_STATE_RELATIVE_DIR = "sync";

/** 同步状态文件名 */
export const SYNC_STATE_FILENAME = "sync_state.json";

// --------------------------------
// 监听配置
// --------------------------------

/** 文件变化 debounce 延迟（毫秒） */
export const DEFAULT_DEBOUNCE_MS = 500;

/** chokidar 轮询间隔（毫秒，仅在不支持 native events 时使用） */
export const CHOKIDAR_POLL_INTERVAL_MS = 1000;

// --------------------------------
// 预留扩展配置
// --------------------------------

/** 定时扫描间隔（毫秒），默认 5 分钟 */
export const DEFAULT_PERIODIC_SCAN_INTERVAL_MS = 5 * 60 * 1000;

/** 数据对账间隔（毫秒），默认 24 小时 */
export const DEFAULT_RECONCILIATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

// --------------------------------
// API 接口配置
// --------------------------------

/** Agent 全量同步接口路径 后端接口: /api/agents/upsert（命令字 4174） */
export const AGENT_UPSERT_API_PATH = "/data/4174/forward";

/** CronJob 全量同步接口路径 后端接口: /api/cronjobs/upsert（命令字 4180） */
export const CRONJOB_UPSERT_API_PATH = "/data/4180/forward";

/** CronRunLog 批量上报接口路径 后端接口: /api/cronjobs/logs（命令字 4179） */
export const CRONRUN_LOG_API_PATH = "/data/4179/forward";

/** 查询服务端数据同步状态接口路径（命令字 4181） */
export const RECONCILIATION_QUERY_API_PATH = "/data/4181/forward";

/** API 请求超时（毫秒） */
export const API_REQUEST_TIMEOUT_MS = 30000;

/** CronRunLog 单次上报最大条数 */
export const CRONRUN_LOG_MAX_BATCH_SIZE = 100;

/** 生产环境 JPRX 网关基础 URL */
const JPRX_GATEWAY_PRODUCTION = "https://jprx.m.qq.com";

/** 测试环境 JPRX 网关基础 URL */
const JPRX_GATEWAY_TEST = "https://jprx.sparta.html5.qq.com";

/**
 * 获取 JPRX 网关基础 URL
 *
 * 与 @guanjia-openclaw/shared 的 getEnvUrls 逻辑对齐：
 * 根据 process.env.BUILD_ENV 选择生产/测试环境
 */
export function getJprxBaseUrl(): string {
  const env = process.env.BUILD_ENV || "test";
  return env === "production" ? JPRX_GATEWAY_PRODUCTION : JPRX_GATEWAY_TEST;
}

/**
 * 对账查询 API
 *
 * 调用后端命令字 4181 接口，查询服务端各业务维度的数据同步状态。
 * 客户端据此判断本地数据与后端是否一致，进行差异修正。
 */

import type { Logger } from "../types.js";
import type { TelemetryReporter } from "../../../../core/reporter-types.js";
import { RECONCILIATION_QUERY_API_PATH } from "../constants.js";
import { fetchApi } from "./fetch-api.js";

// --------------------------------
// 响应类型
// --------------------------------

/** 单个 Agent 的服务端同步状态 */
export interface ServerAgentSyncStatus {
  /** Agent 唯一标识 */
  readonly id: string;
  /** 重要字段的哈希摘要（前端上报时传入的 hash） */
  readonly hash: string;
  /** 最后更新时间（毫秒时间戳） */
  readonly updated_at: number;
  /**
   * Agent Identity 的哈希摘要（前端通过 Identity 接口上报时传入的 hash）
   *
   * 为空字符串表示后端尚未记录该 Agent 的 identity（未上报 / 已清理）。
   */
  readonly identity_hash: string;
}

/** 单个 CronJob 的服务端同步状态 */
export interface ServerCronJobSyncStatus {
  /** CronJob 唯一标识 */
  readonly id: string;
  /** 重要字段的哈希摘要（前端上报时传入的 hash） */
  readonly hash: string;
  /** 最后更新时间（毫秒时间戳） */
  readonly updated_at: number;
}

/** 命令字 4181 的响应 data 结构 */
export interface ReconciliationQueryData {
  readonly agents: ServerAgentSyncStatus[];
  readonly cron_jobs: ServerCronJobSyncStatus[];
  readonly cron_runs: Record<string, { total_records: number; last_ts: number }>;
}

// --------------------------------
// 请求类型
// --------------------------------

interface ReconciliationQueryRequest {
  readonly scope: "all" | "meta" | "cron";
  readonly job_ids?: string[];
}

// --------------------------------
// API 调用
// --------------------------------

/**
 * 查询服务端数据同步状态（命令字 4181）
 *
 * @param scope 查询范围（meta: 仅 Agent + CronJob）
 * @param logger 日志记录器
 * @param fetchFn fetch 函数
 * @returns 服务端同步状态数据，失败时返回 null
 */
export async function queryServerSyncStatus(
  scope: "all" | "meta" | "cron",
  logger: Logger,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  telemetryReporter?: TelemetryReporter
): Promise<ReconciliationQueryData | null> {
  const requestBody: ReconciliationQueryRequest = {
    scope,
  };

  const [data, error] = await fetchApi<ReconciliationQueryData>({
    apiPath: RECONCILIATION_QUERY_API_PATH,
    body: requestBody,
    logger,
    logTag: "ReconciliationApi",
    fetchFn,
    telemetryReporter,
  });

  if (error !== null) {
    logger.error(
      `==data-sync-report插件==动作:ReconciliationApi查询失败==参数==error="${error}"`
    );
    return null;
  }

  return data;
}

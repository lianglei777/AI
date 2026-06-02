/**
 * CronRunLog 批量上报 API
 *
 * 调用后端命令字 4179 接口，批量上报定时任务的执行日志。
 * 后端以 job_id + ts 为唯一键去重，重复日志会被自动跳过。
 *
 * 字段对齐 openclaw/src/cron/run-log.ts 中的 CronRunLogEntry 完整定义：
 * - ts, jobId, action("finished"), status, error, summary
 * - delivered, deliveryStatus, deliveryError
 * - sessionId, sessionKey, runAtMs, durationMs, nextRunAtMs
 * - model, provider, usage (CronRunTelemetry)
 */

import type { CronRunLogEntryData, Logger } from "../types.js";
import type { TelemetryReporter } from "../../../../core/reporter-types.js";
import { CRONRUN_LOG_API_PATH, CRONRUN_LOG_MAX_BATCH_SIZE } from "../constants.js";
import { fetchApi } from "./fetch-api.js";

// --------------------------------
// 请求体类型
// --------------------------------

/** 单条执行日志的 API 请求格式 */
interface ApiCronRunLog {
  ts: number;
  action: string;
  status: string;
  summary: string;
  delivery_status: string;
  started_at?: number;
  finished_at?: number;
  run_at_ms?: number;
  duration_ms: number;
  next_run_at_ms?: number;
}

/** 批量上报请求体 */
interface CronRunLogRequest {
  job_id: string;
  logs: ApiCronRunLog[];
  /** 当前文件的字节偏移量（处理完本批次后的位置） */
  offset: number;
}

// --------------------------------
// 数据转换
// --------------------------------

/**
 * 将内部 CronRunLogEntryData 转换为 API 请求格式
 *
 * 字段映射：
 * - ts → ts（幂等去重键）
 * - action → action（必填，兜底 "finished"）
 * - status → status（必填，兜底 "unknown"）
 * - summary → summary（必填，兜底空字符串）
 * - deliveryStatus → delivery_status（必填，兜底 "not-requested"）
 * - runAtMs → started_at（毫秒时间戳）
 * - runAtMs + durationMs → finished_at（毫秒时间戳）
 * - runAtMs → run_at_ms（毫秒时间戳）
 * - durationMs → duration_ms（必填，兜底 0）
 * - nextRunAtMs → next_run_at_ms
 */
function toApiRunLog(entry: CronRunLogEntryData): ApiCronRunLog {
  const startedAtMs = entry.runAtMs;
  const durationMs = typeof entry.durationMs === "number" ? entry.durationMs : 0;
  const finishedAtMs =
    typeof startedAtMs === "number" ? startedAtMs + durationMs : undefined;

  return {
    ts: entry.ts,
    action: entry.action || "finished",
    status: entry.status || "unknown",
    summary: entry.summary || "",
    delivery_status: entry.deliveryStatus || "not-requested",
    started_at: typeof startedAtMs === "number" ? startedAtMs : undefined,
    finished_at: finishedAtMs,
    run_at_ms: typeof startedAtMs === "number" ? startedAtMs : undefined,
    duration_ms: durationMs,
    next_run_at_ms: typeof entry.nextRunAtMs === "number" ? entry.nextRunAtMs : undefined,
  };
}

// --------------------------------
// API 调用
// --------------------------------

/**
 * 上报单个 job 的执行日志（命令字 4179）
 *
 * @param jobId 任务 ID
 * @param entries 该 job 的执行记录列表
 * @param offset 当前文件的字节偏移量
 * @param logger 日志记录器
 * @returns 是否上报成功
 */
export async function reportCronRunLogs(
  jobId: string,
  entries: CronRunLogEntryData[],
  offset: number,
  logger: Logger,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  telemetryReporter?: TelemetryReporter
): Promise<boolean> {
  if (entries.length === 0) {
    return true;
  }

  // 接口限制单次最多 100 条
  const batch = entries.slice(0, CRONRUN_LOG_MAX_BATCH_SIZE);

  const requestBody: CronRunLogRequest = {
    job_id: jobId,
    logs: batch.map(toApiRunLog),
    offset,
  };

  const [, error] = await fetchApi({
    apiPath: CRONRUN_LOG_API_PATH,
    body: requestBody,
    logger,
    logTag: "CronRunLogApi",
    fetchFn,
    telemetryReporter,
  });

  return error === null;
}

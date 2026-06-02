/**
 * CronJob 增量同步 API
 *
 * 调用后端命令字 4180 接口，增量上报 CronJob 的变化。
 * - 新增/修改的 job 放在 jobs 字段中
 * - 删除的 job 放在 delete_job_ids 字段中
 * - 根据本次变化情况，请求体中只包含有数据的字段
 *
 * 字段对齐 openclaw/src/cron/types.ts 中的 CronJob 完整定义：
 * - CronJobBase: id, agentId, sessionKey, name, description, enabled, deleteAfterRun,
 *   createdAtMs, updatedAtMs, schedule, sessionTarget, wakeMode, payload, delivery, failureAlert
 * - CronJobState: nextRunAtMs, lastRunAtMs, lastRunStatus, lastDurationMs,
 *   lastDeliveryStatus, consecutiveErrors
 */

import type { CronJobDiffResult, CronJobWithHash, Logger } from "../types.js";
import type { TelemetryReporter } from "../../../../core/reporter-types.js";
import { CRONJOB_UPSERT_API_PATH } from "../constants.js";
import { fetchApi } from "./fetch-api.js";

// --------------------------------
// 请求体类型（对齐接口文档 + openclaw 源码字段）
// --------------------------------

/** Schedule 结构 — 对齐 openclaw CronSchedule 联合类型 */
interface ApiSchedule {
  kind: string;
  expr?: string;
  tz?: string;
  every_ms?: number;
  anchor_ms?: number;
  stagger_ms?: number;
  at?: string;
}

/** Payload 结构 — 对齐 openclaw CronPayload */
interface ApiPayload {
  kind: string;
  text?: string;
  message?: string;
  model?: string;
  thinking?: string;
  timeout_seconds?: number;
}

/** State 结构 — 对齐 openclaw CronJobState（只传运行时快照） */
interface ApiState {
  next_run_at_ms?: number;
  last_run_at_ms?: number;
  last_run_status?: string;
  last_duration_ms?: number;
  last_delivery_status?: string;
  consecutive_errors?: number;
}

/** 单个 CronJob 的 API 请求格式 */
interface ApiCronJob {
  job_id: string;
  agent_id: string;
  session_key: string;
  name: string;
  description?: string;
  enabled: boolean;
  delete_after_run?: boolean;
  created_at_ms: number;
  updated_at_ms: number;
  schedule: ApiSchedule;
  session_target: string;
  wake_mode: string;
  payload: ApiPayload;
  state?: ApiState;
  /** 剥离运行时字段后的 SHA-256 哈希 */
  hash: string;
}

/** 全量同步请求体 */
interface CronJobUpsertRequest {
  jobs?: ApiCronJob[];
  delete_job_ids?: string[];
}

// --------------------------------
// 数据转换
// --------------------------------

/**
 * 从 openclaw 的 CronJob 数据中提取 schedule 字段
 *
 * openclaw CronSchedule 是联合类型：
 * - { kind: "at", at: string }
 * - { kind: "every", everyMs: number, anchorMs?: number }
 * - { kind: "cron", expr: string, tz?: string, staggerMs?: number }
 */
function toApiSchedule(schedule: unknown): ApiSchedule {
  if (!schedule || typeof schedule !== "object") {
    return { kind: "unknown" };
  }

  const s = schedule as Record<string, unknown>;
  const kind = typeof s.kind === "string" ? s.kind : "unknown";

  const result: ApiSchedule = { kind };

  if (kind === "cron") {
    if (typeof s.expr === "string") result.expr = s.expr;
    if (typeof s.tz === "string") result.tz = s.tz;
    if (typeof s.staggerMs === "number") result.stagger_ms = s.staggerMs;
  } else if (kind === "every") {
    if (typeof s.everyMs === "number") result.every_ms = s.everyMs;
    if (typeof s.anchorMs === "number") result.anchor_ms = s.anchorMs;
  } else if (kind === "at") {
    if (typeof s.at === "string") result.at = s.at;
  }

  return result;
}

/**
 * 从 openclaw 的 CronJob 数据中提取 payload 字段
 *
 * openclaw CronPayload 是联合类型：
 * - { kind: "systemEvent", text: string }
 * - { kind: "agentTurn", message: string, model?, thinking?, timeoutSeconds?, ... }
 */
function toApiPayload(payload: unknown): ApiPayload {
  if (!payload || typeof payload !== "object") {
    return { kind: "unknown" };
  }

  const p = payload as Record<string, unknown>;
  const kind = typeof p.kind === "string" ? p.kind : "unknown";

  const result: ApiPayload = { kind };

  if (kind === "systemEvent") {
    if (typeof p.text === "string") result.text = p.text;
  } else if (kind === "agentTurn") {
    if (typeof p.message === "string") result.text = p.message;
    if (typeof p.model === "string") result.model = p.model;
    if (typeof p.thinking === "string") result.thinking = p.thinking;
    if (typeof p.timeoutSeconds === "number") result.timeout_seconds = p.timeoutSeconds;
  }

  return result;
}

/**
 * 从 openclaw 的 CronJobState 中提取运行时状态
 */
function toApiState(state: unknown): ApiState | undefined {
  if (!state || typeof state !== "object") {
    return undefined;
  }

  const s = state as Record<string, unknown>;
  const result: ApiState = {};
  let hasField = false;

  if (typeof s.nextRunAtMs === "number") { result.next_run_at_ms = s.nextRunAtMs; hasField = true; }
  if (typeof s.lastRunAtMs === "number") { result.last_run_at_ms = s.lastRunAtMs; hasField = true; }
  if (typeof s.lastRunStatus === "string") { result.last_run_status = s.lastRunStatus; hasField = true; }
  if (typeof s.lastDurationMs === "number") { result.last_duration_ms = s.lastDurationMs; hasField = true; }
  if (typeof s.lastDeliveryStatus === "string") { result.last_delivery_status = s.lastDeliveryStatus; hasField = true; }
  if (typeof s.consecutiveErrors === "number") { result.consecutive_errors = s.consecutiveErrors; hasField = true; }

  return hasField ? result : undefined;
}

/**
 * 将内部 CronJobWithHash 转换为 API 请求格式
 */
function toApiCronJob(jobWithHash: CronJobWithHash): ApiCronJob {
  const job = jobWithHash.data;
  return {
    job_id: job.id,
    agent_id: job.agentId || "main",
    session_key: job.sessionKey || `agent:${job.agentId || "main"}:main`,
    name: job.name,
    description: job.description || undefined,
    enabled: job.enabled,
    delete_after_run: job.deleteAfterRun,
    created_at_ms: job.createdAtMs,
    updated_at_ms: job.updatedAtMs,
    schedule: toApiSchedule(job.schedule),
    session_target: String(job.sessionTarget || "main"),
    wake_mode: String(job.wakeMode || "next-heartbeat"),
    payload: toApiPayload(job.payload),
    state: toApiState(job.state),
    hash: jobWithHash.hash,
  };
}

// --------------------------------
// API 调用
// --------------------------------

/**
 * 调用 CronJob 增量同步接口（命令字 4180）
 *
 * 根据 diff 结果，只上报有变化的部分：
 * - createdOrUpdatedJobs 不为空时，放入 jobs 字段
 * - deletedJobIds 不为空时，放入 delete_job_ids 字段
 */
export async function syncCronJobsDiffToBackend(
  diff: CronJobDiffResult,
  logger: Logger,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  telemetryReporter?: TelemetryReporter
): Promise<boolean> {
  const { createdOrUpdatedJobs, deletedJobIds } = diff;

  if (createdOrUpdatedJobs.length === 0 && deletedJobIds.length === 0) {
    logger.debug("==data-sync-report插件==动作:CronJobSyncApi跳过同步,无变化需上报==");
    return true;
  }

  const requestBody: CronJobUpsertRequest = {};

  if (createdOrUpdatedJobs.length > 0) {
    requestBody.jobs = createdOrUpdatedJobs.map(toApiCronJob);
  }

  if (deletedJobIds.length > 0) {
    requestBody.delete_job_ids = deletedJobIds;
  }

  const [, error] = await fetchApi({
    apiPath: CRONJOB_UPSERT_API_PATH,
    body: requestBody,
    logger,
    logTag: "CronJobSyncApi",
    fetchFn,
    telemetryReporter,
  });

  return error === null;
}

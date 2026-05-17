/**
 * 数据同步上报插件 - ChangeReporter
 *
 * 统一的变化事件汇聚和上报层。
 *
 * 职责：
 * - 接收所有 Watcher 产生的变化事件
 * - 通过日志输出事件摘要
 * - Agent 变化时，调用后端增量同步接口（命令字 4174），只上报变化部分
 * - CronJob 变化时，调用后端增量同步接口（命令字 4180），只上报变化部分
 * - CronRun 新增时，调用后端日志上报接口（命令字 4179）
 */

import type {
  AgentDiffResult,
  AgentSnapshot,
  ChangeEvent,
  CronJobDiffResult,
  CronJobSnapshot,
  CronRunEvent,
  IChangeReporter,
  IdentityDiffResult,
  IdentitySnapshot,
  Logger,
  ReportResult,
} from "../types.js";
import type { TelemetryReporter } from "../../../../core/reporter-types.js";
import { syncAgentsDiffToBackend, syncAgentIdentityToBackend } from "./agent-sync-api.js";
import { syncCronJobsDiffToBackend } from "./cronjob-sync-api.js";
import { reportCronRunLogs } from "./cronrun-log-api.js";

export interface ChangeReporterOptions {
  /** 日志记录器 */
  readonly logger: Logger;
  /** 原始 fetch 函数（通过 ctx.getOriginalFetch() 获取，绕过 FetchChain） */
  readonly fetchFn?: typeof globalThis.fetch;
  /** 伽利略遥测上报器（通过 ctx.reporter 获取） */
  readonly telemetryReporter?: TelemetryReporter;
  /** Agent 快照持久化回调 — 上报成功后调用 */
  readonly onAgentSyncSuccess?: (snapshots: Record<string, AgentSnapshot>) => Promise<void>;
  /** Identity 快照持久化回调 — 上报成功后调用 */
  readonly onIdentitySyncSuccess?: (snapshots: Record<string, IdentitySnapshot>) => Promise<void>;
  /** CronJob 快照持久化回调 — 上报成功后调用 */
  readonly onCronJobSyncSuccess?: (snapshots: Record<string, CronJobSnapshot>) => Promise<void>;
  /** CronRun 偏移确认回调 — 上报成功后调用 */
  readonly onCronRunSyncSuccess?: (filePath: string, offset: number) => Promise<void>;
}

/**
 * 默认变化上报器
 */
export class ChangeReporter implements IChangeReporter {
  private readonly logger: Logger;
  /** 原始 fetch 函数（绕过 FetchChain） */
  private readonly fetchFn: typeof globalThis.fetch;
  /** 伽利略遥测上报器 */
  private readonly telemetryReporter?: TelemetryReporter;

  /** Agent 快照持久化回调 */
  private readonly onAgentSyncSuccess?: (snapshots: Record<string, AgentSnapshot>) => Promise<void>;
  /** Identity 快照持久化回调 */
  private readonly onIdentitySyncSuccess?: (snapshots: Record<string, IdentitySnapshot>) => Promise<void>;
  /** CronJob 快照持久化回调 */
  private readonly onCronJobSyncSuccess?: (snapshots: Record<string, CronJobSnapshot>) => Promise<void>;
  /** CronRun 偏移确认回调 */
  private readonly onCronRunSyncSuccess?: (filePath: string, offset: number) => Promise<void>;

  /** 累计上报事件计数（用于监控） */
  private eventCount = 0;

  /** 是否已销毁 */
  private destroyed = false;

  /** Agent 增量同步的 debounce 定时器 */
  private agentSyncTimer: ReturnType<typeof setTimeout> | null = null;

  /** CronJob 增量同步的 debounce 定时器 */
  private cronJobSyncTimer: ReturnType<typeof setTimeout> | null = null;

  /** 同步 debounce 延迟（毫秒） — 合并多个 Watcher 几乎同时产出的 diff */
  private readonly syncDebounceMs = 100;

  /**
   * Agent 增量 diff 缓冲
   * 在 debounce 窗口内合并多次 diff 结果
   */
  private pendingAgentDiff: AgentDiffResult | null = null;

  /**
   * CronJob 增量 diff 缓冲
   * 在 debounce 窗口内合并多次 diff 结果
   */
  private pendingCronJobDiff: CronJobDiffResult | null = null;

  /** 待上报的 CronRun 事件缓冲：Map<jobId, CronRunEvent[]> */
  private cronRunBuffer: Map<string, CronRunEvent[]> = new Map();

  /** Identity 同步的 debounce 定时器 */
  private identitySyncTimer: ReturnType<typeof setTimeout> | null = null;

  /** Identity 增量 diff 缓冲：在 debounce 窗口内合并多次 diff 结果 */
  private pendingIdentityDiff: IdentityDiffResult | null = null;

  /** CronRun 上报的 debounce 定时器 */
  private cronRunReportTimer: ReturnType<typeof setTimeout> | null = null;

  /** CronRun 上报 debounce 延迟（毫秒） — 合并同一 job 的连续执行记录 */
  private readonly cronRunReportDebounceMs = 500;

  constructor(options: ChangeReporterOptions) {
    this.logger = options.logger;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.telemetryReporter = options.telemetryReporter;
    this.onAgentSyncSuccess = options.onAgentSyncSuccess;
    this.onIdentitySyncSuccess = options.onIdentitySyncSuccess;
    this.onCronJobSyncSuccess = options.onCronJobSyncSuccess;
    this.onCronRunSyncSuccess = options.onCronRunSyncSuccess;
  }

  /**
   * 上报单个变化事件（仅处理 cron-run 类型）
   */
  async report(event: ChangeEvent): Promise<ReportResult> {
    if (this.destroyed) {
      return { success: false, error: "reporter is destroyed" };
    }

    this.eventCount++;

    // 记录事件日志
    this.logEvent(event);

    // CronRun 事件通过缓冲区上报
    if (event.type === "cron-run") {
      this.bufferCronRunEvent(event);
    }

    return { success: true };
  }

  /**
   * 批量上报变化事件
   */
  async reportBatch(events: ChangeEvent[]): Promise<ReportResult> {
    if (this.destroyed) {
      return { success: false, error: "reporter is destroyed" };
    }

    if (events.length === 0) {
      return { success: true };
    }

    let lastError: string | undefined;
    for (const event of events) {
      const result = await this.report(event);
      if (!result.success) {
        lastError = result.error;
      }
    }

    return lastError
      ? { success: false, error: lastError }
      : { success: true };
  }

  /**
   * 销毁上报器，释放资源
   */
  destroy(): void {
    if (this.agentSyncTimer) {
      clearTimeout(this.agentSyncTimer);
      this.agentSyncTimer = null;
    }
    if (this.cronJobSyncTimer) {
      clearTimeout(this.cronJobSyncTimer);
      this.cronJobSyncTimer = null;
    }
    if (this.identitySyncTimer) {
      clearTimeout(this.identitySyncTimer);
      this.identitySyncTimer = null;
    }
    if (this.cronRunReportTimer) {
      clearTimeout(this.cronRunReportTimer);
      this.cronRunReportTimer = null;
    }
    this.cronRunBuffer.clear();
    this.pendingAgentDiff = null;
    this.pendingCronJobDiff = null;
    this.pendingIdentityDiff = null;
    this.destroyed = true;

  }

  /**
   * 获取累计事件计数
   */
  getEventCount(): number {
    return this.eventCount;
  }

  // --------------------------------
  // Agent 增量同步（命令字 4174）
  // --------------------------------

  /**
   * 接收 Agent 增量 diff 结果并调度同步
   *
   * 由 AgentWatcher 的 onDiff 回调触发。
   * 在 debounce 窗口内合并多次 diff 结果，然后一次性上报。
   */
  reportAgentDiff(diff: AgentDiffResult): void {
    if (this.destroyed) {
      return;
    }

    this.logger.info(
      `==data-sync-report插件==动作:ChangeReporter收到Agent diff==参数==upsert=${diff.createdOrUpdatedAgents.length}, delete=${diff.deletedAgentIds.length}, deleteIdentity=${diff.deleteIdentityAgentIds.length}`
    );

    // 合并到缓冲中
    if (this.pendingAgentDiff) {
      // 合并 createdOrUpdatedAgents：后来的覆盖前一次（以 agentId 为 key）
      const agentMap = new Map(
        this.pendingAgentDiff.createdOrUpdatedAgents.map((a) => [a.data.id, a])
      );
      for (const agent of diff.createdOrUpdatedAgents) {
        agentMap.set(agent.data.id, agent);
      }

      // 合并 deletedAgentIds：去重
      const deleteSet = new Set([
        ...this.pendingAgentDiff.deletedAgentIds,
        ...diff.deletedAgentIds,
      ]);

      // 合并 deleteIdentityAgentIds：去重
      const deleteIdentitySet = new Set([
        ...this.pendingAgentDiff.deleteIdentityAgentIds,
        ...diff.deleteIdentityAgentIds,
      ]);

      // 如果某个 agent 既在 upsert 又在 delete 中，以最新的 diff 为准
      for (const agent of diff.createdOrUpdatedAgents) {
        deleteSet.delete(agent.data.id);
      }
      for (const id of diff.deletedAgentIds) {
        agentMap.delete(id);
      }

      // agent 被删除时，identity 自然也没了，从 deleteIdentity 中移除避免冗余
      for (const id of deleteSet) {
        deleteIdentitySet.delete(id);
      }
      // agent 本次 upsert 且带 identity 的情况下，也不应再发 deleteIdentity
      for (const agent of diff.createdOrUpdatedAgents) {
        deleteIdentitySet.delete(agent.data.id);
      }

      // pendingSnapshots 合并策略：
      // - 如果新 diff 影响了 agent 本身（有 upsert/delete），就用新 diff 的快照
      //   （包括 handleAllDeleted 场景下空对象主动清空的语义）
      // - 如果新 diff 仅是 identity-only（不影响 agent 快照），保留旧的快照
      const newAffectsAgent =
        diff.createdOrUpdatedAgents.length > 0 || diff.deletedAgentIds.length > 0;
      const mergedSnapshots = newAffectsAgent
        ? diff.pendingSnapshots
        : this.pendingAgentDiff.pendingSnapshots;

      this.pendingAgentDiff = {
        createdOrUpdatedAgents: Array.from(agentMap.values()),
        deletedAgentIds: Array.from(deleteSet),
        deleteIdentityAgentIds: Array.from(deleteIdentitySet),
        pendingSnapshots: mergedSnapshots,
      };
    } else {
      this.pendingAgentDiff = diff;
    }

    this.scheduleAgentDiffSync();
  }

  /**
   * 立即执行 Agent 增量同步（不走 debounce）
   *
   * 与 reportAgentDiff 不同，此方法会立即执行上报并等待完成。
   * 供需要串行等待上报+持久化完成的调用方使用（如 AgentWatcher 的 onDiff）。
   *
   * 注意：如果 pendingAgentDiff 中有之前 debounce 未发出的 diff，
   * 会先合并再一并上报，并取消之前的 debounce 定时器。
   */
  async reportAgentDiffImmediate(diff: AgentDiffResult): Promise<void> {
    if (this.destroyed) {
      return;
    }

    this.logger.info(
      `==data-sync-report插件==动作:ChangeReporter收到Agent diff(immediate)==参数==upsert=${diff.createdOrUpdatedAgents.length}, delete=${diff.deletedAgentIds.length}, deleteIdentity=${diff.deleteIdentityAgentIds.length}`
    );

    // 取消之前的 debounce 定时器
    if (this.agentSyncTimer) {
      clearTimeout(this.agentSyncTimer);
      this.agentSyncTimer = null;
    }

    // 合并已缓冲的 diff（如果有）
    let mergedDiff = diff;
    if (this.pendingAgentDiff) {
      const agentMap = new Map(
        this.pendingAgentDiff.createdOrUpdatedAgents.map((a) => [a.data.id, a])
      );
      for (const agent of diff.createdOrUpdatedAgents) {
        agentMap.set(agent.data.id, agent);
      }

      const deleteSet = new Set([
        ...this.pendingAgentDiff.deletedAgentIds,
        ...diff.deletedAgentIds,
      ]);

      const deleteIdentitySet = new Set([
        ...this.pendingAgentDiff.deleteIdentityAgentIds,
        ...diff.deleteIdentityAgentIds,
      ]);

      for (const agent of diff.createdOrUpdatedAgents) {
        deleteSet.delete(agent.data.id);
      }
      for (const id of diff.deletedAgentIds) {
        agentMap.delete(id);
      }

      for (const id of deleteSet) {
        deleteIdentitySet.delete(id);
      }
      for (const agent of diff.createdOrUpdatedAgents) {
        deleteIdentitySet.delete(agent.data.id);
      }

      // pendingSnapshots 合并策略（与 reportAgentDiff 保持一致）：
      // 新 diff 影响 agent 本身 → 用新快照；否则保留旧快照
      const newAffectsAgent =
        diff.createdOrUpdatedAgents.length > 0 || diff.deletedAgentIds.length > 0;
      const mergedSnapshots = newAffectsAgent
        ? diff.pendingSnapshots
        : this.pendingAgentDiff.pendingSnapshots;

      mergedDiff = {
        createdOrUpdatedAgents: Array.from(agentMap.values()),
        deletedAgentIds: Array.from(deleteSet),
        deleteIdentityAgentIds: Array.from(deleteIdentitySet),
        pendingSnapshots: mergedSnapshots,
      };
    }
    this.pendingAgentDiff = null;

    try {
      const success = await syncAgentsDiffToBackend(mergedDiff, this.logger, this.fetchFn, this.telemetryReporter);
      // 仅当本次 diff 影响了 agent 本身（有 upsert 或 delete）时才覆盖 sync_state.agents。
      // 纯 identity 清理（只有 deleteIdentityAgentIds）不应触碰 agent 快照，
      // 避免把既有 agent 快照擦掉。
      const affectsAgentSnapshot =
        mergedDiff.createdOrUpdatedAgents.length > 0 ||
        mergedDiff.deletedAgentIds.length > 0;
      if (success && affectsAgentSnapshot && this.onAgentSyncSuccess) {
        await this.onAgentSyncSuccess(mergedDiff.pendingSnapshots);
        this.logger.info("==data-sync-report插件==动作:ChangeReporter的Agent快照已持久化(immediate)==");
      } else if (!success) {
        this.logger.warn("==data-sync-report插件==动作:ChangeReporter的Agent同步失败,快照未持久化(immediate)==");
      }
    } catch (error) {
      this.logger.error("==data-sync-report插件==动作:ChangeReporter的Agent增量同步异常(immediate)==参数==", error);
    }
  }

  /**
   * 调度延迟 Agent 增量同步
   *
   * 上报成功后，调用 onAgentSyncSuccess 将 pendingSnapshots 持久化到 sync_state。
   * 上报失败时不持久化，确保下次 diff 时能重新检测到变化。
   */
  private scheduleAgentDiffSync(): void {
    if (this.agentSyncTimer) {
      clearTimeout(this.agentSyncTimer);
    }

    this.agentSyncTimer = setTimeout(async () => {
      this.agentSyncTimer = null;

      const diff = this.pendingAgentDiff;
      this.pendingAgentDiff = null;

      if (!diff) {
        return;
      }

      try {
        const success = await syncAgentsDiffToBackend(diff, this.logger, this.fetchFn, this.telemetryReporter);
        // 仅当本次 diff 影响了 agent 本身（有 upsert 或 delete）时才覆盖 sync_state.agents。
        // 纯 identity 清理（只有 deleteIdentityAgentIds）不应触碰 agent 快照，
        // 避免把既有 agent 快照擦掉。
        const affectsAgentSnapshot =
          diff.createdOrUpdatedAgents.length > 0 ||
          diff.deletedAgentIds.length > 0;
        if (success && affectsAgentSnapshot && this.onAgentSyncSuccess) {
          await this.onAgentSyncSuccess(diff.pendingSnapshots);
          this.logger.info("==data-sync-report插件==动作:ChangeReporter的Agent快照已持久化==");
        } else if (!success) {
          this.logger.warn("==data-sync-report插件==动作:ChangeReporter的Agent同步失败,快照未持久化==");
        }
      } catch (error) {
        this.logger.error("==data-sync-report插件==动作:ChangeReporter的Agent增量同步异常==参数==", error);
      }
    }, this.syncDebounceMs);
  }

  // --------------------------------
  // Agent Identity 增量同步（复用命令字 4174）
  // --------------------------------

  /**
   * 接收 Identity 增量 diff 结果并调度同步
   *
   * 由 IdentityWatcher 的 onDiff 回调触发。
   * 在 debounce 窗口内合并多次 diff 结果，然后一次性上报。
   * 上报成功后调用 onIdentitySyncSuccess 持久化快照到 sync_state。
   */
  reportIdentityDiff(diff: IdentityDiffResult): void {
    if (this.destroyed) {
      return;
    }

    this.logger.info(
      `==data-sync-report插件==动作:ChangeReporter收到Identity diff==参数==changed=${diff.changedIdentities.length}`
    );

    // 合并到缓冲中
    if (this.pendingIdentityDiff) {
      // 合并 changedIdentities：后来的覆盖前一次（以 agentId 为 key）
      const identityMap = new Map(
        this.pendingIdentityDiff.changedIdentities.map((i) => [i.agentId, i])
      );
      for (const item of diff.changedIdentities) {
        identityMap.set(item.agentId, item);
      }

      this.pendingIdentityDiff = {
        changedIdentities: Array.from(identityMap.values()),
        // pendingSnapshots 取最新的
        pendingSnapshots: diff.pendingSnapshots,
      };
    } else {
      this.pendingIdentityDiff = diff;
    }

    this.scheduleIdentityDiffSync();
  }

  /**
   * 调度延迟 Identity 增量同步
   *
   * 上报成功后，调用 onIdentitySyncSuccess 将 pendingSnapshots 持久化到 sync_state。
   * 上报失败时不持久化，确保下次 diff 时能重新检测到变化。
   */
  private scheduleIdentityDiffSync(): void {
    if (this.identitySyncTimer) {
      clearTimeout(this.identitySyncTimer);
    }

    this.identitySyncTimer = setTimeout(async () => {
      this.identitySyncTimer = null;

      const diff = this.pendingIdentityDiff;
      this.pendingIdentityDiff = null;

      if (!diff || diff.changedIdentities.length === 0) {
        return;
      }

      // 逐个 agent 上报 identity（复用 syncAgentIdentityToBackend）
      let allSuccess = true;
      for (const { agentId, identity, hash } of diff.changedIdentities) {
        try {
          const success = await syncAgentIdentityToBackend({ agentId, identity, hash }, this.logger, this.fetchFn, this.telemetryReporter);
          if (success) {
            this.logger.info(`==data-sync-report插件==动作:ChangeReporter的Identity同步成功==参数==agentId="${agentId}"`);
          } else {
            this.logger.warn(`==data-sync-report插件==动作:ChangeReporter的Identity同步失败==参数==agentId="${agentId}"`);
            allSuccess = false;
          }
        } catch (error) {
          this.logger.error(`==data-sync-report插件==动作:ChangeReporter的Identity同步异常==参数==agentId="${agentId}"`, error);
          allSuccess = false;
        }
      }

      // 全部上报成功后才持久化快照
      if (allSuccess && this.onIdentitySyncSuccess) {
        await this.onIdentitySyncSuccess(diff.pendingSnapshots);
        this.logger.info("==data-sync-report插件==动作:ChangeReporter的Identity快照已持久化==");
      } else if (!allSuccess) {
        this.logger.warn("==data-sync-report插件==动作:ChangeReporter的Identity部分同步失败,快照未持久化==");
      }
    }, this.syncDebounceMs);
  }

  // --------------------------------
  // CronJob 增量同步（命令字 4180）
  // --------------------------------

  /**
   * 接收 CronJob 增量 diff 结果并调度同步
   *
   * 由 CronJobsWatcher 的 onDiff 回调触发。
   * 在 debounce 窗口内合并多次 diff 结果，然后一次性上报。
   */
  reportCronJobDiff(diff: CronJobDiffResult): void {
    if (this.destroyed) {
      return;
    }

    this.logger.info(
      `==data-sync-report插件==动作:ChangeReporter收到CronJob diff==参数==upsert=${diff.createdOrUpdatedJobs.length}, delete=${diff.deletedJobIds.length}`
    );

    // 合并到缓冲中
    if (this.pendingCronJobDiff) {
      // 合并 createdOrUpdatedJobs：后来的覆盖前一次（以 jobId 为 key）
      const jobMap = new Map(
        this.pendingCronJobDiff.createdOrUpdatedJobs.map((j) => [j.data.id, j])
      );
      for (const job of diff.createdOrUpdatedJobs) {
        jobMap.set(job.data.id, job);
      }

      // 合并 deletedJobIds：去重
      const deleteSet = new Set([
        ...this.pendingCronJobDiff.deletedJobIds,
        ...diff.deletedJobIds,
      ]);

      // 如果某个 job 既在 upsert 又在 delete 中，以最新的 diff 为准
      // 新 diff 中有 upsert → 从 delete 中移除
      for (const job of diff.createdOrUpdatedJobs) {
        deleteSet.delete(job.data.id);
      }
      // 新 diff 中有 delete → 从 upsert 中移除
      for (const id of diff.deletedJobIds) {
        jobMap.delete(id);
      }

      this.pendingCronJobDiff = {
        createdOrUpdatedJobs: Array.from(jobMap.values()),
        deletedJobIds: Array.from(deleteSet),
        // pendingSnapshots 取最新的（后来的 diff 是基于最新文件内容计算的完整快照）
        pendingSnapshots: diff.pendingSnapshots,
      };
    } else {
      this.pendingCronJobDiff = diff;
    }

    this.scheduleCronJobDiffSync();
  }

  /**
   * 调度延迟 CronJob 增量同步
   *
   * 上报成功后，调用 onCronJobSyncSuccess 将 pendingSnapshots 持久化到 sync_state。
   * 上报失败时不持久化，确保下次 diff 时能重新检测到变化。
   */
  private scheduleCronJobDiffSync(): void {
    if (this.cronJobSyncTimer) {
      clearTimeout(this.cronJobSyncTimer);
    }

    this.cronJobSyncTimer = setTimeout(async () => {
      this.cronJobSyncTimer = null;

      const diff = this.pendingCronJobDiff;
      this.pendingCronJobDiff = null;

      if (!diff) {
        return;
      }

      try {
        const success = await syncCronJobsDiffToBackend(diff, this.logger, this.fetchFn, this.telemetryReporter);
        if (success && this.onCronJobSyncSuccess) {
          await this.onCronJobSyncSuccess(diff.pendingSnapshots);
          this.logger.info("==data-sync-report插件==动作:ChangeReporter的CronJob快照已持久化==");
        } else if (!success) {
          this.logger.warn("==data-sync-report插件==动作:ChangeReporter的CronJob同步失败,快照未持久化==");
        }
      } catch (error) {
        this.logger.error("==data-sync-report插件==动作:ChangeReporter的CronJob增量同步异常==参数==", error);
      }
    }, this.syncDebounceMs);
  }

  // --------------------------------
  // CronRun 日志上报（命令字 4179）
  // --------------------------------

  /**
   * 缓冲 CronRun 事件，按 jobId 分组
   *
   * 同一个 job 的连续执行记录会被合并到一次 API 调用中（最多 100 条）
   */
  private bufferCronRunEvent(event: CronRunEvent): void {
    const existing = this.cronRunBuffer.get(event.jobId) || [];
    existing.push(event);
    this.cronRunBuffer.set(event.jobId, existing);

    this.scheduleCronRunReport();
  }

  /**
   * 调度延迟 CronRun 日志上报
   *
   * 等待 1 秒合并同一 job 的连续执行记录，然后按 jobId 分组逐个上报。
   * 上报成功后调用 onCronRunSyncSuccess 确认偏移推进。
   */
  private scheduleCronRunReport(): void {
    if (this.cronRunReportTimer) {
      clearTimeout(this.cronRunReportTimer);
    }

    this.cronRunReportTimer = setTimeout(async () => {
      this.cronRunReportTimer = null;

      // 取出所有缓冲的事件并清空
      const buffered = new Map(this.cronRunBuffer);
      this.cronRunBuffer.clear();

      // 按 jobId 逐个上报
      for (const [jobId, events] of buffered) {
        const entries = events.map((e) => e.data);
        // 取最后一个事件的 offset 和 filePath
        const lastEvent = events[events.length - 1];
        const offset = lastEvent.offset;
        const filePath = lastEvent.filePath;

        try {
          const success = await reportCronRunLogs(jobId, entries, offset, this.logger, this.fetchFn, this.telemetryReporter);
          if (success && this.onCronRunSyncSuccess) {
            await this.onCronRunSyncSuccess(filePath, offset);
          } else if (!success) {
            this.logger.warn(
              `==data-sync-report插件==动作:ChangeReporter的CronRun日志上报失败,偏移未确认==参数==jobId="${jobId}"`
            );
          }
        } catch (error) {
          this.logger.error(
            `==data-sync-report插件==动作:ChangeReporter的CronRun日志上报异常==参数==jobId="${jobId}"`,
            error
          );
        }
      }
    }, this.cronRunReportDebounceMs);
  }

  // --------------------------------
  // 通用工具方法
  // --------------------------------

  /**
   * 记录事件日志（简洁摘要格式，避免完整序列化大对象）
   */
  private logEvent(event: ChangeEvent): void {
    switch (event.type) {
      case "agent":
        this.logger.info(
          `==data-sync-report插件==动作:ChangeReporter记录Agent事件==参数==action="${event.action}", agentId="${event.agentId}", name="${event.data.name ?? event.data.id}"`
        );
        break;
      case "cron-job":
        this.logger.info(
          `==data-sync-report插件==动作:ChangeReporter记录CronJob事件==参数==action="${event.action}", jobId="${event.jobId}", name="${event.data.name}"`
        );
        break;
      case "cron-run":
        this.logger.info(
          `==data-sync-report插件==动作:ChangeReporter记录CronRun事件==参数==action="${event.action}", jobId="${event.jobId}", status="${event.data.status ?? "unknown"}"`
        );
        break;
    }
  }
}

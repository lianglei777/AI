/**
 * 数据同步上报插件 - CronJobsWatcher
 *
 * 监听 cron/jobs.json 文件变化，检测 Cron Job 的创建、修改和删除。
 *
 * 实现原理：
 * 1. chokidar 监听 cron/jobs.json 文件变化（debounce 500ms）
 * 2. 读取并解析文件（标准 JSON 格式）
 * 3. 提取 store.jobs 数组
 * 4. 对每个 job 的完整数据进行递归排序键 + SHA-256 哈希
 * 5. 直接从 sync_state.json 读取上次快照进行对比，推断 created/updated/deleted
 * 6. 将 pendingSnapshots 传给 onDiff 回调，由上层在上报成功后再写入 sync_state
 */

import fs from "node:fs";
import type {
  CronJobData,
  CronJobDiffCallback,
  CronJobDiffResult,
  CronJobSnapshot,
  CronJobWithHash,
  Logger,
} from "../types.js";
import { computeHash } from "../utils/hash.js";
import { safeParseJson5 } from "../utils/json-parser.js";

import { BaseWatcher } from "./base-watcher.js";

/**
 * 文件读取解析失败时的重试延迟（毫秒）
 * rename-based 原子写入理论上不会产生中间态，但兜底重试一次更安全
 */
const READ_RETRY_DELAY_MS = 300;

export interface CronJobsWatcherOptions {
  /** cron/jobs.json 文件的完整路径 */
  readonly jobsFilePath: string;
  /** debounce 延迟（毫秒） */
  readonly debounceMs: number;
  /** 日志记录器 */
  readonly logger: Logger;
  /** CronJob 增量 diff 回调，每次 diff 后将增量结果传出 */
  readonly onDiff: CronJobDiffCallback;
  /** 从 sync_state.json 读取 CronJob 快照 */
  readonly getSnapshots: () => Record<string, CronJobSnapshot>;
  /** 将最新 CronJob 快照写入 sync_state.json */
  readonly saveSnapshots: (snapshots: Record<string, CronJobSnapshot>) => Promise<void>;
}

export class CronJobsWatcher extends BaseWatcher {
  private readonly jobsFilePath: string;
  private readonly onDiff: CronJobDiffCallback;
  private readonly getSnapshotsFromState: () => Record<string, CronJobSnapshot>;
  private readonly saveSnapshotsToState: (snapshots: Record<string, CronJobSnapshot>) => Promise<void>;

  constructor(options: CronJobsWatcherOptions) {
    super({
      watchPath: options.jobsFilePath,
      debounceMs: options.debounceMs,
      logger: options.logger,
      name: "CronJobsWatcher",
    });
    this.jobsFilePath = options.jobsFilePath;
    this.onDiff = options.onDiff;
    this.getSnapshotsFromState = options.getSnapshots;
    this.saveSnapshotsToState = options.saveSnapshots;
  }

  /**
   * 初始化：读取当前 Cron Jobs，与 sync_state 中的快照对比
   *
   * - 如果 sync_state 中有快照 → 做 diff 对比，检测离线期间的变化
   * - 如果 sync_state 中没有快照 → 首次启动，构建初始快照写入 sync_state
   */
  protected async initialize(): Promise<void> {
    const jobs = await this.readJobsList();
    if (!jobs) {
      return;
    }

    const savedSnapshots = this.getSnapshotsFromState();
    const hasSavedSnapshots = Object.keys(savedSnapshots).length > 0;

    if (hasSavedSnapshots) {
      await this.diffAndEmit(jobs);
    } else {
      // 首次启动：构建初始快照并写入 sync_state
      const now = Date.now();
      const newSnapshots: Record<string, CronJobSnapshot> = {};
      for (const job of jobs) {
        const hash = computeHash(job);
        newSnapshots[job.id] = { hash, lastChangedAt: now };
      }
      await this.saveSnapshotsToState(newSnapshots);
    }
  }

  /**
   * 处理 jobs.json 文件变化
   *
   * 当文件读取/解析失败时，延迟 READ_RETRY_DELAY_MS 后重试一次，
   * 避免因短暂的文件不可用（如 rename 原子替换瞬间）而丢失变化事件。
   */
  protected async onFileChange(
    _filePath: string,
    eventType: "change" | "add" | "unlink"
  ): Promise<void> {
    if (eventType === "unlink") {
      await this.handleAllDeleted();
      return;
    }

    let jobs = await this.readJobsList();
    if (!jobs) {
      this.logger.info(
        `==data-sync-report插件==动作:CronJobsWatcher首次读取失败,${READ_RETRY_DELAY_MS}ms后重试==`
      );
      await new Promise((resolve) => setTimeout(resolve, READ_RETRY_DELAY_MS));
      jobs = await this.readJobsList();
      if (!jobs) {
        this.logger.warn(
          "==data-sync-report插件==动作:CronJobsWatcher重试读取仍失败,跳过本次变化=="
        );
        return;
      }
    }

    await this.diffAndEmit(jobs);
  }

  /**
   * 从 cron/jobs.json 读取 jobs 数组
   *
   * 文件格式：{ version: 1, jobs: CronJob[] }
   */
  private async readJobsList(): Promise<CronJobData[] | null> {
    try {
      const content = await fs.promises.readFile(this.jobsFilePath, "utf-8");
      const result = safeParseJson5(content);

      if (!result.ok) {
        this.logger.warn(
          `==data-sync-report插件==动作:CronJobsWatcher解析Jobs文件失败==参数==${result.error}`
        );
        return null;
      }

      const store = result.data as Record<string, unknown>;
      const jobs = store?.jobs;

      if (!Array.isArray(jobs)) {
        return [];
      }

      return jobs.filter(
        (job): job is CronJobData =>
          Boolean(job && typeof job === "object" && (job as CronJobData).id)
      );
    } catch (error) {
      const nodeErr = error as NodeJS.ErrnoException;
      if (nodeErr?.code === "ENOENT") {
        return null;
      }
      this.logger.error("==data-sync-report插件==动作:CronJobsWatcher读取Jobs文件失败==参数==", error);
      return null;
    }
  }

  /**
   * 对比当前 jobs 列表与 sync_state 中的快照，收集增量变化
   *
   * 1. 从 sync_state.json 读取上次的快照
   * 2. 计算当前 jobs 的 hash
   * 3. 对比得出 created/updated/deleted
   * 4. 构建 pendingSnapshots（不写入 sync_state，等上报成功后再写）
   * 5. 通过 onDiff 回调传出增量结果 + pendingSnapshots
   */
  private async diffAndEmit(currentJobs: CronJobData[]): Promise<void> {
    const now = Date.now();

    // 从 sync_state 读取上次快照
    const previousSnapshots = this.getSnapshotsFromState();

    // 计算当前 jobs 的 hash（对完整 job 数据做 hash）
    const currentMap = new Map<
      string,
      { hash: string; data: CronJobData }
    >();
    for (const job of currentJobs) {
      const hash = computeHash(job);
      currentMap.set(job.id, { hash, data: job });
    }

    const createdOrUpdatedJobs: CronJobWithHash[] = [];
    const deletedJobIds: string[] = [];

    // 检测新增和修改
    for (const [id, { hash, data }] of currentMap) {
      const previous = previousSnapshots[id];

      if (!previous) {
        this.logger.info(`==data-sync-report插件==动作:CronJobsWatcher检测到Job新增==参数==jobId="${id}"`);
        createdOrUpdatedJobs.push({ hash, data });
      } else if (previous.hash !== hash) {
        this.logger.info(`==data-sync-report插件==动作:CronJobsWatcher检测到Job编辑==参数==jobId="${id}"`);
        createdOrUpdatedJobs.push({ hash, data });
      }
    }

    // 检测删除
    for (const id of Object.keys(previousSnapshots)) {
      if (!currentMap.has(id)) {
        this.logger.info(`==data-sync-report插件==动作:CronJobsWatcher检测到Job删除==参数==jobId="${id}"`);
        deletedJobIds.push(id);
      }
    }

    // 构建最新快照（不立即写入 sync_state，等上报成功后再写）
    const pendingSnapshots: Record<string, CronJobSnapshot> = {};
    for (const [id, { hash }] of currentMap) {
      pendingSnapshots[id] = { hash, lastChangedAt: now };
    }

    // 有变化时才回调
    if (createdOrUpdatedJobs.length === 0 && deletedJobIds.length === 0) {
      this.logger.info("==data-sync-report插件==动作:CronJobsWatcher无变化==");
      return;
    }

    const diff: CronJobDiffResult = { createdOrUpdatedJobs, deletedJobIds, pendingSnapshots };

    Promise.resolve(this.onDiff(diff)).catch((error) => {
      this.logger.error(
        "==data-sync-report插件==动作:CronJobsWatcher的diff回调异常==参数==",
        error
      );
    });
  }

  /**
   * 处理 jobs.json 被删除：所有 job 标记为 deleted
   */
  private async handleAllDeleted(): Promise<void> {
    const previousSnapshots = this.getSnapshotsFromState();
    const deletedJobIds = Object.keys(previousSnapshots);

    for (const id of deletedJobIds) {
      this.logger.info(`==data-sync-report插件==动作:CronJobsWatcher检测到Job删除(文件移除)==参数==jobId="${id}"`);
    }

    if (deletedJobIds.length === 0) {
      return;
    }

    // 空快照，上报成功后写入 sync_state 以清空
    const diff: CronJobDiffResult = {
      createdOrUpdatedJobs: [],
      deletedJobIds,
      pendingSnapshots: {},
    };

    Promise.resolve(this.onDiff(diff)).catch((error) => {
      this.logger.error(
        "==data-sync-report插件==动作:CronJobsWatcher的diff回调异常(全部删除)==参数==",
        error
      );
    });
  }
}

/**
 * 数据同步上报插件 - CronRunsWatcher
 *
 * 监听 cron/runs/ 目录下的 .jsonl 文件变化，检测 Cron 执行记录的新增。
 *
 * 实现原理：
 * 1. chokidar 监听 cron/runs/ 目录下所有 .jsonl 文件
 * 2. 偏移由 SyncStateManager 管理（通过 getOffset/saveOffset 回调读写）
 * 3. 文件变化时：读取 stat.size，如果 > 已确认偏移则只读新增部分
 * 4. 按行解析新增部分 → 每行 JSON.parse → 生成 cron-run 事件
 * 5. 上报成功后才通过 saveOffset 回调持久化偏移到 sync_state
 * 6. 文件缩小时通过 saveOffset 重置偏移（应对 pruneIfNeeded 截断）
 *
 * 核心原则：
 * - 偏移只有在上报成功后才持久化（或文件截断时重置）
 * - 对于 sync_state 中没有记录的文件，偏移默认为 0，从头读取全部内容上报
 *
 * 注意：
 * - 执行记录文件是追加写入的 JSONL 格式
 * - 文件名格式为 <jobId>.jsonl
 * - 超过 2MB 时 OpenClaw 会保留最近 2000 行（pruneIfNeeded），此时文件会缩小
 */

import fs from "node:fs";
import path from "node:path";
import type {
  BatchChangeEventCallback,
  CronRunEvent,
  CronRunLogEntryData,
  Logger,
} from "../types.js";
import { CRON_RUNS_FILE_EXTENSION } from "../constants.js";
import { parseJsonlLines } from "../utils/json-parser.js";
import { BaseWatcher } from "./base-watcher.js";

export interface CronRunsWatcherOptions {
  /** cron/runs/ 目录的完整路径 */
  readonly runsDir: string;
  /** debounce 延迟（毫秒） */
  readonly debounceMs: number;
  /** 日志记录器 */
  readonly logger: Logger;
  /** 变化事件批量回调 */
  readonly onBatchEvent: BatchChangeEventCallback;
  /** 从 SyncStateManager 获取某个文件的已确认偏移（未记录返回 undefined） */
  readonly getOffset: (filePath: string) => number | undefined;
  /** 从 SyncStateManager 获取所有 CronRun 偏移记录的 filePath 列表 */
  readonly getAllOffsetPaths: () => string[];
  /** 上报成功后将偏移持久化到 SyncStateManager（立即写磁盘） */
  readonly saveOffset: (filePath: string, byteOffset: number) => Promise<void>;
  /** 文件被删除时清除 SyncStateManager 中的偏移记录 */
  readonly deleteOffset: (filePath: string) => Promise<void>;
}

export class CronRunsWatcher extends BaseWatcher {
  private readonly runsDir: string;
  private readonly onBatchEvent: BatchChangeEventCallback;
  private readonly getOffset: (filePath: string) => number | undefined;
  private readonly getAllOffsetPaths: () => string[];
  private readonly saveOffset: (filePath: string, byteOffset: number) => Promise<void>;
  private readonly deleteOffset: (filePath: string) => Promise<void>;

  constructor(options: CronRunsWatcherOptions) {
    super({
      watchPath: options.runsDir,
      debounceMs: options.debounceMs,
      logger: options.logger,
      name: "CronRunsWatcher",
    });
    this.runsDir = options.runsDir;
    this.onBatchEvent = options.onBatchEvent;
    this.getOffset = options.getOffset;
    this.getAllOffsetPaths = options.getAllOffsetPaths;
    this.saveOffset = options.saveOffset;
    this.deleteOffset = options.deleteOffset;
  }

  /**
   * 子类提供的额外 chokidar 选项：监听目录模式
   */
  protected getChokidarOptions() {
    return {
      // 只关注 .jsonl 文件，允许目录通过（无扩展名或路径不含 . 的视为目录）
      ignored: (filePath: string) => {
        const ext = path.extname(filePath);
        // 无扩展名的路径视为目录，允许通过
        if (!ext) {
          return false;
        }
        return ext !== CRON_RUNS_FILE_EXTENSION;
      },
      depth: 0, // 只监听一级目录
    };
  }

  /**
   * 初始化：扫描 runs 目录中的所有 .jsonl 文件
   *
   * 从 SyncStateManager 读取已确认偏移：
   * - 有偏移且文件变大了 → 读取增量内容并上报
   * - 有偏移但文件缩小了 → 文件被截断，重置偏移
   * - 没有偏移但文件有内容 → 从 0 开始读取全部内容并上报（首次启动或新文件）
   */
  protected async initialize(): Promise<void> {
    try {
      await fs.promises.mkdir(this.runsDir, { recursive: true });
      const entries = await fs.promises.readdir(this.runsDir);
      const existingFilePaths = new Set<string>();

      let fileCount = 0;
      for (const entry of entries) {
        if (!entry.endsWith(CRON_RUNS_FILE_EXTENSION)) {
          continue;
        }

        const filePath = path.join(this.runsDir, entry);
        const stat = await fs.promises.stat(filePath).catch(() => null);
        if (!stat || !stat.isFile()) {
          continue;
        }

        existingFilePaths.add(filePath);

        // 从 SyncStateManager 读取已确认偏移
        const confirmedOffset = this.getOffset(filePath);
        const currentOffset = confirmedOffset ?? 0;

        if (stat.size > currentOffset) {
          // 有新增内容（或 sync_state 无记录时从 0 开始读取全部内容），读取并上报
          await this.readNewEntries(filePath, currentOffset, stat.size);
        } else if (confirmedOffset !== undefined && stat.size < confirmedOffset) {
          // 文件被截断（pruneIfNeeded），重置偏移
          // 注意：只有 sync_state 中有记录时才需要重置，无记录时不存在"截断"的概念
          await this.saveOffset(filePath, stat.size);
          this.logger.info(
            `==data-sync-report插件==动作:CronRunsWatcher初始化检测到文件截断==参数==文件="${entry}", ${confirmedOffset} -> ${stat.size}`
          );
        }
        // stat.size === currentOffset: 无新增内容，跳过

        fileCount++;
      }

      let staleCount = 0;
      for (const offsetPath of this.getAllOffsetPaths()) {
        if (!existingFilePaths.has(offsetPath)) {
          await this.deleteOffset(offsetPath);
          staleCount++;
          this.logger.info(
            `==data-sync-report插件==动作:CronRunsWatcher清理残留偏移记录==参数==文件="${path.basename(offsetPath)}"`
          );
        }
      }

    } catch (error) {
      const nodeErr = error as NodeJS.ErrnoException;
      if (nodeErr?.code !== "ENOENT") {
        this.logger.error(
          "==data-sync-report插件==动作:CronRunsWatcher初始化runs目录失败==参数==",
          error
        );
      }
    }
  }

  /**
   * 处理 .jsonl 文件变化
   *
   * 从 SyncStateManager 读取已确认偏移作为读取起点。
   * 如果 sync_state 中没有记录，偏移默认为 0，从头读取全部内容。
   * 上报失败时偏移不推进，下次变化时会重新读取未确认的部分。
   */
  protected async onFileChange(
    filePath: string,
    eventType: "change" | "add" | "unlink"
  ): Promise<void> {
    // 只处理 .jsonl 文件
    if (!filePath.endsWith(CRON_RUNS_FILE_EXTENSION)) {
      return;
    }

    if (eventType === "unlink") {
      // 文件被删除，清除 sync_state 中的偏移记录
      await this.deleteOffset(filePath);
      return;
    }

    try {
      const stat = await fs.promises.stat(filePath);
      // 从 SyncStateManager 读取已确认偏移，没有记录则从 0 开始
      const currentOffset = this.getOffset(filePath) ?? 0;

      if (stat.size > currentOffset) {
        // 有新增内容
        await this.readNewEntries(filePath, currentOffset, stat.size);
      } else if (stat.size < currentOffset) {
        // 文件被截断（pruneIfNeeded 使用 temp+rename 原子替换，保留最近 2000 行）
        // 截断后需要重置偏移，被截断的旧内容在截断前已经被处理过了
        this.logger.info(
          `==data-sync-report插件==动作:CronRunsWatcher检测到文件截断==参数==文件="${path.basename(filePath)}", ${currentOffset} -> ${stat.size}, 重置偏移`
        );
        await this.saveOffset(filePath, stat.size);
      }
      // stat.size === currentOffset: 无变化，跳过
    } catch (error) {
      const nodeErr = error as NodeJS.ErrnoException;
      if (nodeErr?.code !== "ENOENT") {
        this.logger.error(
          `==data-sync-report插件==动作:CronRunsWatcher处理文件失败==参数==文件="${path.basename(filePath)}"`,
          error
        );
      }
    }
  }

  /**
   * 读取文件的新增内容并解析为事件
   *
   * 注意：不在此处推进偏移，由上层在上报成功后通过 saveOffset 回调持久化。
   *
   * @param filePath .jsonl 文件路径
   * @param fromOffset 开始读取的字节偏移
   * @param toOffset 文件当前大小
   */
  private async readNewEntries(
    filePath: string,
    fromOffset: number,
    toOffset: number
  ): Promise<void> {
    try {
      // 只读取新增的部分
      const fd = await fs.promises.open(filePath, "r");
      try {
        const buffer = Buffer.alloc(toOffset - fromOffset);
        const { bytesRead } = await fd.read(
          buffer,
          0,
          buffer.length,
          fromOffset
        );

        const content = buffer.subarray(0, bytesRead).toString("utf-8");

        // 如果内容不以换行符结尾，说明最后一行可能不完整
        // 只处理到最后一个换行符为止，剩余的部分不计入 offset
        const lastNewline = content.lastIndexOf("\n");

        if (lastNewline === -1) {
          // 完全没有换行符，说明是一个不完整的行，暂不处理
          return;
        }

        // 处理到最后一个换行符（包含换行符）
        const processableContent = content.substring(0, lastNewline + 1);
        const consumedBytes = Buffer.byteLength(processableContent, "utf-8");

        const entries = parseJsonlLines(processableContent);

        // 从文件名提取 jobId（格式：<jobId>.jsonl）
        const jobId = path.basename(filePath, CRON_RUNS_FILE_EXTENSION);

        // 计算新偏移（不立即持久化，等上报成功后由 ChangeReporter 回调 saveOffset）
        const newOffset = fromOffset + consumedBytes;

        if (entries.length > 0) {
          this.emitEvents(jobId, entries as CronRunLogEntryData[], newOffset, filePath);
          this.logger.info(`==data-sync-report插件==动作:CronRunsWatcher读取新条目==参数==job="${jobId}", 条数=${entries.length}`);
        }
      } finally {
        await fd.close();
      }
    } catch (error) {
      this.logger.error(
        `==data-sync-report插件==动作:CronRunsWatcher读取新条目失败==参数==文件="${path.basename(filePath)}"`,
        error
      );
    }
  }

  /**
   * 批量发送 Cron Run 事件
   */
  private emitEvents(jobId: string, entries: CronRunLogEntryData[], offset: number, filePath: string): void {
    const now = Date.now();
    const events: CronRunEvent[] = entries.map((data) => ({
      type: "cron-run",
      action: "finished",
      jobId,
      data,
      timestamp: now,
      offset,
      filePath,
    }));

    Promise.resolve(this.onBatchEvent(events)).catch((error) => {
      this.logger.error(
        `==data-sync-report插件==动作:CronRunsWatcher批量事件回调异常==参数==job="${jobId}", 事件数=${events.length}`,
        error
      );
    });
  }
}

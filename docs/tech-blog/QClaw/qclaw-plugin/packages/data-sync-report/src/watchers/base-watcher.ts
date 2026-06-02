/**
 * 数据同步上报插件 - BaseWatcher 基类
 *
 * 封装 chokidar 文件监听的通用逻辑，包括：
 * - chokidar watcher 初始化与销毁
 * - debounce 处理
 * - 错误处理与日志
 * - start/stop 生命周期管理
 * - mtime 补偿轮询（解决 chokidar 漏报事件的问题）
 */

import chokidar, { type FSWatcher, type ChokidarOptions } from "chokidar";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../types.js";

/**
 * 补偿轮询配置
 *
 * chokidar + macOS FSEvents + awaitWriteFinish 在 rename-based 原子写入场景下
 * 可能漏报后续的 change 事件（尤其是快速连续操作时）。
 * 补偿轮询在每次处理完文件变化后，启动一个短暂的定时检查窗口，
 * 通过对比 mtime 来发现 chokidar 遗漏的文件变化。
 */
const COMPENSATE_POLL_INTERVAL_MS = 500;
const COMPENSATE_POLL_DURATION_MS = 3000;

export interface BaseWatcherOptions {
  /** 监听的文件或目录路径 */
  readonly watchPath: string;
  /** debounce 延迟（毫秒） */
  readonly debounceMs: number;
  /** 日志记录器 */
  readonly logger: Logger;
  /** Watcher 名称（用于日志标识） */
  readonly name: string;
  /** chokidar 额外选项 */
  readonly chokidarOptions?: ChokidarOptions;
}

/**
 * 文件 Watcher 基类
 *
 * 子类需要实现 `onFileChange` 方法来处理文件变化事件。
 */
export abstract class BaseWatcher {
  protected readonly watchPath: string;
  protected readonly debounceMs: number;
  protected readonly logger: Logger;
  protected readonly name: string;

  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isRunning = false;

  /**
   * 待处理的文件变化事件 Map<filePath, eventType>
   * 在 debounce 窗口内收集所有变化的文件，debounce 结束后批量处理。
   * 同一文件多次变化只保留最后一次的 eventType。
   */
  private pendingChanges: Map<string, "change" | "add" | "unlink"> = new Map();

  /**
   * 补偿轮询定时器
   * 每次处理完文件变化后启动，在 COMPENSATE_POLL_DURATION_MS 窗口内
   * 每 COMPENSATE_POLL_INTERVAL_MS 检查一次 mtime，发现变化则触发重新处理。
   */
  private compensateTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 补偿轮询结束定时器（控制轮询窗口的总时长）
   */
  private compensateEndTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 上次处理完成后记录的文件 mtimeMs
   * 补偿轮询会定期对比此值，发现变化则触发重新处理
   */
  private lastKnownMtimes: Map<string, number> = new Map();

  constructor(options: BaseWatcherOptions) {
    this.watchPath = options.watchPath;
    this.debounceMs = options.debounceMs;
    this.logger = options.logger;
    this.name = options.name;
  }

  /**
   * 启动文件监听
   *
   * 初始化 chokidar watcher 并开始监听文件变化。
   *
   * 使用 `awaitWriteFinish` 是因为 macOS FSEvents + chokidar 在没有它的情况下
   * 无法可靠地将 rename-based 原子写入（OpenClaw 的写入方式）转化为 change 事件。
   * `awaitWriteFinish` 通过 stat 轮询来检测文件稳定，能正确捕获 rename 后的变化。
   *
   * 但 `awaitWriteFinish` 在快速连续写入时可能漏报后续 change 事件，
   * 这个问题由补偿轮询机制（mtime 定时检查）解决。
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn(`==data-sync-report插件==动作:${this.name}已在运行,跳过启动==`);
      return;
    }

    try {
      // 确保监听目标的父目录存在
      // 对于目录监听（如 cron/runs/），初始状态下目录可能不存在
      // 对于文件监听（如 jobs.json），父目录也可能不存在
      //
      // 判断逻辑：通过 path.extname 判断是否有文件扩展名来区分文件/目录
      // 有扩展名（如 .json）→ 文件监听 → 确保父目录存在
      // 无扩展名 → 目录监听 → 确保目录本身存在
      const watchTarget = this.watchPath;
      const ext = path.extname(watchTarget);
      if (ext) {
        // 文件监听：确保父目录存在
        const parentDir = path.dirname(watchTarget);
        await fs.promises.mkdir(parentDir, { recursive: true });
      } else {
        // 目录监听：确保目录本身存在
        await fs.promises.mkdir(watchTarget, { recursive: true });
      }

      this.watcher = chokidar.watch(this.watchPath, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
          // macOS FSEvents + rename-based 原子写入需要 awaitWriteFinish 才能可靠触发 change
          stabilityThreshold: 300,
          pollInterval: 100,
        },
        ...this.getChokidarOptions(),
      });

      this.watcher.on("change", (filePath: string) => {
        this.scheduleHandleChange(filePath, "change");
      });

      this.watcher.on("add", (filePath: string) => {
        this.scheduleHandleChange(filePath, "add");
      });

      this.watcher.on("unlink", (filePath: string) => {
        this.scheduleHandleChange(filePath, "unlink");
      });

      this.watcher.on("error", (error: unknown) => {
        this.logger.error(`==data-sync-report插件==动作:${this.name}监听错误==参数==`, error);
      });

      this.isRunning = true;
      // 启动后执行一次初始化快照（子类实现）
      await this.initialize();
    } catch (error) {
      this.logger.error(`==data-sync-report插件==动作:${this.name}启动失败==参数==`, error);
      throw error;
    }
  }

  /**
   * 停止文件监听
   *
   * 关闭 chokidar watcher 并清理定时器。
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.stopCompensatePoll();

    this.pendingChanges.clear();
    this.lastKnownMtimes.clear();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    this.isRunning = false;
  }

  /** 当前是否正在运行 */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * 子类提供的额外 chokidar 选项
   * 默认返回空对象，子类可以覆盖以提供特定选项。
   */
  protected getChokidarOptions(): ChokidarOptions {
    return {};
  }

  /**
   * 初始化快照
   * 子类实现，在 watcher 启动后执行一次初始状态加载。
   */
  protected abstract initialize(): Promise<void>;

  /**
   * 处理文件变化
   * 子类实现具体的变化检测逻辑。
   *
   * @param filePath 变化的文件路径
   * @param eventType 变化类型（change/add/unlink）
   */
  protected abstract onFileChange(
    filePath: string,
    eventType: "change" | "add" | "unlink"
  ): Promise<void>;

  /**
   * 带 debounce 的变化处理调度
   *
   * 在 debounceMs 窗口内收集所有变化的文件到 pendingChanges Map 中，
   * debounce 结束后批量处理所有收集到的文件变化。
   * 同一文件多次变化只保留最后一次的 eventType。
   *
   * 这确保了监听目录时（如 CronRunsWatcher），短时间内多个不同文件的变化
   * 都能被正确处理，不会因为 debounce 只保留最后一个而丢失事件。
   */
  private scheduleHandleChange(
    filePath: string,
    eventType: "change" | "add" | "unlink"
  ): void {
    // 收集变化事件（同一文件只保留最后一次 eventType）
    this.pendingChanges.set(filePath, eventType);

    // chokidar 正常触发了事件，停止补偿轮询（避免重复处理）
    this.stopCompensatePoll();

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null;

      // 取出所有待处理的变化并清空
      const changes = new Map(this.pendingChanges);
      this.pendingChanges.clear();

      for (const [changedPath, changedEventType] of changes) {
        try {
          await this.onFileChange(changedPath, changedEventType);
        } catch (error) {
          this.logger.error(
            `==data-sync-report插件==动作:${this.name}处理文件变化异常==参数==文件="${changedPath}"`,
            error
          );
        }
      }

      // 处理完成后，记录当前 mtime 并启动补偿轮询
      this.recordMtimesAndStartCompensatePoll(changes);
    }, this.debounceMs);
  }

  /**
   * 记录已处理文件的当前 mtime，并启动补偿轮询
   *
   * 补偿轮询解决 chokidar 漏报事件的问题：
   * 在处理完成后的 COMPENSATE_POLL_DURATION_MS 窗口内，
   * 每 COMPENSATE_POLL_INTERVAL_MS 检查一次 mtime，
   * 如果 mtime 发生变化但 chokidar 没有报告，主动触发处理。
   */
  private recordMtimesAndStartCompensatePoll(
    processedChanges: Map<string, "change" | "add" | "unlink">
  ): void {
    // 停止之前可能还在运行的补偿轮询
    this.stopCompensatePoll();

    // 记录每个已处理文件的当前 mtime
    this.lastKnownMtimes.clear();
    for (const [changedPath, eventType] of processedChanges) {
      if (eventType === "unlink") {
        continue;
      }
      try {
        const stat = fs.statSync(changedPath);
        this.lastKnownMtimes.set(changedPath, stat.mtimeMs);
      } catch {
        // 文件不存在或无法访问，跳过
      }
    }

    if (this.lastKnownMtimes.size === 0) {
      return;
    }

    // 启动定期轮询
    this.compensateTimer = setInterval(() => {
      void this.checkMtimeCompensation();
    }, COMPENSATE_POLL_INTERVAL_MS);

    // 设置轮询窗口结束定时器
    this.compensateEndTimer = setTimeout(() => {
      this.stopCompensatePoll();
    }, COMPENSATE_POLL_DURATION_MS);
  }

  /**
   * 补偿轮询检查：对比已记录的 mtime，发现变化则触发处理
   */
  private async checkMtimeCompensation(): Promise<void> {
    for (const [filePath, knownMs] of this.lastKnownMtimes) {
      // 如果 chokidar 已经报告了新事件或 debounce 正在等待，跳过
      if (this.pendingChanges.has(filePath) || this.debounceTimer) {
        continue;
      }
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.mtimeMs !== knownMs) {
          this.logger.info(
            `==data-sync-report插件==动作:${this.name}补偿轮询发现文件变化(chokidar漏报)==参数==文件="${filePath}"`
          );

          // 停止补偿轮询（即将触发新一轮处理，处理完后会启动新的补偿轮询）
          this.stopCompensatePoll();

          // 通过 scheduleHandleChange 触发标准处理流程
          this.scheduleHandleChange(filePath, "change");
          return;
        }
      } catch {
        // 文件被删除或无法访问，跳过
      }
    }
  }

  /**
   * 停止补偿轮询
   */
  private stopCompensatePoll(): void {
    if (this.compensateTimer) {
      clearInterval(this.compensateTimer);
      this.compensateTimer = null;
    }
    if (this.compensateEndTimer) {
      clearTimeout(this.compensateEndTimer);
      this.compensateEndTimer = null;
    }
  }
}

/**
 * 数据同步上报插件 - SyncStateManager
 *
 * 管理同步状态的持久化和恢复。
 *
 * 状态文件路径：~/.openclaw/sync/sync_state.json
 *
 * 职责：
 * - 从磁盘加载上次的同步状态（Agent 快照、Cron Job 快照、Cron Run 偏移）
 * - 将当前同步状态持久化到磁盘
 * - 提供原子写入保障（先写 .tmp 再 rename）
 */

import fs from "node:fs";
import path from "node:path";
import type { Logger, SyncState } from "./types.js";
import {
  SYNC_STATE_FILENAME,
  SYNC_STATE_RELATIVE_DIR,
} from "./constants.js";
import { safeParseJson } from "./utils/json-parser.js";

/**
 * 创建空的初始同步状态
 */
export function createEmptySyncState(): SyncState {
  return {
    version: 1,
    agents: {},
    identities: {},
    cronJobs: {},
    cronRunOffsets: {},
    lastUpdatedAt: Date.now(),
  };
}

export interface SyncStateManagerOptions {
  /** OpenClaw 状态目录路径（~/.openclaw/） */
  readonly stateDir: string;
  /** 日志记录器 */
  readonly logger: Logger;
}

export class SyncStateManager {
  private readonly stateDir: string;
  private readonly statePath: string;
  private readonly logger: Logger;

  /** 当前内存中的同步状态 */
  private state: SyncState;

  constructor(options: SyncStateManagerOptions) {
    this.stateDir = path.join(options.stateDir, SYNC_STATE_RELATIVE_DIR);
    this.statePath = path.join(this.stateDir, SYNC_STATE_FILENAME);
    this.logger = options.logger;
    this.state = createEmptySyncState();
  }

  /**
   * 从磁盘加载同步状态
   *
   * @returns 是否成功加载（false 表示使用默认空状态）
   */
  async load(): Promise<boolean> {
    try {
      const content = await fs.promises.readFile(this.statePath, "utf-8");
      const result = safeParseJson(content);

      if (!result.ok) {
        this.logger.warn(
          `==data-sync-report插件==动作:StateManager解析状态文件失败==参数==${result.error}`
        );
        return false;
      }

      const data = result.data as SyncState;

      // 版本检查
      if (data.version !== 1) {
        this.logger.warn(
          `==data-sync-report插件==动作:StateManager状态版本不支持==参数==${data.version}`
        );
        return false;
      }

      this.state = {
        version: 1,
        agents: data.agents ?? {},
        identities: data.identities ?? {},
        cronJobs: data.cronJobs ?? {},
        cronRunOffsets: data.cronRunOffsets ?? {},
        lastFullScanAt: data.lastFullScanAt,
        lastReconciliationAt: data.lastReconciliationAt,
        lastUpdatedAt: data.lastUpdatedAt ?? Date.now(),
      };
      return true;
    } catch (error) {
      const nodeErr = error as NodeJS.ErrnoException;
      if (nodeErr?.code === "ENOENT") {
        this.logger.info("==data-sync-report插件==动作:StateManager无历史状态文件,从空状态开始==");
        return false;
      }
      this.logger.error("==data-sync-report插件==动作:StateManager加载状态失败==参数==", error);
      return false;
    }
  }

  /**
   * 将当前同步状态持久化到磁盘
   *
   * 使用原子写入保障：先写 .tmp 文件，再 rename 覆盖。
   */
  async save(): Promise<void> {
    try {
      // 确保目录存在
      await fs.promises.mkdir(this.stateDir, { recursive: true });

      // 更新时间戳
      const stateToSave: SyncState = {
        ...this.state,
        lastUpdatedAt: Date.now(),
      };

      const json = JSON.stringify(stateToSave, null, 2) + "\n";
      const tmpPath = `${this.statePath}.tmp`;

      // 原子写入：先写临时文件
      await fs.promises.writeFile(tmpPath, json, { encoding: "utf-8" });

      // rename 覆盖
      await fs.promises.rename(tmpPath, this.statePath);

      this.state = stateToSave;
    } catch (error) {
      this.logger.error("==data-sync-report插件==动作:StateManager保存状态失败==参数==", error);
      // 清理临时文件
      try {
        await fs.promises.unlink(`${this.statePath}.tmp`);
      } catch {
        // 忽略清理失败
      }
    }
  }

  /** 获取当前状态的只读副本 */
  getState(): Readonly<SyncState> {
    return this.state;
  }

  /** 更新 Agent 快照 */
  updateAgentSnapshots(
    agents: Record<string, { hash: string; lastChangedAt: number }>
  ): void {
    this.state = { ...this.state, agents };
  }

  /** 更新 Cron Job 快照 */
  updateCronJobSnapshots(
    cronJobs: Record<string, { hash: string; lastChangedAt: number }>
  ): void {
    this.state = { ...this.state, cronJobs };
  }

  /** 更新 Cron Run 文件偏移（批量） */
  updateCronRunOffsets(
    cronRunOffsets: Record<
      string,
      { filePath: string; byteOffset: number; lastUpdatedAt: number }
    >
  ): void {
    this.state = { ...this.state, cronRunOffsets };
  }

  // --------------------------------
  // CronRun 偏移直接读写（供 CronRunsWatcher 使用）
  // --------------------------------

  /**
   * 获取单个 CronRun 文件的已确认偏移
   * 直接从内存状态中读取（内存状态在 load() 时已从磁盘恢复）
   *
   * @returns 偏移量，如果没有记录则返回 undefined
   */
  getCronRunOffset(filePath: string): number | undefined {
    const offset = this.state.cronRunOffsets[filePath];
    return offset?.byteOffset;
  }

  /**
   * 获取当前所有 CronRun 偏移
   * 直接从内存状态中读取
   */
  getCronRunOffsets(): Record<string, { filePath: string; byteOffset: number; lastUpdatedAt: number }> {
    return this.state.cronRunOffsets;
  }

  /**
   * 更新单个 CronRun 文件偏移并立即持久化到磁盘
   *
   * 上报成功后调用，确保偏移不会因进程崩溃而丢失。
   */
  async saveCronRunOffset(filePath: string, byteOffset: number): Promise<void> {
    this.state = {
      ...this.state,
      cronRunOffsets: {
        ...this.state.cronRunOffsets,
        [filePath]: { filePath, byteOffset, lastUpdatedAt: Date.now() },
      },
    };
    await this.save();
  }

  /**
   * 删除单个 CronRun 文件的偏移记录并立即持久化到磁盘
   *
   * 文件被删除时调用。
   */
  async deleteCronRunOffset(filePath: string): Promise<void> {
    const { [filePath]: _, ...rest } = this.state.cronRunOffsets;
    this.state = {
      ...this.state,
      cronRunOffsets: rest,
    };
    await this.save();
  }

  /** 更新最后全量扫描时间（预留给定时扫描） */
  updateLastFullScanAt(timestamp: number): void {
    this.state = { ...this.state, lastFullScanAt: timestamp };
  }

  /** 更新最后对账时间（预留给数据对账） */
  updateLastReconciliationAt(timestamp: number): void {
    this.state = { ...this.state, lastReconciliationAt: timestamp };
  }

  // --------------------------------
  // Agent 快照直接读写（供 AgentWatcher 使用）
  // --------------------------------

  /**
   * 获取当前 Agent 快照
   * 直接从内存状态中读取（内存状态在 load() 时已从磁盘恢复）
   */
  getAgentSnapshots(): Record<string, { hash: string; lastChangedAt: number }> {
    return this.state.agents;
  }

  /**
   * 更新 Agent 快照并立即持久化到磁盘
   *
   * 更新内存后立即写磁盘，确保 diff 结果不会因进程崩溃而丢失。
   */
  async saveAgentSnapshots(
    agents: Record<string, { hash: string; lastChangedAt: number }>
  ): Promise<void> {
    this.state = { ...this.state, agents };
    await this.save();
  }

  // --------------------------------
  // CronJob 快照直接读写（供 CronJobsWatcher 使用）
  // --------------------------------

  /**
   * 获取当前 CronJob 快照
   * 直接从内存状态中读取（内存状态在 load() 时已从磁盘恢复）
   */
  getCronJobSnapshots(): Record<string, { hash: string; lastChangedAt: number }> {
    return this.state.cronJobs;
  }

  /**
   * 更新 CronJob 快照并立即持久化到磁盘
   *
   * 更新内存后立即写磁盘，确保 diff 结果不会因进程崩溃而丢失。
   */
  async saveCronJobSnapshots(
    cronJobs: Record<string, { hash: string; lastChangedAt: number }>
  ): Promise<void> {
    this.state = { ...this.state, cronJobs };
    await this.save();
  }

  // --------------------------------
  // Identity 快照直接读写（供 IdentityWatcher 使用）
  // --------------------------------

  /**
   * 获取当前 Identity 快照
   * 直接从内存状态中读取（内存状态在 load() 时已从磁盘恢复）
   */
  getIdentitySnapshots(): Record<string, { hash: string; lastChangedAt: number }> {
    return this.state.identities;
  }

  /**
   * 更新 Identity 快照并立即持久化到磁盘
   *
   * 更新内存后立即写磁盘，确保 diff 结果不会因进程崩溃而丢失。
   */
  async saveIdentitySnapshots(
    identities: Record<string, { hash: string; lastChangedAt: number }>
  ): Promise<void> {
    this.state = { ...this.state, identities };
    await this.save();
  }
}

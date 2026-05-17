/**
 * 数据同步上报插件 - PeriodicScanner
 *
 * 定时全量扫描器：每隔 5 分钟扫描一次本地的 openclaw.json、cron/jobs.json
 * 和 cron/runs/ 目录，计算 hash/偏移后与 sync_state 对比，
 * 将差异部分通过现有 API 接口增量上报到后端。
 *
 * 解决的核心问题：
 * 用户操作后因网络异常导致上报失败，且后续没有新的文件变化触发 Watcher，
 * 此时 sync_state 中的快照/偏移落后于实际文件，PeriodicScanner 能定期发现
 * 这些未上报的差异并重新上报。
 *
 * 与 Watcher 的并发安全性：
 * - Agent/CronJob：全量快照对比，pendingSnapshots 总是基于最新文件计算的完整快照
 * - CronRun：偏移由 SyncStateManager 管理，只有上报成功后才持久化推进
 * - 后端接口均为幂等（upsert + ts 去重），重复上报不会产生副作用
 */

import fs from "node:fs";
import path from "node:path";
import type {
  AgentConfigData,
  AgentDiffResult,
  AgentIdentityData,
  AgentSnapshot,
  AgentWithHash,
  CronJobData,
  CronJobDiffResult,
  CronJobSnapshot,
  CronJobWithHash,
  CronRunEvent,
  CronRunLogEntryData,
  IdentityDiffResult,
  IdentitySnapshot,
  IPeriodicScanner,
  Logger,
} from "./types.js";
import {
  CONFIG_FILENAME,
  CRON_JOBS_RELATIVE_PATH,
  CRON_RUNS_FILE_EXTENSION,
  CRON_RUNS_RELATIVE_DIR,
  DEFAULT_PERIODIC_SCAN_INTERVAL_MS,
} from "./constants.js";
import { computeHash } from "./utils/hash.js";
import { safeParseJson5 } from "./utils/json-parser.js";
import { parseJsonlLines } from "./utils/json-parser.js";
import { parseIdentityMarkdown } from "./watchers/identity-watcher.js";
import type { ChangeReporter } from "./reporter/change-reporter.js";
import type { SyncStateManager } from "./sync-state-manager.js";

/**
 * 默认 Agent ID
 * 与 openclaw 源码 routing/session-key.ts 中的 DEFAULT_AGENT_ID 对齐
 */
const DEFAULT_AGENT_ID = "main";

export interface PeriodicScannerOptions {
  /** 扫描间隔（毫秒），默认 5 分钟 */
  readonly intervalMs?: number;
  /** OpenClaw 状态目录路径 */
  readonly stateDir: string;
  /** 日志记录器 */
  readonly logger: Logger;
  /** ChangeReporter 实例，用于上报差异 */
  readonly reporter: ChangeReporter;
  /** SyncStateManager 实例，用于读取 sync_state 快照和 CronRun 偏移 */
  readonly stateManager: SyncStateManager;
}

/**
 * 定时全量扫描器
 *
 * 流程：
 * 1. 每隔 intervalMs（默认 5 分钟）执行一次全量扫描
 * 2. 读取 openclaw.json → 计算 Agent hash → 与 sync_state 中的快照对比
 * 3. 读取 cron/jobs.json → 计算 CronJob hash → 与 sync_state 中的快照对比
 * 4. 扫描 cron/runs/*.jsonl → 对比已确认偏移与文件大小 → 读取新增内容
 * 5. 有差异则通过 ChangeReporter 上报（上报成功后由 ChangeReporter 回调持久化）
 */
export class PeriodicScanner implements IPeriodicScanner {
  private readonly intervalMs: number;
  private readonly stateDir: string;
  private readonly logger: Logger;
  private readonly reporter: ChangeReporter;
  private readonly stateManager: SyncStateManager;

  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  /** 防止并发扫描（上一轮还没结束时不启动新一轮） */
  private isScanning = false;

  constructor(options: PeriodicScannerOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_PERIODIC_SCAN_INTERVAL_MS;
    this.stateDir = options.stateDir;
    this.logger = options.logger;
    this.reporter = options.reporter;
    this.stateManager = options.stateManager;
  }

  /**
   * 启动定时扫描
   */
  start(): void {
    if (this.isRunning) {
      this.logger.warn("==data-sync-report插件==动作:PeriodicScanner插件正在运行==参数==");
      return;
    }

    this.isRunning = true;

    this.timer = setInterval(() => {
      this.scanNow().catch((error) => {
        this.logger.error(`==data-sync-report插件==动作:PeriodicScanner扫描失败==参数==${JSON.stringify(error)}`);
      });
    }, this.intervalMs);
  }

  /**
   * 停止定时扫描
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.isRunning = false;
  }

  /**
   * 立即执行一次全量扫描
   *
   * 扫描所有数据源，与 sync_state 对比，上报差异部分。
   */
  async scanNow(): Promise<void> {
    if (this.isScanning) {
      this.logger.debug("==data-sync-report插件==动作:PeriodicScanner插件正在扫描==参数==");
      return;
    }

    this.isScanning = true;
    const startTime = Date.now();

    try {
      // 并行扫描 Agent、Identity（CronJob/CronRuns 暂时关闭）
      const [agentResult, identityResult] = await Promise.allSettled([
        this.scanAgents(),
        this.scanIdentities(),
        // this.scanCronJobs(),   // [暂时关闭]
        // this.scanCronRuns(),   // [暂时关闭]
      ]);

      // 记录各项扫描结果
      if (agentResult.status === "rejected") {
        this.logger.error(`==data-sync-report插件==动作:PeriodicScanner的Agent扫描失败==参数==${agentResult.reason}`);
      }
      if (identityResult.status === "rejected") {
        this.logger.error(`==data-sync-report插件==动作:PeriodicScanner的Identity扫描失败==参数==${identityResult.reason}`);
      }
      // [暂时关闭] CronJob/CronRun 扫描结果检查
      // if (cronJobResult.status === "rejected") {
      //   this.logger.error(`==data-sync-report插件==动作:PeriodicScanner的CronJob扫描失败==参数==${cronJobResult.reason}`);
      // }
      // if (cronRunResult.status === "rejected") {
      //   this.logger.error(`==data-sync-report插件==动作:PeriodicScanner的CronRun扫描失败==参数==${cronRunResult.reason}`);
      // }

      // 更新最后扫描时间
      this.stateManager.updateLastFullScanAt(Date.now());
    } catch (error) {
      this.logger.error("==data-sync-report插件==动作:PeriodicScanner扫描异常==参数==", error);
    } finally {
      this.isScanning = false;
    }
  }

  // --------------------------------
  // Agent 扫描
  // --------------------------------

  /**
   * 扫描 Agent 配置，与 sync_state 快照对比，上报差异
   *
   * 逻辑与 AgentWatcher.diffAndEmit 完全一致，只是触发源不同。
   */
  private async scanAgents(): Promise<void> {
    const configPath = path.join(this.stateDir, CONFIG_FILENAME);
    const agents = await this.readAllAgents(configPath);

    if (!agents) {
      // 文件不存在或解析失败
      // 检查 sync_state 中是否有残留的快照 → 说明文件被删了但删除事件没上报成功
      const savedSnapshots = this.stateManager.getAgentSnapshots();
      const deletedIds = Object.keys(savedSnapshots);

      if (deletedIds.length === 0) {
        return;
      }

      this.logger.info(
        `==data-sync-report插件==动作:PeriodicScanner的Agent配置文件缺失==参数==待删除${deletedIds.length}个agents`
      );

      const diff: AgentDiffResult = {
        createdOrUpdatedAgents: [],
        deletedAgentIds: deletedIds,
        deleteIdentityAgentIds: [],
        pendingSnapshots: {},
      };
      this.reporter.reportAgentDiff(diff);
      return;
    }

    const now = Date.now();
    const savedSnapshots = this.stateManager.getAgentSnapshots();

    // 计算当前 agents 的 hash
    const currentMap = new Map<string, { hash: string; data: AgentConfigData }>();
    for (const agent of agents) {
      const id = this.normalizeAgentId(agent.id);
      const hash = computeHash(agent);
      currentMap.set(id, { hash, data: agent });
    }

    const createdOrUpdatedAgents: AgentWithHash[] = [];
    const deletedAgentIds: string[] = [];

    // 检测新增和修改
    for (const [id, { hash, data }] of currentMap) {
      const saved = savedSnapshots[id];
      if (!saved || saved.hash !== hash) {
        createdOrUpdatedAgents.push({ hash, data });
      }
    }

    // 检测删除
    for (const id of Object.keys(savedSnapshots)) {
      if (!currentMap.has(id)) {
        deletedAgentIds.push(id);
      }
    }

    if (createdOrUpdatedAgents.length === 0 && deletedAgentIds.length === 0) {
      this.logger.info("==data-sync-report插件==动作:PeriodicScanner的Agent扫描无差异==");
      return;
    }

    this.logger.info(
      `==data-sync-report插件==动作:PeriodicScanner的Agent扫描完成==参数==upsert=${createdOrUpdatedAgents.length}, delete=${deletedAgentIds.length}`
    );

    const pendingSnapshots: Record<string, AgentSnapshot> = {};
    for (const [id, { hash }] of currentMap) {
      pendingSnapshots[id] = { hash, lastChangedAt: now };
    }

    const diff: AgentDiffResult = {
      createdOrUpdatedAgents,
      deletedAgentIds,
      deleteIdentityAgentIds: [],
      pendingSnapshots,
    };
    this.reporter.reportAgentDiff(diff);
  }

  // --------------------------------
  // Identity 扫描
  // --------------------------------

  /**
   * 扫描所有有效 Agent 的 IDENTITY.md，与 sync_state 中的快照对比，上报差异
   *
   * 逻辑与 IdentityWatcher.diffAndEmit 完全一致，只是触发源不同。
   *
   * 流程：
   * 1. 读取 openclaw.json 获取有效 agent 列表，构建 agentId → workspace 目录名映射
   * 2. 遍历有效 agent，读取对应的 IDENTITY.md 并解析
   * 3. 计算 hash，与 sync_state 中的 identity 快照对比
   * 4. 有差异则通过 reporter.reportIdentityDiff() 上报
   */
  private async scanIdentities(): Promise<void> {
    // 1. 获取有效 agent 列表
    const agentIdToDirName = await this.getValidAgentDirMap();

    // 2. 扫描所有有效 agent 的 IDENTITY.md
    const currentMap = new Map<string, { identity: AgentIdentityData; hash: string }>();
    for (const [agentId, dirName] of agentIdToDirName) {
      const filePath = path.join(this.stateDir, dirName, "IDENTITY.md");
      try {
        const content = await fs.promises.readFile(filePath, "utf-8");
        const identity = parseIdentityMarkdown(content);

        // 过滤掉无有效字段的 identity
        if (!identity.name && !identity.vibe && !identity.avatar) {
          continue;
        }

        const hash = computeHash(identity);
        currentMap.set(agentId, { identity, hash });
      } catch (error) {
        const nodeErr = error as NodeJS.ErrnoException;
        if (nodeErr?.code !== "ENOENT") {
          this.logger.warn(
            `==data-sync-report插件==动作:PeriodicScanner扫描Identity文件失败==参数==agentId="${agentId}", file="${filePath}"`
          );
        }
        // ENOENT：文件不存在，正常跳过
      }
    }

    // 3. 与 sync_state 中的快照对比
    const now = Date.now();
    const savedSnapshots = this.stateManager.getIdentitySnapshots();

    const changedIdentities: IdentityDiffResult["changedIdentities"][number][] = [];

    // 检测新增和修改
    for (const [agentId, { identity, hash }] of currentMap) {
      const saved = savedSnapshots[agentId];
      if (!saved || saved.hash !== hash) {
        changedIdentities.push({ agentId, identity, hash });
      }
    }

    if (changedIdentities.length === 0) {
      this.logger.debug("==data-sync-report插件==动作:PeriodicScanner的Identity扫描无差异==");
      return;
    }

    this.logger.info(
      `==data-sync-report插件==动作:PeriodicScanner的Identity扫描完成==参数==changed=${changedIdentities.length}`
    );

    // 构建最新的完整快照（保留未变化的 agent 快照）
    const pendingSnapshots: Record<string, IdentitySnapshot> = { ...savedSnapshots };
    for (const [agentId, { hash }] of currentMap) {
      pendingSnapshots[agentId] = { hash, lastChangedAt: now };
    }

    const diff: IdentityDiffResult = {
      changedIdentities,
      pendingSnapshots,
    };
    this.reporter.reportIdentityDiff(diff);
  }

  /**
   * 从 openclaw.json 读取有效 agent 列表，构建 agentId → workspace 目录名映射
   *
   * 逻辑与 IdentityWatcher.refreshValidAgents 对齐：
   * - agents.list 存在且非空 → 使用 list 中的条目
   * - agents.list 不存在或为空 → 仅包含隐式的 main agent
   *
   * 目录映射规则：
   * - id 为 "main" → "workspace"
   * - id 为其他值 → "workspace-{id}"
   */
  private async getValidAgentDirMap(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const configPath = path.join(this.stateDir, CONFIG_FILENAME);

    try {
      const content = await fs.promises.readFile(configPath, "utf-8");
      const parseResult = safeParseJson5(content);

      if (!parseResult.ok) {
        this.logger.warn(
          `==data-sync-report插件==动作:PeriodicScanner解析配置文件失败(Identity)==参数==${parseResult.error}`
        );
        // 解析失败：回退到只有 main agent
        result.set(DEFAULT_AGENT_ID, "workspace");
        return result;
      }

      const cfg = parseResult.data as Record<string, unknown>;
      const agentsCfg = cfg?.agents as Record<string, unknown> | undefined;
      const list = agentsCfg?.list;

      if (Array.isArray(list) && list.length > 0) {
        for (const entry of list) {
          if (entry && typeof entry === "object" && (entry as { id?: string }).id) {
            const agentId = (entry as { id: string }).id;
            const dirName = agentId === DEFAULT_AGENT_ID ? "workspace" : `workspace-${agentId}`;
            result.set(agentId, dirName);
          }
        }
      } else {
        result.set(DEFAULT_AGENT_ID, "workspace");
      }
    } catch (error) {
      const nodeErr = error as NodeJS.ErrnoException;
      if (nodeErr?.code === "ENOENT") {
        result.set(DEFAULT_AGENT_ID, "workspace");
      } else {
        this.logger.error("==data-sync-report插件==动作:PeriodicScanner读取配置文件失败(Identity)==参数==", error);
        result.set(DEFAULT_AGENT_ID, "workspace");
      }
    }

    return result;
  }

  // --------------------------------
  // CronJob 扫描
  // --------------------------------

  /**
   * 扫描 CronJob 配置，与 sync_state 快照对比，上报差异
   */
  private async scanCronJobs(): Promise<void> {
    const jobsFilePath = path.join(this.stateDir, CRON_JOBS_RELATIVE_PATH);
    const jobs = await this.readJobsList(jobsFilePath);

    if (!jobs) {
      // 文件不存在或解析失败
      const savedSnapshots = this.stateManager.getCronJobSnapshots();
      const deletedIds = Object.keys(savedSnapshots);

      if (deletedIds.length === 0) {
        return;
      }

      this.logger.info(
        `==data-sync-report插件==动作:PeriodicScanner的Jobs文件缺失==参数==待删除${deletedIds.length}个jobs`
      );

      const diff: CronJobDiffResult = {
        createdOrUpdatedJobs: [],
        deletedJobIds: deletedIds,
        pendingSnapshots: {},
      };
      this.reporter.reportCronJobDiff(diff);
      return;
    }

    const now = Date.now();
    const savedSnapshots = this.stateManager.getCronJobSnapshots();

    // 计算当前 jobs 的 hash
    const currentMap = new Map<string, { hash: string; data: CronJobData }>();
    for (const job of jobs) {
      const hash = computeHash(job);
      currentMap.set(job.id, { hash, data: job });
    }

    const createdOrUpdatedJobs: CronJobWithHash[] = [];
    const deletedJobIds: string[] = [];

    // 检测新增和修改
    for (const [id, { hash, data }] of currentMap) {
      const saved = savedSnapshots[id];
      if (!saved || saved.hash !== hash) {
        createdOrUpdatedJobs.push({ hash, data });
      }
    }

    // 检测删除
    for (const id of Object.keys(savedSnapshots)) {
      if (!currentMap.has(id)) {
        deletedJobIds.push(id);
      }
    }

    if (createdOrUpdatedJobs.length === 0 && deletedJobIds.length === 0) {
      this.logger.debug("==data-sync-report插件==动作:PeriodicScanner的CronJob扫描无差异==");
      return;
    }

    this.logger.info(
      `==data-sync-report插件==动作:PeriodicScanner的CronJob扫描完成==参数==upsert=${createdOrUpdatedJobs.length}, delete=${deletedJobIds.length}`
    );

    const pendingSnapshots: Record<string, CronJobSnapshot> = {};
    for (const [id, { hash }] of currentMap) {
      pendingSnapshots[id] = { hash, lastChangedAt: now };
    }

    const diff: CronJobDiffResult = {
      createdOrUpdatedJobs,
      deletedJobIds,
      pendingSnapshots,
    };
    this.reporter.reportCronJobDiff(diff);
  }

  // --------------------------------
  // CronRun 扫描
  // --------------------------------

  /**
   * 扫描 CronRun 执行记录，对比已确认偏移与实际文件大小，上报新增内容
   *
   * 从 SyncStateManager 读取已确认偏移，与实际文件大小对比。
   */
  private async scanCronRuns(): Promise<void> {
    const runsDir = path.join(this.stateDir, CRON_RUNS_RELATIVE_DIR);

    let entries: string[] = [];
    try {
      entries = await fs.promises.readdir(runsDir);
    } catch (error) {
      const nodeErr = error as NodeJS.ErrnoException;
      if (nodeErr?.code !== "ENOENT") {
        throw error;
      }
    }

    // 从 SyncStateManager 获取已确认偏移
    const confirmedOffsets = this.stateManager.getCronRunOffsets();
    let totalNewEntries = 0;

    for (const entry of entries) {
      if (!entry.endsWith(CRON_RUNS_FILE_EXTENSION)) {
        continue;
      }

      const filePath = path.join(runsDir, entry);
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat || !stat.isFile()) {
        continue;
      }

      const confirmedOffset = confirmedOffsets[filePath];
      const currentOffset = confirmedOffset?.byteOffset ?? 0;

      if (stat.size <= currentOffset) {
        continue; // 无新内容
      }

      // 有未上报的新增内容
      const newEntryCount = await this.readAndReportCronRunEntries(
        filePath,
        currentOffset,
        stat.size
      );
      totalNewEntries += newEntryCount;
    }

    if (totalNewEntries > 0) {
      this.logger.info(
        `==data-sync-report插件==动作:PeriodicScanner的CronRun扫描发现未上报条目==参数==${totalNewEntries}条`
      );
    } else {
      this.logger.debug("==data-sync-report插件==动作:PeriodicScanner的CronRun扫描无新条目==");
    }

    // 反向清理：删除 sync_state 中存在但磁盘上已不存在的偏移记录
    // 补偿 Watcher 未运行期间文件被删除导致 unlink 事件丢失的场景
    const existingFilePaths = new Set(
      entries
        .filter((e) => e.endsWith(CRON_RUNS_FILE_EXTENSION))
        .map((e) => path.join(runsDir, e))
    );
    let staleCount = 0;
    for (const offsetPath of Object.keys(confirmedOffsets)) {
      if (!existingFilePaths.has(offsetPath)) {
        await this.stateManager.deleteCronRunOffset(offsetPath);
        staleCount++;
        this.logger.info(
          `==data-sync-report插件==动作:PeriodicScanner清理残留偏移记录==参数==文件="${path.basename(offsetPath)}"`
        );
      }
    }
    if (staleCount > 0) {
      this.logger.info(
        `==data-sync-report插件==动作:PeriodicScanner的CronRun清理完成==参数==清理${staleCount}条残留偏移记录`
      );
    }
  }

  /**
   * 读取 CronRun 文件的新增内容并通过 Reporter 上报
   *
   * @returns 本次读取到的条目数
   */
  private async readAndReportCronRunEntries(
    filePath: string,
    fromOffset: number,
    toOffset: number
  ): Promise<number> {
    try {
      const fd = await fs.promises.open(filePath, "r");
      try {
        const buffer = Buffer.alloc(toOffset - fromOffset);
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, fromOffset);

        const content = buffer.subarray(0, bytesRead).toString("utf-8");

        // 只处理到最后一个完整的换行符
        const lastNewline = content.lastIndexOf("\n");
        if (lastNewline === -1) {
          return 0; // 不完整的行，跳过
        }

        const processableContent = content.substring(0, lastNewline + 1);
        const consumedBytes = Buffer.byteLength(processableContent, "utf-8");
        const entries = parseJsonlLines(processableContent) as CronRunLogEntryData[];

        if (entries.length === 0) {
          return 0;
        }

        const jobId = path.basename(filePath, CRON_RUNS_FILE_EXTENSION);
        const newOffset = fromOffset + consumedBytes;
        const now = Date.now();

        // 构造 CronRunEvent 数组，通过 reporter.reportBatch 上报
        const events: CronRunEvent[] = entries.map((data) => ({
          type: "cron-run" as const,
          action: "finished" as const,
          jobId,
          data,
          timestamp: now,
          offset: newOffset,
          filePath,
        }));

        await this.reporter.reportBatch(events);

        this.logger.info(
          `==data-sync-report插件==动作:PeriodicScanner的CronRun扫描读取条目==参数==job="${jobId}", 条数=${entries.length}`
        );

        return entries.length;
      } finally {
        await fd.close();
      }
    } catch (error) {
      this.logger.error(
        `==data-sync-report插件==动作:PeriodicScanner读取CronRun文件失败==参数==文件="${path.basename(filePath)}"`,
        error
      );
      return 0;
    }
  }

  // --------------------------------
  // Agent 文件读取（复用 AgentWatcher 的逻辑）
  // --------------------------------

  /**
   * 从 openclaw.json 读取完整的 agent 列表
   *
   * 逻辑与 AgentWatcher.readAllAgents 完全一致。
   */
  private async readAllAgents(configPath: string): Promise<AgentConfigData[] | null> {
    try {
      const content = await fs.promises.readFile(configPath, "utf-8");
      const result = safeParseJson5(content);

      if (!result.ok) {
        this.logger.warn(`==data-sync-report插件==动作:PeriodicScanner解析配置文件失败==参数==${result.error}`);
        return null;
      }

      const cfg = result.data as Record<string, unknown>;
      const agentsCfg = cfg?.agents as Record<string, unknown> | undefined;
      const defaults = agentsCfg?.defaults as Record<string, unknown> | undefined;
      const list = agentsCfg?.list;

      const defaultsData = defaults ?? {};

      if (Array.isArray(list)) {
        const validEntries = list.filter(
          (entry): entry is AgentConfigData =>
            Boolean(entry && typeof entry === "object" && (entry as AgentConfigData).id)
        );

        if (validEntries.length > 0) {
          return validEntries.map((entry) => ({
            ...entry,
            _defaults: defaultsData,
          }));
        }
      }

      // 合成隐式 main agent
      return [{ id: DEFAULT_AGENT_ID, _defaults: defaultsData } as AgentConfigData];
    } catch (error) {
      const nodeErr = error as NodeJS.ErrnoException;
      if (nodeErr?.code === "ENOENT") {
        return null;
      }
      this.logger.error("==data-sync-report插件==动作:PeriodicScanner读取配置文件失败==参数==", error);
      return null;
    }
  }

  // --------------------------------
  // CronJob 文件读取（复用 CronJobsWatcher 的逻辑）
  // --------------------------------

  /**
   * 从 cron/jobs.json 读取 jobs 数组
   *
   * 逻辑与 CronJobsWatcher.readJobsList 完全一致。
   */
  private async readJobsList(jobsFilePath: string): Promise<CronJobData[] | null> {
    try {
      const content = await fs.promises.readFile(jobsFilePath, "utf-8");
      const result = safeParseJson5(content);

      if (!result.ok) {
        this.logger.warn(`==data-sync-report插件==动作:PeriodicScanner解析Jobs文件失败==参数==${result.error}`);
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
      this.logger.error("==data-sync-report插件==动作:PeriodicScanner读取Jobs文件失败==参数==", error);
      return null;
    }
  }

  // --------------------------------
  // 工具方法
  // --------------------------------

  /**
   * 标准化 agentId（与 AgentWatcher 一致）
   */
  private normalizeAgentId(id: string): string {
    return (id ?? "").trim().toLowerCase();
  }
}

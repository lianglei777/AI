/**
 * 数据同步上报插件 - ReconciliationService（对账服务）
 *
 * 在服务激活时执行一次数据对账，确保后端数据与本地数据一致。
 *
 * 对账流程：
 * 1. 调用命令字 4181 查询服务端已存储的 Agent/CronJob 数据摘要（id + hash + identity_hash）
 * 2. 读取本地文件，计算当前 Agent/Identity/CronJob 的 hash
 * 3. 三向比对：
 *    - 本地有、后端无 → 上报新增（upsert）
 *    - 本地有、后端有但 hash 不同 → 上报更新（upsert）
 *    - 本地无、后端有 → 通知后端删除（delete，仅 Agent/CronJob 支持，Identity 仅观测）
 *    - 本地有、后端有且 hash 相同 → 无需操作
 * 4. 通过现有的 ChangeReporter 接口上报差异（Agent 走 4174，Identity 复用 4174 identity 子接口）
 *
 * 与 Watcher/PeriodicScanner 的并发安全性：
 * - 所有后端接口均为幂等（upsert + 去重），重复上报不会产生副作用
 * - delete 也是幂等的（删除不存在的数据不报错）
 * - 对账在 Watcher 启动后执行，Watcher 的初始 diff 会先处理明显变化，
 *   对账再补充处理 Watcher 无法覆盖的场景（如后端多余的数据需要删除）
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
  IdentityDiffResult,
  IdentitySnapshot,
  IReconciliationService,
  Logger,
  SyncState,
} from "./types.js";
import type { TelemetryReporter } from "../../../core/reporter-types.js";
import {
  CONFIG_FILENAME,
  CRON_JOBS_RELATIVE_PATH,
} from "./constants.js";
import { computeHash } from "./utils/hash.js";
import { safeParseJson5 } from "./utils/json-parser.js";
import type { ReconciliationQueryData } from "./reporter/reconciliation-api.js";
import { queryServerSyncStatus } from "./reporter/reconciliation-api.js";
import type { ChangeReporter } from "./reporter/change-reporter.js";
import type { SyncStateManager } from "./sync-state-manager.js";
import { getUserIdentity } from "./user-identity-store.js";
import { parseIdentityMarkdown } from "./watchers/identity-watcher.js";

// --------------------------------
// 对账 diff 详情类型（用于伽利略上报）
// --------------------------------

/** Agent 对账 diff 详情 */
interface AgentReconciliationDetail {
  /** 是否有差异 */
  readonly hasDiff: boolean;
  /** 新增或更新的 agentId 列表 */
  readonly upsertIds: string[];
  /** 删除的 agentId 列表 */
  readonly deleteIds: string[];
}

/** CronJob 对账 diff 详情 */
interface CronJobReconciliationDetail {
  /** 是否有差异 */
  readonly hasDiff: boolean;
  /** 新增或更新的 jobId 列表 */
  readonly upsertIds: string[];
  /** 删除的 jobId 列表 */
  readonly deleteIds: string[];
}

/** Identity 对账 diff 详情 */
interface IdentityReconciliationDetail {
  /** 是否有差异 */
  readonly hasDiff: boolean;
  /** 本次需要上报（新增或更新）的 agentId 列表 */
  readonly upsertIds: string[];
  /**
   * 后端存在 identity_hash 但本地无 IDENTITY.md 的 agentId 列表
   *
   * 对账时会通过 Agent upsert 通道的 delete_identity_agent_ids 字段
   * 通知后端清理这些 agent 的 identity（保留 agent 本身）。
   */
  readonly serverOnlyIds: string[];
}

/** CronRun 对账 diff 详情（当前仅做本地/后端 jobId 维度存在性比对） */
interface CronRunReconciliationDetail {
  /** 是否有差异 */
  readonly hasDiff: boolean;
  /** 本地有 offset 但后端无记录的 jobId 列表 */
  readonly localOnlyJobIds: string[];
  /** 后端有记录但本地无 offset 的 jobId 列表 */
  readonly serverOnlyJobIds: string[];
}

/**
 * 默认 Agent ID
 * 与 openclaw 源码 routing/session-key.ts 中的 DEFAULT_AGENT_ID 对齐
 */
const DEFAULT_AGENT_ID = "main";

export interface ReconciliationServiceOptions {
  /** OpenClaw 状态目录路径 */
  readonly stateDir: string;
  /** 日志记录器 */
  readonly logger: Logger;
  /** 原始 fetch 函数（绕过 FetchChain） */
  readonly fetchFn?: typeof globalThis.fetch;
  /** 伽利略遥测上报器（通过 ctx.reporter 获取） */
  readonly telemetryReporter?: TelemetryReporter;
  /** ChangeReporter 实例，用于上报差异 */
  readonly reporter: ChangeReporter;
  /** SyncStateManager 实例，用于更新对账时间戳 */
  readonly stateManager: SyncStateManager;
}

/**
 * 数据对账服务
 *
 * 在服务激活时执行一次对账，确保后端数据与本地一致。
 */
export class ReconciliationService implements IReconciliationService {
  private readonly stateDir: string;
  private readonly logger: Logger;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly telemetryReporter?: TelemetryReporter;
  private readonly reporter: ChangeReporter;
  private readonly stateManager: SyncStateManager;

  private isRunning = false;

  /** 每日定时对账的 setTimeout 定时器 */
  private dailyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ReconciliationServiceOptions) {
    this.stateDir = options.stateDir;
    this.logger = options.logger;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.telemetryReporter = options.telemetryReporter;
    this.reporter = options.reporter;
    this.stateManager = options.stateManager;
  }

  /**
   * 启动对账服务（立即执行一次对账）
   */
  start(): void {
    if (this.isRunning) {
      this.logger.warn("==data-sync-report插件==动作:Reconciliation已在运行==");
      return;
    }
    this.isRunning = true;
    // 异步执行对账，不阻塞 start 返回
    this.reconcileNow().catch((error) => {
      this.logger.error("==data-sync-report插件==动作:Reconciliation对账执行失败==参数==", error);
    });

    // 调度每日凌晨 3 点定时对账
    this.scheduleDailyReconciliation();
  }

  /**
   * 停止对账服务
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    // 清理每日定时对账定时器
    if (this.dailyTimer) {
      clearTimeout(this.dailyTimer);
      this.dailyTimer = null;
    }

    this.isRunning = false;
  }

  /**
   * 立即执行一次数据对账
   *
   * 流程：
   * 1. 查询服务端数据同步状态（scope: meta，仅 Agent + CronJob；含 identity_hash）
   * 2. 读取本地 Agent / Identity / CronJob 数据，计算 hash
   * 3. 比对差异并通过 Reporter 上报
   * 4. 更新对账时间戳
   * 5. 通过伽利略上报对账结果（本地 syncState、后端数据、diff 结果）
   */
  async reconcileNow(): Promise<void> {
    const startTime = Date.now();

    try {
      // 0. 在对账前快照当前本地 syncState（用于伽利略上报）
      const localSyncState = this.stateManager.getState();

      // 1. 查询服务端同步状态
      const serverData = await queryServerSyncStatus(
        "all",
        this.logger,
        this.fetchFn,
        this.telemetryReporter
      );

      if (!serverData) {
        this.logger.warn("==data-sync-report插件==动作:Reconciliation查询服务端状态失败,跳过本次对账==");
        // 查询失败也上报伽利略，记录失败状态
        this.reportReconciliationTelemetry({
          success: false,
          error: "query_server_sync_status_failed",
          durationMs: Date.now() - startTime,
          localSyncState,
          serverData: null,
          agentDetail: null,
          identityDetail: null,
          cronJobDetail: null,
        });
        return;
      }

      // 2. 并行读取本地数据（CronJob 暂时关闭）
      const [localAgents, localIdentities] = await Promise.all([
        this.readLocalAgents(),
        this.readLocalIdentities(),
        // this.readLocalCronJobs(),  // [暂时关闭]
      ]);

      // 3. 分别对账 Agent / Identity（CronJob 暂时关闭）
      const [agentDetail, identityDetail] = await Promise.all([
        this.reconcileAgents(serverData, localAgents),
        this.reconcileIdentities(serverData, localIdentities),
        // this.reconcileCronJobs(serverData, localCronJobs),  // [暂时关闭]
      ]);
      const cronJobDetail: CronJobReconciliationDetail = { hasDiff: false, upsertIds: [], deleteIds: [] };

      // 4. 更新对账时间戳
      this.stateManager.updateLastReconciliationAt(Date.now());

      const durationMs = Date.now() - startTime;

      // 5. 通过伽利略上报对账结果
      this.reportReconciliationTelemetry({
        success: true,
        durationMs,
        localSyncState,
        serverData,
        agentDetail,
        identityDetail,
        cronJobDetail,
      });
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this.logger.error("==data-sync-report插件==动作:Reconciliation对账异常==参数==", error);

      // 异常也上报伽利略
      this.reportReconciliationTelemetry({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs,
        localSyncState: null,
        serverData: null,
        agentDetail: null,
        identityDetail: null,
        cronJobDetail: null,
      });
    }
  }

  // --------------------------------
  // Agent 对账
  // --------------------------------

  /**
   * Agent 对账：比对本地与服务端的 Agent 数据
   *
   * @returns 对账 diff 详情（用于伽利略上报）
   */
  private async reconcileAgents(
    serverData: ReconciliationQueryData,
    localAgents: AgentConfigData[] | null
  ): Promise<AgentReconciliationDetail> {
    const serverAgents = serverData.agents ?? [];

    // 构建服务端 Agent Map<id, hash>
    const serverMap = new Map<string, string>();
    for (const sa of serverAgents) {
      serverMap.set(sa.id, sa.hash);
    }

    // 构建本地 Agent Map<id, { hash, data }>
    const localMap = new Map<string, { hash: string; data: AgentConfigData }>();
    if (localAgents) {
      for (const agent of localAgents) {
        const id = this.normalizeAgentId(agent.id);
        const hash = computeHash(agent);
        localMap.set(id, { hash, data: agent });
      }
    }

    const createdOrUpdatedAgents: AgentWithHash[] = [];
    const deletedAgentIds: string[] = [];

    // 本地有、后端无 → 需要上报（新增）
    // 本地有、后端有但 hash 不同 → 需要上报（更新）
    for (const [id, { hash, data }] of localMap) {
      const serverHash = serverMap.get(id);
      if (serverHash === undefined) {
        this.logger.info(`==data-sync-report插件==动作:Reconciliation发现Agent本地有后端无==参数==agentId="${id}"`);
        createdOrUpdatedAgents.push({ hash, data });
      } else if (serverHash !== hash) {
        this.logger.info(`==data-sync-report插件==动作:Reconciliation发现Agent hash不一致==参数==agentId="${id}", local="${hash}", server="${serverHash}"`);
        createdOrUpdatedAgents.push({ hash, data });
      }
    }

    // 本地无、后端有 → 通知后端删除
    for (const [id] of serverMap) {
      if (!localMap.has(id)) {
        this.logger.info(`==data-sync-report插件==动作:Reconciliation发现Agent后端有本地无==参数==agentId="${id}"`);
        deletedAgentIds.push(id);
      }
    }

    if (createdOrUpdatedAgents.length === 0 && deletedAgentIds.length === 0) {
      return { hasDiff: false, upsertIds: [], deleteIds: [] };
    }

    this.logger.info(
      `==data-sync-report插件==动作:Reconciliation的Agent对账发现差异==参数==upsert=${createdOrUpdatedAgents.length}, delete=${deletedAgentIds.length}`
    );

    // 构建 pendingSnapshots（基于本地当前数据的完整快照）
    const now = Date.now();
    const pendingSnapshots: Record<string, AgentSnapshot> = {};
    for (const [id, { hash }] of localMap) {
      pendingSnapshots[id] = { hash, lastChangedAt: now };
    }

    const diff: AgentDiffResult = {
      createdOrUpdatedAgents,
      deletedAgentIds,
      deleteIdentityAgentIds: [],
      pendingSnapshots,
    };

    this.reporter.reportAgentDiff(diff);
    return {
      hasDiff: true,
      upsertIds: createdOrUpdatedAgents.map((a) => a.data.id),
      deleteIds: deletedAgentIds,
    };
  }

  // --------------------------------
  // Identity 对账
  // --------------------------------

  /**
   * Identity 对账：比对本地 IDENTITY.md 与服务端 identity_hash
   *
   * 差异处理：
   * - 本地有、后端 identity_hash 为空 → 通过 reporter.reportIdentityDiff 上报（首次上报）
   * - 本地有、后端 identity_hash 非空但不等 → 通过 reporter.reportIdentityDiff 上报（更新）
   * - 本地无、后端 identity_hash 非空 → 通过 reporter.reportAgentDiff 构造一个纯 identity
   *   清理 diff，让后端清理 identity 但保留 agent（走 delete_identity_agent_ids 字段）
   * - 本地有、后端 identity_hash 相同 → 无需操作
   *
   * @returns 对账 diff 详情（用于伽利略上报）
   */
  private async reconcileIdentities(
    serverData: ReconciliationQueryData,
    localIdentities: Map<string, { identity: AgentIdentityData; hash: string }>
  ): Promise<IdentityReconciliationDetail> {
    const serverAgents = serverData.agents ?? [];

    // 构建服务端 Identity Map<agentId, identity_hash>（identity_hash 为 "" 视为未记录）
    const serverIdentityMap = new Map<string, string>();
    for (const sa of serverAgents) {
      const id = this.normalizeAgentId(sa.id);
      serverIdentityMap.set(id, sa.identity_hash ?? "");
    }

    const changedIdentities: IdentityDiffResult["changedIdentities"][number][] = [];
    const serverOnlyIds: string[] = [];

    // 本地有 → 对比 hash
    for (const [agentId, { identity, hash }] of localIdentities) {
      const serverHash = serverIdentityMap.get(agentId) ?? "";
      if (serverHash === "") {
        this.logger.info(
          `==data-sync-report插件==动作:Reconciliation发现Identity本地有后端无==参数==agentId="${agentId}"`
        );
        changedIdentities.push({ agentId, identity, hash });
      } else if (serverHash !== hash) {
        this.logger.info(
          `==data-sync-report插件==动作:Reconciliation发现Identity hash不一致==参数==agentId="${agentId}", local="${hash}", server="${serverHash}"`
        );
        changedIdentities.push({ agentId, identity, hash });
      }
    }

    // 本地无、后端 identity_hash 非空 → 需要让后端清理 identity（保留 agent）
    for (const [agentId, serverHash] of serverIdentityMap) {
      if (serverHash === "") continue;
      if (!localIdentities.has(agentId)) {
        this.logger.info(
          `==data-sync-report插件==动作:Reconciliation发现Identity后端有本地无==参数==agentId="${agentId}"`
        );
        serverOnlyIds.push(agentId);
      }
    }

    if (changedIdentities.length === 0 && serverOnlyIds.length === 0) {
      return { hasDiff: false, upsertIds: [], serverOnlyIds: [] };
    }

    this.logger.info(
      `==data-sync-report插件==动作:Reconciliation的Identity对账发现差异==参数==upsert=${changedIdentities.length}, deleteIdentity=${serverOnlyIds.length}`
    );

    // 分支 1：需要清理 identity（本地无、后端有）→ 通过 Agent upsert 通道传递
    // delete_identity_agent_ids，不影响 agent 本身的快照。
    if (serverOnlyIds.length > 0) {
      this.logger.info(
        `==data-sync-report插件==动作:Reconciliation触发Identity清理==参数==count=${serverOnlyIds.length}, agentIds=[${serverOnlyIds.join(", ")}]`
      );
      const deleteIdentityDiff: AgentDiffResult = {
        createdOrUpdatedAgents: [],
        deletedAgentIds: [],
        deleteIdentityAgentIds: serverOnlyIds,
        // 空对象：ChangeReporter 会识别本次不影响 agent 快照，跳过覆盖
        pendingSnapshots: {},
      };
      this.reporter.reportAgentDiff(deleteIdentityDiff);
    }

    // 分支 2：有本地 identity 需要补/改 → 走 identity 上报通道
    if (changedIdentities.length > 0) {
      this.logger.info(
        `==data-sync-report插件==动作:Reconciliation触发Identity上报==参数==count=${changedIdentities.length}, agentIds=[${changedIdentities.map((i) => i.agentId).join(", ")}]`
      );
      // 构建 pendingSnapshots（基于本地当前数据的完整快照，保留所有本地 identity）
      // 注意：ChangeReporter.scheduleIdentityDiffSync 在全部 upsert 成功后会用
      // 这份快照覆盖 sync_state 中的 identities 记录。
      const now = Date.now();
      const pendingSnapshots: Record<string, IdentitySnapshot> = {};
      for (const [agentId, { hash }] of localIdentities) {
        pendingSnapshots[agentId] = { hash, lastChangedAt: now };
      }

      const diff: IdentityDiffResult = {
        changedIdentities,
        pendingSnapshots,
      };

      this.reporter.reportIdentityDiff(diff);
    }

    return {
      hasDiff: true,
      upsertIds: changedIdentities.map((item) => item.agentId),
      serverOnlyIds,
    };
  }

  // --------------------------------
  //   // CronJob 对账
  // --------------------------------

  /**
   * CronJob 对账：比对本地与服务端的 CronJob 数据
   *
   * @returns 对账 diff 详情（用于伽利略上报）
   */
  private async reconcileCronJobs(
    serverData: ReconciliationQueryData,
    localCronJobs: CronJobData[] | null
  ): Promise<CronJobReconciliationDetail> {
    const serverCronJobs = serverData.cron_jobs ?? [];

    // 构建服务端 CronJob Map<id, hash>
    const serverMap = new Map<string, string>();
    for (const sj of serverCronJobs) {
      serverMap.set(sj.id, sj.hash);
    }

    // 构建本地 CronJob Map<id, { hash, data }>
    const localMap = new Map<string, { hash: string; data: CronJobData }>();
    if (localCronJobs) {
      for (const job of localCronJobs) {
        const hash = computeHash(job);
        localMap.set(job.id, { hash, data: job });
      }
    }

    const createdOrUpdatedJobs: CronJobWithHash[] = [];
    const deletedJobIds: string[] = [];

    // 本地有、后端无 → 需要上报（新增）
    // 本地有、后端有但 hash 不同 → 需要上报（更新）
    for (const [id, { hash, data }] of localMap) {
      const serverHash = serverMap.get(id);
      if (serverHash === undefined) {
        this.logger.info(`==data-sync-report插件==动作:Reconciliation发现CronJob本地有后端无==参数==jobId="${id}"`);
        createdOrUpdatedJobs.push({ hash, data });
      } else if (serverHash !== hash) {
        this.logger.info(`==data-sync-report插件==动作:Reconciliation发现CronJob hash不一致==参数==jobId="${id}", local="${hash}", server="${serverHash}"`);
        createdOrUpdatedJobs.push({ hash, data });
      }
    }

    // 本地无、后端有 → 通知后端删除
    for (const [id] of serverMap) {
      if (!localMap.has(id)) {
        this.logger.info(`==data-sync-report插件==动作:Reconciliation发现CronJob后端有本地无==参数==jobId="${id}"`);
        deletedJobIds.push(id);
      }
    }

    if (createdOrUpdatedJobs.length === 0 && deletedJobIds.length === 0) {
      this.logger.info("==data-sync-report插件==动作:Reconciliation的CronJob对账无差异==");
      return { hasDiff: false, upsertIds: [], deleteIds: [] };
    }

    this.logger.info(
      `==data-sync-report插件==动作:Reconciliation的CronJob对账发现差异==参数==upsert=${createdOrUpdatedJobs.length}, delete=${deletedJobIds.length}`
    );

    // 构建 pendingSnapshots（基于本地当前数据的完整快照）
    const now = Date.now();
    const pendingSnapshots: Record<string, CronJobSnapshot> = {};
    for (const [id, { hash }] of localMap) {
      pendingSnapshots[id] = { hash, lastChangedAt: now };
    }

    const diff: CronJobDiffResult = {
      createdOrUpdatedJobs,
      deletedJobIds,
      pendingSnapshots,
    };

    this.reporter.reportCronJobDiff(diff);
    return {
      hasDiff: true,
      upsertIds: createdOrUpdatedJobs.map((j) => j.data.id),
      deleteIds: deletedJobIds,
    };
  }

  // --------------------------------
  // 本地文件读取（复用 AgentWatcher / CronJobsWatcher 的逻辑）
  // --------------------------------

  /**
   * 从 openclaw.json 读取完整的 Agent 列表
   *
   * 逻辑与 AgentWatcher.readAllAgents 一致：
   * - agents.list 存在 → 使用 list 中的条目，附加 defaults
   * - agents.list 不存在 → 合成隐式 main agent
   */
  private async readLocalAgents(): Promise<AgentConfigData[] | null> {
    const configPath = path.join(this.stateDir, CONFIG_FILENAME);
    try {
      const content = await fs.promises.readFile(configPath, "utf-8");
      const result = safeParseJson5(content);

      if (!result.ok) {
        this.logger.warn(
          `==data-sync-report插件==动作:Reconciliation解析配置文件失败==参数==${result.error}`
        );
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
      this.logger.error("==data-sync-report插件==动作:Reconciliation读取配置文件失败==参数==", error);
      return null;
    }
  }

  /**
   * 读取所有有效 Agent 的 IDENTITY.md，解析并计算 hash
   *
   * 逻辑与 PeriodicScanner.scanIdentities / IdentityWatcher.scanAllIdentities 对齐：
   * - 有效 agent 列表来自 openclaw.json（通过 readLocalAgents 复用同一份解析）
   * - 目录映射规则：id="main" → "workspace"；其他 → "workspace-{id}"
   * - 跳过无有效字段的 identity（name / vibe / avatar 均为空）
   * - 跳过 IDENTITY.md 不存在的 agent（ENOENT 正常）
   *
   * @returns Map<agentId（已 normalize）, { identity, hash }>
   */
  private async readLocalIdentities(): Promise<
    Map<string, { identity: AgentIdentityData; hash: string }>
  > {
    const result = new Map<string, { identity: AgentIdentityData; hash: string }>();

    const agents = await this.readLocalAgents();
    if (!agents || agents.length === 0) {
      return result;
    }

    for (const agent of agents) {
      const agentId = this.normalizeAgentId(agent.id);
      if (!agentId) continue;

      const dirName = agentId === DEFAULT_AGENT_ID ? "workspace" : `workspace-${agentId}`;
      const filePath = path.join(this.stateDir, dirName, "IDENTITY.md");

      try {
        const content = await fs.promises.readFile(filePath, "utf-8");
        const identity = parseIdentityMarkdown(content);

        // 过滤无有效字段的 identity（与 IdentityWatcher.hasValidIdentityFields 一致）
        if (!identity.name && !identity.vibe && !identity.avatar) {
          continue;
        }

        const hash = computeHash(identity);
        result.set(agentId, { identity, hash });
      } catch (error) {
        const nodeErr = error as NodeJS.ErrnoException;
        if (nodeErr?.code !== "ENOENT") {
          this.logger.warn(
            `==data-sync-report插件==动作:Reconciliation读取Identity文件失败==参数==agentId="${agentId}", file="${filePath}"`
          );
        }
        // ENOENT：agent 尚未创建 IDENTITY.md，正常跳过
      }
    }

    return result;
  }

  /**
   * 从 cron/jobs.json 读取 jobs 数组
   *
   * 逻辑与 CronJobsWatcher.readJobsList 一致。
   */
  private async readLocalCronJobs(): Promise<CronJobData[] | null> {
    const jobsFilePath = path.join(this.stateDir, CRON_JOBS_RELATIVE_PATH);
    try {
      const content = await fs.promises.readFile(jobsFilePath, "utf-8");
      const result = safeParseJson5(content);

      if (!result.ok) {
        this.logger.warn(
          `==data-sync-report插件==动作:Reconciliation解析Jobs文件失败==参数==${result.error}`
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
      this.logger.error("==data-sync-report插件==动作:Reconciliation读取Jobs文件失败==参数==", error);
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

  /**
   * 构建 CronRun 对账 diff 详情
   *
   * 当前 Reconciliation 不直接对 CronRun 做补偿上报，这里仅基于：
   * - 本地 sync_state 中的 cronRunOffsets
   * - 后端 4181 返回的 cron_runs
   * 做 jobId 维度的存在性差异统计，供伽利略观测使用。
   */
  private buildCronRunReconciliationDetail(
    localSyncState: Readonly<SyncState> | null,
    serverData: ReconciliationQueryData | null
  ): CronRunReconciliationDetail | null {
    if (!localSyncState || !serverData) {
      return null;
    }

    const localJobIds = new Set(
      Object.keys(localSyncState.cronRunOffsets).map((filePath) =>
        path.basename(filePath, ".jsonl")
      )
    );
    const serverJobIds = new Set(Object.keys(serverData.cron_runs ?? {}));

    const localOnlyJobIds = Array.from(localJobIds).filter(
      (jobId) => !serverJobIds.has(jobId)
    );
    const serverOnlyJobIds = Array.from(serverJobIds).filter(
      (jobId) => !localJobIds.has(jobId)
    );

    return {
      hasDiff: localOnlyJobIds.length > 0 || serverOnlyJobIds.length > 0,
      localOnlyJobIds,
      serverOnlyJobIds,
    };
  }

  // --------------------------------
  // 伽利略遥测上报
  // --------------------------------

  /**
   * 上报对账结果到伽利略
   *
   * 上报数据包含三部分：
   * 1. local_sync_state: 对账前本地 syncState 中存储的快照数据
   * 2. server_data: 后端状态接口返回的数据
   * 3. diff_result: 对比后的变更结果
   */
  private reportReconciliationTelemetry(params: {
    success: boolean;
    error?: string;
    durationMs: number;
    localSyncState: Readonly<SyncState> | null;
    serverData: ReconciliationQueryData | null;
    agentDetail: AgentReconciliationDetail | null;
    identityDetail: IdentityReconciliationDetail | null;
    cronJobDetail: CronJobReconciliationDetail | null;
  }): void {
    if (!this.telemetryReporter) {
      return;
    }

    const cronRunDetail = this.buildCronRunReconciliationDetail(
      params.localSyncState,
      params.serverData
    );

    const { userId, guid } = getUserIdentity();

    const telemetryData: Record<string, unknown> = {
      // 基础信息
      success: params.success,
      error: params.error ?? undefined,
      duration_ms: params.durationMs,
      guid: guid || undefined,
      user_id: userId || undefined,

      // 1. 本地 syncState 快照数据
      local_sync_state: params.localSyncState
        ? {
            agent_count: Object.keys(params.localSyncState.agents).length,
            agent_ids: Object.keys(params.localSyncState.agents),
            agent_snapshots: params.localSyncState.agents,
            identity_count: Object.keys(params.localSyncState.identities).length,
            identity_ids: Object.keys(params.localSyncState.identities),
            identity_snapshots: params.localSyncState.identities,
            cron_job_count: Object.keys(params.localSyncState.cronJobs).length,
            cron_job_ids: Object.keys(params.localSyncState.cronJobs),
            cron_job_snapshots: params.localSyncState.cronJobs,
            cron_run_offset_count: Object.keys(params.localSyncState.cronRunOffsets).length,
            cron_run_offsets: params.localSyncState.cronRunOffsets,
            last_reconciliation_at: params.localSyncState.lastReconciliationAt,
            last_full_scan_at: params.localSyncState.lastFullScanAt,
            last_updated_at: params.localSyncState.lastUpdatedAt,
          }
        : null,

      // 2. 后端状态接口返回的数据
      server_data: params.serverData
        ? {
            agent_count: params.serverData.agents?.length ?? 0,
            agents: params.serverData.agents,
            cron_job_count: params.serverData.cron_jobs?.length ?? 0,
            cron_jobs: params.serverData.cron_jobs,
            cron_run_count: Object.keys(params.serverData.cron_runs ?? {}).length,
            cron_runs: params.serverData.cron_runs,
          }
        : null,

      // 3. 对比后的变更结果
      diff_result: {
        agent: params.agentDetail
          ? {
              has_diff: params.agentDetail.hasDiff,
              upsert_count: params.agentDetail.upsertIds.length,
              upsert_ids: params.agentDetail.upsertIds,
              delete_count: params.agentDetail.deleteIds.length,
              delete_ids: params.agentDetail.deleteIds,
            }
          : null,
        identity: params.identityDetail
          ? {
              has_diff: params.identityDetail.hasDiff,
              upsert_count: params.identityDetail.upsertIds.length,
              upsert_ids: params.identityDetail.upsertIds,
              server_only_count: params.identityDetail.serverOnlyIds.length,
              server_only_ids: params.identityDetail.serverOnlyIds,
            }
          : null,
        cron_job: params.cronJobDetail
          ? {
              has_diff: params.cronJobDetail.hasDiff,
              upsert_count: params.cronJobDetail.upsertIds.length,
              upsert_ids: params.cronJobDetail.upsertIds,
              delete_count: params.cronJobDetail.deleteIds.length,
              delete_ids: params.cronJobDetail.deleteIds,
            }
          : null,
        cron_run: cronRunDetail
          ? {
              has_diff: cronRunDetail.hasDiff,
              local_only_count: cronRunDetail.localOnlyJobIds.length,
              local_only_job_ids: cronRunDetail.localOnlyJobIds,
              server_only_count: cronRunDetail.serverOnlyJobIds.length,
              server_only_job_ids: cronRunDetail.serverOnlyJobIds,
            }
          : null,
      },
    };

    try {
      this.telemetryReporter.report(
        "data_sync_reconciliation_result",
        telemetryData
      );
    } catch (error) {
      this.logger.error(
        "==data-sync-report插件==动作:Reconciliation伽利略上报失败==参数==",
        error
      );
    }
  }

  // --------------------------------
  // 每日定时对账调度
  // --------------------------------

  /** 每日定时对账的目标小时（24 小时制，3 = 凌晨 3 点） */
  private static readonly DAILY_RECONCILIATION_HOUR = 3;

  /**
   * 调度每日凌晨 3 点的定时对账
   *
   * 使用 setTimeout 递归调度（而非固定 setInterval 24h），
   * 确保每次都精确计算距下一个凌晨 3 点的延迟，
   * 不受启动时间、夏令时切换等因素影响。
   *
   * 休眠补偿：系统休眠会暂停 setTimeout 计时，唤醒后剩余倒计时
   * 可能不准确（如休眠 2h 则触发时间会顺延 2h）。
   * 因此在定时器触发时校验当前小时，若未到目标时间则重新调度。
   */
  private scheduleDailyReconciliation(): void {
    if (this.dailyTimer) {
      clearTimeout(this.dailyTimer);
      this.dailyTimer = null;
    }

    const delayMs = ReconciliationService.getMsUntilNextTargetHour(
      ReconciliationService.DAILY_RECONCILIATION_HOUR
    );
    this.dailyTimer = setTimeout(() => {
      this.dailyTimer = null;

      if (!this.isRunning) {
        return;
      }

      // 休眠补偿：校验当前时间是否确实到了目标小时附近（允许 1 分钟误差）
      // 系统休眠会暂停 setTimeout 计时，唤醒后可能提前触发
      const now = new Date();
      const targetHour = ReconciliationService.DAILY_RECONCILIATION_HOUR;
      const remainMs = ReconciliationService.getMsUntilNextTargetHour(targetHour);
      const ONE_MINUTE_MS = 60 * 1000;

      // remainMs 接近 24h 说明刚好到达目标时间；接近 0 说明也快到了
      // 如果 remainMs 在 (1min, 24h - 1min) 之间，说明还没到，被休眠打断了
      const ALMOST_24H = 24 * 60 * 60 * 1000 - ONE_MINUTE_MS;
      if (remainMs > ONE_MINUTE_MS && remainMs < ALMOST_24H) {
        this.logger.info(
          `==data-sync-report插件==动作:Reconciliation定时器触发但未到目标时间(可能因系统休眠)==参数==当前时间=${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}, 距目标还有${(remainMs / (1000 * 60)).toFixed(0)}分钟, 重新调度==`
        );
        this.scheduleDailyReconciliation();
        return;
      }

      this.logger.info("==data-sync-report插件==动作:Reconciliation每日定时对账触发==");
      this.reconcileNow().catch((error) => {
        this.logger.error(
          "==data-sync-report插件==动作:Reconciliation每日定时对账执行失败==参数==",
          error
        );
      });

      // 递归调度下一次
      this.scheduleDailyReconciliation();
    }, delayMs);
  }

  /**
   * 计算距离下一个目标小时（本地时间）的毫秒数
   *
   * 如果当前时间已过今天的目标小时，则计算到明天该小时的延迟。
   *
   * @param targetHour 目标小时（0-23，本地时间）
   * @returns 距离下一个目标小时的毫秒数
   */
  private static getMsUntilNextTargetHour(targetHour: number): number {
    const now = new Date();
    const target = new Date(now);
    target.setHours(targetHour, 0, 0, 0);

    // 如果今天的目标时间已过，推到明天
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }

    return target.getTime() - now.getTime();
  }
}

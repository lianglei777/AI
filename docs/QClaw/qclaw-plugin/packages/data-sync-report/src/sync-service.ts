/**
 * 数据同步上报插件 - SyncService
 *
 * 主服务，编排所有 Watcher、Reporter、StateManager 和预留扩展。
 *
 * 实现 OpenClawPluginService 接口：
 * - start(ctx)：初始化并启动所有子模块
 * - stop(ctx)：优雅关闭所有子模块，保存状态
 *
 * 架构：
 * ┌─────────────────────────────────────────────────────────┐
 * │                     SyncService                         │
 * │  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  │
 * │  │AgentWatcher  │  │CronJobsWatcher│  │CronRunsWatcher│ │
 * │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
 * │         │                 │                  │          │
 * │         └─────────┬───────┴──────────────────┘          │
 * │                   │                                     │
 * │          ┌────────▼────────┐                            │
 * │          │ ChangeReporter  │                            │
 * │          └────────┬────────┘                            │
 * │                   │                                     │
 * │          ┌────────▼────────┐                            │
 * │          │SyncStateManager │                            │
 * │          └─────────────────┘                            │
 * │                                                         │
 * │  [预留] PeriodicScanner | ReconciliationService(对账)  │
 * └─────────────────────────────────────────────────────────┘
 */

import path from "node:path";
import type { AgentDiffResult, CronJobDiffResult, Logger } from "./types.js";
import type { TelemetryReporter } from "../../../core/reporter-types.js";
import {
  CONFIG_FILENAME,
  CRON_JOBS_RELATIVE_PATH,
  CRON_RUNS_RELATIVE_DIR,
  DEFAULT_DEBOUNCE_MS,
  SERVICE_ID,
} from "./constants.js";
import { AgentWatcher } from "./watchers/agent-watcher.js";
import { CronJobsWatcher } from "./watchers/cron-jobs-watcher.js";
import { CronRunsWatcher } from "./watchers/cron-runs-watcher.js";
import { IdentityWatcher } from "./watchers/identity-watcher.js";
import { ChangeReporter } from "./reporter/change-reporter.js";
import { SyncStateManager } from "./sync-state-manager.js";
import { PeriodicScanner } from "./periodic-scanner.js";
import { ReconciliationService } from "./reconciliation.js";
import { onIdentityChange } from "./user-identity-store.js";

export interface SyncServiceContext {
  /** OpenClaw 配置对象 */
  readonly config: unknown;
  /** 工作区目录 */
  readonly workspaceDir?: string;
  /** OpenClaw 状态目录（~/.openclaw/） */
  readonly stateDir: string;
  /** 日志记录器 */
  readonly logger: Logger;
  /** 原始 fetch 函数（通过 ctx.getOriginalFetch() 获取，绕过 FetchChain） */
  readonly fetchFn?: typeof globalThis.fetch;
  /** 伽利略遥测上报器（通过 ctx.reporter 获取） */
  readonly telemetryReporter?: TelemetryReporter;
}

/**
 * 数据同步上报主服务
 */
export class SyncService {
  readonly id = SERVICE_ID;

  private agentWatcher: AgentWatcher | null = null;
  private identityWatcher: IdentityWatcher | null = null;
  private cronJobsWatcher: CronJobsWatcher | null = null;
  private cronRunsWatcher: CronRunsWatcher | null = null;
  private reporter: ChangeReporter | null = null;
  private stateManager: SyncStateManager | null = null;
  private periodicScanner: PeriodicScanner | null = null;
  private reconciliationService: ReconciliationService | null = null;

  /** 是否已激活（收到有效身份后才为 true） */
  private activated = false;

  /**
   * 启动服务（由 OpenClaw Service 框架调用）
   *
   * 不立即启动子模块，而是注册身份变化监听：
   * - 身份就绪（userId + token 都有）→ 激活所有 Watcher/Reporter/Scanner
   * - 身份失效（退出登录或 token 被清空）→ 停用所有子模块
   *
   * 如果调用时身份已就绪（覆盖"先推送后启动"的时序），会立即激活。
   */
  async start(ctx: SyncServiceContext): Promise<void> {
    const logger = ctx.logger;
    // 注册身份变化监听
    // 如果身份已就绪，onIdentityChange 会立即触发回调
    onIdentityChange((_identity, ready) => {
      if (ready && !this.activated) {
        this.doActivate(ctx).catch((error) => {
          logger.error("==data-sync-report插件==动作:SyncService激活失败==参数==", error);
        });
      } else if (!ready && this.activated) {
        this.doDeactivate(logger).catch((error) => {
          logger.error("==data-sync-report插件==动作:SyncService停用失败==参数==", error);
        });
      }
    });
  }

  /**
   * 激活所有子模块（身份就绪后调用）
   *
   * 执行顺序：
   * 1. 初始化 SyncStateManager 并加载历史状态
   * 2. 初始化 ChangeReporter
   * 3. 初始化各 Watcher（Agent 和 CronJob 从 sync_state 读写快照）
   * 4. 启动各 Watcher
   * 5. 初始化预留扩展（PeriodicScanner、ReconciliationService）
   */
  private async doActivate(ctx: SyncServiceContext): Promise<void> {
    const logger = ctx.logger;
    const stateDir = ctx.stateDir;
    this.activated = true;

    // 1. 初始化状态管理器并加载历史状态
    this.stateManager = new SyncStateManager({ stateDir, logger });
    await this.stateManager.load();

    // 2. 初始化上报器（注入上报成功后的回调）
    this.reporter = new ChangeReporter({
      logger,
      fetchFn: ctx.fetchFn,
      telemetryReporter: ctx.telemetryReporter,
      onAgentSyncSuccess: async (snapshots) => {
        await this.stateManager?.saveAgentSnapshots(snapshots);
      },
      onIdentitySyncSuccess: async (snapshots) => {
        await this.stateManager?.saveIdentitySnapshots(snapshots);
      },
      onCronJobSyncSuccess: async (snapshots) => {
        await this.stateManager?.saveCronJobSnapshots(snapshots);
      },
      onCronRunSyncSuccess: async (filePath, offset) => {
        // 上报成功后直接通过 SyncStateManager 持久化偏移到磁盘
        await this.stateManager?.saveCronRunOffset(filePath, offset);
        logger.info(
          `==data-sync-report插件==动作:SyncService的CronRun偏移已持久化==参数==文件="${path.basename(filePath)}", offset=${offset}`
        );
      },
    });

    // 3. 初始化 Agent Watcher（从 sync_state 读写快照，产出增量 diff）
    const configPath = path.join(stateDir, CONFIG_FILENAME);
    this.agentWatcher = new AgentWatcher({
      configPath,
      debounceMs: DEFAULT_DEBOUNCE_MS,
      logger,
      onDiff: async (diff: AgentDiffResult) => {
        // 使用 reportAgentDiffImmediate 立即执行上报+持久化，
        // 使 AgentWatcher 中的 await onDiff(diff) 能真正等到完成，
        // 确保下一次 diff 读取的 sync_state 是最新的。
        await this.reporter?.reportAgentDiffImmediate(diff);
      },
      getSnapshots: () => this.stateManager?.getAgentSnapshots() ?? {},
      saveSnapshots: async (snapshots) => {
        await this.stateManager?.saveAgentSnapshots(snapshots);
      },
    });

    // 4. [暂时关闭] CronJobs 和 CronRuns 的同步 — 当前不需要同步这些数据
    // TODO: 需要恢复时取消以下注释
    // const jobsFilePath = path.join(stateDir, CRON_JOBS_RELATIVE_PATH);
    // this.cronJobsWatcher = new CronJobsWatcher({
    //   jobsFilePath,
    //   debounceMs: DEFAULT_DEBOUNCE_MS,
    //   logger,
    //   onDiff: (diff: CronJobDiffResult) => {
    //     this.reporter?.reportCronJobDiff(diff);
    //   },
    //   getSnapshots: () => this.stateManager?.getCronJobSnapshots() ?? {},
    //   saveSnapshots: async (snapshots) => {
    //     await this.stateManager?.saveCronJobSnapshots(snapshots);
    //   },
    // });

    // const runsDir = path.join(stateDir, CRON_RUNS_RELATIVE_DIR);
    // this.cronRunsWatcher = new CronRunsWatcher({
    //   runsDir,
    //   debounceMs: DEFAULT_DEBOUNCE_MS,
    //   logger,
    //   onBatchEvent: (events) => {
    //     this.reporter?.reportBatch(events).catch((error) => {
    //       logger.error("==data-sync-report插件==动作:SyncService批量上报失败==参数==", error);
    //     });
    //   },
    //   getOffset: (filePath) => this.stateManager?.getCronRunOffset(filePath),
    //   getAllOffsetPaths: () => Object.keys(this.stateManager?.getCronRunOffsets() ?? {}),
    //   saveOffset: async (filePath, byteOffset) => {
    //     await this.stateManager?.saveCronRunOffset(filePath, byteOffset);
    //   },
    //   deleteOffset: async (filePath) => {
    //     await this.stateManager?.deleteCronRunOffset(filePath);
    //   },
    // });

    // 5.1. 初始化 Identity Watcher（监听 workspace*/IDENTITY.md，从 sync_state 读写快照，产出增量 diff）
    this.identityWatcher = new IdentityWatcher({
      stateDir,
      configPath,
      debounceMs: DEFAULT_DEBOUNCE_MS,
      logger,
      getSnapshots: () => this.stateManager?.getIdentitySnapshots() ?? {},
      saveSnapshots: async (snapshots) => {
        await this.stateManager?.saveIdentitySnapshots(snapshots);
      },
      onDiff: (diff) => {
        this.reporter?.reportIdentityDiff(diff);
      },
    });

    // 6. 启动所有 Watcher（CronJobs/CronRuns 暂时关闭）
    await Promise.all([
      this.agentWatcher.start(),
      this.identityWatcher.start(),
      // this.cronJobsWatcher.start(),  // [暂时关闭]
      // this.cronRunsWatcher.start(),  // [暂时关闭]
    ]);

    // 7. 初始化 PeriodicScanner（传入 reporter 和 stateManager）
    this.periodicScanner = new PeriodicScanner({
      stateDir,
      logger,
      reporter: this.reporter,
      stateManager: this.stateManager,
    });
    this.reconciliationService = new ReconciliationService({
      stateDir,
      logger,
      fetchFn: ctx.fetchFn,
      telemetryReporter: ctx.telemetryReporter,
      reporter: this.reporter,
      stateManager: this.stateManager,
    });

    // 启动定时扫描（每 5 分钟）
    this.periodicScanner.start();

    // 启动对账服务（在 Watcher 启动后执行一次对账，补充处理 Watcher 无法覆盖的差异）
    this.reconciliationService.start();
  }

  /**
   * 停用所有子模块（用户退出登录时调用）
   *
   * 与 stop() 不同，doDeactivate 不清空 savedCtx，
   * 这样用户重新登录时可以重新激活。
   */
  private async doDeactivate(logger: Logger): Promise<void> {

    this.activated = false;

    // 停止预留扩展
    this.periodicScanner?.stop();
    this.reconciliationService?.stop();

    // 停止所有 Watcher（CronJobs/CronRuns 暂时关闭）
    await Promise.all([
      this.agentWatcher?.stop(),
      this.identityWatcher?.stop(),
      // this.cronJobsWatcher?.stop(),  // [暂时关闭]
      // this.cronRunsWatcher?.stop(),  // [暂时关闭]
    ]);

    // 销毁 Reporter
    this.reporter?.destroy();

    // 清理引用（但保留 savedCtx）
    this.agentWatcher = null;
    this.identityWatcher = null;
    this.cronJobsWatcher = null;
    this.cronRunsWatcher = null;
    this.reporter = null;
    this.stateManager = null;
    this.periodicScanner = null;
    this.reconciliationService = null;
  }

  /**
   * 停止服务（由 OpenClaw Service 框架调用）
   *
   * 执行顺序：
   * 1. 停止预留扩展
   * 2. 停止所有 Watcher
   * 3. 销毁 Reporter
   */
  async stop(ctx: SyncServiceContext): Promise<void> {
    const logger = ctx.logger;
    // 如果已激活，先停用子模块
    if (this.activated) {
      await this.doDeactivate(logger);
    }

  }

}

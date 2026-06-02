/**
 * 数据同步上报插件 - 类型定义
 *
 * 定义插件使用的所有类型，包括变化事件、同步状态、上报数据等。
 */

// --------------------------------
// 变化事件类型
// --------------------------------

/** Agent 变化动作类型 */
export type AgentChangeAction = "created" | "updated" | "deleted";

/** Cron Job 变化动作类型 */
export type CronJobChangeAction = "created" | "updated" | "deleted";

/** Cron Run 记录动作类型（目前仅 finished） */
export type CronRunAction = "finished";

/** Agent 变化事件 */
export interface AgentChangeEvent {
  readonly type: "agent";
  readonly action: AgentChangeAction;
  readonly agentId: string;
  /** 变化后的完整 AgentConfig 数据（deleted 时为变化前的数据） */
  readonly data: AgentConfigData;
  readonly timestamp: number;
}

/** Cron Job 变化事件 */
export interface CronJobChangeEvent {
  readonly type: "cron-job";
  readonly action: CronJobChangeAction;
  readonly jobId: string;
  /** 变化后的完整 CronJob 数据（deleted 时为变化前的数据） */
  readonly data: CronJobData;
  readonly timestamp: number;
}

/** Cron Run 执行记录事件 */
export interface CronRunEvent {
  readonly type: "cron-run";
  readonly action: CronRunAction;
  readonly jobId: string;
  /** 完整的 CronRunLogEntry 数据 */
  readonly data: CronRunLogEntryData;
  readonly timestamp: number;
  /** 当前文件的字节偏移量（处理完本批次后的位置） */
  readonly offset: number;
  /** 来源文件路径（用于上报成功后确认偏移） */
  readonly filePath: string;
}

/** 所有变化事件的联合类型 */
export type ChangeEvent = AgentChangeEvent | CronJobChangeEvent | CronRunEvent;

// --------------------------------
// 数据结构类型（与 OpenClaw 源码对齐）
// --------------------------------

/**
 * Agent 配置数据
 * 对齐 openclaw/src/config/types.agents.ts 中的 AgentConfig
 */
export interface AgentConfigData {
  readonly id: string;
  readonly default?: boolean;
  readonly name?: string;
  readonly workspace?: string;
  readonly agentDir?: string;
  readonly model?: unknown;
  readonly thinkingDefault?: string;
  readonly reasoningDefault?: string;
  readonly fastModeDefault?: boolean;
  readonly skills?: string[];
  readonly memorySearch?: unknown;
  readonly humanDelay?: unknown;
  readonly heartbeat?: unknown;
  readonly identity?: unknown;
  readonly groupChat?: unknown;
  readonly subagents?: unknown;
  readonly sandbox?: unknown;
  readonly params?: Record<string, unknown>;
  readonly tools?: unknown;
  readonly runtime?: unknown;
  [key: string]: unknown;
}

/**
 * Cron Job 数据
 * 对齐 openclaw/src/cron/types.ts 中的 CronJob
 */
export interface CronJobData {
  readonly id: string;
  readonly agentId?: string;
  readonly sessionKey?: string;
  readonly name: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly deleteAfterRun?: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly schedule: unknown;
  readonly sessionTarget: unknown;
  readonly wakeMode: unknown;
  readonly payload: unknown;
  readonly delivery?: unknown;
  readonly failureAlert?: unknown;
  readonly state: unknown;
  [key: string]: unknown;
}

/**
 * Cron 执行记录数据
 * 对齐 openclaw/src/cron/run-log.ts 中的 CronRunLogEntry
 */
export interface CronRunLogEntryData {
  readonly ts: number;
  readonly jobId: string;
  readonly action: string;
  readonly status?: string;
  readonly error?: string;
  readonly summary?: string;
  readonly delivered?: boolean;
  readonly deliveryStatus?: string;
  readonly deliveryError?: string;
  readonly sessionId?: string;
  readonly sessionKey?: string;
  readonly runAtMs?: number;
  readonly durationMs?: number;
  readonly nextRunAtMs?: number;
  readonly model?: string;
  readonly provider?: string;
  readonly usage?: unknown;
  [key: string]: unknown;
}

// --------------------------------
// 同步状态类型（用于持久化）
// --------------------------------

/** 单个 Agent 的快照状态 */
export interface AgentSnapshot {
  /** 递归排序后 SHA-256 哈希 */
  readonly hash: string;
  /** 最后一次变化的时间戳 */
  readonly lastChangedAt: number;
}

/** 单个 Cron Job 的快照状态 */
export interface CronJobSnapshot {
  /** 剥离运行时字段后的 SHA-256 哈希 */
  readonly hash: string;
  /** 最后一次变化的时间戳 */
  readonly lastChangedAt: number;
}

/** 单个 Agent Identity 的快照状态 */
export interface IdentitySnapshot {
  /** 对解析后 AgentIdentityData 计算的 MD5 哈希 */
  readonly hash: string;
  /** 最后一次变化的时间戳 */
  readonly lastChangedAt: number;
}

/** 单个 Cron Run 文件的偏移追踪状态 */
export interface CronRunFileOffset {
  /** 文件路径 */
  readonly filePath: string;
  /** 已读取的字节偏移量 */
  readonly byteOffset: number;
  /** 最后更新时间戳 */
  readonly lastUpdatedAt: number;
}

/** 完整的同步状态 */
export interface SyncState {
  /** 状态版本号，用于未来的格式迁移 */
  readonly version: 1;
  /** Agent 快照 Map<agentId, AgentSnapshot> */
  readonly agents: Record<string, AgentSnapshot>;
  /** Agent Identity 快照 Map<agentId, IdentitySnapshot> */
  readonly identities: Record<string, IdentitySnapshot>;
  /** Cron Job 快照 Map<jobId, CronJobSnapshot> */
  readonly cronJobs: Record<string, CronJobSnapshot>;
  /** Cron Run 文件偏移 Map<filePath, CronRunFileOffset> */
  readonly cronRunOffsets: Record<string, CronRunFileOffset>;
  /** 最后一次全量扫描的时间戳（预留给定时扫描） */
  readonly lastFullScanAt?: number;
  /** 最后一次对账的时间戳（预留给数据对账） */
  readonly lastReconciliationAt?: number;
  /** 最后更新时间 */
  readonly lastUpdatedAt: number;
}

// --------------------------------
// Watcher 相关类型
// --------------------------------

/** 带 hash 的 Agent 数据（用于增量上报） */
export interface AgentWithHash {
  /** SHA-256 哈希 */
  readonly hash: string;
  /** 完整的 Agent 配置数据 */
  readonly data: AgentConfigData;
}

/**
 * Agent 增量 Diff 结果
 *
 * 由 AgentWatcher 的 diffAndEmit 产生，包含本次变化的增量数据：
 * - createdOrUpdatedAgents：新增或修改的 agent 完整数据（含 hash）
 * - deletedAgentIds：被删除的 agentId 列表
 * - deleteIdentityAgentIds：Agent 仍然存在、但需要删除其 identity 的 agentId 列表
 *   （用于对账场景：本地无 IDENTITY.md 但后端 identity_hash 非空，仅清理 identity）
 * - pendingSnapshots：本次 diff 后的最新快照，上报成功后再持久化
 */
export interface AgentDiffResult {
  /** 新增或修改的 agent 列表（含 hash，供 API 上报） */
  readonly createdOrUpdatedAgents: AgentWithHash[];
  /** 被删除的 agentId 列表 */
  readonly deletedAgentIds: string[];
  /**
   * 需要删除 identity 但保留 agent 本身的 agentId 列表
   *
   * 典型来源：Reconciliation 发现后端 identity_hash 非空但本地无 IDENTITY.md。
   * 传给后端时会映射到请求体的 delete_identity_agent_ids 字段。
   */
  readonly deleteIdentityAgentIds: string[];
  /** 本次 diff 计算出的最新快照，上报成功后才写入 sync_state */
  readonly pendingSnapshots: Record<string, AgentSnapshot>;
}

/** Agent 增量 Diff 回调函数类型 */
export type AgentDiffCallback = (diff: AgentDiffResult) => void | Promise<void>;

/** 带 hash 的 CronJob 数据（用于增量上报） */
export interface CronJobWithHash {
  /** SHA-256 哈希 */
  readonly hash: string;
  /** 完整的 CronJob 数据 */
  readonly data: CronJobData;
}

/**
 * CronJob 增量 Diff 结果
 *
 * 由 CronJobsWatcher 的 diffAndEmit 产生，包含本次变化的增量数据：
 * - createdOrUpdatedJobs：新增或修改的 job 完整数据（含 hash）
 * - deletedJobIds：被删除的 jobId 列表
 * - pendingSnapshots：本次 diff 后的最新快照，上报成功后再持久化
 */
export interface CronJobDiffResult {
  /** 新增或修改的 job 列表（含 hash，供 API 上报） */
  readonly createdOrUpdatedJobs: CronJobWithHash[];
  /** 被删除的 jobId 列表 */
  readonly deletedJobIds: string[];
  /** 本次 diff 计算出的最新快照，上报成功后才写入 sync_state */
  readonly pendingSnapshots: Record<string, CronJobSnapshot>;
}

/** CronJob 增量 Diff 回调函数类型 */
export type CronJobDiffCallback = (diff: CronJobDiffResult) => void | Promise<void>;

/** Agent Identity 数据（从 IDENTITY.md 解析） */
export interface AgentIdentityData {
  /** Agent 显示名称 */
  readonly name?: string;
  /** Agent Emoji 标识 */
  readonly emoji?: string;
  /** Agent 风格描述 */
  readonly vibe?: string;
  /** Agent 头像 URL */
  readonly avatar?: string;
}

/** Identity 变化结果（由 IdentityWatcher 产生） */
export interface IdentityChangeResult {
  /** Agent ID */
  readonly agentId: string;
  /** 解析后的 identity 数据 */
  readonly identity: AgentIdentityData;
  /** Identity 数据的哈希值 */
  readonly hash: string;
}

/** Identity 变化回调函数类型 */
export type IdentityChangeCallback = (result: IdentityChangeResult) => void | Promise<void>;

/**
 * Identity 增量 Diff 结果
 *
 * 由 IdentityWatcher 的 diff 逻辑产生，包含本次变化的增量数据：
 * - changedIdentities：有变化的 identity 列表（含 hash，供 API 上报）
 * - pendingSnapshots：本次 diff 后的最新快照，上报成功后再持久化
 */
export interface IdentityDiffResult {
  /** 有变化的 identity 列表（新增或修改） */
  readonly changedIdentities: ReadonlyArray<{
    readonly agentId: string;
    readonly identity: AgentIdentityData;
    readonly hash: string;
  }>;
  /** 本次 diff 计算出的最新快照，上报成功后才写入 sync_state */
  readonly pendingSnapshots: Record<string, IdentitySnapshot>;
}

/** Identity 增量 Diff 回调函数类型 */
export type IdentityDiffCallback = (diff: IdentityDiffResult) => void | Promise<void>;

/** Watcher 回调函数类型（单条） */
export type ChangeEventCallback = (event: ChangeEvent) => void | Promise<void>;

/** Watcher 批量回调函数类型 */
export type BatchChangeEventCallback = (events: ChangeEvent[]) => void | Promise<void>;

/** Watcher 通用配置 */
export interface WatcherConfig {
  /** debounce 延迟（毫秒） */
  readonly debounceMs: number;
  /** 日志记录器 */
  readonly logger: Logger;
}

/** 日志记录器接口 */
export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

// --------------------------------
// Reporter 相关类型
// --------------------------------

/** 上报结果 */
export interface ReportResult {
  readonly success: boolean;
  readonly error?: string;
}

/** 上报器接口 - 预留给后续 HTTP 上报实现 */
export interface IChangeReporter {
  /**
   * 上报变化事件
   * @param event 变化事件
   * @returns 上报结果
   */
  report(event: ChangeEvent): Promise<ReportResult>;

  /**
   * 批量上报变化事件
   * @param events 变化事件列表
   * @returns 上报结果
   */
  reportBatch(events: ChangeEvent[]): Promise<ReportResult>;

  /** 销毁上报器，释放资源 */
  destroy(): void;
}

// --------------------------------
// 预留扩展类型
// --------------------------------

/** 定时扫描器接口（预留） */
export interface IPeriodicScanner {
  /** 启动定时扫描 */
  start(): void;
  /** 停止定时扫描 */
  stop(): void;
  /** 立即执行一次全量扫描 */
  scanNow(): Promise<void>;
}

/** 数据对账服务接口（预留） */
export interface IReconciliationService {
  /** 启动对账服务 */
  start(): void;
  /** 停止对账服务 */
  stop(): void;
  /** 立即执行一次对账 */
  reconcileNow(): Promise<void>;
}

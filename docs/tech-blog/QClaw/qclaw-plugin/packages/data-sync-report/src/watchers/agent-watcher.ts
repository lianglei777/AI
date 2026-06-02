/**
 * 数据同步上报插件 - AgentWatcher
 *
 * 监听 openclaw.json 配置文件变化，检测 Agent 配置的创建、修改和删除。
 *
 * 实现原理：
 * 1. chokidar 监听 openclaw.json 文件变化（debounce 500ms）
 * 2. 读取并解析文件（JSON5 格式）
 * 3. 提取完整的 agent 列表（包含隐式的默认 main agent）
 * 4. 对每个 agent 进行递归排序键 + SHA-256 哈希
 * 5. 直接从 sync_state.json 读取上次快照进行对比，推断 created/updated/deleted
 * 6. 将 pendingSnapshots 传给 onDiff 回调，由上层在上报成功后再写入 sync_state
 *
 * OpenClaw Agent 存储结构：
 * - agents.defaults: 全局默认配置层，对所有 agent 生效（包括隐式的 main agent）
 *   包含 model、workspace、heartbeat 等大量配置字段
 * - agents.list: 显式定义的 agent 列表（可选，可能不存在）
 *
 * 边界场景处理：
 * - agents.list 不存在时，系统仍隐式存在一个 ID 为 "main" 的默认 agent，
 *   其配置来自 agents.defaults。我们需要为其合成一条 AgentConfigData 记录。
 * - agents.defaults 变化时（如修改 model、workspace），也视为 main agent 的配置变更。
 * - 删除所有自定义 agent 后，list 从配置中移除，main agent 回退为纯 defaults 状态。
 * - 创建第一个非默认 agent 时，list 会同时包含自动插入的默认 agent（id: "main"）。
 *
 * 并发安全：
 * - onDiff 回调使用 await 等待上报+快照持久化完成后才允许下一次 diff，
 *   避免 pendingSnapshots 覆盖导致中间删除状态丢失。
 * - readAllAgents 解析失败时会延迟重试一次，避免读到文件写入中间态的不完整 JSON。
 */

import fs from "node:fs";
import type {
  AgentConfigData,
  AgentDiffCallback,
  AgentDiffResult,
  AgentSnapshot,
  AgentWithHash,
  Logger,
} from "../types.js";
import { computeHash } from "../utils/hash.js";
import { safeParseJson5 } from "../utils/json-parser.js";

import { BaseWatcher } from "./base-watcher.js";

/**
 * 默认 Agent ID
 * 与 openclaw 源码 routing/session-key.ts 中的 DEFAULT_AGENT_ID 对齐
 */
const DEFAULT_AGENT_ID = "main";

/**
 * 文件读取解析失败时的重试延迟（毫秒）
 * 连续写文件时可能读到不完整的 JSON，等待一段时间后文件写入完成再重试
 */
const READ_RETRY_DELAY_MS = 300;

export interface AgentWatcherOptions {
  /** openclaw.json 配置文件的完整路径 */
  readonly configPath: string;
  /** debounce 延迟（毫秒） */
  readonly debounceMs: number;
  /** 日志记录器 */
  readonly logger: Logger;
  /** Agent 增量 diff 回调，每次 diff 后将增量结果传出 */
  readonly onDiff: AgentDiffCallback;
  /** 从 sync_state.json 读取 Agent 快照 */
  readonly getSnapshots: () => Record<string, AgentSnapshot>;
  /** 将最新 Agent 快照写入 sync_state.json */
  readonly saveSnapshots: (snapshots: Record<string, AgentSnapshot>) => Promise<void>;
}

export class AgentWatcher extends BaseWatcher {
  private readonly configPath: string;
  private readonly onDiff: AgentDiffCallback;
  private readonly getSnapshotsFromState: () => Record<string, AgentSnapshot>;
  private readonly saveSnapshotsToState: (snapshots: Record<string, AgentSnapshot>) => Promise<void>;

  /** 是否正在处理 diff（串行锁，防止并发 diff 导致快照竞态） */
  private isDiffing = false;

  constructor(options: AgentWatcherOptions) {
    super({
      watchPath: options.configPath,
      debounceMs: options.debounceMs,
      logger: options.logger,
      name: "AgentWatcher",
    });
    this.configPath = options.configPath;
    this.onDiff = options.onDiff;
    this.getSnapshotsFromState = options.getSnapshots;
    this.saveSnapshotsToState = options.saveSnapshots;
  }

  /**
   * 初始化：读取当前 Agent 配置，与 sync_state 中的快照对比
   *
   * - 如果 sync_state 中有快照 → 做 diff 对比，检测离线期间的变化
   * - 如果 sync_state 中没有快照 → 首次启动，构建初始快照写入 sync_state
   */
  protected async initialize(): Promise<void> {
    const agents = await this.readAllAgents();
    if (!agents) {
      return;
    }

    const savedSnapshots = this.getSnapshotsFromState();
    const hasSavedSnapshots = Object.keys(savedSnapshots).length > 0;

    if (hasSavedSnapshots) {
      await this.diffAndEmit(agents);
    } else {
      // 首次启动：构建初始快照并写入 sync_state
      const now = Date.now();
      const newSnapshots: Record<string, AgentSnapshot> = {};
      for (const agent of agents) {
        const id = this.normalizeAgentId(agent.id);
        const hash = computeHash(agent);
        newSnapshots[id] = { hash, lastChangedAt: now };
      }
      await this.saveSnapshotsToState(newSnapshots);
    }
  }

  /**
   * 处理 openclaw.json 文件变化
   *
   * 当文件读取/解析失败时（可能读到写入中间态的不完整 JSON），
   * 会延迟 READ_RETRY_DELAY_MS 后重试一次，避免因此丢失变化事件。
   */
  protected async onFileChange(
    _filePath: string,
    eventType: "change" | "add" | "unlink"
  ): Promise<void> {
    this.logger.info(`==data-sync-report插件==动作:检测到Agent的配置文件发生变化==参数==eventType=${eventType};_filePath: ${_filePath}`)
    if (eventType === "unlink") {
      await this.handleAllDeleted();
      return;
    }

    let agents = await this.readAllAgents();
    if (!agents) {
      // 解析失败可能是因为读到了文件写入中间态的不完整 JSON，延迟重试一次
      this.logger.info(
        `==data-sync-report插件==动作:AgentWatcher首次读取失败,${READ_RETRY_DELAY_MS}ms后重试==`
      );
      await new Promise((resolve) => setTimeout(resolve, READ_RETRY_DELAY_MS));
      agents = await this.readAllAgents();
      if (!agents) {
        this.logger.warn(
          "==data-sync-report插件==动作:AgentWatcher重试读取仍失败,跳过本次变化=="
        );
        return;
      }
    }
      this.logger.info(`==data-sync-report插件==动作:读取到Agent的变化后的内容==参数==agents:${JSON.stringify(agents)}`)
    await this.diffAndEmit(agents);
  }

  /**
   * 从 openclaw.json 读取完整的 agent 列表（包含隐式的默认 main agent）
   *
   * OpenClaw 的 agent 配置采用双层结构：
   * - agents.defaults: 全局默认配置层，当 agents.list 不存在时，
   *   系统仍隐式存在一个 ID 为 "main" 的默认 agent，其配置全部来自 defaults
   * - agents.list: 显式定义的 agent 列表
   *
   * 本方法的逻辑与 openclaw 源码的 listAgentIds() 对齐：
   * - 如果 agents.list 存在且非空 → 使用 list 中的条目
   * - 如果 agents.list 不存在或为空 → 合成一个 main agent（基于 defaults 数据）
   *
   * 边界处理：
   * - 文件不存在 → 返回 null（不产生事件）
   * - 文件解析失败 → 返回 null（不产生事件）
   * - cfg.agents 不存在 → 返回包含隐式 main agent 的数组
   * - cfg.agents.list 不存在 → 返回包含隐式 main agent 的数组
   * - cfg.agents.list 存在 → 返回 list 中的条目，并将 defaults 数据附加到每个条目上
   */
  private async readAllAgents(): Promise<AgentConfigData[] | null> {
    try {
      const content = await fs.promises.readFile(this.configPath, "utf-8");
      const result = safeParseJson5(content);

      if (!result.ok) {
        this.logger.warn(
          `==data-sync-report插件==动作:AgentWatcher解析配置文件失败==参数==${result.error}`
        );
        return null;
      }

      const cfg = result.data as Record<string, unknown>;
      const agentsCfg = cfg?.agents as Record<string, unknown> | undefined;
      const defaults = agentsCfg?.defaults as Record<string, unknown> | undefined;
      const list = agentsCfg?.list;

      // 提取 defaults 数据（剥离掉非 agent 粒度的字段后，作为 main agent 的配置基础）
      const defaultsData = defaults ?? {};

      if (Array.isArray(list)) {
        // agents.list 存在：过滤无效条目并附加 defaults 信息
        const validEntries = list.filter(
          (entry): entry is AgentConfigData =>
            Boolean(entry && typeof entry === "object" && (entry as AgentConfigData).id)
        );

        if (validEntries.length > 0) {
          // 为每个 agent 附加 defaults 数据用于 hash 计算
          // 这样当 defaults 变化时，依赖 defaults 的 agent 也能检测到变化
          return validEntries.map((entry) => this.enrichAgentWithDefaults(entry, defaultsData));
        }
      }

      // agents.list 不存在或为空：
      // 与 openclaw 源码 listAgentIds() 对齐，合成一个隐式的 main agent
      return [this.buildImplicitMainAgent(defaultsData)];
    } catch (error) {
      const nodeErr = error as NodeJS.ErrnoException;
      if (nodeErr?.code === "ENOENT") {
        // 文件不存在，正常情况
        return null;
      }
      this.logger.error("==data-sync-report插件==动作:AgentWatcher读取配置文件失败==参数==", error);
      return null;
    }
  }

  /**
   * 为显式定义的 agent 条目附加 defaults 数据
   *
   * defaults 作为全局配置层影响所有 agent 的运行时行为，
   * 将其纳入 hash 计算可以确保 defaults 变化时也能触发变化检测。
   *
   * 附加方式：在 agent 数据上增加 _defaults 字段存储 defaults 数据，
   * 这个字段不会影响原始 agent 数据，但会参与 hash 计算。
   */
  private enrichAgentWithDefaults(
    agent: AgentConfigData,
    defaults: Record<string, unknown>
  ): AgentConfigData {
    return {
      ...agent,
      _defaults: defaults,
    };
  }

  /**
   * 当 agents.list 不存在时，合成一个隐式的 main agent
   *
   * 与 openclaw 源码对齐：
   * - listAgentIds() 在 list 为空时返回 [DEFAULT_AGENT_ID]（即 ["main"]）
   * - resolveDefaultAgentId() 在 list 为空时返回 "main"
   * - main agent 的所有配置来自 agents.defaults
   *
   * 注意：合成的数据结构必须与 list 中存在 { id: "main" } 时
   * 经过 enrichAgentWithDefaults 处理后的结构保持一致，
   * 避免从 "无 list" 过渡到 "有 list" 时因结构差异产生虚假的 updated 事件。
   */
  private buildImplicitMainAgent(
    defaults: Record<string, unknown>
  ): AgentConfigData {
    return {
      id: DEFAULT_AGENT_ID,
      _defaults: defaults,
    } as AgentConfigData;
  }

  /**
   * 对比当前 agent 列表与 sync_state 中的快照，收集增量变化
   *
   * 1. 从 sync_state.json 读取上次的快照
   * 2. 计算当前 agents 的 hash
   * 3. 对比得出 created/updated/deleted
   * 4. 构建 pendingSnapshots（不写入 sync_state，等上报成功后再写）
   * 5. 通过 onDiff 回调传出增量结果 + pendingSnapshots（await 等待上报完成）
   *
   * 使用 isDiffing 锁保证串行执行：当上一次 diff→上报→持久化快照未完成时，
   * 新的 diff 请求会等待，确保 getSnapshotsFromState() 读到的是最新已持久化的快照。
   */
  private async diffAndEmit(currentAgents: AgentConfigData[]): Promise<void> {
    // 串行锁：等待上一次 diff 完成
    if (this.isDiffing) {
      this.logger.info("==data-sync-report插件==动作:AgentWatcher的diffAndEmit正在执行,等待上一次完成==");
    }
    while (this.isDiffing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.isDiffing = true;

    try {
      const now = Date.now();

      // 从 sync_state 读取上次快照
      const previousSnapshots = this.getSnapshotsFromState();

      // 计算当前 agents 的 hash
      const currentMap = new Map<string, { hash: string; data: AgentConfigData }>();
      for (const agent of currentAgents) {
        const id = this.normalizeAgentId(agent.id);
        const hash = computeHash(agent);
        currentMap.set(id, { hash, data: agent });
      }

      const createdOrUpdatedAgents: AgentWithHash[] = [];
      const deletedAgentIds: string[] = [];

      // 检测新增和修改
      for (const [id, { hash, data }] of currentMap) {
        const previous = previousSnapshots[id];

        if (!previous) {
          this.logger.info(`==data-sync-report插件==动作:AgentWatcher检测到Agent新增==参数==agentId="${id}"`);
          createdOrUpdatedAgents.push({ hash, data });
        } else if (previous.hash !== hash) {
          this.logger.info(`==data-sync-report插件==动作:AgentWatcher检测到Agent修改==参数==agentId="${id}"`);
          createdOrUpdatedAgents.push({ hash, data });
        }
      }

      // 检测删除
      for (const id of Object.keys(previousSnapshots)) {
        if (!currentMap.has(id)) {
          this.logger.info(`==data-sync-report插件==动作:AgentWatcher检测到Agent删除==参数==agentId="${id}"`);
          deletedAgentIds.push(id);
        }
      }

      // 构建最新快照（不立即写入 sync_state，等上报成功后再写）
      const pendingSnapshots: Record<string, AgentSnapshot> = {};
      for (const [id, { hash }] of currentMap) {
        pendingSnapshots[id] = { hash, lastChangedAt: now };
      }

      // 有变化时才回调
      if (createdOrUpdatedAgents.length === 0 && deletedAgentIds.length === 0) {
        return;
      }

      const diff: AgentDiffResult = {
        createdOrUpdatedAgents,
        deletedAgentIds,
        deleteIdentityAgentIds: [],
        pendingSnapshots,
      };

      // await onDiff 确保上报+快照持久化完成后才释放锁，
      // 这样下一次 diffAndEmit 读取的 sync_state 是最新的。
      try {
        await this.onDiff(diff);
      } catch (error) {
        this.logger.error(
          "==data-sync-report插件==动作:AgentWatcher的diff回调异常==参数==",
          error
        );
      }
    } finally {
      this.isDiffing = false;
    }
  }

  /**
   * 处理配置文件被删除：所有 agent 标记为 deleted
   */
  private async handleAllDeleted(): Promise<void> {
    // 串行锁：等待上一次 diff 完成
    while (this.isDiffing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.isDiffing = true;

    try {
      const previousSnapshots = this.getSnapshotsFromState();
      const deletedAgentIds = Object.keys(previousSnapshots);

      for (const id of deletedAgentIds) {
        this.logger.info(`==data-sync-report插件==动作:AgentWatcher检测到Agent删除(文件移除)==参数==agentId="${id}"`);
      }

      if (deletedAgentIds.length === 0) {
        return;
      }

      // 空快照，上报成功后写入 sync_state 以清空
      const diff: AgentDiffResult = {
        createdOrUpdatedAgents: [],
        deletedAgentIds,
        deleteIdentityAgentIds: [],
        pendingSnapshots: {},
      };

      try {
        await this.onDiff(diff);
      } catch (error) {
        this.logger.error(
          "==data-sync-report插件==动作:AgentWatcher的diff回调异常(全部删除)==参数==",
          error
        );
      }
    } finally {
      this.isDiffing = false;
    }
  }

  /**
   * 标准化 agentId
   * 与 openclaw 源码 normalizeAgentId 对齐：小写化 + trim
   */
  private normalizeAgentId(id: string): string {
    return (id ?? "").trim().toLowerCase();
  }
}

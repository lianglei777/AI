/**
 * 数据同步上报插件 - IdentityWatcher
 *
 * 监听 stateDir 下有效 agent 的 workspace-xxx/IDENTITY.md 文件变化，
 * 解析 Agent 的 identity 信息（name / vibe / avatar），
 * 与 sync_state 中的快照做 diff 对比，只上报有变化的 identity。
 *
 * 实现原理：
 * 1. 启动时读取 openclaw.json 获取有效 agent 列表
 * 2. 主动扫描有效 agent 的 IDENTITY.md 文件（initialize），与历史快照 diff
 * 3. 监听 stateDir 目录（depth=1, ignoreInitial=true），运行时检测文件变化
 * 4. 文件变化时解析内容、计算 hash，与快照对比，有变化才回调 onDiff
 * 5. 同时监听 openclaw.json 变化，动态更新有效 agent 列表
 */

import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type {
  AgentIdentityData,
  IdentityDiffCallback,
  IdentityDiffResult,
  IdentitySnapshot,
  Logger,
} from "../types.js";
import { DEFAULT_DEBOUNCE_MS } from "../constants.js";
import { safeParseJson5 } from "../utils/json-parser.js";
import { computeHash } from "../utils/hash.js";


export interface IdentityWatcherOptions {
  /** OpenClaw 状态目录（~/.qclaw/） */
  readonly stateDir: string;
  /** openclaw.json 配置文件的完整路径 */
  readonly configPath: string;
  /** debounce 延迟（毫秒） */
  readonly debounceMs?: number;
  /** 日志记录器 */
  readonly logger: Logger;
  /** 从 sync_state 读取 Identity 快照 */
  readonly getSnapshots: () => Record<string, IdentitySnapshot>;
  /** 将最新 Identity 快照写入 sync_state */
  readonly saveSnapshots: (snapshots: Record<string, IdentitySnapshot>) => Promise<void>;
  /** Identity 增量 diff 回调 */
  readonly onDiff: IdentityDiffCallback;
}

/**
 * 解析 IDENTITY.md 内容为结构化数据
 *
 * 格式示例：
 * ```
 * - Name: 无不言
 * - Emoji: 📚
 * - Vibe: 毒舌的自由撰稿人
 * - Avatar: https://cos-url.example.com/avatar.png
 * ```
 */
export function parseIdentityMarkdown(content: string): AgentIdentityData {
  const identity: Record<string, string> = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    // 匹配 "- Key: Value" 或 "Key: Value" 格式
    const match = trimmed.match(/^-?\s*(\w+)\s*:\s*(.+)$/);
    if (!match) continue;

    const label = match[1].toLowerCase();
    const value = match[2].trim();

    switch (label) {
      case "name":
        identity.name = value;
        break;
      case "emoji":
        identity.emoji = value;
        break;
      case "vibe":
        identity.vibe = value;
        break;
      case "avatar":
        identity.avatar = value;
        break;
    }
  }

  return identity as AgentIdentityData;
}

/**
 * 从文件路径中提取 agentId
 *
 * 匹配模式：
 * - .../workspace/IDENTITY.md → "main"
 * - .../workspace-{agentId}/IDENTITY.md → agentId
 */
function extractAgentIdFromPath(filePath: string): string | null {
  const match = filePath.match(/workspace-([^/\\]+)[/\\]IDENTITY\.md$/);
  if (match) return match[1];
  if (/workspace[/\\]IDENTITY\.md$/.test(filePath)) return "main";
  return null;
}

/** 判断给定路径是否是我们关心的 workspace-xxx/IDENTITY.md */
function isIdentityFile(filePath: string): boolean {
  return extractAgentIdFromPath(filePath) !== null;
}

/** 判断路径是否是 workspace 或 workspace-xxx 的目录名 */
function isWorkspaceDir(dirName: string): boolean {
  return dirName === "workspace" || dirName.startsWith("workspace-");
}

/**
 * 从 IDENTITY.md 文件的完整路径中提取 workspace 目录名
 *
 * 例如：
 * - .../workspace/IDENTITY.md → "workspace"
 * - .../workspace-agent-6e093702/IDENTITY.md → "workspace-agent-6e093702"
 */
function extractWorkspaceDirName(filePath: string): string | null {
  const match = filePath.match(/(workspace(?:-[^/\\]+)?)[/\\]IDENTITY\.md$/);
  return match ? match[1] : null;
}

/**
 * 判断解析后的 identity 数据是否有有效字段
 */
function hasValidIdentityFields(identity: AgentIdentityData): boolean {
  return !!(identity.name || identity.vibe || identity.avatar);
}

export class IdentityWatcher {
  private readonly stateDir: string;
  private readonly configPath: string;
  private readonly debounceMs: number;
  private readonly logger: Logger;
  private readonly onDiff: IdentityDiffCallback;
  private readonly getSnapshotsFromState: () => Record<string, IdentitySnapshot>;
  private readonly saveSnapshotsToState: (snapshots: Record<string, IdentitySnapshot>) => Promise<void>;

  private watcher: FSWatcher | null = null;
  private configWatcher: FSWatcher | null = null;
  private isRunning = false;

  /**
   * 有效的 workspace 目录名集合（如 "workspace", "workspace-agent-6e093702"）
   * 只有在此集合中的目录下的 IDENTITY.md 变化才会触发回调
   */
  private validWorkspaceDirs: Set<string> = new Set();

  /**
   * 有效的 agentId → workspace 目录名映射
   * 用于 initialize 时构建文件路径
   */
  private validAgentIds: Map<string, string> = new Map();

  /** debounce 缓冲：Map<agentId, filePath>，窗口内合并同一 agent 的多次变化 */
  private pendingChanges = new Map<string, string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** 配置文件变化的 debounce 定时器 */
  private configDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: IdentityWatcherOptions) {
    this.stateDir = options.stateDir;
    this.configPath = options.configPath;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.logger = options.logger;
    this.onDiff = options.onDiff;
    this.getSnapshotsFromState = options.getSnapshots;
    this.saveSnapshotsToState = options.saveSnapshots;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn("==data-sync-report插件==动作:IdentityWatcher已在运行,跳过启动==");
      return;
    }

    // 读取 openclaw.json 构建有效 agent 的 workspace 目录集合
    await this.refreshValidAgents();

    // 监听 openclaw.json 变化，动态更新有效 agent 列表
    this.configWatcher = chokidar.watch(this.configPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });
    this.configWatcher.on("change", () => this.scheduleConfigRefresh());
    this.configWatcher.on("error", (error: unknown) => {
      this.logger.error("==data-sync-report插件==动作:IdentityWatcher配置文件监听错误==参数==", error);
    });

    // 监听 stateDir 目录（ignoreInitial: true — 不自动触发已存在文件的 add 事件）
    // 初始化扫描在 initialize() 中手动完成
    this.watcher = chokidar.watch(this.stateDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 1,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      ignored: (filePath: string) => {
        const rel = path.relative(this.stateDir, filePath);

        // stateDir 本身 → 不忽略（需要递归进入）
        if (rel === "" || rel === ".") return false;

        const segments = rel.split(path.sep);

        // 第一层：只放行 workspace / workspace-xxx 目录
        if (segments.length === 1) {
          return !isWorkspaceDir(segments[0]);
        }

        // 第二层：只放行 IDENTITY.md 文件
        if (segments.length === 2) {
          return segments[1] !== "IDENTITY.md";
        }

        // 更深层级全部忽略
        return true;
      },
    });

    this.watcher.on("add", (fp: string) => this.scheduleChange(fp));
    this.watcher.on("change", (fp: string) => this.scheduleChange(fp));
    this.watcher.on("error", (error: unknown) => {
      this.logger.error("==data-sync-report插件==动作:IdentityWatcher监听错误==参数==", error);
    });

    this.isRunning = true;

    // 启动后执行一次初始化扫描（对齐 AgentWatcher/CronJobsWatcher 的 initialize 模式）
    await this.initialize();
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.configDebounceTimer) {
      clearTimeout(this.configDebounceTimer);
      this.configDebounceTimer = null;
    }
    this.pendingChanges.clear();

    if (this.configWatcher) {
      await this.configWatcher.close();
      this.configWatcher = null;
    }

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    this.validWorkspaceDirs.clear();
    this.validAgentIds.clear();
    this.isRunning = false;
  }

  // --------------------------------
  // 初始化扫描（启动时执行一次）
  // --------------------------------

  /**
   * 初始化：主动扫描所有有效 agent 的 IDENTITY.md，与 sync_state 中的快照对比
   *
   * - 如果 sync_state 中有 identity 快照 → 做 diff 对比，检测离线期间的变化
   * - 如果 sync_state 中没有 identity 快照 → 首次启动，构建初始快照写入 sync_state（不上报）
   */
  private async initialize(): Promise<void> {
    const currentIdentities = await this.scanAllIdentities();

    const savedSnapshots = this.getSnapshotsFromState();
    const hasSavedSnapshots = Object.keys(savedSnapshots).length > 0;

    if (hasSavedSnapshots) {
      // 非首次启动：与历史快照对比，上报有变化的部分
      await this.diffAndEmit(currentIdentities);
    } else {
      // 首次启动：构建初始快照写入 sync_state，不上报
      const now = Date.now();
      const newSnapshots: Record<string, IdentitySnapshot> = {};
      for (const [agentId, { hash }] of currentIdentities) {
        newSnapshots[agentId] = { hash, lastChangedAt: now };
      }
      if (Object.keys(newSnapshots).length > 0) {
        await this.saveSnapshotsToState(newSnapshots);
      }
      this.logger.info(
        `==data-sync-report插件==动作:IdentityWatcher初始化完成(首次)==参数==identities=${currentIdentities.size}`
      );
    }
  }

  /**
   * 扫描所有有效 agent 的 IDENTITY.md 文件
   *
   * @returns Map<agentId, { identity, hash }>
   */
  private async scanAllIdentities(): Promise<
    Map<string, { identity: AgentIdentityData; hash: string }>
  > {
    const result = new Map<string, { identity: AgentIdentityData; hash: string }>();

    for (const [agentId, dirName] of this.validAgentIds) {
      const filePath = path.join(this.stateDir, dirName, "IDENTITY.md");
      try {
        const content = await fs.promises.readFile(filePath, "utf-8");
        const identity = parseIdentityMarkdown(content);

        if (!hasValidIdentityFields(identity)) {
          continue;
        }

        const hash = computeHash(identity);
        result.set(agentId, { identity, hash });
      } catch (error) {
        const nodeErr = error as NodeJS.ErrnoException;
        if (nodeErr?.code !== "ENOENT") {
          this.logger.warn(
            `==data-sync-report插件==动作:IdentityWatcher扫描文件失败==参数==agentId="${agentId}", file="${filePath}"`
          );
        }
        // ENOENT：文件不存在，正常（agent 可能还没创建 IDENTITY.md）
      }
    }

    return result;
  }

  // --------------------------------
  // 运行时文件变化处理
  // --------------------------------

  private scheduleChange(filePath: string): void {
    // 二次过滤：确保是 IDENTITY.md
    if (!isIdentityFile(filePath)) return;

    // 过滤：只处理有效 agent 对应的 workspace 目录
    const workspaceDirName = extractWorkspaceDirName(filePath);
    if (!workspaceDirName || !this.validWorkspaceDirs.has(workspaceDirName)) {
      this.logger.debug(
        `==data-sync-report插件==动作:IdentityWatcher跳过非活跃Agent的Identity变化==参数==dir="${workspaceDirName ?? "unknown"}", file="${filePath}"`
      );
      return;
    }

    const agentId = extractAgentIdFromPath(filePath);
    if (!agentId) return;

    this.pendingChanges.set(agentId, filePath);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null;
      const changes = new Map(this.pendingChanges);
      this.pendingChanges.clear();

      // 读取所有变化的文件，构建当前 identity map，统一做 diff
      const currentIdentities = new Map<string, { identity: AgentIdentityData; hash: string }>();

      for (const [aid, fp] of changes) {
        try {
          const content = await fs.promises.readFile(fp, "utf-8");
          const identity = parseIdentityMarkdown(content);

          if (!hasValidIdentityFields(identity)) {
            this.logger.info(
              `==data-sync-report插件==动作:IdentityWatcher的Identity为空,跳过==参数==agentId="${aid}"`
            );
            continue;
          }

          const hash = computeHash(identity);
          currentIdentities.set(aid, { identity, hash });
        } catch {
          this.logger.warn(
            `==data-sync-report插件==动作:IdentityWatcher读取文件失败==参数==agentId="${aid}", file="${fp}"`
          );
        }
      }

      if (currentIdentities.size > 0) {
        await this.diffAndEmitPartial(currentIdentities);
      }
    }, this.debounceMs);
  }

  // --------------------------------
  // Diff 对比逻辑
  // --------------------------------

  /**
   * 全量 diff：用于 initialize 场景
   *
   * 将当前所有有效 agent 的 identity 与 sync_state 中的快照全量对比。
   */
  private async diffAndEmit(
    currentIdentities: Map<string, { identity: AgentIdentityData; hash: string }>
  ): Promise<void> {
    const now = Date.now();
    const previousSnapshots = this.getSnapshotsFromState();

    const changedIdentities: IdentityDiffResult["changedIdentities"][number][] = [];

    // 检测新增和修改
    for (const [agentId, { identity, hash }] of currentIdentities) {
      const previous = previousSnapshots[agentId];

      if (!previous) {
        this.logger.info(
          `==data-sync-report插件==动作:IdentityWatcher检测到Identity新增==参数==agentId="${agentId}"`
        );
        changedIdentities.push({ agentId, identity, hash });
      } else if (previous.hash !== hash) {
        this.logger.info(
          `==data-sync-report插件==动作:IdentityWatcher检测到Identity变化==参数==agentId="${agentId}"`
        );
        changedIdentities.push({ agentId, identity, hash });
      }
    }

    // 构建最新的完整快照
    const pendingSnapshots: Record<string, IdentitySnapshot> = {};
    for (const [agentId, { hash }] of currentIdentities) {
      pendingSnapshots[agentId] = { hash, lastChangedAt: now };
    }

    if (changedIdentities.length === 0) {
      return;
    }

    const diff: IdentityDiffResult = { changedIdentities, pendingSnapshots };

    await Promise.resolve(this.onDiff(diff)).catch((error) => {
      this.logger.error("==data-sync-report插件==动作:IdentityWatcher的diff回调异常==参数==", error);
    });
  }

  /**
   * 增量 diff：用于运行时文件变化场景
   *
   * 只对本次变化的 agent 做对比，其他 agent 的快照保持不变。
   */
  private async diffAndEmitPartial(
    changedFiles: Map<string, { identity: AgentIdentityData; hash: string }>
  ): Promise<void> {
    const now = Date.now();
    const previousSnapshots = this.getSnapshotsFromState();

    const changedIdentities: IdentityDiffResult["changedIdentities"][number][] = [];

    for (const [agentId, { identity, hash }] of changedFiles) {
      const previous = previousSnapshots[agentId];

      if (!previous || previous.hash !== hash) {
        this.logger.info(
          `==data-sync-report插件==动作:IdentityWatcher检测到Identity变化==参数==agentId="${agentId}", name="${identity.name ?? ""}", vibe="${identity.vibe ?? ""}", avatar=${identity.avatar ? "(set)" : "(empty)"}`
        );
        changedIdentities.push({ agentId, identity, hash });
      }
    }

    if (changedIdentities.length === 0) {
      return;
    }

    // 合并快照：保留之前的快照，只更新变化的 agent
    const pendingSnapshots: Record<string, IdentitySnapshot> = { ...previousSnapshots };
    for (const { agentId, hash } of changedIdentities) {
      pendingSnapshots[agentId] = { hash, lastChangedAt: now };
    }

    const diff: IdentityDiffResult = { changedIdentities, pendingSnapshots };

    await Promise.resolve(this.onDiff(diff)).catch((error) => {
      this.logger.error("==data-sync-report插件==动作:IdentityWatcher的diff回调异常==参数==", error);
    });
  }

  // --------------------------------
  // 有效 Agent 列表管理
  // --------------------------------

  /**
   * 从 openclaw.json 读取 agents.list，构建有效的 workspace 目录名集合
   *
   * 逻辑与 AgentWatcher.readAllAgents() 对齐：
   * - agents.list 存在且非空 → 使用 list 中的条目
   * - agents.list 不存在或为空 → 仅包含隐式的 main agent
   *
   * 目录映射规则：
   * - id 为 "main" → "workspace"
   * - id 为其他值（如 "agent-6e093702"）→ "workspace-agent-6e093702"
   */
  private async refreshValidAgents(): Promise<void> {
    const newValidDirs = new Set<string>();
    const newAgentIds = new Map<string, string>();

    try {
      const content = await fs.promises.readFile(this.configPath, "utf-8");
      const result = safeParseJson5(content);

      if (!result.ok) {
        this.logger.warn(
          `==data-sync-report插件==动作:IdentityWatcher解析配置文件失败==参数==${result.error}`
        );
        // 解析失败时保留之前的有效集合，不清空
        return;
      }

      const cfg = result.data as Record<string, unknown>;
      const agentsCfg = cfg?.agents as Record<string, unknown> | undefined;
      const list = agentsCfg?.list;

      if (Array.isArray(list) && list.length > 0) {
        for (const entry of list) {
          if (entry && typeof entry === "object" && (entry as { id?: string }).id) {
            const agentId = (entry as { id: string }).id;
            const dirName = agentId === "main" ? "workspace" : `workspace-${agentId}`;
            newValidDirs.add(dirName);
            newAgentIds.set(agentId, dirName);
          }
        }
      } else {
        // agents.list 不存在或为空：仅包含隐式的 main agent
        newValidDirs.add("workspace");
        newAgentIds.set("main", "workspace");
      }
    } catch (error) {
      const nodeErr = error as NodeJS.ErrnoException;
      if (nodeErr?.code === "ENOENT") {
        // 文件不存在，仅包含隐式的 main agent
        newValidDirs.add("workspace");
        newAgentIds.set("main", "workspace");
      } else {
        this.logger.error("==data-sync-report插件==动作:IdentityWatcher读取配置文件失败==参数==", error);
        // 读取失败时保留之前的有效集合，不清空
        return;
      }
    }

    // 计算新增的 agentId（在新列表中存在但旧列表中不存在的）
    const addedAgentIds: Array<{ agentId: string; dirName: string }> = [];
    for (const [agentId, dirName] of newAgentIds) {
      if (!this.validAgentIds.has(agentId)) {
        addedAgentIds.push({ agentId, dirName });
      }
    }

    const oldDirs = [...this.validWorkspaceDirs].sort().join(", ");
    const newDirsStr = [...newValidDirs].sort().join(", ");

    this.validWorkspaceDirs = newValidDirs;
    this.validAgentIds = newAgentIds;
    // 对新增的 agent 主动扫描 IDENTITY.md 并做 diff
    // 解决竞态：IDENTITY.md 的 add 事件可能先于白名单更新到达 scheduleChange 而被丢弃
    if (addedAgentIds.length > 0) {
      await this.scanNewAgentIdentities(addedAgentIds);
    }
  }

  /**
   * 扫描新增 agent 的 IDENTITY.md 并做增量 diff
   *
   * 当 openclaw.json 新增了 agent 后，其 workspace-xxx/IDENTITY.md 的 chokidar add 事件
   * 可能先于白名单更新而被 scheduleChange 的过滤逻辑丢弃。
   * 此方法在白名单更新后主动补扫，确保新增 agent 的 identity 不会丢失。
   */
  private async scanNewAgentIdentities(
    agents: Array<{ agentId: string; dirName: string }>
  ): Promise<void> {
    const currentIdentities = new Map<string, { identity: AgentIdentityData; hash: string }>();

    for (const { agentId, dirName } of agents) {
      const filePath = path.join(this.stateDir, dirName, "IDENTITY.md");
      try {
        const content = await fs.promises.readFile(filePath, "utf-8");
        const identity = parseIdentityMarkdown(content);

        if (!hasValidIdentityFields(identity)) {
          continue;
        }

        const hash = computeHash(identity);
        currentIdentities.set(agentId, { identity, hash });
      } catch (error) {
        const nodeErr = error as NodeJS.ErrnoException;
        if (nodeErr?.code !== "ENOENT") {
          this.logger.warn(
            `==data-sync-report插件==动作:IdentityWatcher扫描新增Agent的Identity失败==参数==agentId="${agentId}", file="${filePath}"`
          );
        }
        // ENOENT：IDENTITY.md 尚未创建，正常跳过
      }
    }

    if (currentIdentities.size > 0) {
      await this.diffAndEmitPartial(currentIdentities);
    }
  }

  /**
   * 调度配置文件刷新（debounce，避免频繁读取）
   */
  private scheduleConfigRefresh(): void {
    if (this.configDebounceTimer) {
      clearTimeout(this.configDebounceTimer);
    }

    this.configDebounceTimer = setTimeout(async () => {
      this.configDebounceTimer = null;
      try {
        await this.refreshValidAgents();
      } catch (error) {
        this.logger.error("==data-sync-report插件==动作:IdentityWatcher刷新有效Agent列表失败==参数==", error);
      }
    }, this.debounceMs);
  }
}

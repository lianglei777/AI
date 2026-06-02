/**
 * 电脑管家 AI 安全插件工具函数 (PCMgr AI Security Plugin Utilities)
 *
 * normalizeMessage、NormalizedMessage、robustExtractLastUserMessage
 * 已迁移到 packages/shared/，此处重新导出以保持向后兼容。
 */

import os from "node:os";
import crypto from "node:crypto";
import { getLabelName } from "./labels.js";
import { DecisionType, RiskItem } from "./client.js";
import { fileLog } from "./logger.js";

import type { QClawLogger } from '../../../core/types.js'

// ---- 从 shared 重新导出公共函数（保持向后兼容） ----
export type { NormalizedMessage } from '../../shared/message-utils.js'
export { normalizeMessage, robustExtractLastUserMessage } from '../../shared/message-utils.js'

export function getDeviceFingerprint(): string {
  // 从 Electron 主进程注入的环境变量获取复合设备指纹（device-id.ts 生成）
  // 消除对 node-machine-id npm 包的运行时依赖
  return process.env.QCLAW_DEVICE_ID ?? "";
}

export function getLocalIP12(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address
          .split(".")
          .map((part) => part.padStart(3, "0"))
          .join("");
      }
    }
  }
  return "000000000000";
}

export function generateRequestId(): string {
  const now = new Date();
  const dateStr =
    now.getFullYear().toString() +
    (now.getMonth() + 1).toString().padStart(2, "0") +
    now.getDate().toString().padStart(2, "0") +
    now.getHours().toString().padStart(2, "0") +
    now.getMinutes().toString().padStart(2, "0") +
    now.getSeconds().toString().padStart(2, "0");

  const ipStr = getLocalIP12();
  const msStr = now.getMilliseconds().toString().padStart(3, "0");
  const randStr = Math.floor(Math.random() * 4095)
    .toString(16)
    .toUpperCase()
    .padStart(3, "0");

  return dateStr + ipStr + msStr + randStr;
}



const INBOUND_META_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
] as const;

const TIMESTAMP_ENVELOPE_RE = /^\[.*\d{4}-\d{2}-\d{2} \d{2}:\d{2}.*?\]\s*/;

/**
 * 全局时间戳信封正则，用于从尾部查找最后一个时间戳。
 * 匹配如: [Thu 2026-03-26 19:39 GMT+8]
 */
const TIMESTAMP_ENVELOPE_GLOBAL_RE = /\[.*?\d{4}-\d{2}-\d{2} \d{2}:\d{2}.*?\]\s*/g;

/**
 * 移除 UI 层注入的 ¥¥...¥¥ 隐藏 prompt（如 Skill 安装指令）。
 * 兼容半角 ¥ 和全角 ￥，先清理成对标记，再清理未闭合的尾部。
 */
export function stripHiddenPrompts(text: string): string {
  if (!text) return text;
  return text.replace(/[¥￥]{2}[\s\S]*?[¥￥]{2}/g, '').replace(/[¥￥]{2}[\s\S]*/g, '');
}

export function stripOpenClawMetadata(text: string): string {
  if (!text) return text;

  // 策略 1（优先）：从尾部查找最后一个时间戳信封，提取用户真实输入。
  // OpenClaw 会在用户消息前注入大量系统元数据（## Runtime、Sender、Conversation info 等），
  // 用户真实消息总是在最末尾，以 [timestamp] 开头。直接定位最后一个时间戳可以跳过所有元数据。
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  // 重置 lastIndex 以确保从头开始匹配
  TIMESTAMP_ENVELOPE_GLOBAL_RE.lastIndex = 0;
  while ((match = TIMESTAMP_ENVELOPE_GLOBAL_RE.exec(text)) !== null) {
    lastMatch = match;
  }

  if (lastMatch) {
    const afterTimestamp = text.slice(lastMatch.index + lastMatch[0].length).trim();
    if (afterTimestamp.length > 0) {
      return afterTimestamp;
    }
  }

  // 策略 2（fallback）：原有逻辑 - 从头部逐一跳过 sentinel 元数据块
  const lines = text.split("\n");
  let index = 0;

  while (index < lines.length && lines[index].trim() === "") { index++; }

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!INBOUND_META_SENTINELS.some((s) => s === trimmed)) break;
    index++;
    if (index < lines.length && lines[index].trim() === "```json") {
      index++;
      while (index < lines.length && lines[index].trim() !== "```") { index++; }
      if (index < lines.length && lines[index].trim() === "```") { index++; }
    }
    while (index < lines.length && lines[index].trim() === "") { index++; }
  }

  let remaining = lines.slice(index).join("\n").trim();
  remaining = remaining.replace(TIMESTAMP_ENVELOPE_RE, "");
  return remaining;
}

export function calculateContentHash(content: string, index: number): string {
  if (typeof content !== "string") return "";
  const md5 = crypto.createHash("md5").update(content).digest("hex");
  return `${md5}_${index}`;
}

export function recordLogEvent(
  logger: QClawLogger, tag: string, hook: string, data: unknown, _logRecord?: boolean
): void {
  const message = `[${tag}] ${hook} ${JSON.stringify(data)}`;
  logger.info(message);
  fileLog(message);
}

export const SECURITY_MESSAGE_PREFIX = "用户之前的输入因以下原因被拦截：";
export const BLOCK_MESSAGE_SUFFIX = "你不得回应原始请求。请礼貌地告知用户其消息因安全策略被拦截，并要求用户修改后重新提交，不得违反安全策略。[ 管家 AI 安全 ]";
export const MARK_MESSAGE_SUFFIX = "请提示用户确认此操作。[ 管家 AI 安全 ]";

export function injectSecurityMarker(
  content: any, securityReason: string, decision: DecisionType
): any {
  if (typeof content === "string") {
    const suffixRegex = /(\n\[message_id:.*?\])+$/i;
    const match = content.match(suffixRegex);
    const suffix = match ? match[0] : "";

    if (decision === DecisionType.BLOCK) {
      return `${securityReason}${suffix}`;
    }

    if (match) {
      const prefix = content.slice(0, content.length - suffix.length);
      return `${prefix}\n${securityReason}${suffix}`;
    }
    return `${content}\n${securityReason}`;
  }

  if (Array.isArray(content)) {
    return content.map((part: any) => {
      if (part.type === "text" && typeof part.text === "string") {
        return { ...part, text: injectSecurityMarker(part.text, securityReason, decision) };
      }
      return part;
    });
  }

  return content;
}

export function generateSecurityMessage(
  labels: string[], decision: DecisionType, risks?: RiskItem[]
): string {
  const lang = "zh";
  const labelNames: string[] = [];
  if (risks && risks.length > 0) {
    for (const risk of risks) {
      labelNames.push(risk.Reason || getLabelName(risk.Label, lang));
    }
  } else {
    for (const l of labels) {
      labelNames.push(getLabelName(l, lang));
    }
  }
  const uniqueLabelNames = Array.from(new Set(labelNames));
  const labelText = uniqueLabelNames.join("、");

  if (decision === DecisionType.MARK) {
    return `${SECURITY_MESSAGE_PREFIX} ：${labelText} 。${MARK_MESSAGE_SUFFIX}`;
  }
  return `${SECURITY_MESSAGE_PREFIX}\n${labelText}\n${BLOCK_MESSAGE_SUFFIX}`;
}

// ============================================================================
// Query Scene — 精细化 query 场景识别（与 content-plugin 保持一致）
// ============================================================================

/** Query 场景枚举 */
export const QueryScene = {
  /** 主动 Query：用户主动发起的对话（PC 端 / 外部渠道：微信、企微、钉钉、QQ、飞书等） */
  USER_QUERY: 'user_query',
  /** 定时任务：被动，对用户有感知 */
  SCHEDULED: 'scheduled',
  /** 心跳检测 */
  HEARTBEAT: 'heartbeat',
  /** 记忆（压缩/提取等） */
  MEMORY: 'memory',
  /** 插件（含子 Agent、记忆内部调用等） */
  PLUGIN: 'plugin',
  /** 未知/其他 */
  OTHERS: 'others',
} as const;

export type QuerySceneType = typeof QueryScene[keyof typeof QueryScene];

export interface QuerySceneContext {
  /** hookCtx.sessionKey，如 "agent:main:session-xxx"、"agent:corn:中文" 等 */
  sessionKey?: string;
  /** x-session-id header 值，如 "plg-mem-{xxx}"、"plg-ws-{xxx}"、"plg-lcm-{xxx}" 等 */
  sessionId?: string;
  /** resolveChannelId() 的结果 */
  channelId: string;
  /** hookCtx.trigger — OpenClaw agent runner 设置的触发来源（如 "heartbeat"、"user" 等） */
  trigger?: string;
  /** 链路追踪 ID（runId / roundTraceId），用于同一次 run 内的 query scene 缓存复用 */
  traceId?: string;
}

/** Memory 相关 sessionId 模式 */
const MEMORY_SESSION_ID_PATTERNS: RegExp[] = [
  /^plg-mem-.+$/,       // plg-mem-{xxx}
  /^plg-ws-.+$/,        // plg-ws-{xxx}
  /^plg-lcm-.+$/,       // plg-lcm-{xxx}
];

/**
 * 用户对话 sessionKey 模式（排除 cron/memory/subagent 后匹配）：
 *
 * 1. agent:main:* — main agent 下的所有会话（PC 端 + 外部渠道：微信、企微、钉钉等）
 * 2. agent:{agentId}:session-* — 任意 agent 的 PC 端新建会话
 * 3. agent:{agentId}:main — 任意 agent 的 PC 端主对话
 */
const USER_QUERY_PATTERN = /^agent:(?:main:.+|[^:]+:(?:session-.+|main))$/;

/**
 * traceId → QuerySceneType 缓存，同一次 run 内只需判定一次。
 * 上限 100 条，超过时删除最早插入的 key（FIFO）。
 */
const querySceneCache = new Map<string, QuerySceneType>();
const QUERY_SCENE_CACHE_MAX = 100;

/**
 * 综合判定当前 query 场景。
 * 优先级：HEARTBEAT > SCHEDULED > MEMORY > USER_QUERY > OTHERS
 *
 * 如果传入 traceId，会先查缓存；判定完成后将结果缓存以供同一 run 的后续 hook 复用。
 */
export function resolveQueryScene(ctx: QuerySceneContext): QuerySceneType {
  // ─── 缓存命中：同一 traceId 直接返回 ───
  if (ctx.traceId) {
    const cached = querySceneCache.get(ctx.traceId);
    if (cached !== undefined) {
      return cached;
    }
  }

  // ─── 正常判定逻辑 ───
  // 0. Heartbeat：trigger 由 OpenClaw agent runner 在 heartbeat 路径中设为 "heartbeat"
  if (ctx.trigger === 'heartbeat') {
    return cacheAndReturn(ctx.traceId, QueryScene.HEARTBEAT);
  }

  // 1. 定时任务：sessionKey 中包含 ":cron" 段（如 "agent:main:cron:..." 等格式）
  if (ctx.sessionKey && /(?:^|:)cron(?::|$)/.test(ctx.sessionKey)) {
    return cacheAndReturn(ctx.traceId, QueryScene.SCHEDULED);
  }

  // 2. Memory 场景判定：sessionId 格式
  if (ctx.sessionId) {
    for (const pattern of MEMORY_SESSION_ID_PATTERNS) {
      if (pattern.test(ctx.sessionId)) {
        return cacheAndReturn(ctx.traceId, QueryScene.MEMORY);
      }
    }
  }

  // 3. 用户对话：
  //    a) agent:main:* — main agent 下，排除内部会话后全部为用户对话（PC + 外部渠道）
  //    b) agent:{agentId}:session-* — 任意 agent 的 PC 端新建会话
  //    c) agent:{agentId}:main — 任意 agent 的 PC 端主对话
  if (ctx.sessionKey && USER_QUERY_PATTERN.test(ctx.sessionKey)) {
    return cacheAndReturn(ctx.traceId, QueryScene.USER_QUERY);
  }

  // 4. 兜底：未匹配到任何已知模式（不缓存，避免首次信息不全时锁定为 OTHERS）
  return QueryScene.OTHERS;
}

/** 将结果写入缓存（如果有 traceId），并返回结果 */
function cacheAndReturn(traceId: string | undefined, scene: QuerySceneType): QuerySceneType {
  if (traceId) {
    if (querySceneCache.size >= QUERY_SCENE_CACHE_MAX) {
      const firstKey = querySceneCache.keys().next().value;
      if (firstKey !== undefined) {
        querySceneCache.delete(firstKey);
      }
    }
    querySceneCache.set(traceId, scene);
  }
  return scene;
}

// isInternalPluginRequest 已移除（安全修复）。
// 该函数基于 prompt 前缀文本匹配跳过审核，可被用户伪造绕过。
// 场景判定已由 resolveQueryScene() 通过 sessionKey + x-session-id header 可靠完成。

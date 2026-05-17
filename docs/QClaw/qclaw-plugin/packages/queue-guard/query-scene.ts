/**
 * Query 场景识别工具（queue-guard package）
 *
 * 从 content-plugin/src/utils.ts 复制，用于 queue-guard package 内部判定 query 场景。
 */

// ============================================================================
// Query Scene — 精细化 query 场景识别
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
} as const

export type QuerySceneType = typeof QueryScene[keyof typeof QueryScene]

export interface QuerySceneContext {
  /** hookCtx.sessionKey，如 "agent:main:session-xxx"、"agent:corn:中文" 等 */
  sessionKey?: string
  /** x-session-id header 值，如 "plg-mem-{xxx}"、"plg-ws-{xxx}"、"plg-lcm-{xxx}" 等 */
  sessionId?: string
  /** resolveChannelId() 的结果 */
  channelId: string
  /** hookCtx.trigger — OpenClaw agent runner 设置的触发来源（如 "heartbeat"、"user" 等） */
  trigger?: string
}

/** Memory 相关 sessionId 模式 */
const MEMORY_SESSION_ID_PATTERNS: RegExp[] = [
  /^plg-mem-.+$/, // plg-mem-{xxx}
  /^plg-ws-.+$/, // plg-ws-{xxx}
  /^plg-lcm-.+$/, // plg-lcm-{xxx}
]

/**
 * 用户对话 sessionKey 模式（排除 cron/memory/subagent 后匹配）：
 *
 * 1. agent:main:* — main agent 下的所有会话（PC 端 + 外部渠道：微信、企微、钉钉等）
 * 2. agent:{agentId}:session-* — 任意 agent 的 PC 端新建会话
 * 3. agent:{agentId}:main — 任意 agent 的 PC 端主对话
 */
const USER_QUERY_PATTERN = /^agent:(?:main:.+|[^:]+:(?:session-.+|main))$/

/**
 * 综合判定当前 query 场景。
 * 优先级：HEARTBEAT > SCHEDULED > MEMORY > PLUGIN（内部会话排除） > USER_QUERY > OTHERS
 */
export function resolveQueryScene(ctx: QuerySceneContext): QuerySceneType {
  // 0. Heartbeat：trigger 由 OpenClaw agent runner 在 heartbeat 路径中设为 "heartbeat"
  if (ctx.trigger === 'heartbeat') {
    return QueryScene.HEARTBEAT
  }

  // 1. 定时任务：sessionKey 中包含 ":cron" 段（如 "agent:main:cron:..." 等格式）
  if (ctx.sessionKey && /(?:^|:)cron(?::|$)/.test(ctx.sessionKey)) {
    return QueryScene.SCHEDULED
  }

  // 2. Memory 场景判定：sessionId 格式
  if (ctx.sessionId) {
    for (const pattern of MEMORY_SESSION_ID_PATTERNS) {
      if (pattern.test(ctx.sessionId)) {
        return QueryScene.MEMORY
      }
    }
  }

  // 3. 用户对话：
  //    a) agent:main:* — main agent 下，排除内部会话后全部为用户对话（PC + 外部渠道）
  //    b) agent:{agentId}:session-* — 任意 agent 的 PC 端新建会话
  //    c) agent:{agentId}:main — 任意 agent 的 PC 端主对话
  if (ctx.sessionKey && USER_QUERY_PATTERN.test(ctx.sessionKey)) {
    return QueryScene.USER_QUERY
  }

  // 4. 兜底：未匹配到任何已知模式
  return QueryScene.OTHERS
}

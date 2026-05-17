/**
 * cron-delivery-guard — 定时任务投递守护 Package v3.2.0
 *
 * 通过 message_received / before_tool_call / after_tool_call 钩子实现四项功能：
 *
 * 1. 渠道默认投递目标自动记录（message_received）
 *    触发条件：外部渠道（非 webchat/last）收到消息
 *    作用：解析 channel / to，通过 bindings 反查 agentId，
 *    写入 {stateDir}/channel-defaults.json（以 agentId 为维度存储）。
 *
 * 2. channel/to 自动补全（before_tool_call）
 *    触发条件：cron 工具调用的 delivery 缺少 channel 或 to
 *    作用：从 hookCtx.sessionKey 解析外部渠道信息（channel、peerid 等），
 *    自动注入到 delivery 中，确保 LLM 忘传 channel/to 时仍能正确投递。
 *
 * 3. bestEffort 自动注入（before_tool_call）
 *    - mode=none → 强制改为 mode=announce + bestEffort=true（保留投递能力，允许失败静默降级）
 *    - mode=announce + channel 为空/webchat/last → 注入 bestEffort=true
 *    作用：投递失败时静默降级，不影响 cron 执行结果的保存。
 *
 * 4. cron add 后兜底写入 + 上报（after_tool_call）
 *    触发条件：cron add 调用完成
 *    - 失败时：上报创建失败埋点
 *    - 成功时：delivery 有外部渠道 + 有 to 时兜底写入 channel-defaults.json
 *
 * channel-defaults.json v2 格式（以 agentId 为 key，联动 openclaw.json bindings）：
 *   {
 *     "main": {
 *       "wecom": { "to": "T48250041A" }
 *     },
 *     "agent-sales": {
 *       "wecom": { "to": "T48250041A" }
 *     }
 *   }
 * 向后兼容：读取时如果检测到旧格式 Record<string, string>，自动迁移到 v2。
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { QClawPackage, QClawContext, HookHandlerResult } from '../../core/types.js'
import { REPORT_CONST } from '../../core/reporter-constants.js'

/** 主 agent 的 ID */
const MAIN_AGENT_ID = 'main'

/**
 * 本地渠道标识：不写 channel-defaults，cron 任务注入 bestEffort。
 */
const LOCAL_CHANNELS = new Set(['webchat', 'last', ''])

// ---- delivery 类型 ----

export interface CronDelivery {
  mode?: string
  channel?: string
  to?: string
  bestEffort?: boolean
  [key: string]: unknown
}

// ---- message_received 事件类型 ----

export interface MessageReceivedEvent {
  from?: string
  content?: unknown
  metadata?: {
    to?: string
    senderId?: string
    originatingTo?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface MessageReceivedContext {
  channelId?: string
  conversationId?: string
  [key: string]: unknown
}

// ---- 纯函数（已 export，可独立测试） ----

/**
 * 判断是否为 cron add 工具调用（仅拦截创建操作）
 */
export function isCronAdd(toolName: string, params: Record<string, unknown>): boolean {
  if (toolName !== 'cron') return false
  const action = params.action
  return action === 'add' || action === undefined // 兼容无 action 字段的旧格式
}

/**
 * 从 cron 参数中提取 delivery 配置
 * cron 工具的参数结构可能是:
 * - params.delivery (顶层)
 * - params.job.delivery (嵌套在 job 中)
 */
export function extractDelivery(params: Record<string, unknown>): CronDelivery | null {
  // 尝试顶层 delivery
  if (params.delivery && typeof params.delivery === 'object') {
    return params.delivery as CronDelivery
  }

  // 尝试 job.delivery
  const job = params.job as Record<string, unknown> | undefined
  if (job?.delivery && typeof job.delivery === 'object') {
    return job.delivery as CronDelivery
  }

  return null
}

/**
 * 判断 delivery 是否有外部渠道（非本地）
 */
export function hasExternalChannel(delivery: CronDelivery): boolean {
  const channel = delivery.channel ?? ''
  return !LOCAL_CHANNELS.has(channel)
}

// ---- sessionKey → channel/to 解析 ----

/**
 * sessionKey 中解析出的渠道投递信息
 */
export interface SessionChannelInfo {
  channel: string
  to: string
}

/**
 * 已知外部渠道标识（与 LOCAL_CHANNELS 互斥）
 */
const KNOWN_EXTERNAL_CHANNELS = new Set([
  'wechat-access',
  'openclaw-weixin',
  'wecom',
  'feishu',
  'dingtalk-connector',
  'qqbot',
  // 'yuanbao',
])

/**
 * 从 sessionKey 中解析外部渠道和投递目标。
 *
 * 支持三种格式：
 * 1. agent:main:openai-user:{"channel":"dingtalk-connector","peerid":"xxx",...}
 *    → channel=dingtalk-connector, to=peerid
 * 2. agent:main:dingtalk-connector:{"accountid":"xxx","peerid":"xxx",...}
 *    → channel=dingtalk-connector, to=peerid
 * 3. agent:main:wechat-access:direct:{userId}
 *    → channel=wechat-access, to=userId
 *
 * 返回 null 表示无法解析（本地 session 或格式不匹配）。
 */
export function parseSessionKeyChannel(sessionKey: string | undefined): SessionChannelInfo | null {
  if (!sessionKey) return null

  const parts = sessionKey.split(':')
  // 最少 3 段：agent:{agentId}:{thirdPart}...
  if (parts.length < 3) return null

  const thirdPart = parts[2] || ''

  // 尝试从 JSON 部分提取（格式 1 和格式 2）
  // JSON 从第一个 '{' 开始到末尾
  const jsonStart = sessionKey.indexOf('{')
  if (jsonStart !== -1) {
    try {
      const json = JSON.parse(sessionKey.slice(jsonStart)) as Record<string, unknown>
      const channel = (json.channel as string) || thirdPart
      if (!channel || !KNOWN_EXTERNAL_CHANNELS.has(channel)) return null

      // 优先级：peerid → to → senderid → from
      const to =
        (json.peerid as string) ||
        (json.peerId as string) ||
        (json.to as string) ||
        (json.senderid as string) ||
        (json.senderId as string) ||
        (json.from as string) ||
        ''

      if (!to) return null
      return { channel, to }
    } catch {
      // JSON 解析失败，继续后续逻辑
    }
  }

  // 格式 3：agent:main:wechat-access:direct:{userId}
  if (KNOWN_EXTERNAL_CHANNELS.has(thirdPart) && parts.length >= 5) {
    const to = parts.slice(4).join(':') // userId 部分可能包含冒号
    if (!to) return null
    return { channel: thirdPart, to }
  }

  return null
}

/**
 * 深拷贝 params，为缺失 channel/to 的 delivery 注入从 sessionKey 解析出的值。
 * 仅在 delivery.channel 或 delivery.to 缺失时注入，不覆盖 LLM 已传入的值。
 */
export function injectChannelAndTo(
  params: Record<string, unknown>,
  info: SessionChannelInfo,
): Record<string, unknown> {
  const newParams = JSON.parse(JSON.stringify(params)) as Record<string, unknown>

  // 顶层 delivery
  if (newParams.delivery && typeof newParams.delivery === 'object') {
    const d = newParams.delivery as CronDelivery
    if (!d.channel) d.channel = info.channel
    if (!d.to) d.to = info.to
    return newParams
  }

  // job.delivery
  const job = newParams.job as Record<string, unknown> | undefined
  if (job?.delivery && typeof job.delivery === 'object') {
    const d = job.delivery as CronDelivery
    if (!d.channel) d.channel = info.channel
    if (!d.to) d.to = info.to
    return newParams
  }

  return newParams
}

/**
 * 深拷贝 params 并注入 bestEffort: true
 */
export function injectBestEffort(params: Record<string, unknown>): Record<string, unknown> {
  const newParams = JSON.parse(JSON.stringify(params)) as Record<string, unknown>

  // 顶层 delivery
  if (newParams.delivery && typeof newParams.delivery === 'object') {
    ;(newParams.delivery as CronDelivery).bestEffort = true
    return newParams
  }

  // job.delivery
  const job = newParams.job as Record<string, unknown> | undefined
  if (job?.delivery && typeof job.delivery === 'object') {
    ;(job.delivery as CronDelivery).bestEffort = true
    return newParams
  }

  return newParams
}

/**
 * 深拷贝 params，将 mode 改为 announce 并注入 bestEffort: true。
 * 用于 mode=none 场景：AI 不想投递，但我们强制改为 announce+bestEffort，
 * 使定时任务保留投递能力同时允许失败静默降级。
 */
export function injectAnnounceWithBestEffort(params: Record<string, unknown>): Record<string, unknown> {
  const newParams = JSON.parse(JSON.stringify(params)) as Record<string, unknown>

  // 顶层 delivery
  if (newParams.delivery && typeof newParams.delivery === 'object') {
    ;(newParams.delivery as CronDelivery).mode = 'announce'
    ;(newParams.delivery as CronDelivery).bestEffort = true
    return newParams
  }

  // job.delivery
  const job = newParams.job as Record<string, unknown> | undefined
  if (job?.delivery && typeof job.delivery === 'object') {
    ;(job.delivery as CronDelivery).mode = 'announce'
    ;(job.delivery as CronDelivery).bestEffort = true
    return newParams
  }

  return newParams
}

// ---- bindings 反查 agentId ----

/**
 * binding 条目（来自 openclaw.json 的 bindings 配置）
 * 仅声明插件实际使用的字段，避免引入完整类型依赖。
 */
interface BindingEntry {
  agentId?: string
  match?: {
    channel?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

/**
 * 从 OpenClaw 配置的 bindings 中反查 agentId。
 *
 * message_received 钩子的 hookCtx（PluginHookMessageContext）不携带 agentId，
 * 因此需要利用 config.bindings 的 channel 匹配来确定消息归属的 agent。
 *
 * 匹配策略：
 * 1. 匹配 channel 吻合的第一个 binding 条目
 * 2. 未命中时返回 undefined，调用方降级到 MAIN_AGENT_ID
 */
export function resolveAgentIdFromBindings(
  config: Record<string, unknown>,
  channel: string,
): string | undefined {
  const bindings = config.bindings as BindingEntry[] | undefined
  if (!Array.isArray(bindings) || bindings.length === 0) return undefined

  for (const b of bindings) {
    const m = b.match
    if (!m || m.channel !== channel) continue
    return b.agentId || undefined
  }

  return undefined
}

// ---- channel-defaults v2 类型 ----

/** v2 单条渠道默认投递目标 */
export interface ChannelDefaultEntry {
  to: string
}

/**
 * v2 格式：以 agentId 为 key，每个 agent 下按 channel 存储 { to }
 *   { "main": { "wecom": { "to": "xxx" } } }
 *
 * v1 旧格式：扁平 Record<string, string>
 *   { "wecom": "xxx" }
 */
export type ChannelDefaultsV2 = Record<string, Record<string, ChannelDefaultEntry>>
type ChannelDefaultsV1 = Record<string, string>

/**
 * 检测是否为 v1 旧格式（扁平 Record<string, string>）。
 * v1 的值是纯字符串，v2 的值是对象。
 */
function isV1Format(data: unknown): data is ChannelDefaultsV1 {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  const values = Object.values(data as Record<string, unknown>)
  if (values.length === 0) return false
  // v1: 所有 value 都是 string；v2: value 是 object
  return values.every((v) => typeof v === 'string')
}

/**
 * 将 v1 旧格式迁移为 v2 格式，所有条目归入 "main" agent。
 */
function migrateV1ToV2(v1: ChannelDefaultsV1): ChannelDefaultsV2 {
  const v2: ChannelDefaultsV2 = {}
  const mainDefaults: Record<string, ChannelDefaultEntry> = {}
  for (const [channel, to] of Object.entries(v1)) {
    mainDefaults[channel] = { to }
  }
  if (Object.keys(mainDefaults).length > 0) {
    v2[MAIN_AGENT_ID] = mainDefaults
  }
  return v2
}

/**
 * 将 agentId → channel → { to } 映射写入 {stateDir}/channel-defaults.json。
 * 不碰 openclaw.json，避免触发热重载。
 * 若已存在且值相同则跳过，不重复写入。
 *
 * v2 格式支持以 agentId 为维度区分不同 agent 的渠道投递目标，
 * 与 openclaw.json 的 bindings 配置联动。
 */
export function persistChannelDefault(
  stateDir: string,
  channel: string,
  to: string,
  agentId?: string,
): void {
  // stateDir 为空时 fallback 到 ~/.qclaw
  const resolvedDir = stateDir || path.join(os.homedir(), '.qclaw')
  const filePath = path.join(resolvedDir, 'channel-defaults.json')
  const effectiveAgentId = agentId || MAIN_AGENT_ID
  try {
    let defaults: ChannelDefaultsV2 = {}
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown
      if (isV1Format(raw)) {
        // 自动迁移旧格式
        defaults = migrateV1ToV2(raw)
      } else {
        defaults = (raw as ChannelDefaultsV2) || {}
      }
    }

    const agentDefaults = defaults[effectiveAgentId] || {}
    const existing = agentDefaults[channel]

    // 比较是否相同，相同则跳过
    if (existing && existing.to === to) {
      return
    }

    agentDefaults[channel] = { to }
    defaults[effectiveAgentId] = agentDefaults
    fs.writeFileSync(filePath, JSON.stringify(defaults, null, 2), 'utf-8')
  } catch {
    // best-effort，写入失败不影响主流程
  }
}

/**
 * 从 metadata.to / from 字段提取纯 to 值，去掉 "{channel}:" 前缀。
 * 例如：
 *   channel=wecom, metadata.to="wecom:T48250041A"  → "T48250041A"
 *   channel=wecom, from="wecom:T48250041A"          → "T48250041A"
 *   channel=feishu, metadata.to="user:ou_x"         → "user:ou_x"
 *
 * 注意：wecom 等插件在构建消息上下文时设置 To: "${CHANNEL_ID}:${chatId}"，
 * 框架透传到 metadata.to，因此 metadata.to 和 from 都需要去除 channel 前缀。
 */
export function extractTo(
  channel: string,
  metadataTo: string | undefined,
  from: string | undefined,
): string {
  const prefix = `${channel}:`
  if (metadataTo) {
    return metadataTo.startsWith(prefix) ? metadataTo.slice(prefix.length) : metadataTo
  }
  if (!from) return ''
  return from.startsWith(prefix) ? from.slice(prefix.length) : from
}

// ---- Package 定义 ----

const cronDeliveryGuard: QClawPackage = {
  id: 'cron-delivery-guard',
  name: 'Cron 投递降级守卫',
  description:
    'message_received 记录外部渠道 channel-defaults; before_tool_call mode=none 强转 announce+bestEffort / 本地渠道注入 bestEffort; after_tool_call 兜底写入 + 失败上报',

  configSchema: {
    type: 'object',
    additionalProperties: false as const,
    properties: {},
  },

  setup(ctx: QClawContext): void {
    ctx.logger.info('setup')

    // ---- message_received: 记录外部渠道默认投递目标 ----
    ctx.onHook(
      'message_received' as Parameters<typeof ctx.onHook>[0],
      async (event, hookCtx): Promise<HookHandlerResult | undefined> => {
        const msgEvent = event as MessageReceivedEvent
        const msgCtx = hookCtx as unknown as MessageReceivedContext

        const channel = msgCtx.channelId ?? ''
        if (LOCAL_CHANNELS.has(channel)) return undefined

        const to = extractTo(
          channel,
          msgEvent.metadata?.to as string | undefined,
          msgEvent.from as string | undefined,
        )
        if (!to) {
          ctx.logger.info('message_received: no "to" resolved, skip.')
          return undefined
        }

        // hookCtx 不携带 agentId，通过 api.runtime.config.loadConfig() 读取 bindings 反查。
        // 注意：ctx.runtime.config 始终为 {}（框架未实现 getConfig()），必须走 loadConfig()。
        const runtimeConfig = ctx.api.runtime as Record<string, unknown>
        const configAccessor = runtimeConfig.config as { loadConfig?: () => Record<string, unknown> } | undefined
        const liveConfig: Record<string, unknown> = configAccessor?.loadConfig?.() ?? {}
        const agentId = resolveAgentIdFromBindings(liveConfig, channel)

        persistChannelDefault(ctx.runtime.stateDir, channel, to, agentId)
        ctx.logger.info(
          `message_received: persisted channel=${channel} to=${to} agentId=${agentId ?? MAIN_AGENT_ID}`,
        )
        return undefined
      },
    )

    // ---- before_tool_call: channel/to 自动注入 + mode=none 强转 + bestEffort 注入 ----
    ctx.onHook(
      'before_tool_call',
      async (event, hookCtx): Promise<HookHandlerResult | undefined> => {
        const toolName = event.toolName as string
        let params = event.params as Record<string, unknown>
        const toolCallId = event.toolCallId as string

        if (toolName !== 'cron') return undefined

        const delivery = extractDelivery(params)
        if (!delivery) {
          ctx.logger.info(`cron call (${toolCallId}) has no delivery, skip.`)
          return undefined
        }

        let modified = false

        // ---- 第 0 步：从 sessionKey 自动补全缺失的 channel/to ----
        // LLM 经常忘记传 channel/to（钉钉等通过 OpenAI-compatible API 接入的渠道尤其常见），
        // 通过解析 hookCtx.sessionKey 中的渠道信息进行防御性补全。
        if (!delivery.channel || !delivery.to) {
          const sessionInfo = parseSessionKeyChannel(hookCtx.sessionKey as string | undefined)
          if (sessionInfo) {
            params = injectChannelAndTo(params, sessionInfo)
            const injectedParts: string[] = []
            if (!delivery.channel) injectedParts.push(`channel=${sessionInfo.channel}`)
            if (!delivery.to) injectedParts.push(`to=${sessionInfo.to}`)
            ctx.logger.info(
              `cron call (${toolCallId}) auto-injected from sessionKey: ${injectedParts.join(', ')}`,
            )
            modified = true
          }
        }

        // 重新提取 delivery（params 可能已被深拷贝替换）
        const currentDelivery = modified ? extractDelivery(params) ?? delivery : delivery
        const mode = currentDelivery.mode ?? ''
        const channel = currentDelivery.channel ?? ''

        // ---- 第 1 步：mode=none → 强制改为 announce + bestEffort ----
        if (mode === 'none') {
          const newParams = injectAnnounceWithBestEffort(params)
          ctx.logger.info(`cron call (${toolCallId}) mode=none → announce+bestEffort`)
          return { params: newParams }
        }

        // ---- 第 2 步：mode=announce + 本地渠道 → 注入 bestEffort ----
        if (mode === 'announce' && !currentDelivery.bestEffort && LOCAL_CHANNELS.has(channel)) {
          const newParams = injectBestEffort(params)
          ctx.logger.info(`cron call (${toolCallId}) injected bestEffort=true (channel=${channel})`)
          return { params: newParams }
        }

        // 如果只有 channel/to 被注入（step 0 修改了 params），也需要返回修改后的 params
        if (modified) {
          ctx.logger.info(
            `cron call (${toolCallId}) returning channel/to injected params (mode=${mode}, channel=${channel})`,
          )
          return { params }
        }

        ctx.logger.info(
          `cron call (${toolCallId}) no injection needed (mode=${mode}, channel=${channel}, bestEffort=${String(currentDelivery.bestEffort)})`,
        )
        return undefined
      },
      { priority: 400 },
    )

    // ---- after_tool_call: cron add 成功后写入 channel-defaults ----
    ctx.onHook(
      'after_tool_call',
      async (event, hookCtx): Promise<HookHandlerResult | undefined> => {
        const toolName = event.toolName as string
        const params = event.params as Record<string, unknown>
        const toolCallId = event.toolCallId as string

        if (!isCronAdd(toolName, params)) {
          return undefined
        }

        // 工具调用失败时：上报创建失败埋点（成功由前端 WS added 事件 reportAll 上报）
        if (event.isError) {
          const delivery = extractDelivery(params)
          ctx.reporter.report(REPORT_CONST.PLUGIN, {
            module_id: 'task_creation',
            component_id: 'task_creation',
            event_code: 'e_abc122eb_mc',
            action_type: 'click',
            action_status: 'fail',
            statistics: {
              agent_id: hookCtx.agentId ?? '',
              session_key: hookCtx.sessionKey ?? '',
              channel: delivery?.channel || '',
              mode: delivery?.mode || 'none',
              to: delivery?.to || '',
              best_effort: String(delivery?.bestEffort ?? false),
              fail_reason: String(event.result ?? '').slice(0, 200),
            },
          })
          ctx.logger.info(`after_tool_call: cron add (${toolCallId}) FAILED, reported`)
          return undefined
        }

        const delivery = extractDelivery(params)
        if (!delivery || !hasExternalChannel(delivery) || !delivery.to) {
          return undefined
        }

        const channel = delivery.channel as string
        const to = delivery.to as string
        const agentId = hookCtx.agentId ?? MAIN_AGENT_ID

        persistChannelDefault(ctx.runtime.stateDir, channel, to, agentId)
        ctx.logger.info(
          `after_tool_call: cron add (${toolCallId}) persisted agentId=${agentId} channel=${channel} to=${to}`,
        )

        return undefined
      },
      { priority: 400 },
    )
  },
}

export default cronDeliveryGuard

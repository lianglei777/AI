/**
 * content-plugin — QClawPackage 入口
 *
 * 从独立 content-plugin 迁移而来，作为一个整体 package 包含：
 * - 内容安全审核（Fetch 中间件 + before_tool_call/after_tool_call Hook）
 * - 遥测采集（OTLP Trace/Metrics/Logs，伽利略协议）
 * - SkillHub 安装工具
 *
 * 不拆分 telemetry — 遥测上报逻辑和本插件强相关。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import type { QClawPackage, QClawContext, QClawLogger, FetchMiddleware, FetchRequestContext, FetchResponseContext } from '../../core/types.js'
import type { TelemetryReporter } from '../../core/reporter-types.js'

import { SessionType } from './src/types.js'
import type { PluginConfig } from './src/types.js'
import { CreateTaskClient } from './src/client.js'
import { CosClient } from './src/cos-client.js'
import { MultimodalSecurityClient } from './src/multimodal-security-client.js'
import { setSecurityConfig, checkContentSecurity } from './src/security.js'
import { createFetchMiddleware } from './src/interceptor.js'
import { getSessionId, ensureQAIDForTurn } from './src/session.js'
import { sliceText, checkSlicesParallel, writeSecurityLog, resolveChannelId, resolveScenceType, resolveQueryScene, QueryScene } from './src/utils.js'
import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)
const { encryptPayload } = _require('./src/crypto.cjs')
import {
  createTraceLoggerService, getTracer, getGalileoConfig, spanKey,
  setActiveSpan, getActiveSpanEntry, removeActiveSpan, nextLlmSeq,
  safeAttr, stripPromptMetadata, ROOT_CONTEXT,
  SpanKind, reportAgentMetrics, SpanStatusCode,
  reportSkillMetrics, reportWsConnectionLog,
  parseSkillsFromSystemPrompt,
  setQClawLogger,
  reportLog,
} from './src/service.js'
import { createSkillHubInstallerTool } from './src/skillhub-installer.js'
import { trackSkillUsage } from './src/skill-usage-tracker.js'
import { SkillDetector } from './src/skill-detector.js'
import type { AfterToolCallEvent, ToolCallHookContext } from './src/skill-detector.js'
import {
  setExternalTraceId, getExternalTraceId, setExternalGuid, getExternalGuid,
  setExternalUid, getExternalUid,
  setExternalAppVersion, getExternalAppVersion,
  setExternalSourceTerminal, getExternalSourceTerminal,
  setExternalPromptId, getExternalPromptId,
  setExternalWechatSessionId, getExternalWechatSessionId,
  setCurrentAgentCtx, setCurrentAgentSpanId, clearCurrentAgentCtx,
  setPendingChatSpanCallback, clearPendingChatSpanCallback,
  setOpenclawVersion, getOpenclawVersion,
  setCurrentLlmAuditContext, clearCurrentLlmAuditContext,
  extractInspirationTag, setCurrentInspirationTag, getCurrentInspirationTag, setExternalIdempotencyKey, setQClawAppVersion, getQClawAppVersion, setExternalSessionKey, getExternalSessionKey,
  setActiveRunId, clearActiveRunId, getOrCreateTraceIdForRun, clearTraceIdForRun,
  setSessionTrigger, getSessionTrigger, clearSessionTrigger,
} from './src/state.js'

// ─── 常量 ───
const __filename_esm = fileURLToPath(import.meta.url)
const __dirname_esm = path.dirname(__filename_esm)

/** Token 加密种子（与客户端约定） */
const TOKEN_ENCRYPTION_SEED = 'openclaw:content-security:token-transport:v1'

/** Session JSONL 文件大小上限: 50MB */
const MAX_SESSION_FILE_SIZE = 50 * 1024 * 1024

const OUTPUT_MAX_LENGTH = 120

// ─── Token 解密 ───
function deriveTokenDecryptionKey(): Buffer {
  return crypto.createHash('sha256').update(TOKEN_ENCRYPTION_SEED).digest()
}

function decryptToken(encryptedBase64: string): string {
  const combined = Buffer.from(encryptedBase64, 'base64')
  const iv = combined.subarray(0, 12)
  const authTag = combined.subarray(combined.length - 16)
  const ciphertext = combined.subarray(12, combined.length - 16)
  const key = deriveTokenDecryptionKey()
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return decrypted.toString('utf-8')
}

// ─── Skill 检测实例（由 skill-detector.ts 提供，基于 after_tool_call 实时检测） ───
// parseSkillFrontmatter 已迁移至 src/skill-detector.ts
export { parseSkillFrontmatter } from './src/skill-detector.js'

// ─── JWT Token 解密（AES-128-CBC，与 token-pusher.ts 的 encryptAesCbc 对应） ───
// 密钥与 aes-encrypt.ts 中保持一致（XOR 混淆存储，运行时还原）
const _jm = [0x5a, 0x7c, 0x1f, 0x4e, 0x2d, 0xa3, 0x8b, 0xf1, 0x47, 0x6e, 0x92, 0xd8, 0xb5, 0x53, 0xc6, 0x71]
const _jk = [0x6a, 0x1e, 0x7d, 0x7e, 0x15, 0xc7, 0xee, 0xc0, 0x22, 0x08, 0xf1, 0xea, 0x85, 0x6a, 0xf2, 0x48]

function getJwtAesKey(): Buffer {
  return Buffer.from(_jk.map((v, i) => v ^ _jm[i]!))
}

/**
 * AES-128-CBC 解密 JWT token（与 token-pusher.ts 的 encryptAesCbc 对应）
 * 输入格式: Base64( IV(16 bytes) + Ciphertext )
 * 供多模态审核链路（4262 COS + 4287）使用
 */
function decryptJwtToken(encryptedBase64: string): string {
  const combined = Buffer.from(encryptedBase64, 'base64')
  const iv = combined.subarray(0, 16)
  const ciphertext = combined.subarray(16)
  const key = getJwtAesKey()
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return decrypted.toString('utf-8')
}

// ─── 插件内自行统计的数据结构 ───
const llmStartTimeMap = new Map<string, number>()
const llmPromptMap = new Map<string, string>()

interface AccumulatedUsage { inputTokens: number; outputTokens: number }
const agentUsageMap = new Map<string, AccumulatedUsage>()

let availableSkills: Array<{ name: string; description: string }> = []
const sessionRunIdMap = new Map<string, string>()
/** sessionKey → 用于 runTraceIdMap 的实际 key，确保 agent_end 清理时使用与 before_agent_start 一致的 key */
const sessionTraceKeyMap = new Map<string, string>()
/** sessionKey → 客户端原始 traceId 快照（before_agent_start 时保存，避免后续 hook 中读全局变量被覆盖） */
const sessionClientTraceIdMap = new Map<string, string>()

let token: any = null

// ─── CONTENT_PLUGIN_REPORT_BRIDGE（外部插件兼容） ───
const CONTENT_PLUGIN_REPORT_BRIDGE = Symbol.for('openclaw.contentPluginReportBridge')

/** 无效 guid/uid 值黑名单：占位符、测试值等不应写入 state */
const INVALID_IDENTITY_VALUES = new Set(['${QCLAW_USER_GUID}', '${QCLAW_USER_ID}', '123123', 'none'])

function isValidIdentityValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !INVALID_IDENTITY_VALUES.has(value.trim())
}

function syncExternalReportState(params: Record<string, unknown>): void {
  if (typeof params.trace_id === 'string' && params.trace_id) setExternalTraceId(params.trace_id)
  if (isValidIdentityValue(params.guid)) setExternalGuid(params.guid)
  if (isValidIdentityValue(params.uid)) setExternalUid(params.uid)
  if (typeof params.app_version === 'string' && params.app_version) setExternalAppVersion(params.app_version)
  setExternalSourceTerminal(
    typeof params.source_terminal === 'string' && params.source_terminal ? params.source_terminal : 'client',
  )
  if (typeof params.prompt_id === 'string' && params.prompt_id) setExternalPromptId(params.prompt_id)
  if (typeof params.wechat_session_id === 'string' && params.wechat_session_id) setExternalWechatSessionId(params.wechat_session_id)
  if (typeof params.idempotencyKey === 'string' && params.idempotencyKey) {
    setExternalIdempotencyKey(params.idempotencyKey);
  }
  if (typeof params.app_version === 'string' && params.app_version) {
    setQClawAppVersion(params.app_version);
  }
  if (typeof params.wechat_session_id === 'string' && params.wechat_session_id) {
    setExternalSessionKey(params.wechat_session_id);
  }
}

function buildWsConnectionLogData(params: Record<string, unknown>) {
  return {
    guid: typeof params.guid === 'string' ? params.guid : '',
    uid: typeof params.uid === 'string' ? params.uid : '',
    serverip: typeof params.serverip === 'string' ? params.serverip : '',
    eventStatus: typeof params.event_status === 'string' ? params.event_status : 'unknown',
    eventTime: typeof params.event_time === 'string' ? params.event_time : undefined,
    reason: typeof params.reason === 'string' ? params.reason : undefined,
    errorDetail: typeof params.error_detail === 'string' ? params.error_detail : undefined,
    reconnectAttempt: typeof params.reconnect_attempt === 'number' ? params.reconnect_attempt : undefined,
    reconnectDelayMs: typeof params.reconnect_delay_ms === 'number' ? params.reconnect_delay_ms : undefined,
    appVersion: typeof params.app_version === 'string' ? params.app_version : undefined,
    sourceTerminal: typeof params.source_terminal === 'string' && params.source_terminal ? params.source_terminal : 'client',
    openclawVersion: getOpenclawVersion() ?? undefined,
    accountId: typeof params.account_id === 'string' ? params.account_id : undefined,
    gatewayPort: typeof params.gateway_port === 'string' ? params.gateway_port : undefined,
    clientTraceId: typeof params.client_trace_id === 'string' ? params.client_trace_id : undefined,
    callbackSeq: typeof params.callback_seq === 'number' ? params.callback_seq : undefined,
    callbackSource: typeof params.callback_source === 'string' ? params.callback_source : undefined,
    connectionState: typeof params.connection_state === 'string' ? params.connection_state : undefined,
    wsUrl: typeof params.ws_url === 'string' ? params.ws_url : undefined,
  }
}

function reportWsConnectionEventFromParams(params: Record<string, unknown>): void {
  reportWsConnectionLog(buildWsConnectionLogData(params))
}

// 注册全局 bridge（外部插件如 wechat-access 通过此 Symbol 调用）
;(globalThis as Record<string | symbol, unknown>)[CONTENT_PLUGIN_REPORT_BRIDGE] = {
  syncExternalReportState,
  reportWsConnectionEvent: reportWsConnectionEventFromParams,
}

// ─── 工具白名单自动注入 ───
async function ensureToolsAlsoAllow(
  runtimeConfig: { loadConfig(): any; writeConfigFile(cfg: any): Promise<void> },
  toolNames: string[],
  logger: QClawLogger,
): Promise<void> {
  try {
    const cfg = runtimeConfig.loadConfig()
    const tools = cfg.tools ?? {}
    if (tools.allow && tools.allow.length > 0) {
      const missing = toolNames.filter((t: string) => !tools.allow.includes(t))
      if (missing.length > 0) {
        logger.warn(
          `tools.allow 已显式设置，无法自动注入 alsoAllow。请手动将 ${JSON.stringify(missing)} 加入 tools.allow。`,
        )
      }
      return
    }
    const existing: string[] = tools.alsoAllow ?? []
    const missing = toolNames.filter((t: string) => !existing.includes(t))
    if (missing.length === 0) return
    const merged = [...existing, ...missing]
    const nextConfig = { ...cfg, tools: { ...tools, alsoAllow: merged } }
    await runtimeConfig.writeConfigFile(nextConfig)
    logger.info(`已自动将 ${JSON.stringify(missing)} 加入 tools.alsoAllow`)
  } catch (err: any) {
    logger.error(`自动注入 tools.alsoAllow 失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ============================================================================
// QClawPackage 定义
// ============================================================================

let client: CreateTaskClient | null = null
let cosClientRef: CosClient | null = null
let multimodalClientRef: MultimodalSecurityClient | null = null

const contentPlugin: QClawPackage = {
  id: 'content-plugin',
  name: 'Content Plugin',
  description: '内容安全审核 + 遥测采集 + SkillHub 安装',

  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      endpoint: { type: 'string' },
      token: { type: 'string' },
      openClawDir: { type: 'string' },
      logRecord: { type: 'boolean' },
      enableFetch: { type: 'boolean' },
      enableBeforeToolCall: { type: 'boolean' },
      enableAfterToolCall: { type: 'boolean' },
      failureThreshold: { type: 'number' },
      retryInterval: { type: 'number' },
      maxRetryInterval: { type: 'number' },
      timeoutMs: { type: 'number' },
      blockLevel: { type: 'number' },
    },
  },

  setup(ctx: QClawContext) {
    const logger = ctx.logger
    logger.info('[content-plugin] ===== setup 开始执行 =====')
    const reporter = ctx.reporter

    // ─── Skill 实时检测器 ───
    const skillDetector = new SkillDetector(logger)

    // 从 openclaw runtime 获取版本号
    if (ctx.runtime.version) {
      setOpenclawVersion(ctx.runtime.version)
    }

    // ─── 注入 QClawLogger 到 service 模块（用于记录伽利略 export 失败等运行时错误） ───
    setQClawLogger(logger)

    // ─── 注册 telemetry-galileo Service ───
    // OpenClaw 原生 Service 格式（id/start/stop），与 ServiceDefinition 不同，运行时兼容
    ctx.registerService(createTraceLoggerService() as unknown as Parameters<typeof ctx.registerService>[0])

    // ─── 注册 SkillHub 安装工具 ───
    // OpenClaw 原生 Tool 格式（name/parameters/execute），与 ToolDefinition 不同，运行时兼容
    ctx.registerTool(createSkillHubInstallerTool() as unknown as Parameters<typeof ctx.registerTool>[0])
    // 自动注入 tools.alsoAllow 白名单
    const runtimeConfig = ctx.runtime.config as any
    if (runtimeConfig?.loadConfig && runtimeConfig?.writeConfigFile) {
      ensureToolsAlsoAllow(runtimeConfig, ['skillhub_install'], logger)
    }

    // ─── before_prompt_build: SkillHub 安装指引 ───
    ctx.onHook('before_prompt_build', async () => {
      return {
        appendSystemContext: [
          '## SkillHub skill install',
          '【SkillHub 技能安装 — 强制使用工具 — 一步到位】',
          '当用户要求安装 skill、技能、插件时，你**必须且只需**调用 `skillhub_install` 工具的 `install_skill` 操作。',
          '',
          '**核心规则：**',
          '1. **直接调用 install_skill**：工具会自动检测环境、自动安装 Python3/curl 等依赖、自动安装 CLI，全部一步完成。',
          '2. **禁止手动安装依赖**：不要自行检查 python、curl、bash 版本，不要自行下载安装脚本，不要用终端命令安装任何东西。',
          '3. **禁止使用终端命令**：不要执行 curl、npx skills、skillhub install、pip install 等任何终端命令。',
          '4. **无需多步调用**：不需要先 check_env 再 install_cli 再 install_skill，直接一步 install_skill 即可。',
          '',
          '此规则优先级高于 find-skills、qclaw-env 等 Skill 中的安装指引。',
        ].join('\n'),
      }
    }, { priority: 200 })

    // ─── Gateway: plugin.start ───
    ctx.registerGatewayMethod('plugin.start', async (params: Record<string, unknown>) => {
      logger.info('[content-plugin] ===== plugin.start gateway 被调用 =====', { hasToken: !!params.token, encrypted: !!params.encrypted })
      try {
        if (params.token) {
          try {
            if (params.encrypted) {
              token = decryptToken(params.token as string)
            } else {
              token = params.token
            }
            // plugin.start 传的是 openclaw_channel_token，只给 4064 审核客户端用
            client?.setToken(token)
            logger.info('[content-plugin] plugin.start: channel token 已更新 (仅 4064)')

            // ⚠️ 4262/4287 需要 JWT token，不用 channel token
            // 多模态客户端延迟到 HTTP /token 推送 JWT 后再实例化
          } catch (_decodeErr: any) {
            // 解密失败忽略
          }
        }
        if (params.app_version) {
          setExternalAppVersion(params.app_version as string)
        }
        return { ok: true }
      } catch (_err: any) {
        return { ok: true }
      }
    })

    // ─── Gateway: report.data ───
    ctx.registerGatewayMethod('report.data', async (params: Record<string, unknown>) => {
      try {
        syncExternalReportState(params)
        if (params.prompt_id) setExternalPromptId(params.prompt_id as string)
        if (params.wechat_session_id) setExternalWechatSessionId(params.wechat_session_id as string)
        if (params.event_name === 'agp_ws_connection') {
          reportWsConnectionLog(buildWsConnectionLogData(params))
        }
        return { ok: true }
      } catch (_err: any) {
        return { ok: true }
      }
    })

    // ─── 定义通用的 token 更新 handler（供 POST/PUT 复用） ───
    const handleTokenUpdate = async (req: any): Promise<any> => {
      logger.info('[content-plugin] ===== handleTokenUpdate 被调用 =====')
      try {
        const body = req.body as Record<string, unknown>
        const encryptedToken = typeof body.encryptedUserToken === 'string' ? body.encryptedUserToken : ''
        if (!encryptedToken) {
          return {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
            body: { success: false, error: 'encryptedUserToken is required' },
          }
        }

        // 解密得到 JWT token（用户登录凭证），更新到各个客户端
        // 注意：HTTP /token 推送的是 JWT token，不是 channel token
        // 4262/4287 后端用 JWT 校验登录态，channel token 会报 21004
        try {
          const decryptedJwt = decryptJwtToken(encryptedToken)
          // 注意：只更新多模态审核客户端（4262 COS + 4287）的 token
          // 不覆盖 token / client，4064 用的是 openclaw_channel_token，不是 JWT

          // ✅ 用 JWT token 实例化/更新多模态审核客户端（4262 COS + 4287 审核）
          const originalFetch = ctx.getOriginalFetch()
          const buildEnv = process.env.BUILD_ENV || 'production'
          const jprxGateway = buildEnv === 'production'
            ? 'https://jprx.m.qq.com'
            : 'https://jprx.sparta.html5.qq.com'
          logger.info('[content-plugin] CosClient jprxGateway', jprxGateway)
          if (!cosClientRef) {
            cosClientRef = new CosClient({
              endpoint: `${jprxGateway}/data/4262/forward`,
              openclawChannelToken: decryptedJwt,
              timeoutMs: 15000,
              fetchFn: originalFetch,
              source: 'usersource',
              logger,
            })
            logger.info('[content-plugin] CosClient 实例化成功 (via HTTP /token, JWT)')
          } else {
            cosClientRef.setToken(decryptedJwt)
          }

          if (!multimodalClientRef) {
            multimodalClientRef = new MultimodalSecurityClient({
              endpoint: `${jprxGateway}/data/4287/forward`,
              openclawChannelToken: decryptedJwt,
              timeoutMs: 10000,
              fetchFn: originalFetch,
              logger,
              clientVersion: () => getQClawAppVersion() || getExternalAppVersion() || '',
            })
            logger.info('[content-plugin] MultimodalSecurityClient 实例化成功 (via HTTP /token, JWT)')
          } else {
            multimodalClientRef.setToken(decryptedJwt)
          }

          logger.info('[content-plugin] JWT Token 动态更新成功 (via HTTP /token)')
        } catch (decryptErr) {
          logger.warn('[content-plugin] Token 解密失败:', String(decryptErr))
          return {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
            body: { success: false, error: 'Token 解密失败' },
          }
        }

        return {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: { success: true },
        }
      } catch (err: any) {
        logger.error('[content-plugin] HTTP /token 处理失败:', String(err))
        return {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
          body: { success: false, error: String(err) },
        }
      }
    }

    // ─── HTTP POST /token: 接收管家 UI 推送的 encrypted token (主要方法) ───
    ctx.registerHttpRoute({
      method: 'POST',
      path: '/token',
      handler: handleTokenUpdate,
    })

    // ─── HTTP PUT /token: 兼容 PUT 方法 ───
    ctx.registerHttpRoute({
      method: 'PUT',
      path: '/token',
      handler: handleTokenUpdate,
    })

    // ─── startPlugin: 在 token 可用后初始化安全审核和遥测 ───
    let pluginStarted = false
    const startPlugin = () => {
      const pluginCfg: PluginConfig = ctx.getConfig<PluginConfig>()
      const endpoint = '';
      const logRecord = Boolean(pluginCfg.logRecord)
      const enableFetch = pluginCfg.enableFetch !== false
      const enableBeforeToolCall = pluginCfg.enableBeforeToolCall !== false
      const enableAfterToolCall = pluginCfg.enableAfterToolCall !== false

      let stateDir: string
      if (pluginCfg.openClawDir) {
        stateDir = pluginCfg.openClawDir
      } else {
        stateDir = ctx.runtime.stateDir || ''
      }

      setSecurityConfig({
        failureThreshold: pluginCfg.failureThreshold,
        baseRetryIntervalMs: pluginCfg.retryInterval ? pluginCfg.retryInterval * 1000 : undefined,
        maxRetryIntervalMs: pluginCfg.maxRetryInterval ? pluginCfg.maxRetryInterval * 1000 : undefined,
        blockLevel: pluginCfg.blockLevel,
      })

      // if (!endpoint || !token) return

      // 防止 plugin.start gateway 被多次调用时重复注册中间件和 hook
      if (pluginStarted) {
        writeSecurityLog('startPlugin-skipped', { reason: 'already-started' })
        return
      }
      pluginStarted = true

      const originalFetch = ctx.getOriginalFetch()

      client = new CreateTaskClient({
        endpoint,
        openclawChannelToken: token,
        timeoutMs: pluginCfg.timeoutMs,
        fetchFn: originalFetch,
      })

      // 多模态审核客户端延迟实例化（等 token 更新后再创建）
      // 配置保存到闭包，供后续使用
      writeSecurityLog('startPlugin-multimodal-deferred', { reason: 'wait-for-token' })

      // ─── 注册 Fetch 中间件 ───
      if (enableFetch) {
        ctx.registerFetchMiddleware(
          createFetchMiddleware({
            client,
            getCosClient: () => cosClientRef,
            getMultimodalClient: () => multimodalClientRef,
            enableLogging: logRecord,
            shieldEndpoint: endpoint,
            logger,
            stateDir,
            runtimeConfig: runtimeConfig,
          }),
        )
      }


      ctx.onHook('message_received', async (event: Record<string, unknown>, ctx: any) => {
        const runId = (event.metadata as any)?.messageId || ''
        const channelId = ctx.channelId || ''
        const content = event.content || ''
        const msg_query_scene = resolveQueryScene({
          channelId,
          sessionKey: getExternalSessionKey() || '',
          sessionId: (event.sessionId as string) || ctx.sessionId || '',
          trigger: ctx.trigger,
          traceId: runId || undefined,
        })

        // ─── 上报日志 ───
        reportLog({
          body: 'message_received',
          params: {
            logtype: 'MessageReceived',
            stage: 'message_received',
            opname: 'chat',
            model: (event.model as string) || '',
            provider: (event.provider as string) || '',
            runId,
            sessionId: '',
            input: encryptPayload(content),
            sessionKey: getExternalSessionKey() || '',
            userId: getExternalUid() || '',
            channelId,
            query_scene: msg_query_scene || QueryScene.OTHERS,
          }
        })

      })

      // ================================================================
      // 1. before_agent_start — 创建 invoke_agent root span
      // ================================================================
      ctx.onHook('before_agent_start', async (event: Record<string, unknown>, hookCtx) => {
        const tracer = getTracer()
        if (!tracer) return

        // ─── 缓存 trigger，供后续 hook 中 resolveQueryScene 使用 ───
        const triggerValue = (hookCtx as any).trigger as string | undefined
        if (hookCtx.sessionKey && triggerValue) {
          setSessionTrigger(hookCtx.sessionKey, triggerValue)
        }

        const galileoCfg = getGalileoConfig()
        const genAi = galileoCfg?.galileo.trace.genAi

        // ─── runId → traceId 映射：设置当前活跃 runId 并预生成 traceId ───
        const traceIdKey = (event.runId || hookCtx.runId || hookCtx.sessionId || 'unknown') as string
        setActiveRunId(traceIdKey)
        getOrCreateTraceIdForRun(traceIdKey) // 预生成并缓存，保证后续 interceptor 和 OTel 使用同一值
        // 保存 traceIdKey，确保 agent_end 用同一个 key 清理 runTraceIdMap
        const sessionKeyForTraceCleanup = hookCtx.sessionKey || (hookCtx as any).sessionId
        if (sessionKeyForTraceCleanup) {
          sessionTraceKeyMap.set(sessionKeyForTraceCleanup, traceIdKey)
          // 快照客户端原始 traceId，避免后续 hook 中读全局变量被其他通路覆盖
          sessionClientTraceIdMap.set(sessionKeyForTraceCleanup, getExternalTraceId() ?? '')
        }

        const agentName = genAi?.agentName || hookCtx.agentId || 'openclaw-agent'
        const agentKey = spanKey('agent', hookCtx.sessionKey || (hookCtx as any).sessionId)
        const channelId = resolveChannelId(getExternalSessionKey());
        const scenceType = resolveScenceType(channelId);

        // ─── 精细化 query scene 判定 ───
        const query_scene = resolveQueryScene({
          channelId,
          sessionKey: hookCtx.sessionKey,
          sessionId: (event.sessionId as string) || (hookCtx as any).sessionId || '',
          trigger: triggerValue,
          traceId: traceIdKey !== 'unknown' ? traceIdKey : undefined,
        })

        const span = tracer.startSpan(
          `invoke_agent ${agentName}`,
          {
            kind: SpanKind.CLIENT,
            attributes: {
              'gen_ai.operation.name': 'invoke_agent',
              'gen_ai.system': genAi?.system || 'openclaw',
              'gen_ai.agent.name': agentName,
              'gen_ai.agent.id': genAi?.agentId || hookCtx.agentId || '',
              'gen_ai.app.name': genAi?.appName || 'openclaw',
              'gen_ai.conversation.id': hookCtx.sessionKey || (hookCtx as any).sessionId || '',
              'gen_ai.user.id': getExternalUid() || '',
              'gen_ai.is_stream': true,
              "openclaw.scence_type": scenceType,
              "openclaw.query_scene": query_scene || QueryScene.OTHERS,
              "openclaw.stage": "before_agent_start",
              "openclaw.status": "success",
              'openclaw.session_key': hookCtx.sessionKey ?? '',
              'openclaw.session_id': (hookCtx as any).sessionId ?? '',
              'openclaw.trigger': (hookCtx as any).trigger ?? '',
              'openclaw.channel_id': (hookCtx as any).channelId ?? '',
              'openclaw.guid': getExternalGuid() ?? '',
              'openclaw.uid': getExternalUid() ?? '',
              'openclaw.app_version': getExternalAppVersion() ?? '',
              'openclaw.source_terminal': getExternalSourceTerminal() ?? '',
              'openclaw.openclaw_version': getOpenclawVersion() ?? '',
              'openclaw.prompt_id': getExternalPromptId() ?? '',
              'openclaw.wechat_session_id': getExternalWechatSessionId() ?? '',
              'openclaw.client_trace_id': getExternalTraceId() ?? '',
            },
          },
          ROOT_CONTEXT,
        )

        const agentPromptText = stripPromptMetadata((event.prompt as string) ?? '')
        const agentMd5Query = crypto.createHash('md5').update(agentPromptText).digest('hex')
        span.addEvent('gen_ai.invoke_agent_request', {
          'message.detail': safeAttr({
            prompt: encryptPayload({ user_id: String(getExternalUid() ?? ''), log: agentPromptText }),
            message_count: (event.messages as any[])?.length ?? 0,
            md5_query: agentMd5Query,
          }),
        })
        span.setAttribute('openclaw.md5_query', agentMd5Query)

        setActiveSpan(agentKey, span, ROOT_CONTEXT)

        const agentEntry = getActiveSpanEntry(agentKey)
        if (agentEntry) {
          setCurrentAgentCtx(agentEntry.ctx)
          setCurrentAgentSpanId(span.spanContext().spanId)
        }

        reportLog({
          body: 'before_agent_start',
          params: {
            logtype: 'BeforAgentStart',
            stage: 'before_agent_start',
            opname: 'chat',
            model: event.model as string,
            provider: (event.provider as string) || '',
            runId: (event.runId as string) || (hookCtx as any).runId || '',
            sessionId: (event.sessionId as string) || (hookCtx as any).sessionId || '',
            sessionKey: hookCtx.sessionKey || '',
            userId: getExternalUid() || '',
            query_scene: query_scene || QueryScene.OTHERS,
          }
        })
      }, { priority: 300 })

      // ================================================================
      // 2. llm_input — 延迟创建 chat span
      // ================================================================
      ctx.onHook('llm_input', async (event: Record<string, unknown>, hookCtx) => {
        const tracer = getTracer()
        if (!tracer) return

        const galileoCfg = getGalileoConfig()
        const genAi = galileoCfg?.galileo.trace.genAi

        const runId = (event.runId as string) || (hookCtx as any).runId || hookCtx.sessionId || ''
        const agentKey = spanKey('agent', hookCtx.sessionKey || (hookCtx as any).sessionId)
        const seq = nextLlmSeq(runId)
        const llmKey = spanKey('llm', runId, String(seq))
        const model = (event.model as string) || 'unknown'

        if (hookCtx.sessionKey && runId !== 'unknown') {
          sessionRunIdMap.set(hookCtx.sessionKey, runId)
        }

        // 重置 Skill 检测器累积数据（新一轮 agent 开始时清空上轮残留）
        skillDetector.reset(hookCtx.sessionKey || (hookCtx as any).sessionId || '')

        if (runId !== 'unknown') {
          const auditSessionKey = hookCtx.sessionKey || (hookCtx as any).sessionId || `run:${runId}`
          setCurrentLlmAuditContext(auditSessionKey, runId)
        }

        if (typeof event.systemPrompt === 'string') {
          availableSkills = parseSkillsFromSystemPrompt(event.systemPrompt)
          if (availableSkills.length > 0) {
            const agentEntry = getActiveSpanEntry(agentKey)
            if (agentEntry) {
              agentEntry.span.setAttribute('openclaw.available_skills', availableSkills.map((s) => s.name).join(','))
              agentEntry.span.setAttribute('openclaw.available_skills_count', availableSkills.length)
            }
          }
        }

        const inspirationTag = extractInspirationTag((event.prompt as string) ?? '')
        if (inspirationTag) setCurrentInspirationTag(inspirationTag)

        setPendingChatSpanCallback(() => {
          const parentEntry = getActiveSpanEntry(agentKey)
          const parentCtx = parentEntry?.ctx ?? ROOT_CONTEXT
          const channelId = resolveChannelId(getExternalSessionKey());
          const scenceType = resolveScenceType(channelId);
          const llm_query_scene = resolveQueryScene({
            channelId,
            sessionKey: hookCtx.sessionKey,
            sessionId: (event.sessionId as string) || (hookCtx as any).sessionId || '',
            trigger: hookCtx.sessionKey ? getSessionTrigger(hookCtx.sessionKey) : undefined,
            traceId: runId || undefined,
          })
          const span = tracer.startSpan(
            `chat ${model}`,
            {
              kind: SpanKind.CLIENT,
              attributes: {
                'gen_ai.operation.name': 'chat',
                'gen_ai.system': (event.provider as string) || genAi?.system || 'openclaw',
                'gen_ai.request.model': model,
                'gen_ai.app.name': genAi?.appName || 'openclaw',
                'gen_ai.conversation.id': hookCtx.sessionKey || (hookCtx as any).sessionId || '',
                'gen_ai.user.id': getExternalUid() || '',
                'gen_ai.is_stream': true,
                'openclaw.session_key': hookCtx.sessionKey ?? '',
                "openclaw.span_name": `chat ${model}`,
                "openclaw.scence_type": scenceType,
                "openclaw.query_scene": llm_query_scene || QueryScene.OTHERS,
                "openclaw.channel_id": channelId,
                "openclaw.channel_session_id": getExternalWechatSessionId() ?? "",
                "openclaw.channel_request_id": getExternalPromptId() ?? "",
                "openclaw.stage": "llm_input",
                'openclaw.run_id': runId,
                "openclaw.status": "success",
                'openclaw.session_id': (event.sessionId as string) ?? '',
                'openclaw.provider': (event.provider as string) ?? '',
                'openclaw.model': model,
                'openclaw.llm.seq': seq,
                'openclaw.guid': getExternalGuid() ?? '',
                'openclaw.uid': getExternalUid() ?? '',
                'openclaw.app_version': getExternalAppVersion() ?? '',
                'openclaw.source_terminal': getExternalSourceTerminal() ?? '',
                'openclaw.openclaw_version': getOpenclawVersion() ?? '',
                'openclaw.prompt_id': getExternalPromptId() ?? '',
                'openclaw.wechat_session_id': getExternalWechatSessionId() ?? '',
                'openclaw.usage_inspiration': getCurrentInspirationTag() ?? '',
              },
            },
            parentCtx,
          )

          if (event.systemPrompt) {
            span.addEvent('gen_ai.system.message', {
              'message.detail': safeAttr({
                content: encryptPayload({ user_id: String(getExternalUid() ?? ''), log: event.systemPrompt }),
                role: 'system',
              }),
            })
          }

          const userPromptText = stripPromptMetadata((event.prompt as string) ?? '')
          const md5Query = crypto.createHash('md5').update(userPromptText).digest('hex')
          span.addEvent('gen_ai.user.message', {
            'message.detail': safeAttr({
              content: encryptPayload({ user_id: String(getExternalUid() ?? ''), log: userPromptText }),
              role: 'user',
              md5_query: md5Query,
            }),
          })
          span.setAttribute('openclaw.md5_query', md5Query)

          if (availableSkills.length > 0) {
            span.setAttribute('openclaw.available_skills', availableSkills.map((s) => s.name).join(','))
            span.setAttribute('openclaw.available_skills_count', availableSkills.length)
          }

          const startTime = Date.now()
          span.setAttribute('openclaw.start_time_ms', startTime)
          llmStartTimeMap.set(llmKey, startTime)
          llmPromptMap.set(llmKey, userPromptText)

          setActiveSpan(llmKey, span, parentCtx)
        })

        // ─── 上报 llm_input Log ───
        const channelIdForLog = resolveChannelId(getExternalSessionKey())
        const llm_input_query_scene = resolveQueryScene({
          channelId: channelIdForLog,
          sessionKey: hookCtx.sessionKey,
          sessionId: (event.sessionId as string) || (hookCtx as any).sessionId || '',
          trigger: hookCtx.sessionKey ? getSessionTrigger(hookCtx.sessionKey) : undefined,
          traceId: runId || undefined,
        })
        // reportLlmInputLog({
        //   model,
        //   provider: (event.provider as string) || '',
        //   runId,
        //   sessionId: (event.sessionId as string) || (hookCtx as any).sessionId || '',
        //   sessionKey: hookCtx.sessionKey || '',
        //   seq,
        //   prompt: encryptPayload({ user_id: String(getExternalUid() ?? ''), log: (event.prompt as string) ?? '' }),
        //   systemPrompt: event.systemPrompt
        //     ? encryptPayload({ user_id: String(getExternalUid() ?? ''), log: (event.systemPrompt as string) })
        //     : undefined,
        //   userId: getExternalUid() || '',
        //   scenceType: resolveScenceType(channelIdForLog),
        //   channelId: channelIdForLog,
        //   clientTraceId: sessionClientTraceIdMap.get(hookCtx.sessionKey || '') ?? '',
        // })
        reportLog({
          body: `llm_input model=${model}`,
          params: {
            logtype: 'LlmInput',
            stage: 'llminput',
            opname: 'chat',
            model,
            provider: (event.provider as string) || '',
            runId,
            sessionId: (event.sessionId as string) || (hookCtx as any).sessionId || '',
            sessionKey: hookCtx.sessionKey || '',
            userId: getExternalUid() || '',
            seq,
            input: encryptPayload({user_id: String(getExternalUid() ?? ''), log: event.prompt}),
            // encryptPayload({ user_id: String(getExternalUid() ?? ''), log: (userPromptText as string) ?? '' }),
            // systemPrompt: event.systemPrompt
            //   ? encryptPayload({ user_id: String(getExternalUid() ?? ''), log: (event.systemPrompt as string) })
            //   : undefined,
            scenceType: resolveScenceType(channelIdForLog),
            channelId: channelIdForLog,
            clientTraceId: sessionClientTraceIdMap.get(hookCtx.sessionKey || '') ?? '',
            query_scene: llm_input_query_scene || QueryScene.OTHERS,
          }
        })
      }, { priority: 300 })

      // ================================================================
      // 3. llm_output — 结束 chat span，上报 metrics
      // ================================================================
      ctx.onHook('llm_output', async (event: Record<string, unknown>, hookCtx) => {
        const runId = (event.runId as string) || (hookCtx as any).sessionId || 'unknown'
        const currentSeq = (() => {
          for (let s = 100; s >= 1; s--) {
            if (getActiveSpanEntry(spanKey('llm', runId, String(s)))) return s
          }
          return 0
        })()

        const channelId = resolveChannelId(getExternalSessionKey());
        if (currentSeq === 0) {
          clearPendingChatSpanCallback()
          clearCurrentLlmAuditContext(runId)
          for (let s = 100; s >= 1; s--) {
            const k = spanKey('llm', runId, String(s))
            llmPromptMap.delete(k)
            llmStartTimeMap.delete(k)
          }
          return
        }

        const llmKey = spanKey('llm', runId, String(currentSeq))
        const entry = removeActiveSpan(llmKey)
        if (!entry) {
          clearPendingChatSpanCallback()
          clearCurrentLlmAuditContext(runId)
          llmPromptMap.delete(llmKey)
          llmStartTimeMap.delete(llmKey)
          return
        }

        clearPendingChatSpanCallback()
        clearCurrentLlmAuditContext(runId)

        const { span } = entry
        const usage = event.usage as any
        const inputTokens = usage?.input ?? 0
        const outputTokens = usage?.output ?? 0

        const startTimeMs = llmStartTimeMap.get(llmKey) ?? 0
        llmStartTimeMap.delete(llmKey)
        const cachedPrompt = llmPromptMap.get(llmKey) ?? ''
        llmPromptMap.delete(llmKey)
        const computedDurationMs = startTimeMs > 0 ? Date.now() - startTimeMs : 0

        const agentKey = spanKey('agent', hookCtx.sessionKey || (hookCtx as any).sessionId)
        const accumulated = agentUsageMap.get(agentKey) ?? { inputTokens: 0, outputTokens: 0 }
        accumulated.inputTokens += inputTokens
        accumulated.outputTokens += outputTokens
        agentUsageMap.set(agentKey, accumulated)

        const lastAssistantContent = (event as any)?.lastAssistant?.content

        let contentErrorType: string | null = null
        if (lastAssistantContent === undefined || lastAssistantContent === null || (Array.isArray(lastAssistantContent) && lastAssistantContent.length === 0)) {
          contentErrorType = 'empty_content'
        } else if (Array.isArray(lastAssistantContent)) {
          for (const item of lastAssistantContent) {
            const text: string = typeof item === 'string' ? item : (item?.text ?? '')
            if (text.includes('REDACT')) { contentErrorType = 'REDACT'; break }
            if (text.includes('NO_REPLY')) { contentErrorType = 'NO_REPLY'; break }
          }
        }

        const logPayload = { content: lastAssistantContent, role: 'assistant' }
        const logPayloadStr = JSON.stringify(logPayload)
        const scenceType = resolveScenceType(channelId);
        span.setAttributes({
          'gen_ai.response.model': (event.model as string) || '',
          'gen_ai.usage.input_tokens': inputTokens,
          'gen_ai.usage.output_tokens': outputTokens,
          'gen_ai.response.finish_reasons': 'stop',
          'openclaw.tokens.input': inputTokens,
          'openclaw.tokens.output': outputTokens,
          'openclaw.tokens.cache_read': usage?.cacheRead ?? 0,
          'openclaw.tokens.cache_write': usage?.cacheWrite ?? 0,
          'openclaw.tokens.total': usage?.total ?? 0,
          "openclaw.scence_type": scenceType,
          "openclaw.channel_id": channelId,
          "openclaw.channel_session_id": getExternalWechatSessionId() ?? "",
          "openclaw.channel_request_id": getExternalPromptId() ?? "",
          "openclaw.stage": "llm_output",
          "openclaw.status": "success",
        })

        if (contentErrorType) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: `${contentErrorType}, log: ${logPayloadStr}` })
        }

        span.addEvent('gen_ai.choice', {
          'message.detail': safeAttr({
            index: 0,
            finish_reason: 'stop',
            message: {
              ...((event as any)?.lastAssistant || {}),
              content: encryptPayload({ user_id: String(getExternalUid() ?? ''), log: logPayloadStr }),
            },
          }),
        })

        if (computedDurationMs > 0) {
          span.setAttribute('gen_ai.client.operation.duration', computedDurationMs / 1000)
        }

        span.end()

        const llmOutputTrigger = hookCtx.sessionKey ? getSessionTrigger(hookCtx.sessionKey) : undefined
        const llm_output_query_scene = resolveQueryScene({
          channelId,
          sessionKey: hookCtx.sessionKey,
          sessionId: (event.sessionId as string) || (hookCtx as any).sessionId || '',
          trigger: llmOutputTrigger,
          traceId: runId !== 'unknown' ? runId : undefined,
        })
        reportLog({
          body: `llmoutput model=${event.model}`,
          errorType: contentErrorType ?? undefined,
          params: {
            logtype: 'LlmOutput',
            opname: 'chat',
            stage: 'llmoutput',
            model: (event.model as string) || '',
            provider: (event.provider as string) || '',
            runId,
            sessionId: (event.sessionId as string) || (hookCtx as any).sessionId || '',
            sessionKey: hookCtx.sessionKey || '',
            llmseq: String(currentSeq),
            inputTokens,
            outputTokens,
            durationMs: computedDurationMs,
            input: encryptPayload({ user_id: String(getExternalUid() ?? ''), log: event.prompt as string}),
            output: encryptPayload({ user_id: String(getExternalUid() ?? ''), log: logPayloadStr }),
            userId: getExternalUid() || '',
            scenceType: resolveScenceType(channelId),
            channelId,
            clientTraceId: sessionClientTraceIdMap.get(hookCtx.sessionKey || '') ?? '',
            query_scene: llm_output_query_scene || QueryScene.OTHERS,
          }
        })

        // const computedDurationSec = computedDurationMs / 1000
        // const galileoCfg = getGalileoConfig()
        // if (galileoCfg?.galileo.metrics.enabled) {
        //   const genAi = galileoCfg.galileo.metrics.genAi
        //   const firstTokenLatency = computedDurationSec

        //   reportChatMetrics({
        //     provider: (event.provider as string) || genAi.system,
        //     requestModel: (event.model as string) || '',
        //     responseModel: (event.model as string) || '',
        //     isStream: false,
        //     userId: getExternalUid() || '',
        //     agentName: genAi.agentName,
        //     agentId: genAi.agentId,
        //     appName: genAi.appName,
        //     promptTokens: inputTokens,
        //     completionTokens: outputTokens,
        //     firstTokenLatency,
        //     operationDuration: computedDurationSec,
        //     appVersion: getExternalAppVersion() ?? undefined,
        //     sourceTerminal: getExternalSourceTerminal() ?? undefined,
        //     openclawVersion: getOpenclawVersion() ?? undefined,
        //     promptId: getExternalPromptId() ?? undefined,
        //     wechatSessionId: getExternalWechatSessionId() ?? undefined,
        //     usageInspiration: getCurrentInspirationTag() ?? undefined,
        //     sessionId: (event.sessionId as string) || (hookCtx as any).sessionId || '',
        //     runId: runId !== 'unknown' ? runId : '',
        //     spanContext: entry.ctx,
        //     encryptedInput: (() => {
        //       if (!cachedPrompt) return undefined
        //       try { return encryptPayload({ user_id: String(getExternalUid() ?? ''), log: cachedPrompt }) }
        //       catch { return undefined }
        //     })(),
        //     encryptedOutput: (() => {
        //       if (!(event as any)?.lastAssistant?.content) return undefined
        //       try { return encryptPayload({ user_id: String(getExternalUid() ?? ''), log: JSON.stringify({ content: (event as any).lastAssistant.content, role: 'assistant' }) }) }
        //       catch { return undefined }
        //     })(),
        //     ...(contentErrorType ? { errorType: contentErrorType, codeType: 'error' } : {}),
        //     clientTraceId: sessionClientTraceIdMap.get(hookCtx.sessionKey || '') ?? '',
        //   })
        // }
      }, { priority: 300 })

      // ================================================================
      // 4. before_tool_call — 安全审核 + 遥测
      // ================================================================
      if (enableBeforeToolCall) {
        ctx.onHook('before_tool_call', async (event: Record<string, unknown>, hookCtx) => {
          const _diagStart = performance.now();
          const _diagToolName = String(event.toolName || 'unknown');
          // web_search 条件拦截
          if (event.toolName === 'web_search') {
            try {
              const cfg = runtimeConfig?.loadConfig?.()
              const searchCfg = cfg?.tools?.web?.search

              const hasApiKey = !!(
                searchCfg?.apiKey || searchCfg?.gemini?.apiKey || searchCfg?.grok?.apiKey ||
                searchCfg?.kimi?.apiKey || searchCfg?.perplexity?.apiKey ||
                process.env.BRAVE_API_KEY || process.env.GEMINI_API_KEY ||
                process.env.XAI_API_KEY || process.env.KIMI_API_KEY ||
                process.env.MOONSHOT_API_KEY || process.env.PERPLEXITY_API_KEY
              )

              if (!hasApiKey) {
                reporter.report('execute', {
                  module_id: 'Search', component_id: 'Web_Search_Blocked',
                  event_code: 'execute', action_type: 'tool_blocked',
                  recommend: { tool_name: 'web_search', block_reason: 'no_api_key' },
                })
                return {
                  block: true,
                  blockReason: [
                    'web_search 未配置搜索 Provider API Key，无法使用。',
                    '请改用以下方式执行搜索：',
                    '1. [首选] 使用 online-search Skill（ProSearch 联网搜索）',
                    '2. [备选] 使用 multi-search-engine Skill（多引擎搜索）',
                  ].join('\n'),
                }
              }

              const provider: string = searchCfg?.provider || 'brave'
              reporter.report('execute', {
                module_id: 'Search', component_id: 'Web_Search_Execute',
                page_id: 'Search_Page', event_code: 'execute',
                action_type: 'search_execute', action_status: 'success',
                channel: 'web_search', recommend: { provider },
              })
            } catch (_e) {
              // 配置读取失败不阻断
            }
          }

          if (!hookCtx?.agentId || !hookCtx?.sessionKey) return

          try {
            const sessionKey = hookCtx.sessionKey
            const turnKey = (event.runId as string) || (hookCtx as any).runId || (hookCtx as any).sessionId || sessionKey
            const sessionId = getSessionId(sessionKey)
            const qaid = ensureQAIDForTurn(sessionKey, turnKey)

            let content = `工具: ${event.toolName}, 参数: ${JSON.stringify(event.params)}`

            // 尝试从会话 JSONL 提取 thinking
            try {
              if (stateDir && hookCtx.agentId && hookCtx.sessionKey) {
                const sessionsJsonPath = path.join(stateDir, 'agents', hookCtx.agentId, 'sessions', 'sessions.json')
                if (fs.existsSync(sessionsJsonPath)) {
                  const sessionsData = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf-8'))
                  const sessionInfo = sessionsData[hookCtx.sessionKey]
                  if (sessionInfo?.sessionFile) {
                    const fullSessionPath = path.isAbsolute(sessionInfo.sessionFile)
                      ? sessionInfo.sessionFile
                      : path.join(path.dirname(sessionsJsonPath), sessionInfo.sessionFile)
                    if (fs.existsSync(fullSessionPath)) {
                      const sessionStats = fs.statSync(fullSessionPath)
                      if (sessionStats.size <= MAX_SESSION_FILE_SIZE) {
                        const sessionContent = fs.readFileSync(fullSessionPath, 'utf-8')
                        const lines = sessionContent.split('\n').filter((l) => l.trim())
                        for (let i = lines.length - 1; i >= 0; i--) {
                          try {
                            const item = JSON.parse(lines[i])
                            if (item.type === 'message' && item.message?.role === 'assistant' && Array.isArray(item.message.content)) {
                              const matchedToolCall = item.message.content.find(
                                (c: any) => c.type === 'toolCall' && c.name === event.toolName && JSON.stringify(c.arguments) === JSON.stringify(event.params),
                              )
                              const thinking = item.message.content.find((c: any) => c.type === 'thinking')
                              if (matchedToolCall && thinking) {
                                content = `${thinking.thinking || ''}\n${content}`
                                break
                              }
                            }
                          } catch { /* 单行解析失败跳过 */ }
                        }
                      }
                    }
                  }
                }
              }
            } catch (_e) { /* JSONL 读取失败不影响审核 */ }

            const contentSlices = sliceText(content, 4000)
            const toolCallId = (event.toolCallId as string) || (event.toolName as string)
            const runId = (event.runId as string) || (hookCtx as any).runId || 'unknown'
            const toolKey = spanKey('tool', runId, toolCallId)
            const agentKey = spanKey('agent', hookCtx.sessionKey || (hookCtx as any).sessionId)

            const parentEntry = getActiveSpanEntry(agentKey)
            const parentCtx = parentEntry?.ctx ?? ROOT_CONTEXT

            // 提前计算 channelId 和 query_scene，供审核 span 和后续 reportLog 共用
            const channelId = resolveChannelId(getExternalSessionKey());
            const tool_call_query_scene = resolveQueryScene({
              channelId,
              sessionKey: hookCtx.sessionKey,
              sessionId: (event.sessionId as string) || (hookCtx as any).sessionId || '',
              trigger: hookCtx.sessionKey ? getSessionTrigger(hookCtx.sessionKey) : undefined,
              traceId: runId !== 'unknown' ? runId : undefined,
            })

            const toolCallBlocked = await checkSlicesParallel(
              contentSlices,
              (slice) => checkContentSecurity(
                null, client!, 'prompt',
                [{ Data: slice, MediaType: 'Text' }],
                sessionId, SessionType.ANSWER, 'before_tool_call',
                logRecord, 'content-security', qaid, parentCtx,
                undefined, // galileoTraceId
                { query_scene: tool_call_query_scene || QueryScene.OTHERS },
              ),
            )

            if (toolCallBlocked) {
              return { block: true, blockReason: '请换个问题提问。' }
            }

            // 审核通过后创建 execute_tool span
            const tracer = getTracer()
            if (!tracer) return

            const galileoCfg = getGalileoConfig()
            const genAi = galileoCfg?.galileo.trace.genAi
            const scenceType = resolveScenceType(channelId);
            const span = tracer.startSpan(
              `execute_tool ${event.toolName}`,
              {
                kind: SpanKind.CLIENT,
                attributes: {
                  'gen_ai.operation.name': 'execute_tool',
                  'gen_ai.tool.name': (event.toolName as string) ?? '',
                  'gen_ai.tool.call.id': (event.toolCallId as string) ?? '',
                  'gen_ai.app.name': genAi?.appName || 'openclaw',
                  'gen_ai.conversation.id': hookCtx.sessionKey || (hookCtx as any).sessionId || '',
                  'gen_ai.user.id': getExternalUid() || '',
                  'openclaw.session_key': hookCtx.sessionKey ?? '',
                  'openclaw.run_id': runId,
                  'openclaw.guid': getExternalGuid() ?? '',
                  'openclaw.uid': getExternalUid() ?? '',
                  'openclaw.app_version': getExternalAppVersion() ?? '',
                  'openclaw.source_terminal': getExternalSourceTerminal() ?? '',
                  'openclaw.openclaw_version': getOpenclawVersion() ?? '',
                  'openclaw.prompt_id': getExternalPromptId() ?? '',
                  'openclaw.wechat_session_id': getExternalWechatSessionId() ?? '',
                  "openclaw.scence_type": scenceType,
                  "openclaw.query_scene": tool_call_query_scene || QueryScene.OTHERS,
                  "openclaw.channel_id": channelId,
                  "openclaw.channel_session_id": getExternalWechatSessionId() ?? "",
                  "openclaw.channel_request_id": getExternalPromptId() ?? "",
                  "openclaw.stage": "before_tool_call",
                  "openclaw.status": "success",
                },
              },
              parentCtx,
            )

            span.addEvent('gen_ai.tool_call_args', {
              'message.detail': safeAttr({
                args: encryptPayload({
                  user_id: String(getExternalUid() ?? ''),
                  log: typeof event.params === 'string' ? event.params : JSON.stringify(event.params),
                }),
              }),
            })

            span.setAttribute('openclaw.start_time_ms', Date.now())
            setActiveSpan(toolKey, span, parentCtx)

            reportLog({
              body: `before_tool_call tool_name=${event.toolName || ''}`,
              params: {
                logtype: 'BeforeToolCall',
                opname: 'execute_tool',
                stage: 'before_tool_call',
                userId: getExternalUid() || '',
                model: (event.model as string) || '',
                provider: (event.provider as string) || '',
                runId,
                toolName: event.toolName || '',
                sessionId: (event.sessionId as string) || (hookCtx as any).sessionId || '',
                sessionKey: hookCtx.sessionKey || '',
                channelId,
                clientTraceId: sessionClientTraceIdMap.get(hookCtx.sessionKey || '') ?? '',
                query_scene: tool_call_query_scene || QueryScene.OTHERS,
              }
            })

          } catch (e) {
            const _diagMs = (performance.now() - _diagStart).toFixed(1);
            console.error(
              `[qclaw-plugin:content-plugin] [diag] before_tool_call ERROR tool=${_diagToolName} ${_diagMs}ms:`,
              e instanceof Error ? e.message : e,
            );
            try {
              const toolCallId = (event.toolCallId as string) || (event.toolName as string)
              const runId = (event.runId as string) || (hookCtx as any)?.runId || 'unknown'
              const toolKey = spanKey('tool', runId, toolCallId)
              const entry = removeActiveSpan(toolKey)
              if (entry) {
                entry.span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) })
                entry.span.end()
              }
            } catch { /* 清理失败不影响主流程 */ }
          }
          const _diagEndMs = (performance.now() - _diagStart).toFixed(1);
          if (Number(_diagEndMs) > 1000) {
            console.warn(`[qclaw-plugin:content-plugin] [diag] before_tool_call SLOW tool=${_diagToolName} ${_diagEndMs}ms`);
          }
        }, { priority: 200 })
      }

      // ================================================================
      // 5. after_tool_call — 安全审核 + 遥测
      // ================================================================
      if (enableAfterToolCall) {
        ctx.onHook('after_tool_call', async (event: Record<string, unknown>, hookCtx) => {
          const _diagStart = performance.now();
          const _diagToolName = String(event.toolName || 'unknown');
          try {
            // ─── Skill 实时检测 ───
            try {
              skillDetector.handleToolCall(
                event as unknown as AfterToolCallEvent,
                hookCtx as unknown as ToolCallHookContext,
              )
            } catch { /* Skill 检测异常不影响 after_tool_call 主流程 */ }

            // multi-search 上报
            if (event.toolName === 'web_fetch') {
              try {
                const fetchUrl: string = (event.params as any)?.url || (event.params as any)?.URL || ''
                const engineMap: Record<string, string> = {
                  'baidu.com': 'baidu', 'google.com': 'google', 'bing.com': 'bing_cn',
                  'cn.bing.com': 'bing_cn', 'duckduckgo.com': 'duckduckgo', 'sogou.com': 'sogou',
                  'so.com': '360', 'yahoo.com': 'yahoo', 'startpage.com': 'startpage',
                  'search.brave.com': 'brave', 'ecosia.org': 'ecosia', 'qwant.com': 'qwant',
                  'wolframalpha.com': 'wolfram', 'weixin.sogou.com': 'wechat',
                  'toutiao.com': 'toutiao', 'jisilu.cn': 'jisilu', 'google.com.hk': 'google_hk',
                }
                let detectedEngine = ''
                for (const [domain, engine] of Object.entries(engineMap)) {
                  if (fetchUrl.includes(domain)) { detectedEngine = engine; break }
                }
                if (detectedEngine) {
                  reporter.report('execute', {
                    module_id: 'Search', component_id: 'Multi_Search_Execute',
                    event_code: 'execute', action_type: 'search_execute',
                    channel: 'multi_search_engine', recommend: { engine: detectedEngine },
                  })
                }
              } catch { /* 上报失败不影响 */ }
            }

            const sessionKey = hookCtx?.sessionKey || 'default'
            const turnKey = (event.runId as string) || (hookCtx as any)?.runId || (hookCtx as any)?.sessionId || sessionKey
            const sessionId = getSessionId(sessionKey)
            const qaid = ensureQAIDForTurn(sessionKey, turnKey)

            const content = `工具: ${event.toolName}\n参数: ${JSON.stringify(event.params)}\n结果: ${JSON.stringify(event.result)}`
            const slices = sliceText(content, OUTPUT_MAX_LENGTH)

            const toolCallId = (event.toolCallId as string) || (event.toolName as string)
            const runId = (event.runId as string) || (hookCtx as any).runId || 'unknown'
            const toolKey = spanKey('tool', runId, toolCallId)
            const agentKey = spanKey('agent', hookCtx.sessionKey || (hookCtx as any).sessionId)

            const agentEntry = getActiveSpanEntry(agentKey)
            const securityParentCtx = agentEntry?.ctx ?? ROOT_CONTEXT

            const entry = removeActiveSpan(toolKey)
            if (!entry) return

            const { span } = entry

            span.addEvent('gen_ai.tool_response', {
              'message.detail': safeAttr({
                result: encryptPayload({
                  user_id: String(getExternalUid() ?? ''),
                  log: typeof event.result === 'string' ? event.result : JSON.stringify(event.result),
                }),
              }),
            })

            span.setAttributes({ 'openclaw.duration_ms': (event.durationMs as number) ?? 0 })

            if (event.error) {
              span.setStatus({ code: SpanStatusCode.ERROR, message: String(event.error) })
              span.setAttribute('error.type', String(event.error))
            }

            span.end()

            // 提前计算 query_scene，供 metrics reportLog 和输出审核共用
            const after_tool_query_scene = resolveQueryScene({
              channelId: resolveChannelId(getExternalSessionKey()),
              sessionKey: hookCtx.sessionKey,
              sessionId: (event.sessionId as string) || (hookCtx as any).sessionId || '',
              trigger: hookCtx.sessionKey ? getSessionTrigger(hookCtx.sessionKey) : undefined,
              traceId: runId !== 'unknown' ? runId : undefined,
            })

            // Tool Metrics
            const galileoCfg = getGalileoConfig()
            if (galileoCfg?.galileo.metrics.enabled) {
              // const genAi = galileoCfg.galileo.metrics.genAi
              const durationMs = (event.durationMs as number) ?? 0
              const durationSec = durationMs / 1000

              // reportToolMetrics({
              //   provider: genAi.system,
              //   toolName: (event.toolName as string) || '',
              //   userId: getExternalUid() || '',
              //   agentName: genAi.agentName,
              //   agentId: genAi.agentId,
              //   appName: genAi.appName,
              //   operationDuration: durationSec,
              //   codeType: event.error ? 'exception' : 'success',
              //   errorType: event.error ? String(event.error) : undefined,
              //   appVersion: getExternalAppVersion() ?? undefined,
              //   sourceTerminal: getExternalSourceTerminal() ?? undefined,
              //   openclawVersion: getOpenclawVersion() ?? undefined,
              //   promptId: getExternalPromptId() ?? undefined,
              //   wechatSessionId: getExternalWechatSessionId() ?? undefined,
              //   sessionId: (hookCtx as any).sessionId || '',
              //   runId: runId !== 'unknown' ? runId : '',
              //   status: 'after_tool_call',
              //   clientTraceId: sessionClientTraceIdMap.get(hookCtx.sessionKey || '') ?? '',
              // })

              reportLog({
                body: `after_tool_call tool_name=${event.toolName || ''}`,
                errorType: event.error ? String(event.error) : undefined,
                params: {
                  logtype: 'GenAIExecuteTool',
                  stage: 'after_tool_call',
                  opname: 'execute_tool',
                  model: (event.model as string) || '',
                  provider: (event.provider as string) || '',
                  runId,
                  sessionId: (event.sessionId as string) || (hookCtx as any).sessionId || '',
                  sessionKey: hookCtx.sessionKey || '',
                  userId: getExternalUid() || '',
                  wechatSessionId: getExternalWechatSessionId() ?? undefined,
                  promptId: getExternalPromptId() ?? undefined,
                  codeType: event.error ? 'exception' : 'success',
                  operationDuration: durationSec,
                  toolName: (event.toolName as string) || '',
                  status: 'after_tool_call',
                  clientTraceId: sessionClientTraceIdMap.get(hookCtx.sessionKey || '') ?? '',
                  query_scene: after_tool_query_scene || QueryScene.OTHERS,
                }
              })
            }

            // 输出审核
            let blocked = false
            for (let i = 0; i < slices.length; i++) {
              const sessionType = SessionType.ANSWER
              const result = await checkContentSecurity(
                null, client!, 'output',
                [{ Data: slices[i], MediaType: 'Text' }],
                sessionId, sessionType, 'after_tool_call',
                logRecord, 'content-security', qaid, securityParentCtx,
                undefined, // galileoTraceId
                { query_scene: after_tool_query_scene || QueryScene.OTHERS },
              )
              if (result.blocked) { blocked = true; break }
            }

            if (blocked) {
              const interceptedData = { error: 'Intercepted', message: '请换个问题提问。' }
              ;(event.result as any).content = [{ type: 'text', text: JSON.stringify(interceptedData, null, 2) }]
              ;(event.result as any).details = interceptedData
            }
          } catch (_e) {
            const _diagMs = (performance.now() - _diagStart).toFixed(1);
            console.error(
              `[qclaw-plugin:content-plugin] [diag] after_tool_call ERROR tool=${_diagToolName} ${_diagMs}ms:`,
              _e instanceof Error ? _e.message : _e,
            );
            // after_tool_call 异常不影响工具执行结果
          }
          const _diagEndMs = (performance.now() - _diagStart).toFixed(1);
          if (Number(_diagEndMs) > 1000) {
            console.warn(`[qclaw-plugin:content-plugin] [diag] after_tool_call SLOW tool=${_diagToolName} ${_diagEndMs}ms`);
          }
        }, { priority: 200 })
      }

      // ================================================================
      // 6. subagent_spawned — 创建子 invoke_agent span
      // ================================================================
      ctx.onHook('subagent_spawned', async (event: Record<string, unknown>, hookCtx) => {
        const tracer = getTracer()
        if (!tracer) return

        const galileoCfg = getGalileoConfig()
        const genAi = galileoCfg?.galileo.trace.genAi

        const subagentKey = spanKey('subagent', event.childSessionKey as string)
        const agentKey = spanKey('agent', (hookCtx as any).requesterSessionKey || (event.childSessionKey as string))
        const parentRunId = sessionRunIdMap.get((hookCtx as any).requesterSessionKey || '') ?? ''

        const parentEntry = getActiveSpanEntry(agentKey)
        const parentCtx = parentEntry?.ctx ?? ROOT_CONTEXT
        const channelId = resolveChannelId(getExternalSessionKey());
        const scenceType = resolveScenceType(channelId);
        const subagent_query_scene = resolveQueryScene({
          channelId,
          sessionKey: (hookCtx as any).requesterSessionKey || '',
          sessionId: (event.sessionId as string) || (hookCtx as any).sessionId || '',
          trigger: (hookCtx as any).requesterSessionKey ? getSessionTrigger((hookCtx as any).requesterSessionKey) : undefined,
          traceId: parentRunId || undefined,
        })

        const span = tracer.startSpan(
          `invoke_agent ${event.agentId}`,
          {
            kind: SpanKind.CLIENT,
            attributes: {
              'gen_ai.operation.name': 'invoke_agent',
              'gen_ai.system': genAi?.system || 'openclaw',
              'gen_ai.agent.name': (event.agentId as string) ?? '',
              'gen_ai.agent.id': (event.agentId as string) ?? '',
              'gen_ai.app.name': genAi?.appName || 'openclaw',
              'gen_ai.conversation.id': (event.childSessionKey as string) ?? '',
              'openclaw.session_key': (hookCtx as any).requesterSessionKey ?? (event.childSessionKey as string) ?? '',
              'openclaw.run_id': parentRunId,
              'openclaw.subagent.run_id': (event.runId as string) ?? '',
              'openclaw.subagent.mode': (event.mode as string) ?? '',
              'openclaw.subagent.label': (event.label as string) ?? '',
              'openclaw.guid': getExternalGuid() ?? '',
              'openclaw.uid': getExternalUid() ?? '',
              'openclaw.app_version': getExternalAppVersion() ?? '',
              'openclaw.openclaw_version': getOpenclawVersion() ?? '',
              'openclaw.prompt_id': getExternalPromptId() ?? '',
              'openclaw.wechat_session_id': getExternalWechatSessionId() ?? '',
              "openclaw.scence_type": scenceType,
              "openclaw.query_scene": subagent_query_scene || QueryScene.OTHERS,
              "openclaw.channel_id": channelId,
              "openclaw.channel_session_id": getExternalWechatSessionId() ?? "",
              "openclaw.channel_request_id": getExternalPromptId() ?? "",
              "openclaw.stage": "subagent_spawned",
              "openclaw.status": "success",
            },
          },
          parentCtx,
        )

        span.addEvent('gen_ai.invoke_agent_request', {
          'message.detail': safeAttr({
            agentId: event.agentId,
            mode: event.mode,
            label: event.label,
          }),
        })

        setActiveSpan(subagentKey, span, parentCtx)
      }, { priority: 300 })

      // ================================================================
      // 7. subagent_ended — 结束子 invoke_agent span
      // ================================================================
      ctx.onHook('subagent_ended', async (event: Record<string, unknown>) => {
        const subagentKey = spanKey('subagent', event.targetSessionKey as string)
        const entry = removeActiveSpan(subagentKey)
        if (!entry) return

        const { span } = entry
        span.addEvent('gen_ai.invoke_agent_response', {
          'message.detail': safeAttr({ reason: event.reason, outcome: event.outcome }),
        })

        if (event.outcome === 'error' || event.outcome === 'timeout') {
          span.setStatus({ code: SpanStatusCode.ERROR, message: (event.error as string) ?? (event.outcome as string) })
          if (event.error) span.setAttribute('error.type', String(event.error))
        }
        span.end()
      }, { priority: 300 })

      // ================================================================
      // 8. agent_end — 结束 root span + Skill 检测 + Agent Metrics
      // ================================================================
      ctx.onHook('agent_end', async (event: Record<string, unknown>, hookCtx) => {
        const _diagStart = performance.now();
        const _diagAgentId = String(event.agentId || hookCtx.agentId || 'unknown');
        const agentKey = spanKey('agent', hookCtx.sessionKey || (hookCtx as any).sessionId)
        const entry = removeActiveSpan(agentKey)
        if (!entry) return

        clearCurrentAgentCtx()

        const sessionKey = hookCtx.sessionKey || (hookCtx as any).sessionId
        const runId = event.runId || (hookCtx as any).runId || (sessionRunIdMap.get(sessionKey || '') ?? '')
        clearCurrentLlmAuditContext(runId || undefined)
        if (sessionKey) sessionRunIdMap.delete(sessionKey)

        // ─── 清理 runId → traceId 映射缓存 ───
        // 从 sessionTraceKeyMap 获取 before_agent_start 中实际写入 runTraceIdMap 的 key，
        // 确保清理的是同一个 key（解决 before_agent_start 用 sessionKey、agent_end 用 runId 的不匹配问题）
        const traceIdKey = sessionTraceKeyMap.get(sessionKey || '')
        if (traceIdKey) {
          // clearTraceIdForRun(traceIdKey)
          sessionTraceKeyMap.delete(sessionKey || '')
        }
        sessionClientTraceIdMap.delete(sessionKey || '')
        clearActiveRunId()

        const { span, ctx: agentSpanCtx } = entry

        span.addEvent('gen_ai.invoke_agent_response', {
          'message.detail': safeAttr({
            success: event.success,
            message_count: (event.messages as any[])?.length ?? 0,
            duration_ms: event.durationMs ?? 0,
          }),
        })

        const accumulatedUsage = agentUsageMap.get(agentKey) ?? { inputTokens: 0, outputTokens: 0 }
        agentUsageMap.delete(agentKey)

        // ─── 精细化 query scene 判定（agent_end 时可获取更完整的上下文）───
        const channelId = resolveChannelId(getExternalSessionKey())
        const query_scene = resolveQueryScene({
          channelId,
          sessionKey: hookCtx.sessionKey,
          sessionId: (event.sessionId as string) || (hookCtx as any).sessionId || '',
          trigger: hookCtx.sessionKey ? getSessionTrigger(hookCtx.sessionKey) : undefined,
          traceId: runId ? String(runId) : undefined,
        })
        // 清理 session trigger 缓存
        if (hookCtx.sessionKey) {
          clearSessionTrigger(hookCtx.sessionKey)
        }

        span.setAttributes({
          'openclaw.duration_ms': (event.durationMs as number) ?? 0,
          'gen_ai.usage.input_tokens': accumulatedUsage.inputTokens,
          'gen_ai.usage.output_tokens': accumulatedUsage.outputTokens,
          // ★ 覆写 before_agent_start 时因时序问题可能写入空值/占位符的字段
          // agent_end 时 report.data 已到达，state 中的值是正确的
          'openclaw.guid': getExternalGuid() ?? '',
          'openclaw.uid': getExternalUid() ?? '',
          'gen_ai.user.id': getExternalUid() ?? '',
          'openclaw.app_version': getExternalAppVersion() ?? '',
          'openclaw.query_scene': query_scene || QueryScene.OTHERS,
        })

        if (!event.success && event.error) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(event.error) })
          span.setAttribute('error.type', String(event.error))
        }

        // Skill 检测 — 从 after_tool_call 实时累积中取结果
        try {
          const sessionKey = hookCtx.sessionKey || (hookCtx as any).sessionId || ''
          const detectedSkills = skillDetector.flush(sessionKey)

          if (detectedSkills.length > 0) {
            const tracer = getTracer()
            const galileoCfg = getGalileoConfig()
            const genAi = galileoCfg?.galileo.trace.genAi
            const channelId = resolveChannelId(getExternalSessionKey());
            const scenceType = resolveScenceType(channelId);
            for (const skill of detectedSkills) {
              if (tracer) {
                const skillSpan = tracer.startSpan(
                  `execute_skill ${skill.name}`,
                  {
                    kind: SpanKind.CLIENT,
                    attributes: {
                      'gen_ai.operation.name': 'execute_skill',
                      'gen_ai.skill.name': skill.name,
                      'gen_ai.skill.description': skill.description ?? '',
                      'gen_ai.system': genAi?.system || 'openclaw',
                      'gen_ai.app.name': genAi?.appName || 'openclaw',
                      'gen_ai.conversation.id': hookCtx.sessionKey || '',
                      'gen_ai.user.id': getExternalUid() || '',
                      'openclaw.session_key': hookCtx.sessionKey ?? '',
                      'openclaw.run_id': runId,
                      'openclaw.skill.source_tool': skill.sourceTool,
                      'openclaw.skill.tool_call_id': skill.toolCallId,
                      'openclaw.skill.detection_source': 'after_tool_call_realtime',
                      'openclaw.guid': getExternalGuid() ?? '',
                      'openclaw.uid': getExternalUid() ?? '',
                      'openclaw.app_version': getExternalAppVersion() ?? '',
                      'openclaw.source_terminal': getExternalSourceTerminal() ?? '',
                      'openclaw.openclaw_version': getOpenclawVersion() ?? '',
                      'openclaw.prompt_id': getExternalPromptId() ?? '',
                      'openclaw.wechat_session_id': getExternalWechatSessionId() ?? '',
                      "openclaw.query_scene": query_scene || QueryScene.OTHERS,
                      "openclaw.scence_type": scenceType,
                      "openclaw.channel_id": channelId,
                      "openclaw.channel_session_id": getExternalWechatSessionId() ?? "",
                      "openclaw.channel_request_id": getExternalPromptId() ?? "",
                      "openclaw.stage": "execute_skill",
                      "openclaw.status": "success",
                    },
                  },
                  agentSpanCtx,
                )
                skillSpan.addEvent('gen_ai.skill_loaded', {
                  'skill.name': skill.name,
                  'skill.source_tool': skill.sourceTool,
                  'skill.tool_call_id': skill.toolCallId,
                })
                skillSpan.end()
              }

              logger.debug(`[skill-detector][report] 上报 skill: name="${skill.name}", description="${skill.description || '(空)'}", sourceTool="${skill.sourceTool}", toolCallId="${skill.toolCallId}", session=${hookCtx.sessionKey || ''}, runId=${runId}`)

              if (galileoCfg?.galileo.metrics.enabled) {
                const metricsGenAi = galileoCfg.galileo.metrics.genAi
                logger.debug(`[skill-detector][report] galileo metrics 已启用: provider=${metricsGenAi.system}, agentName=${metricsGenAi.agentName}`)
                reportSkillMetrics({
                  provider: metricsGenAi.system,
                  skillName: skill.name,
                  userId: getExternalUid() || '',
                  agentName: metricsGenAi.agentName,
                  agentId: metricsGenAi.agentId,
                  appName: metricsGenAi.appName,
                  operationDuration: 0,
                  codeType: 'success',
                  sessionKey: hookCtx.sessionKey || '',
                  runId: runId !== 'unknown' ? runId : '',
                  skillDescription: skill.description || '',
                  appVersion: getExternalAppVersion() ?? undefined,
                  sourceTerminal: getExternalSourceTerminal() ?? undefined,
                  openclawVersion: getOpenclawVersion() ?? undefined,
                  clientTraceId: sessionClientTraceIdMap.get(hookCtx.sessionKey || '') ?? '',
                  query_scene: query_scene || QueryScene.OTHERS,
                })
              } else {
                logger.debug(`[skill-detector][report] galileo metrics 未启用, 跳过上报`)
              }
            }

            span.setAttribute('openclaw.detected_skills_count', detectedSkills.length)
            span.setAttribute('openclaw.detected_skills', detectedSkills.map((s) => s.name).join(','))
            // 将 Skill 使用记录写入本地 JSON 文件，供 UI 展示"近期使用"
            trackSkillUsage(detectedSkills.map((s) => s.name))
          }
        } catch { /* Skill 检测异常不影响 agent_end */ }

        span.end()

        // Agent Metrics
        const galileoCfg = getGalileoConfig()
        if (galileoCfg?.galileo.metrics.enabled) {
          const genAi = galileoCfg.galileo.metrics.genAi
          const durationMs = (event.durationMs as number) ?? 0
          const durationSec = durationMs / 1000
          reportAgentMetrics({
            provider: genAi.system,
            userId: getExternalUid() || '',
            agentName: genAi.agentName,
            agentId: genAi.agentId,
            appName: genAi.appName,
            isStream: true,
            promptTokens: accumulatedUsage.inputTokens,
            completionTokens: accumulatedUsage.outputTokens,
            firstTokenLatency: 0,
            operationDuration: durationSec,
            errorType: event.error ? String(event.error) : undefined,
            appVersion: getExternalAppVersion() ?? undefined,
            sourceTerminal: getExternalSourceTerminal() ?? undefined,
            openclawVersion: getOpenclawVersion() ?? undefined,
            promptId: getExternalPromptId() ?? undefined,
            wechatSessionId: getExternalWechatSessionId() ?? undefined,
            query_scene: query_scene || QueryScene.OTHERS,
          })
        }

        reportLog({
          body: `agent_end agent_id=${event.agentId || hookCtx.agentId}`,
          params: {
            logtype: 'AgentEnd',
            opname: 'chat',
            userId: getExternalUid() || '',
            stage: 'agent_end',
            runId: runId || '',
            provider: event.provider as string || '',
            model: event.model as string || '',
            sessionId: (event.sessionId as string) || (hookCtx as any).sessionId || '',
            sessionKey: hookCtx.sessionKey || '',
            query_scene: query_scene || QueryScene.OTHERS,
          }
        })
        const _diagEndMs = (performance.now() - _diagStart).toFixed(1);
        if (Number(_diagEndMs) > 1000) {
          console.warn(`[qclaw-plugin:content-plugin] [diag] agent_end SLOW agentId=${_diagAgentId} ${_diagEndMs}ms`);
        }
      }, { priority: 300 })
    }

    startPlugin()

    logger.info('setup complete')
  },
}

export default contentPlugin

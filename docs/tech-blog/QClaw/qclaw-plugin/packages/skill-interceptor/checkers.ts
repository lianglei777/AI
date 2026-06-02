/**
 * skill-interceptor — 授权状态检查函数
 *
 * 通过 Auth Gateway 代理或本地文件检查 skill 授权/绑定状态。
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { buildJprxCtxHeader } from '../pcmgr-ai-security/src/jprx-sign.js'
import type { CredentialHostedStatus, MultiBindEmailCountResult, QClawLogger } from './types.js'

/** mcporter 配置文件路径 */
const MCPORTER_CONFIG_PATH = join(homedir(), '.mcporter', 'mcporter.json')

/** wecom-cli 凭证文件路径 */
const WECOM_CLI_BOT_FILE = join(
  process.env.WECOM_CLI_CONFIG_DIR || join(homedir(), '.config', 'wecom'),
  'bot.enc',
)

/** openclaw.json 配置文件路径 (~/.qclaw/openclaw.json) */
const OPENCLAW_CONFIG_PATH = join(homedir(), '.qclaw', 'openclaw.json')

// ==================== 环境工具函数 ====================

/**
 * 获取远程 API 基础地址
 */
export function getRemoteBaseUrl(): string {
  if (process.env.BUILD_ENV === 'test') {
    return 'https://jprx.sparta.html5.qq.com'
  }
  return 'https://jprx.m.qq.com'
}

/**
 * 获取 Auth Gateway 代理本地端口
 */
export function getProxyPort(): number {
  const envPort = process.env.AUTH_GATEWAY_PORT
  if (envPort) {
    const parsed = parseInt(envPort, 10)
    if (!isNaN(parsed) && parsed > 0) return parsed
  }
  return 19000
}

// ==================== 凭证托管 OAuth 检查（4164 接口） ====================

/**
 * 通过本地 Auth Gateway 代理检查凭证托管 OAuth 应用的授权状态和开关状态
 *
 * @param platform - 凭证平台标识（如 "notion"）
 * @param logger - 日志实例
 * @param fetchFn - fetch 函数（使用原始 fetch 避免被 FetchChain 拦截）
 */
export async function checkCredentialHostedStatus(
  platform: string,
  logger: QClawLogger,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<CredentialHostedStatus> {
  const proxyPort = getProxyPort()
  const proxyUrl = `http://localhost:${proxyPort}/proxy/api`
  const remoteBaseUrl = getRemoteBaseUrl()
  const remoteUrl = `${remoteBaseUrl}/data/4164/forward`

  const body: Record<string, unknown> = {
    platform,
    web_version: '1.4.0',
    web_env: process.env.BUILD_ENV === 'test' ? 'dev' : 'release',
  }
  const bodyStr = JSON.stringify(body)

  const gid = process.env.QCLAW_USER_GUID || '1'
  const userId = process.env.QCLAW_USER_ID || '1'

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)

    logger.info(`checkCredentialHostedStatus("${platform}"): POST ${proxyUrl} → Remote-URL: ${remoteUrl}`)

    const resp = await fetchFn(proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Remote-URL': remoteUrl,
        'JPrx-Ctx': buildJprxCtxHeader(bodyStr, gid),
        'X-Version': '1',
        'X-Guid': gid,
        'X-Account': userId,
        'X-Session': '',
      },
      body: bodyStr,
      signal: controller.signal,
    })
    clearTimeout(timer)

    const text = await resp.text()

    if (resp.status === 401) {
      logger.info(`checkCredentialHostedStatus("${platform}"): Auth Gateway 返回 401 (未登录) → not authorized`)
      return { isAuthorized: false, isEnabled: false }
    }

    if (!resp.ok) {
      logger.info(`checkCredentialHostedStatus("${platform}"): HTTP ${resp.status}, body=${text || '(empty)'} → not authorized`)
      return { isAuthorized: false, isEnabled: false }
    }

    const data = text ? JSON.parse(text) : null

    const ret = data?.ret
    if (ret !== 0) {
      logger.info(`checkCredentialHostedStatus("${platform}"): ret=${ret}, msg=${data?.msg} → not authorized`)
      return { isAuthorized: false, isEnabled: false }
    }

    const respData = data?.data?.resp?.data ?? data?.data?.data ?? data?.data
    const isAuthorized = !!respData?.is_authorized
    const isEnabled = respData?.is_enabled !== false
    const rawExpired = respData?.is_expired
    const isExpired = rawExpired === true || rawExpired === 1 || rawExpired === 'true'
      ? true
      : (rawExpired === false || rawExpired === 0 || rawExpired === 'false' ? false : undefined)

    logger.info(`checkCredentialHostedStatus("${platform}"): is_authorized=${respData?.is_authorized}, is_enabled=${respData?.is_enabled}, is_expired=${respData?.is_expired} → authorized=${isAuthorized}, enabled=${isEnabled}, expired=${isExpired}`)
    return { isAuthorized, isEnabled, isExpired, accessToken: isAuthorized ? (respData?.access_token ?? undefined) : undefined }
  } catch (err) {
    logger.info(`checkCredentialHostedStatus("${platform}"): ERROR ${err} → not authorized`)
    return { isAuthorized: false, isEnabled: false }
  }
}

// ==================== 公邮绑定状态检查（4227 接口） ====================

/**
 * 通过本地 Auth Gateway 代理检查平台公邮绑定状态（4227 接口）
 */
export async function checkPublicMailBound(
  logger: QClawLogger,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<CredentialHostedStatus> {
  const proxyPort = getProxyPort()
  const proxyUrl = `http://localhost:${proxyPort}/proxy/api`
  const remoteBaseUrl = getRemoteBaseUrl()
  const remoteUrl = `${remoteBaseUrl}/data/4227/forward`

  const bodyStr = JSON.stringify({})
  const gid = process.env.QCLAW_USER_GUID || '1'
  const userId = process.env.QCLAW_USER_ID || '1'

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)

    logger.info(`checkPublicMailBound: POST ${proxyUrl} → Remote-URL: ${remoteUrl}`)

    const resp = await fetchFn(proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Remote-URL': remoteUrl,
        'JPrx-Ctx': buildJprxCtxHeader(bodyStr, gid),
        'X-Version': '1',
        'X-Guid': gid,
        'X-Account': userId,
        'X-Session': '',
      },
      body: bodyStr,
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (resp.status === 401) {
      logger.info(`checkPublicMailBound: Auth Gateway 返回 401 (未登录) → not bound`)
      return { isAuthorized: false, isEnabled: false }
    }

    if (!resp.ok) {
      const text = await resp.text()
      logger.info(`checkPublicMailBound: HTTP ${resp.status}, body=${text || '(empty)'} → not bound`)
      return { isAuthorized: false, isEnabled: false }
    }

    const text = await resp.text()
    const data = text ? JSON.parse(text) : null

    if (data?.ret !== 0) {
      logger.info(`checkPublicMailBound: ret=${data?.ret}, msg=${data?.msg} → not bound`)
      return { isAuthorized: false, isEnabled: false }
    }

    const respObj = data?.data?.resp ?? {}
    const common = respObj?.common ?? {}
    if (String(common?.code) !== '0') {
      logger.info(`checkPublicMailBound: common.code=${common?.code}, message=${common?.message} → not bound`)
      return { isAuthorized: false, isEnabled: false }
    }

    const respData = respObj?.data ?? {}
    const extraData = respData?.extra_data ?? {}
    const email = extraData?.email || extraData?.email_address || respData?.email || respData?.email_address

    if (email) {
      const isEnabled = respData?.is_enabled !== false
      logger.info(`checkPublicMailBound: email="${email}", is_enabled=${respData?.is_enabled} → authorized=true, enabled=${isEnabled}`)
      return { isAuthorized: true, isEnabled }
    }

    logger.info(`checkPublicMailBound: no email found in response → not bound`)
    return { isAuthorized: false, isEnabled: false }
  } catch (err) {
    logger.info(`checkPublicMailBound: ERROR ${err} → not bound`)
    return { isAuthorized: false, isEnabled: false }
  }
}

// ==================== multi-bind 模式查询（4230 接口） ====================

/**
 * 通过本地 Auth Gateway 代理查询已绑定邮箱平台数量
 */
export async function checkMultiBindEmailCount(
  allowedPlatforms: string[],
  logger: QClawLogger,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<MultiBindEmailCountResult> {
  const proxyPort = getProxyPort()
  const proxyUrl = `http://localhost:${proxyPort}/proxy/api`
  const remoteBaseUrl = getRemoteBaseUrl()
  const remoteUrl = `${remoteBaseUrl}/data/4230/forward`

  const bodyStr = JSON.stringify({})
  const gid = process.env.QCLAW_USER_GUID || '1'
  const userId = process.env.QCLAW_USER_ID || '1'

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)

    logger.info(`checkMultiBindEmailCount: POST ${proxyUrl} → Remote-URL: ${remoteUrl}`)

    const resp = await fetchFn(proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Remote-URL': remoteUrl,
        'JPrx-Ctx': buildJprxCtxHeader(bodyStr, gid),
        'X-Version': '1',
        'X-Guid': gid,
        'X-Account': userId,
        'X-Session': '',
      },
      body: bodyStr,
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!resp.ok) {
      logger.info(`checkMultiBindEmailCount: HTTP ${resp.status} → count=0`)
      return { count: 0 }
    }

    const text = await resp.text()
    const data = text ? JSON.parse(text) : null

    if (data?.ret !== 0) {
      logger.info(`checkMultiBindEmailCount: ret=${data?.ret} → count=0`)
      return { count: 0 }
    }

    const respData = data?.data?.resp?.data ?? data?.data?.data ?? data?.data
    const rawPlatforms: Array<{ platform?: string; is_enabled?: boolean }> = Array.isArray(respData?.platforms) ? respData.platforms : []

    const allowedSet = new Set(allowedPlatforms)
    const matchedCount = rawPlatforms.filter(
      (p) => p.platform && allowedSet.has(p.platform) && p.is_enabled !== false,
    ).length

    logger.info(`checkMultiBindEmailCount: rawPlatforms=${JSON.stringify(rawPlatforms.map(p => `${p.platform}(enabled=${p.is_enabled})`))} allowed=${JSON.stringify(allowedPlatforms)}, matchedCount=${matchedCount}`)
    return { count: matchedCount }
  } catch (err) {
    logger.info(`checkMultiBindEmailCount: ERROR ${err} → count=0`)
    return { count: 0 }
  }
}

// ==================== mcporter 模式授权检查 ====================

/**
 * 检查 skill 对应的集成应用是否已完成 OAuth 授权（mcporter 模式）
 *
 * 通过读取 ~/.mcporter/mcporter.json 中对应 mcpServer 的 Authorization token 判断。
 */
export function isMcporterAuthorized(skillName: string, logger: QClawLogger): boolean {
  try {
    if (!existsSync(MCPORTER_CONFIG_PATH)) {
      logger.info(`isMcporterAuthorized("${skillName}"): mcporter.json NOT FOUND → false`)
      return false
    }
    const raw = readFileSync(MCPORTER_CONFIG_PATH, 'utf-8')
    const config = JSON.parse(raw)
    const token = config?.mcpServers?.[skillName]?.headers?.['Authorization']
    const authorized = Boolean(token && typeof token === 'string' && token.trim() !== '')
    logger.info(`isMcporterAuthorized("${skillName}"): token=${token ? `"${String(token).slice(0, 8)}..."` : 'null/undefined'} → ${authorized}`)
    return authorized
  } catch (err) {
    logger.info(`isMcporterAuthorized("${skillName}"): ERROR ${err} → false`)
    return false
  }
}

// ==================== wecom-cli 模式授权检查 ====================

/**
 * 检查企业微信 CLI 是否已完成授权（本地 bot.enc 检查）
 */
export function isWecomCliAuthorized(logger: QClawLogger): boolean {
  try {
    const exists = existsSync(WECOM_CLI_BOT_FILE)
    logger.info(`isWecomCliAuthorized(): bot.enc path="${WECOM_CLI_BOT_FILE}", exists=${exists}`)
    return exists
  } catch (err) {
    logger.info(`isWecomCliAuthorized(): ERROR ${err} → false`)
    return false
  }
}

// ==================== openclaw.json skills.entries 开关检查 ====================

/**
 * 从 openclaw.json 的 skills.entries 读取指定 skill 的本地开关状态。
 *
 * 优先级与 UI 层 resolveSkillEnabled 一致：
 *   1. skills.entries 中有明确配置 → 使用配置值（enabled !== false → true）
 *   2. 无配置 → 默认启用（true）
 */
export function readSkillEntryEnabled(skillName: string, logger: QClawLogger): boolean {
  try {
    if (!existsSync(OPENCLAW_CONFIG_PATH)) {
      return true
    }
    const raw = readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8')
    const config = JSON.parse(raw)
    const entries = config?.skills?.entries
    if (!entries || typeof entries !== 'object') {
      return true
    }
    const entryKey = Object.keys(entries).find(
      (k) => k.toLowerCase() === skillName.toLowerCase(),
    )
    if (entryKey === undefined) {
      return true
    }
    return entries[entryKey]?.enabled !== false
  } catch (err) {
    logger.info(`readSkillEntryEnabled("${skillName}"): ERROR ${err} → default true`)
    return true
  }
}

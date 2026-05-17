/**
 * skill-interceptor — Token 回写函数
 *
 * 将后端凭证托管服务（4164 接口）返回的 access_token 回写到本地配置文件，
 * 确保 mcporter / bdpan CLI 运行时可用。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { McporterWritebackProfile, QClawLogger } from './types.js'

/** mcporter 配置文件路径 */
const MCPORTER_CONFIG_PATH = join(homedir(), '.mcporter', 'mcporter.json')

/** bdpan CLI 配置目录 & 文件路径 */
const BDPAN_CONFIG_DIR = join(homedir(), '.config', 'bdpan')
const BDPAN_CONFIG_PATH_LOCAL = join(BDPAN_CONFIG_DIR, 'config.json')

// ==================== mcporter 回写配置表 ====================

export const MCPORTER_WRITEBACK_PROFILES: Record<string, McporterWritebackProfile> = {
  'tencent-docs': {
    serviceName: 'tencent-docs',
    mcpUrl: 'https://docs.qq.com/openapi/mcp',
    tokenPrefix: '',
    additionalServices: [
      { serviceName: 'tencent-docengine', mcpUrl: 'https://docs.qq.com/api/v6/doc/mcp' },
    ],
  },
  'tencent-survey': {
    serviceName: 'tencent-survey',
    mcpUrl: 'https://wj.qq.com/api/v2/mcp',
    tokenPrefix: 'Bearer ',
  },
  'kdocs': {
    serviceName: 'kdocs-qclaw',
    mcpUrl: 'https://mcp-center.wps.cn/skill_hub/mcp',
    tokenPrefix: 'Bearer ',
    extraHeaders: { 'X-Skill-Version': '1.3.6' },
  },
  'weiyun': {
    serviceName: 'weiyun',
    mcpUrl: 'https://www.weiyun.com/api/v3/mcpserver',
    tokenPrefix: '',
    tokenHeaderName: 'WyHeader',
    tokenHeaderFormat: 'mcp_token={token}',
  },
}

/** 需要回写 bdpan CLI config.json 的 skill 集合 */
export const BDPAN_WRITEBACK_SKILLS = new Set(['bdpan-storage'])

// ==================== bdpan CLI 回写 ====================

/**
 * 检查本地 bdpan CLI config.json 中是否有有效的 access_token
 */
export function hasBdpanConfig(): boolean {
  try {
    if (!existsSync(BDPAN_CONFIG_PATH_LOCAL)) return false
    const raw = readFileSync(BDPAN_CONFIG_PATH_LOCAL, 'utf-8')
    const config = JSON.parse(raw)
    const token = config?.auth?.access_token
    return Boolean(token && typeof token === 'string' && token.trim() !== '')
  } catch {
    return false
  }
}

/**
 * 将 access_token 写入 bdpan CLI 本地 config.json（明文 JSON 格式）
 */
export function writeBdpanConfigLocal(
  accessToken: string,
  logger: QClawLogger,
): void {
  try {
    let config: Record<string, unknown> = {}
    try {
      if (existsSync(BDPAN_CONFIG_PATH_LOCAL)) {
        const raw = readFileSync(BDPAN_CONFIG_PATH_LOCAL, 'utf-8')
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          config = parsed
        }
      }
    } catch { /* 解析失败用新的 */ }

    const expiresIn = 2592000 // 30 天
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()

    config.auth = {
      access_token: accessToken,
      refresh_token: '',
      expires_in: expiresIn,
      expires_at: expiresAt,
    }

    if (!existsSync(BDPAN_CONFIG_DIR)) {
      mkdirSync(BDPAN_CONFIG_DIR, { recursive: true, ...(process.platform !== 'win32' && { mode: 0o700 }) })
    }

    writeFileSync(
      BDPAN_CONFIG_PATH_LOCAL,
      JSON.stringify(config, null, 2),
      process.platform === 'win32' ? 'utf-8' : { encoding: 'utf-8', mode: 0o600 },
    )
    logger.info(`writeBdpanConfigLocal: config.json 已回写到 ${BDPAN_CONFIG_PATH_LOCAL}`)
  } catch (err) {
    logger.info(`writeBdpanConfigLocal: ERROR ${err}`)
  }
}

/**
 * credential-hosted 放行时，尝试回写 bdpan CLI config.json
 */
export function tryWritebackBdpanConfig(
  skillName: string,
  accessToken: string | undefined,
  logger: QClawLogger,
): void {
  if (!BDPAN_WRITEBACK_SKILLS.has(skillName)) return
  if (!accessToken) {
    logger.info(`tryWritebackBdpanConfig("${skillName}"): 后端未返回 access_token，跳过回写`)
    return
  }
  if (hasBdpanConfig()) {
    logger.info(`tryWritebackBdpanConfig("${skillName}"): 本地已有配置，跳过回写`)
    return
  }
  logger.info(`tryWritebackBdpanConfig("${skillName}"): 本地无配置，从后端回写...`)
  writeBdpanConfigLocal(accessToken, logger)
}

// ==================== mcporter 回写 ====================

/**
 * 检查本地 mcporter.json 中指定 skill 是否有 token
 */
export function hasMcporterToken(profile: McporterWritebackProfile): boolean {
  try {
    if (!existsSync(MCPORTER_CONFIG_PATH)) return false
    const raw = readFileSync(MCPORTER_CONFIG_PATH, 'utf-8')
    const config = JSON.parse(raw)
    const headerName = profile.tokenHeaderName ?? 'Authorization'
    const headerValue = config?.mcpServers?.[profile.serviceName]?.headers?.[headerName]
    return Boolean(headerValue && typeof headerValue === 'string' && headerValue.trim() !== '')
  } catch {
    return false
  }
}

/**
 * 将 access_token 写入本地 mcporter.json
 */
export function writeTokenToMcporter(
  profile: McporterWritebackProfile,
  accessToken: string,
  logger: QClawLogger,
): void {
  try {
    const configDir = join(homedir(), '.mcporter')
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true, ...(process.platform !== 'win32' && { mode: 0o700 }) })
    }

    let config: Record<string, unknown> = { mcpServers: {}, imports: [] }
    try {
      if (existsSync(MCPORTER_CONFIG_PATH)) {
        config = JSON.parse(readFileSync(MCPORTER_CONFIG_PATH, 'utf-8')) as Record<string, unknown>
      }
    } catch { /* 配置损坏用新的 */ }

    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {}
    }
    const servers = config.mcpServers as Record<string, unknown>
    const headerName = profile.tokenHeaderName ?? 'Authorization'
    const headerValue = profile.tokenHeaderFormat
      ? profile.tokenHeaderFormat.replace('{token}', accessToken)
      : `${profile.tokenPrefix}${accessToken}`
    const headers: Record<string, string> = { [headerName]: headerValue }
    if (profile.extraHeaders) {
      for (const [k, v] of Object.entries(profile.extraHeaders)) {
        headers[k] = v
      }
    }
    servers[profile.serviceName] = {
      baseUrl: profile.mcpUrl,
      headers,
    }
    // 写入额外的 service（如腾讯文档的 tencent-docengine）
    if (profile.additionalServices) {
      for (const extra of profile.additionalServices) {
        servers[extra.serviceName] = {
          baseUrl: extra.mcpUrl,
          headers: { ...headers },
        }
      }
    }
    writeFileSync(
      MCPORTER_CONFIG_PATH,
      JSON.stringify(config, null, 2),
      process.platform === 'win32' ? 'utf-8' : { encoding: 'utf-8', mode: 0o600 },
    )
    logger.info(`writeTokenToMcporter("${profile.serviceName}"): token 已回写到 mcporter.json`)
  } catch (err) {
    logger.info(`writeTokenToMcporter("${profile.serviceName}"): ERROR ${err}`)
  }
}

/**
 * credential-hosted 放行时，尝试回写 mcporter.json
 */
export function tryWritebackMcporterToken(
  skillName: string,
  accessToken: string | undefined,
  logger: QClawLogger,
): void {
  const profile = MCPORTER_WRITEBACK_PROFILES[skillName]
  if (!profile) return
  if (!accessToken) {
    logger.info(`tryWritebackMcporterToken("${skillName}"): 后端未返回 access_token，跳过回写`)
    return
  }
  if (hasMcporterToken(profile)) {
    logger.info(`tryWritebackMcporterToken("${skillName}"): 本地已有 token，跳过回写`)
    return
  }
  logger.info(`tryWritebackMcporterToken("${skillName}"): 本地无 token，从后端回写...`)
  writeTokenToMcporter(profile, accessToken, logger)
}

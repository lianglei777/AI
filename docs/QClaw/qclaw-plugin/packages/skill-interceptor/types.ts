/**
 * skill-interceptor — 类型定义
 */

/** 插件配置接口 */
export interface SkillInterceptorConfig {
  /** 需要阻断的 skill 名称列表。为空或未配置时阻断全部 skill */
  blockedSkills?: string[]
  /**
   * 凭证托管 OAuth 应用映射：skill 名称 → credentialPlatform 或 credentialPlatform[]
   * 在此映射中的 skill 通过本地 Auth Gateway 代理调 data/4164/forward 接口检查授权状态，
   * 不在此映射中的 skill 通过 mcporter.json 检查。
   *
   * 当值为字符串数组时（如 email-skill → ["163_mail", "qq_mail", ...]），
   * 表示该 skill 对应多个 platform（多绑定模式），任一 platform 已授权即视为已授权。
   */
  credentialHostedSkills?: Record<string, string | string[]>
  /**
   * 授权码（manual-code）模式的 skill 列表。
   *
   * 这些 skill 对应的集成应用使用授权码/Token 手动输入模式（如 163邮箱、QQ邮箱、腾讯会议等），
   * 用户可以在非 PC 端自行完成授权码配置，因此非 PC 端渠道不拦截。
   */
  manualCodeSkills?: string[]
  /**
   * 企业微信 CLI 模式的 skill 列表。
   *
   * 这些 skill 通过检查本地 ~/.config/wecom/bot.enc 文件是否存在来判断授权状态，
   * 不走 mcporter.json 也不走 credential-hosted OAuth（4164 接口）。
   */
  wecomCliSkills?: string[]
  /** 仅记录日志、不阻断（调试模式） */
  logOnly?: boolean
}

/** 凭证托管 OAuth 应用授权状态检查结果 */
export interface CredentialHostedStatus {
  /** 是否已完成授权 */
  isAuthorized: boolean
  /** 授权开关是否已开启（仅在 isAuthorized=true 时有意义） */
  isEnabled: boolean
  /** 授权是否已过期（后端 is_expired 字段） */
  isExpired?: boolean
  /** 后端返回的 access_token（已授权时才有，用于回写本地 mcporter.json） */
  accessToken?: string
}

/** multi-bind 邮箱绑定数量查询结果 */
export interface MultiBindEmailCountResult {
  /** 已绑定的个人邮箱平台数量（仅匹配 allowedPlatforms 中的平台） */
  count: number
}

/** Skill 状态检查结果 */
export interface SkillStatus {
  /** 是否已完成授权 */
  authorized: boolean
  /** 授权开关是否已开启（仅在 authorized=true 时有意义） */
  enabled: boolean
  /** 授权是否已过期 */
  isExpired?: boolean
}

/** mcporter 回写配置 */
export interface McporterWritebackProfile {
  /** mcpServers 中的 service name（如 "tencent-docs"） */
  serviceName: string
  /** MCP 端点 URL */
  mcpUrl: string
  /** token 写入 Authorization header 时的前缀（如 "Bearer "） */
  tokenPrefix: string
  /** 自定义 header 名称（默认 "Authorization"） */
  tokenHeaderName?: string
  /** 自定义 header 值格式模板，{token} 为占位符 */
  tokenHeaderFormat?: string
  /** 额外的 headers（如 X-Skill-Version） */
  extraHeaders?: Record<string, string>
  /** 同一个 token 需要同时写入的额外 service（如腾讯文档的 tencent-docengine） */
  additionalServices?: Array<{ serviceName: string; mcpUrl: string }>
}

/** 日志接口类型（复用 QClawLogger） */
export type { QClawLogger } from '../../core/types.js'

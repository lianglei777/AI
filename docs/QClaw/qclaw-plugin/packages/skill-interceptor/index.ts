/**
 * skill-interceptor — Skill 拦截器 QClawPackage
 *
 * 在 before_tool_call 钩子中拦截三类 Skill 调用并阻断：
 *   ① use_skill — LLM 直接调用 skill
 *   ② read / read_file / with — LLM 通过 read 工具读取 skill 目录下的任意文件
 *   ③ exec / bash / execute_command — LLM 通过 shell 执行 mcporter call/list 命令
 *
 * 拦截策略（按请求来源分两条路径）：
 *
 *   ┌──────────────┬────────────────────┬────────────────────────────────────┐
 *   │ 来源          │ 已授权且已开启      │ 未授权 / 已授权但未开启              │
 *   ├──────────────┼────────────────────┼────────────────────────────────────┤
 *   │ PC 端（主端）  │ 放行               │ 弹授权卡片 / 开启卡片（标记）         │
 *   │ 非PC-授权码   │ 放行               │ 放行（用户可在任意端完成授权码配置）    │
 *   │ 非PC-OAuth    │ 放行               │ 返回文字：请在 PC 端 QClaw 连接应用   │
 *   └──────────────┴────────────────────┴────────────────────────────────────┘
 *
 * 授权检查策略：
 *   - wecom-cli 模式：检查本地 ~/.config/wecom/bot.enc
 *   - public-mail 模式：调 4227 接口
 *   - multi-bind 模式：调 4230 接口
 *   - credential-hosted 模式（如 notion）：调 4164 接口
 *   - mcporter 默认模式：读 ~/.mcporter/mcporter.json
 */

import type { QClawPackage, QClawContext, HookHandlerResult } from '../../core/types.js'
import type { SkillStatus } from './types.js'
import {
  parseMcporterSkillName,
  parseSkillEntryScriptName,
  parseSkillNameFromPath,
  shouldBlock,
  extractFilePath,
  isPCChannel,
} from './parsers.js'
import {
  buildBlockResult,
  buildEnableBlockResult,
  buildExternalChannelBlockResult,
} from './block-builders.js'
import {
  checkCredentialHostedStatus,
  checkPublicMailBound,
  checkMultiBindEmailCount,
  isMcporterAuthorized,
  isWecomCliAuthorized,
  readSkillEntryEnabled,
} from './checkers.js'
import {
  tryWritebackMcporterToken,
  tryWritebackBdpanConfig,
} from './writeback.js'
import { DEFAULT_CONFIG } from './defaults.js'

// ---- 工具名常量 ----
const READ_TOOLS = new Set(['read', 'read_file', 'with'])
const USE_SKILL_TOOL = 'use_skill'
const EXEC_TOOLS = new Set(['exec', 'bash', 'execute_command'])

// ---- Priority 分配 ----
// skill-interceptor 在安全审核之后、telemetry 之前
// 参照 pcmgr-ai-security=250，此处取 280
const HOOK_PRIORITY = 280

const skillInterceptor: QClawPackage = {
  id: 'skill-interceptor',
  name: 'Skill 拦截器',
  description: '拦截 use_skill、read skill 目录文件、exec skill 脚本三种调用，根据配置阻断指定 Skill 的加载',

  configSchema: {
    type: 'object',
    additionalProperties: false as const,
    properties: {},
  },

  setup(ctx: QClawContext): void {
    // 配置直接从内部 defaults.ts 维护，不依赖外部配置文件
    const config = DEFAULT_CONFIG
    const blockedSkills = config.blockedSkills
    const manualCodeSkills = new Set(config.manualCodeSkills ?? [])
    const wecomCliSkills = new Set(config.wecomCliSkills ?? [])

    // 深拷贝 credentialHostedSkills，避免修改原始 pluginConfig 对象
    const credentialHostedSkills: Record<string, string | string[]> = {
      ...(config.credentialHostedSkills ?? {}),
    }

    // "__multi_bind__" 占位符 → 展开为真正的个人邮箱 platform 列表
    if (credentialHostedSkills['imap-smtp-email'] === '__multi_bind__') {
      credentialHostedSkills['imap-smtp-email'] = [
        '163_mail', 'qq_mail', 'gmail', 'outlook', 'sina_mail', 'sohu_mail',
      ]
    }

    const logOnly = config.logOnly ?? false

    // 会话级缓存：记录已弹过 multi-bind 选择卡片的 session + skill 组合
    const multiBindShownCache = new Map<string, Set<string>>()

    // 获取原始 fetch（绕过 FetchChain，避免请求被其他中间件拦截）
    const originalFetch = ctx.getOriginalFetch()

    /**
     * 统一的 skill 状态检查入口
     */
    async function checkSkillStatus(
      skillName: string,
      triggerType: 'use_skill' | 'read_file' | 'exec' = 'use_skill',
      sessionKey?: string,
    ): Promise<SkillStatus> {
      // wecom-cli 模式
      if (wecomCliSkills.has(skillName)) {
        const authorized = isWecomCliAuthorized(ctx.logger)
        const enabled = authorized ? readSkillEntryEnabled(skillName, ctx.logger) : false
        ctx.logger.info(`checkSkillStatus("${skillName}"): wecom-cli mode, authorized=${authorized}, enabled=${enabled}`)
        return { authorized, enabled }
      }

      const credentialPlatform = credentialHostedSkills[skillName]

      if (credentialPlatform) {
        // public-mail 模式
        if (credentialPlatform === '__public_mail_4227__') {
          const status = await checkPublicMailBound(ctx.logger, originalFetch)
          return { authorized: status.isAuthorized, enabled: status.isEnabled }
        }

        // 多绑定模式
        if (Array.isArray(credentialPlatform)) {
          const { count } = await checkMultiBindEmailCount(credentialPlatform, ctx.logger, originalFetch)
          if (count === 0) {
            if (sessionKey) {
              if (!multiBindShownCache.has(sessionKey)) {
                multiBindShownCache.set(sessionKey, new Set())
              }
              multiBindShownCache.get(sessionKey)!.add(skillName)
              ctx.logger.info(`checkSkillStatus("${skillName}"): multi-bind count=0, trigger=${triggerType} → block, show bind card (cached)`)
            } else {
              ctx.logger.info(`checkSkillStatus("${skillName}"): multi-bind count=0, trigger=${triggerType} → block, show bind card (not cached)`)
            }
            return { authorized: false, enabled: false }
          }
          if (count === 1) {
            ctx.logger.info(`checkSkillStatus("${skillName}"): multi-bind count=1 → authorized, pass through`)
            return { authorized: true, enabled: true }
          }

          // ≥2 个绑定：先检查会话级缓存
          if (sessionKey) {
            if (multiBindShownCache.get(sessionKey)?.has(skillName)) {
              ctx.logger.info(`checkSkillStatus("${skillName}"): multi-bind count=${count}, sessionKey="${sessionKey}" cache HIT → pass through`)
              return { authorized: true, enabled: true }
            }
          } else {
            ctx.logger.info(`checkSkillStatus("${skillName}"): multi-bind count=${count}, sessionKey is undefined`)
          }

          // exec 触发时放行
          if (triggerType === 'exec') {
            ctx.logger.info(`checkSkillStatus("${skillName}"): multi-bind count=${count}, trigger=exec → pass through`)
            return { authorized: true, enabled: true }
          }

          // use_skill / read_file 触发 → block（弹选择卡片）
          if (sessionKey) {
            if (!multiBindShownCache.has(sessionKey)) {
              multiBindShownCache.set(sessionKey, new Set())
            }
            multiBindShownCache.get(sessionKey)!.add(skillName)
            ctx.logger.info(`checkSkillStatus("${skillName}"): multi-bind count=${count}, trigger=${triggerType}, sessionKey="${sessionKey}" → block, show select card (cached)`)
          } else {
            ctx.logger.info(`checkSkillStatus("${skillName}"): multi-bind count=${count}, trigger=${triggerType}, no sessionKey → block, show select card (not cached)`)
          }
          return { authorized: false, enabled: false }
        }

        // 单平台模式
        const status = await checkCredentialHostedStatus(credentialPlatform, ctx.logger, originalFetch)

        // 已授权放行时，尝试回写本地配置
        if (status.isAuthorized && status.isEnabled) {
          tryWritebackMcporterToken(skillName, status.accessToken, ctx.logger)
          tryWritebackBdpanConfig(skillName, status.accessToken, ctx.logger)
        }

        return { authorized: status.isAuthorized, enabled: status.isEnabled, isExpired: status.isExpired }
      }

      // mcporter 模式
      const authorized = isMcporterAuthorized(skillName, ctx.logger)
      const enabled = authorized ? readSkillEntryEnabled(skillName, ctx.logger) : false
      return { authorized, enabled }
    }

    /**
     * 根据 skill 状态和请求来源，决定拦截行为
     */
    function resolveBlockAction(
      skillName: string,
      status: SkillStatus,
      isPC: boolean,
      suffix: string,
    ): { block: boolean; blockReason: string } | undefined {
      // 已授权且已开启 → 任何来源都放行
      if (status.authorized && status.enabled) {
        ctx.logger.info(`✅ "${skillName}" 已授权且已开启，放行${suffix}`)
        return undefined
      }

      if (isPC) {
        if (!status.authorized) {
          ctx.logger.info(`❌ "${skillName}" 未授权 [PC]，${logOnly ? '仅记录' : '阻断'}${suffix}`)
          if (logOnly) return undefined
          return buildBlockResult(skillName, status.isExpired)
        }
        ctx.logger.info(`⚠️ "${skillName}" 已授权但未开启 [PC]，${logOnly ? '仅记录' : '阻断'}${suffix}`)
        if (logOnly) return undefined
        return buildEnableBlockResult(skillName)
      }

      // 非 PC 端
      if (manualCodeSkills.has(skillName)) {
        ctx.logger.info(`🔓 "${skillName}" 授权码模式 [外部渠道]，放行${suffix}`)
        return undefined
      }

      // OAuth 模式
      if (!status.authorized) {
        ctx.logger.info(`❌ "${skillName}" 未授权 [外部渠道-OAuth]，${logOnly ? '仅记录' : '阻断'}${suffix}`)
        if (logOnly) return undefined
        return buildExternalChannelBlockResult(skillName)
      }
      ctx.logger.info(`⚠️ "${skillName}" 已授权但未开启 [外部渠道-OAuth]，${logOnly ? '仅记录' : '阻断'}${suffix}`)
      if (logOnly) return undefined
      return buildExternalChannelBlockResult(skillName)
    }

    // ---- 注册 before_tool_call Hook ----
    ctx.onHook(
      'before_tool_call',
      async (event, hookCtx): Promise<HookHandlerResult | undefined> => {
        const toolName = (event.toolName as string) ?? ''
        const isPC = isPCChannel(hookCtx.sessionKey as string | undefined)

        // 调试日志
        ctx.logger.info(`[DEBUG] before_tool_call: toolName="${toolName}", params=${JSON.stringify(event.params ?? {}).slice(0, 300)}, sessionKey="${hookCtx.sessionKey ?? ''}"`)

        // ━━━━ 分支① use_skill ━━━━
        if (toolName === USE_SKILL_TOOL) {
          const params = event.params as Record<string, unknown> | undefined
          const skillName: string =
            typeof params?.command === 'string'
              ? params.command
              : String(params?.name ?? params?.command ?? 'unknown')

          if (!shouldBlock(skillName, blockedSkills)) {
            return undefined
          }

          const status = await checkSkillStatus(skillName, 'use_skill', hookCtx.sessionKey as string | undefined)
          return resolveBlockAction(skillName, status, isPC, '') as HookHandlerResult | undefined
        }

        // ━━━━ 分支② read / read_file / with ━━━━
        if (READ_TOOLS.has(toolName)) {
          const params = event.params as Record<string, unknown> | undefined
          const filePath = extractFilePath(params ?? {})
          if (!filePath) {
            return undefined
          }

          const skillName = parseSkillNameFromPath(filePath)
          if (!skillName || !shouldBlock(skillName, blockedSkills)) {
            return undefined
          }

          const status = await checkSkillStatus(skillName, 'read_file', hookCtx.sessionKey as string | undefined)
          return resolveBlockAction(skillName, status, isPC, ` (read ${filePath.split(/[/\\]/).pop() || 'file'})`) as HookHandlerResult | undefined
        }

        // ━━━━ 分支③ exec / bash / execute_command ━━━━
        if (EXEC_TOOLS.has(toolName)) {
          const params = event.params as Record<string, unknown> | undefined
          const cmdStr: string | undefined =
            typeof params?.command === 'string' ? params.command
            : typeof params?.script === 'string' ? params.script
            : undefined

          if (cmdStr) {
            // 路径一：mcporter call/list 命令
            const mcpSkill = parseMcporterSkillName(cmdStr)
            if (mcpSkill && shouldBlock(mcpSkill, blockedSkills)) {
              const status = await checkSkillStatus(mcpSkill, 'exec', hookCtx.sessionKey as string | undefined)
              return resolveBlockAction(mcpSkill, status, isPC, ' (mcporter)') as HookHandlerResult | undefined
            }

            // 路径二：skill 入口脚本
            const entrySkill = parseSkillEntryScriptName(cmdStr)
            if (entrySkill && shouldBlock(entrySkill, blockedSkills)) {
              const status = await checkSkillStatus(entrySkill, 'exec', hookCtx.sessionKey as string | undefined)
              return resolveBlockAction(entrySkill, status, isPC, ' (skill-script)') as HookHandlerResult | undefined
            }
          }
          return undefined
        }

        // 其他工具 → 放行
        return undefined
      },
      { priority: HOOK_PRIORITY },
    )

    ctx.logger.info(
      `setup complete, blockedSkills=${JSON.stringify(blockedSkills ?? 'ALL')}, ` +
      `credentialHostedSkills=${JSON.stringify(credentialHostedSkills)}, ` +
      `manualCodeSkills=${JSON.stringify([...manualCodeSkills])}, ` +
      `wecomCliSkills=${JSON.stringify([...wecomCliSkills])}, logOnly=${logOnly}`,
    )
  },
}

// ---- 导出纯函数供测试使用 ----
export {
  parseMcporterSkillName,
  parseSkillEntryScriptName,
  parseSkillNameFromPath,
  shouldBlock,
  extractFilePath,
  isPCChannel,
} from './parsers.js'

export {
  buildBlockResult,
  buildEnableBlockResult,
  buildExternalChannelBlockResult,
} from './block-builders.js'

export {
  hasBdpanConfig,
  hasMcporterToken,
  MCPORTER_WRITEBACK_PROFILES,
  BDPAN_WRITEBACK_SKILLS,
} from './writeback.js'

export type { SkillInterceptorConfig, SkillStatus } from './types.js'

export default skillInterceptor

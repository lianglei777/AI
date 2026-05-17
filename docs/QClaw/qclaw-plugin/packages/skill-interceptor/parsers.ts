/**
 * skill-interceptor — 纯函数：命令/路径解析 & 判断逻辑
 *
 * 所有函数无副作用，可独立测试。
 */

/**
 * 匹配 skills 目录下的文件路径（跨平台）
 *
 * 支持格式：
 *   /path/to/skills/public-skill/SKILL.md
 *   /path/to/skills/public-skill/scripts/router.cjs
 *   ~/guanjia-openclaw/.../skills/imap-smtp-email/scripts/imap.js
 *   C:\path\skills\notion\config.json
 */
const SKILLS_DIR_PATTERN = /[/\\]skills[/\\]([a-zA-Z0-9_-]+)[/\\]/

/**
 * 从 exec/bash 命令字符串中提取 mcporter call 的 skill 名称
 *
 * 支持格式：
 *   mcporter call tencent-docs create_doc --args '...'
 *   mcporter call "tencent-docs" "create_doc" --args '...'
 *   mcporter list tencent-docs
 *
 * @returns skill 名称，未匹配返回 undefined
 */
export function parseMcporterSkillName(command: string): string | undefined {
  const match = command.match(/mcporter\s+(?:call|list)\s+["']?([a-zA-Z0-9_-]+)["']?/)
  return match?.[1]
}

/**
 * 从 exec/bash 命令字符串中提取 Skill 入口脚本对应的 skill 名称
 *
 * 支持格式（路径中包含 /skills/{skillName}/scripts/ 的入口脚本）：
 *   bash '/path/to/skills/public-skill/scripts/unix/email_gateway.sh' send ...
 *   node '/path/to/skills/public-skill/scripts/router.js' send ...
 *
 * @returns skill 名称，未匹配返回 undefined
 */
export function parseSkillEntryScriptName(command: string): string | undefined {
  const match = command.match(/[/\\]([a-zA-Z0-9_-]+)[/\\]scripts[/\\](?:unix[/\\]|windows[/\\])?(?:email_gateway\.(?:sh|cmd)|router\.(?:js|cjs))/)
  return match?.[1]
}

/**
 * 从文件路径中解析 skill name
 *
 * 匹配路径中 /skills/{skillName}/ 模式（跨平台，支持 / 和 \）
 *
 * @returns skill 名称，未匹配返回 undefined
 */
export function parseSkillNameFromPath(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, '/')
  const match = normalized.match(SKILLS_DIR_PATTERN)
  return match?.[1]
}

/**
 * 判断 skill 是否在阻断名单中
 */
export function shouldBlock(
  skillName: string,
  blockedSkills: string[] | undefined,
): boolean {
  if (!blockedSkills || blockedSkills.length === 0) return true
  const lower = skillName.toLowerCase()
  return blockedSkills.some((s) => s.toLowerCase() === lower)
}

/**
 * 从工具参数中提取文件路径
 */
export function extractFilePath(params: Record<string, unknown>): string | undefined {
  if (!params || typeof params !== 'object') return undefined
  // 支持 with from 指令（params.from）以及常规 read_file 参数
  const raw = (params.file_path ?? params.filePath ?? params.path ?? params.file ?? params.from ?? undefined) as string | undefined
  if (typeof raw !== 'string') return undefined
  // with from 格式："from /path/to/file" → 去掉 "from " 前缀
  return raw.startsWith('from ') ? raw.slice(5).trim() : raw
}

/**
 * 判断请求是否来自 PC 桌面端
 *
 * PC 端 sessionKey 格式：
 * - 主对话: agent:main:main
 * - 新建会话: agent:main:session-{timestamp}
 *
 * 外部渠道 sessionKey 格式：
 * - agent:main:wechat-access:direct:{userId}
 * - agent:main:openai-user:{"channel":"feishu",...}
 */
export function isPCChannel(sessionKey: string | undefined): boolean {
  if (!sessionKey) return true // 无 sessionKey 时保守处理，视为 PC 端进行拦截
  const parts = sessionKey.split(':')
  const thirdPart = parts[2] || ''
  return thirdPart === 'main' || thirdPart.startsWith('session-')
}

/**
 * skill-detector — Skill 调用实时检测模块
 *
 * 通过 `after_tool_call` 钩子在每次工具调用完成后实时检测 Skill 使用。
 * 相比旧方案（在 agent_end 中扫描全量 messages 历史），优势：
 * - **实时**：工具执行完成立刻触发，无需事后回溯
 * - **结构化**：`toolName`、`params`、`result` 直接可用，无需猜字段 key
 * - **天然不重复**：只在工具实际执行时触发一次，无跨轮次重复问题
 * - **O(1)**：每次只处理当前这一次工具调用
 */

import type { QClawLogger } from '../../../core/types.js'

// ─── 类型 ───

export interface DetectedSkill {
  /** Skill 名称（来自 SKILL.md frontmatter 的 name 字段或路径推断） */
  name: string
  /** Skill 描述 */
  description?: string
  /** 触发检测的 toolCallId */
  toolCallId: string
  /** 检测来源工具 */
  sourceTool: string
}

/** after_tool_call 事件的类型化子集（与 PluginHookAfterToolCallEvent 对齐） */
export interface AfterToolCallEvent {
  toolName: string
  params: Record<string, unknown>
  runId?: string
  toolCallId?: string
  result?: unknown
  error?: string
  durationMs?: number
}

/** after_tool_call 钩子上下文的类型化子集 */
export interface ToolCallHookContext {
  agentId?: string
  sessionKey?: string
  sessionId?: string
  runId?: string
  toolName: string
  toolCallId?: string
}

// ─── 常量 ───

/** read 类工具名集合：兼容 read / read_file 两种工具名 */
const READ_TOOL_NAMES = new Set(['read', 'read_file'])

/** use_skill 工具名 */
const USE_SKILL_TOOL = 'use_skill'

/** exec 类工具名集合：LLM 通过 bash/exec 等工具执行脚本 */
const EXEC_TOOL_NAMES = new Set([
  'exec', 'bash', 'execute_command',
  'run_command', 'run_script', 'shell', 'terminal', 'powershell',
])

/** 匹配 SKILL.md 路径 */
const SKILL_FILE_PATTERN = /[/\\]SKILL\.md$/i

/**
 * 跨平台的文件读取命令模式。
 * 匹配 `<read-command> [flags] <path>` 并捕获 path（可带引号）。
 *
 * 支持的命令:
 *   Windows  — type, Get-Content (gc), more
 *   Unix     — cat, head, tail, less, more, bat, batcat
 */
const FILE_READ_CMD_RE = new RegExp(
  '(?:^|[;&|"]\\s*)' +                             // 行首、管道/分隔符、或双引号之后
  '(?:type|cat|head|tail|less|more|bat|batcat|Get-Content|gc)' +  // 命令
  '(?:\\s+[\\-/]\\S+)*' +                           // 可选 flags
  '\\s+' +                                          // 至少一个空白
  '(?:' +
    '"([^"]+)"' +                                   // 捕获组1: 双引号路径
    '|' +
    "'([^']+)'" +                                   // 捕获组2: 单引号路径
    '|' +
    '(\\S+)' +                                      // 捕获组3: 无引号路径
  ')',
  'i',
)

/** 从 exec/bash 命令中提取 mcporter call/list 的 skill 名称 */
const MCPORTER_PATTERN = /mcporter\s+(?:call|list)\s+["']?([a-zA-Z0-9_-]+)["']?/

/**
 * OpenClaw/QClaw 标准 skill 目录路径前缀，用于收紧匹配范围、防止误匹配。
 * 对应的标准安装路径（共 7 种）：
 *   ~/.openclaw/workspace/skills/{name}
 *   ~/.qclaw/workspace/skills/{name}
 *   ~/.qclaw/skills/{name}
 *   ~/.agents/skills/{name}
 *   .../workspace/skills/{name}
 *   .../config/skills/{name}
 *   .../openclaw/skills/{name}
 *
 * 注意：每个分支已包含 /skills/，避免分支尾部斜杠与外部 /skills/ 重复。
 */

/** 从命令中匹配已知 skill 目录下的 {skillName}（覆盖 cd/exec 场景） */
const SKILL_DIR_PATTERN = /(?:\.openclaw[/\\]workspace[/\\]skills|\.qclaw[/\\]workspace[/\\]skills|\.qclaw[/\\]skills|\.agents[/\\]skills|workspace[/\\]skills|config[/\\]skills|openclaw[/\\]skills)[/\\]([a-zA-Z0-9_-]+)/

/** 从路径中提取已知 skill 目录下的 {name}/SKILL.md 模式的 skill 名称 */
const SKILL_PATH_FALLBACK_PATTERN = /(?:\.openclaw[/\\]workspace[/\\]skills|\.qclaw[/\\]workspace[/\\]skills|\.qclaw[/\\]skills|\.agents[/\\]skills|workspace[/\\]skills|config[/\\]skills|openclaw[/\\]skills)[/\\]([a-zA-Z0-9_-]+)[/\\]SKILL\.md$/i

/** 检测来源描述（中文） */
export const SOURCE_TOOL_DESC: Record<string, string> = {
  read: '通过 read 工具读取 SKILL.md 文件',
  read_file: '通过 read_file 工具读取 SKILL.md 文件',
  use_skill: '通过 use_skill 工具直接调用',
  exec: '通过 exec 工具执行脚本/命令',
  bash: '通过 bash 工具执行脚本/命令',
  execute_command: '通过 execute_command 工具执行脚本/命令',
  run_command: '通过 run_command 工具执行脚本/命令',
  run_script: '通过 run_script 工具执行脚本/命令',
  shell: '通过 shell 工具执行脚本/命令',
  terminal: '通过 terminal 工具执行脚本/命令',
  powershell: '通过 powershell 工具执行脚本/命令',
}

// ─── SKILL.md Frontmatter 解析 ───

/**
 * 解析 SKILL.md 文件内容中的 YAML frontmatter
 * @returns `{ name, description }` 或 `null`（解析失败时）
 */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } | null {
  if (!content || typeof content !== 'string') return null
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match?.[1]) return null
  const frontmatter = match[1]
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
  if (!nameMatch) return null

  let description: string | undefined
  const descMatch = frontmatter.match(/^description:\s*(.*)$/m)
  if (descMatch) {
    const firstLine = descMatch[1].trim()
    if (firstLine === '|' || firstLine === '>' || firstLine === '|+' || firstLine === '>+' || firstLine === '|-' || firstLine === '>-') {
      const descStartIdx = frontmatter.indexOf(descMatch[0]) + descMatch[0].length
      const remainingLines = frontmatter.slice(descStartIdx).split('\n')
      const multilineparts: string[] = []
      for (const line of remainingLines) {
        if (line === '' || /^\s+/.test(line)) {
          multilineparts.push(line.replace(/^\s+/, ''))
        } else {
          break
        }
      }
      const joined = firstLine.startsWith('>')
        ? multilineparts.join(' ').replace(/\s+/g, ' ').trim()
        : multilineparts.join('\n').trim()
      if (joined) description = joined
    } else if (firstLine) {
      description = firstLine.replace(/^["']|["']$/g, '')
    }
  }

  return {
    name: nameMatch[1].trim().replace(/^["']|["']$/g, ''),
    description,
  }
}

// ─── SkillDetector 主类 ───

/**
 * SkillDetector — 基于 after_tool_call 的实时 Skill 检测器
 *
 * 生命周期:
 * 1. `before_agent_start` 时 reset()，清空本轮累积
 * 2. 每次 `after_tool_call` 时 handleToolCall()，实时检测并累积
 * 3. `agent_end` 时 flush()，返回本轮检测到的 skills 并清空
 */
export class SkillDetector {
  /** sessionKey → 当前 runId 期间检测到的 skills (按 name 去重) */
  private pendingSkills = new Map<string, Map<string, DetectedSkill>>()
  private logger: QClawLogger

  constructor(logger: QClawLogger) {
    this.logger = logger
  }

  /**
   * 重置指定 session 的累积数据（在 before_agent_start 时调用）
   */
  reset(sessionKey: string): void {
    const hadPending = this.pendingSkills.has(sessionKey)
    this.pendingSkills.delete(sessionKey)
    this.logger.debug(`[skill-detector] reset: session=${sessionKey}, hadPending=${hadPending}`)
  }

  /**
   * 处理单次 after_tool_call 事件，实时检测 skill
   */
  handleToolCall(event: AfterToolCallEvent, hookCtx: ToolCallHookContext): void {
    const sessionKey = hookCtx.sessionKey || hookCtx.sessionId || ''
    const toolCallId = event.toolCallId || hookCtx.toolCallId || ''

    this.logger.debug(`[skill-detector] handleToolCall: toolName=${event.toolName}, toolCallId=${toolCallId}, session=${sessionKey}`)

    // 场景 1: read/read_file 读取了 SKILL.md
    if (READ_TOOL_NAMES.has(event.toolName)) {
      this.logger.debug(`[skill-detector] → 匹配 READ 场景 (toolName=${event.toolName})`)
      this.handleReadTool(event, sessionKey, toolCallId)
      return
    }

    // 场景 2: use_skill 直接调用
    if (event.toolName === USE_SKILL_TOOL) {
      this.logger.debug(`[skill-detector] → 匹配 USE_SKILL 场景`)
      this.handleUseSkillTool(event, sessionKey, toolCallId)
      return
    }

    // 场景 3: exec/bash/execute_command 执行 skill 脚本
    if (EXEC_TOOL_NAMES.has(event.toolName)) {
      this.logger.debug(`[skill-detector] → 匹配 EXEC 场景 (toolName=${event.toolName})`)
      this.handleExecTool(event, sessionKey, toolCallId)
      return
    }

    this.logger.debug(`[skill-detector] → 工具名 "${event.toolName}" 不属于任何检测场景, 跳过`)
  }

  /**
   * 冲洗（flush）并返回指定 session 本轮检测到的所有 skills
   * 调用后清空累积（在 agent_end 时调用）
   */
  flush(sessionKey: string): DetectedSkill[] {
    const skillMap = this.pendingSkills.get(sessionKey)
    if (!skillMap || skillMap.size === 0) {
      this.logger.debug(`[skill-detector] flush: session=${sessionKey}, 无检测到的 skill`)
      this.pendingSkills.delete(sessionKey)
      return []
    }
    const skills = Array.from(skillMap.values())
    this.logger.debug(`[skill-detector] flush: session=${sessionKey}, 共 ${skills.length} 个 skill: ${skills.map(s => `${s.name}(via ${s.sourceTool})`).join(', ')}`)
    this.pendingSkills.delete(sessionKey)
    return skills
  }

  // ─── 场景 1: read/read_file 检测 ───

  private handleReadTool(event: AfterToolCallEvent, sessionKey: string, toolCallId: string): void {
    const filePath: string = (event.params?.file_path as string)
      ?? (event.params?.filePath as string)
      ?? (event.params?.path as string)
      ?? (event.params?.file as string)
      ?? ''

    this.logger.debug(`[skill-detector][read] filePath=${filePath || '(empty)'}, params keys=[${Object.keys(event.params ?? {}).join(',')}]`)

    if (!filePath) {
      this.logger.debug(`[skill-detector][read] ✗ 无 filePath, 跳过`)
      return
    }
    if (!SKILL_FILE_PATTERN.test(filePath)) {
      this.logger.debug(`[skill-detector][read] ✗ filePath 不匹配 SKILL.md 模式, 跳过: ${filePath}`)
      return
    }

    this.logger.debug(`[skill-detector][read] ✓ filePath 匹配 SKILL.md, 尝试解析 frontmatter`)

    // 文件路径匹配 SKILL.md — 尝试从结果解析 frontmatter
    const resultText = this.extractResultText(event.result)
    this.logger.debug(`[skill-detector][read] resultText 长度=${resultText.length}, 前100字符=${resultText.slice(0, 100).replace(/\n/g, '\\n')}`)

    if (resultText) {
      const frontmatter = parseSkillFrontmatter(resultText)
      this.logger.debug(`[skill-detector][read] frontmatter 解析结果: ${frontmatter ? `name=${frontmatter.name ?? '(无)'}` : 'null'}`)
      if (frontmatter?.name) {
        this.logger.debug(`[skill-detector][read] ✓ 检测到 skill: name=${frontmatter.name}, source=${event.toolName}`)
        this.addSkill(sessionKey, {
          name: frontmatter.name,
          description: frontmatter.description,
          toolCallId,
          sourceTool: event.toolName,
        })
        return
      }
    }

    // frontmatter 解析失败 → 回退: 从文件路径推断 skill 名称
    this.logger.debug(`[skill-detector][read] frontmatter 无法提取 name, 尝试路径回退`)
    const pathMatch = filePath.match(SKILL_PATH_FALLBACK_PATTERN)
    if (pathMatch?.[1]) {
      const fallbackName = pathMatch[1]
      this.logger.debug(`[skill-detector][read] ✓ 路径回退成功: name=${fallbackName}, source=${event.toolName}(path-fallback)`)
      this.addSkill(sessionKey, {
        name: fallbackName,
        description: '',
        toolCallId,
        sourceTool: `${event.toolName}(path-fallback)`,
      })
    } else {
      this.logger.debug(`[skill-detector][read] ✗ 路径回退也失败, filePath 不匹配 SKILL_PATH_FALLBACK_PATTERN: ${filePath}`)
    }
  }

  // ─── 场景 2: use_skill 检测 ───

  private handleUseSkillTool(event: AfterToolCallEvent, sessionKey: string, toolCallId: string): void {
    const skillName: string = (event.params?.command as string) ?? (event.params?.name as string) ?? ''
    this.logger.debug(`[skill-detector][use_skill] params.command=${event.params?.command ?? '(无)'}, params.name=${event.params?.name ?? '(无)'}, resolved=${skillName || '(empty)'}`)
    if (!skillName) {
      this.logger.debug(`[skill-detector][use_skill] ✗ 无法提取 skillName, 跳过`)
      return
    }

    this.logger.debug(`[skill-detector][use_skill] ✓ 检测到 skill: name=${skillName}`)
    this.addSkill(sessionKey, {
      name: skillName,
      description: '',
      toolCallId,
      sourceTool: USE_SKILL_TOOL,
    })
  }

  // ─── 场景 3: exec/bash 检测 ───

  private handleExecTool(event: AfterToolCallEvent, sessionKey: string, toolCallId: string): void {
    const command: string = (event.params?.command as string) ?? (event.params?.content as string) ?? ''
    this.logger.debug(`[skill-detector][exec] command=${command ? command.slice(0, 200) : '(empty)'}`)
    if (!command) {
      this.logger.debug(`[skill-detector][exec] ✗ 无 command, 跳过`)
      return
    }

    // 优先匹配 mcporter call/list {skillName}
    let skillName = MCPORTER_PATTERN.exec(command)?.[1]
    if (skillName) {
      this.logger.debug(`[skill-detector][exec] ✓ mcporter 匹配成功: skillName=${skillName}`)
    }

    // 回退匹配已知 skill 目录路径（.openclaw/workspace/skills/xxx、.qclaw/skills/xxx 等）
    if (!skillName) {
      skillName = SKILL_DIR_PATTERN.exec(command)?.[1]
      if (skillName) {
        this.logger.debug(`[skill-detector][exec] ✓ SKILL_DIR_PATTERN 匹配成功: skillName=${skillName}`)
      } else {
        this.logger.debug(`[skill-detector][exec] mcporter 和 SKILL_DIR_PATTERN 均未匹配, 尝试 FILE_READ_CMD_RE`)
      }
    }

    // 检测 cat/type/head/tail 等文件读取命令读取 skill 文件
    if (!skillName) {
      const cmdMatch = FILE_READ_CMD_RE.exec(command)
      if (cmdMatch) {
        const targetPath = cmdMatch[1] ?? cmdMatch[2] ?? cmdMatch[3] ?? ''
        this.logger.debug(`[skill-detector][exec] FILE_READ_CMD_RE 匹配到路径: ${targetPath}`)
        if (SKILL_FILE_PATTERN.test(targetPath)) {
          this.logger.debug(`[skill-detector][exec] ✓ 目标路径匹配 SKILL.md`)
          // 从路径中提取 skill 名称
          const pathMatch = targetPath.match(SKILL_PATH_FALLBACK_PATTERN)
          if (pathMatch?.[1]) {
            skillName = pathMatch[1]
            this.logger.debug(`[skill-detector][exec] ✓ SKILL_PATH_FALLBACK 提取: skillName=${skillName}`)
          } else {
            // 更宽松地提取: SKILL.md 上一级目录名作为 skill name
            const dirMatch = targetPath.match(/[/\\]([a-zA-Z0-9_-]+)[/\\]SKILL\.md$/i)
            if (dirMatch?.[1]) {
              skillName = dirMatch[1]
              this.logger.debug(`[skill-detector][exec] ✓ 宽松目录名提取: skillName=${skillName}`)
            } else {
              this.logger.debug(`[skill-detector][exec] ✗ SKILL.md 路径匹配但无法提取 skill 名称: ${targetPath}`)
            }
          }
        } else if (SKILL_DIR_PATTERN.test(targetPath)) {
          skillName = SKILL_DIR_PATTERN.exec(targetPath)?.[1]
          this.logger.debug(`[skill-detector][exec] ✓ 文件读取命令路径匹配 SKILL_DIR: skillName=${skillName}`)
        } else {
          this.logger.debug(`[skill-detector][exec] ✗ 文件读取命令的目标路径不匹配 skill 模式: ${targetPath}`)
        }
      } else {
        this.logger.debug(`[skill-detector][exec] ✗ FILE_READ_CMD_RE 未匹配, 所有模式均未命中`)
      }
    }

    if (!skillName) {
      this.logger.debug(`[skill-detector][exec] ✗ 最终未检测到 skill, 跳过`)
      return
    }

    this.logger.debug(`[skill-detector][exec] ✓ 检测到 skill: name=${skillName}, source=${event.toolName}`)
    this.addSkill(sessionKey, {
      name: skillName,
      description: '',
      toolCallId,
      sourceTool: event.toolName,
    })
  }

  // ─── 内部工具方法 ───

  /**
   * 添加 skill 到 pending 集合（按 name 去重，同一 session 内同名 skill 只保留首次）
   */
  private addSkill(sessionKey: string, skill: DetectedSkill): void {
    let skillMap = this.pendingSkills.get(sessionKey)
    if (!skillMap) {
      skillMap = new Map()
      this.pendingSkills.set(sessionKey, skillMap)
    }
    // 按 name 去重 — 同一 skill 只记录首次检测到的结果
    if (!skillMap.has(skill.name)) {
      skillMap.set(skill.name, skill)
      this.logger.debug(`[skill-detector] addSkill: 新增 skill="${skill.name}" (source=${skill.sourceTool}), session=${sessionKey}, 当前累计=${skillMap.size}`)
    } else {
      this.logger.debug(`[skill-detector] addSkill: 去重跳过 skill="${skill.name}" (source=${skill.sourceTool}), 已存在于 session=${sessionKey}`)
    }
  }

  /**
   * 从工具调用结果中提取纯文本内容
   */
  private extractResultText(result: unknown): string {
    if (typeof result === 'string') return result

    if (Array.isArray(result)) {
      return result
        .filter((c: Record<string, unknown>) => c?.type === 'text' && typeof c.text === 'string')
        .map((c: Record<string, unknown>) => c.text as string)
        .join('\n')
    }

    // result 可能是 { content: string | Array } 的包装形式
    if (result && typeof result === 'object') {
      const obj = result as Record<string, unknown>
      if (typeof obj.content === 'string') return obj.content
      if (Array.isArray(obj.content)) {
        return obj.content
          .filter((c: Record<string, unknown>) => c?.type === 'text' && typeof c.text === 'string')
          .map((c: Record<string, unknown>) => c.text as string)
          .join('\n')
      }
      // 兜底：序列化为 JSON 字符串
      try { return JSON.stringify(result) } catch { return '' }
    }

    return ''
  }
}

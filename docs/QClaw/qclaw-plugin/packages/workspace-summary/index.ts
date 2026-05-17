/**
 * workspace-summary — 会话摘要自动生成 Package
 *
 * 功能：
 * 1. 系统启动时自动加载
 * 2. 通过 agent_end Hook 获取多轮 session 对话内容
 * 3. 调用 LLM 生成 summary（会话摘要）
 * 4. 将 summary 保存到 ~/.qclaw/workspace/sessions/<sessionId>/
 *
 * 目录结构（参考 docs/workspace-storage-design.md）：
 *   ~/.qclaw/workspace/sessions/<sessionId>/
 *     ├── store.json           # 元数据索引
 *     └── summary_<id>.md      # 会话摘要（LLM 生成）
 *
 * 核心原则：完全异步、不阻塞对话。
 */

import * as path from 'path'
import * as fs from 'fs/promises'
import type {
  QClawPackage,
  QClawContext,
  QClawLogger,
  HookHandlerResult,
} from '../../core/types.js'
import type { WorkspaceSummaryConfig, Turn } from './src/types.js'
import { generateSummary } from './src/summarizer.js'
import { persistSummary } from './src/storage.js'
import { getStorePath } from './src/paths.js'
import { REPORT_CONST } from '../../core/reporter-constants.js'

// ============================================================================
// 常量
// ============================================================================

const SUMMARIZATION_TIMEOUT_MS = 120_000

// ============================================================================
// Session 管理
// ============================================================================

/**
 * 从 sessionKey 中提取稳定的 sessionId 作为 session 目录名。
 *
 * sessionKey 格式约定（参见 useChat.ts）：
 *   - agent:<agentId>:session-<timestamp>-<rand>   （新建会话）
 *   - agent:<agentId>:main                          （默认主会话）
 *   - agent:<agentId>:cron:<cronId>                 （定时任务）
 *   - agent:<agentId>:subagent:<id>                 （子 agent）
 *   - main                                          （旧格式主会话）
 *
 * 提取规则：取最后一个 ':' 之后的部分（如 session-1775700969337-w9p4f2）。
 * 这样同一个 QClaw 对话框在多次程序启动间始终映射到同一个目录。
 *
 * 安全措施：过滤掉路径分隔符和 '..'，防止目录遍历。
 */
function extractSessionIdFromKey(sessionKey: string): string {
  const lastColon = sessionKey.lastIndexOf(':')
  const rawId = lastColon >= 0 ? sessionKey.slice(lastColon + 1) : sessionKey
  const sanitized = rawId.replace(/[/\\]/g, '_').replace(/\.\./g, '_')
  return sanitized || `fallback_${Date.now()}`
}

/** Session 级别的 Promise 链，保证同一 session 的摘要生成串行执行 */
const summarizationChains = new Map<string, Promise<void>>()

/** session 级触发状态 */
interface SessionState {
  /** 上次处理到的消息总数（增量游标） */
  lastMessageCount: number
}

const sessionStates = new Map<string, SessionState>()

/** sessionKey → 规范 sessionId 的缓存，保证同一会话多次 agent_end 使用同一目录 */
const sessionIdCache = new Map<string, string>()

// ============================================================================
// 文件产物提取（从 tool_use block 中提取 .md 文件路径和内容）
// ============================================================================

/** 写文件工具名称集合（包含内置短名称和第三方兼容名称） */
const WRITE_FILE_TOOL_NAMES = new Set([
  'write',         // 内置短名称
  'write_file',    // 第三方 agent 兼容名称
  'write_to_file',
  'create_file',
])

/** 编辑文件工具名称集合（包含内置短名称和第三方兼容名称） */
const EDIT_FILE_TOOL_NAMES = new Set([
  'edit',          // 内置短名称
  'apply_patch',   // 内置短名称
  'apply-patch',   // 连字符变体
  'replace_in_file',
  'edit_file',
  'replace_file',
  'insert_code',
  'apply_diff',
])

/** exec 类工具名称集合（用于识别通过脚本间接写文件的场景） */
const EXEC_TOOL_NAMES = new Set(['exec', 'bash', 'bash_tool', 'execute_command'])

/**
 * 从 OpenAI 格式的 tool_call 对象中提取 .md 文件产物。
 *
 * OpenAI 格式：tool_calls 数组中每个元素为
 *   { id, type: 'function', function: { name, arguments } }
 * 其中 arguments 是 JSON 字符串。
 */
function extractFileArtifactFromToolCall(toolCall: Record<string, unknown>): FileArtifact | null {
  const fn = toolCall.function as Record<string, unknown> | undefined
  if (!fn || typeof fn !== 'object') return null

  const name = fn.name as string | undefined
  if (!name) return null

  const isWrite = WRITE_FILE_TOOL_NAMES.has(name)
  const isEdit = EDIT_FILE_TOOL_NAMES.has(name)
  const isExec = EXEC_TOOL_NAMES.has(name)
  if (!isWrite && !isEdit && !isExec) return null

  // arguments 可能是 JSON 字符串或已解析的对象
  let input: Record<string, unknown> | undefined
  const rawArgs = fn.arguments
  if (typeof rawArgs === 'string') {
    try { input = JSON.parse(rawArgs) as Record<string, unknown> } catch { return null }
  } else if (rawArgs && typeof rawArgs === 'object') {
    input = rawArgs as Record<string, unknown>
  }
  if (!input) return null

  if (isExec) {
    const command = (input.command ?? input.cmd) as string | undefined
    if (typeof command !== 'string') return null
    const mdPath = extractMdPathFromExecCommand(command)
    if (!mdPath) return null
    return { filePath: mdPath, content: null }
  }

  const filePath = (input.file_path ?? input.filePath ?? input.path ?? input.target_file) as string | undefined
  if (typeof filePath !== 'string') return null
  if (!filePath.toLowerCase().endsWith('.md')) return null

  let content: string | null = null
  if (isWrite) {
    const rawContent = (input.content ?? input.file_content) as string | undefined
    content = typeof rawContent === 'string' ? rawContent : null
  }

  return { filePath, content }
}

/**
 * 从 OpenClaw 原生格式的 toolCall block 中提取 .md 文件产物。
 *
 * OpenClaw 格式：content 数组中 type 为 "toolCall"（驼峰），参数在 arguments 字段（非 input）：
 *   { type: "toolCall", id: "write:5", name: "write", arguments: { path, content } }
 */
function extractFileArtifactFromToolCallBlock(block: Record<string, unknown>): FileArtifact | null {
  const name = block.name as string | undefined
  if (!name) return null

  const isWrite = WRITE_FILE_TOOL_NAMES.has(name)
  const isEdit = EDIT_FILE_TOOL_NAMES.has(name)
  const isExec = EXEC_TOOL_NAMES.has(name)
  if (!isWrite && !isEdit && !isExec) return null

  // OpenClaw 用 "arguments" 而非 "input"
  let args: Record<string, unknown> | undefined
  const rawArgs = block.arguments
  if (typeof rawArgs === 'string') {
    try { args = JSON.parse(rawArgs) as Record<string, unknown> } catch { return null }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = rawArgs as Record<string, unknown>
  }
  if (!args) return null

  if (isExec) {
    const command = (args.command ?? args.cmd) as string | undefined
    if (typeof command !== 'string') return null
    const mdPath = extractMdPathFromExecCommand(command)
    if (!mdPath) return null
    return { filePath: mdPath, content: null }
  }

  const filePath = (args.file_path ?? args.filePath ?? args.path ?? args.target_file) as string | undefined
  if (typeof filePath !== 'string') return null
  if (!filePath.toLowerCase().endsWith('.md')) return null

  let content: string | null = null
  if (isWrite) {
    const rawContent = (args.content ?? args.file_content) as string | undefined
    content = typeof rawContent === 'string' ? rawContent : null
  }

  return { filePath, content }
}

/** 单个文件内容截断上限（字符数），避免超长文档撑爆 token */
const FILE_CONTENT_MAX_CHARS = 2000

interface FileArtifact {
  filePath: string
  content: string | null
}

/**
 * 系统自动生成的 .md 文件名模式列表。
 * 这些文件不应被视为"用户指定生成的文档"，不触发 summary 保留。
 */
const AUTO_GENERATED_MD_PATTERNS: RegExp[] = [
  /^task-summary-/i,       // workspace-summary 自动任务总结
  /^summary[_-]/i,         // 其他 summary 类文件
  /^session-summary/i,     // session 总结文件
  /^auto-memory/i,         // auto-memory 生成的文件
  /^\./, // 隐藏文件（如 .summary.md）
  /^USER\.md$/i,           // QClaw 用户配置文件，非用户创建的文档
  /^CLAUDE\.md$/i,         // agent 配置文件
  /^AGENTS\.md$/i,         // agent 配置文件
  /^CODEBUDDY\.md$/i,      // agent 配置文件
]

/**
 * 判断 .md 文件产物是否为"用户指定生成的文档"。
 *
 * 排除规则：
 * 1. 文件名匹配 AUTO_GENERATED_MD_PATTERNS 中的已知系统模式 → 非用户指定
 *
 * 只有不匹配任何排除模式的 .md 文件，才被视为用户指定的文档产物。
 */
function isUserFacingMdArtifact(filePath: string): boolean {
  const fileName = path.basename(filePath)
  return !AUTO_GENERATED_MD_PATTERNS.some((pattern) => pattern.test(fileName))
}

/**
 * 从 exec 类工具的 command 参数中提取通过 write_file.py 脚本间接写入的 .md 文件路径。
 *
 * qclaw-text-file Skill 会拦截 write 工具，要求通过 exec 调用 write_file.py 脚本写目标文件：
 *   exec(command='python3 ".../write_file.py" --path "目标.md" --content-file "/tmp/_tw_xxx.txt"')
 *
 * 此函数解析 command 参数，提取 --path 后面的目标文件路径。
 */
function extractMdPathFromExecCommand(command: string): string | null {
  // 匹配 write_file.py ... --path "xxx.md" 或 --path 'xxx.md' 或 --path xxx.md
  if (!command.includes('write_file.py')) return null

  // 尝试匹配 --path 后面的路径（支持引号和无引号）
  const pathMatch = command.match(/--path\s+(?:"([^"]+)"|'([^']+)'|(\S+))/)
  if (!pathMatch) return null

  const targetPath = pathMatch[1] ?? pathMatch[2] ?? pathMatch[3]
  if (!targetPath) return null

  return targetPath.toLowerCase().endsWith('.md') ? targetPath : null
}

/**
 * 从 tool_use block 的 input 中提取 .md 文件路径和内容。
 *
 * - 只提取 .md 文件，非 md 文档不参与 summary
 * - 支持写文件工具（提取路径+内容）和编辑工具（只提取路径）
 * - 支持 exec 类工具通过 write_file.py 脚本间接写 .md 文件的场景
 * - 兼容 file_path / filePath / path / target_file 等常见路径字段名
 * - 兼容 content / file_content 等常见内容字段名
 */
function extractFileArtifactFromToolUse(block: Record<string, unknown>): FileArtifact | null {
  const name = block.name as string | undefined
  if (!name) return null

  const isWrite = WRITE_FILE_TOOL_NAMES.has(name)
  const isEdit = EDIT_FILE_TOOL_NAMES.has(name)
  const isExec = EXEC_TOOL_NAMES.has(name)
  if (!isWrite && !isEdit && !isExec) return null

  const input = block.input as Record<string, unknown> | undefined
  if (!input || typeof input !== 'object') return null

  // ---- exec 工具：解析 command 参数中通过 write_file.py 写 .md 文件的场景 ----
  if (isExec) {
    const command = (input.command ?? input.cmd) as string | undefined
    if (typeof command !== 'string') return null
    const mdPath = extractMdPathFromExecCommand(command)
    if (!mdPath) return null
    return { filePath: mdPath, content: null }
  }

  // ---- write / edit 工具：从 input 中提取文件路径 ----
  const filePath = (input.file_path ?? input.filePath ?? input.path ?? input.target_file) as string | undefined
  if (typeof filePath !== 'string') return null

  // 只提取 .md 文件，非 md 文档不参与 summary
  if (!filePath.toLowerCase().endsWith('.md')) return null

  // 写文件工具提取内容，编辑工具只记录路径
  let content: string | null = null
  if (isWrite) {
    const rawContent = (input.content ?? input.file_content) as string | undefined
    content = typeof rawContent === 'string' ? rawContent : null
  }

  return { filePath, content }
}

/** 将文件产物格式化为可读文本，包含路径和（截断的）内容 */
function formatFileArtifact(artifact: FileArtifact): string {
  const lines: string[] = [`[Generated file: ${artifact.filePath}]`]

  if (artifact.content) {
    let truncated = artifact.content
    if (truncated.length > FILE_CONTENT_MAX_CHARS) {
      truncated = truncated.slice(0, FILE_CONTENT_MAX_CHARS) + '\n... (content truncated)'
    }
    lines.push('```')
    lines.push(truncated)
    lines.push('```')
  }

  return lines.join('\n')
}

// ============================================================================
// 对话内容提取
// ============================================================================

/**
 * 从单条 message 中提取文本内容。
 *
 * 支持以下 content 格式：
 * - string: 直接返回
 * - Array<ContentBlock>: 提取 text block + tool_use 中的 .md 文件产物 (Anthropic 格式)
 *
 * 同时检查 msg.tool_calls 字段 (OpenAI 格式) 中的 .md 文件产物。
 */
function extractMessageContent(msg: Record<string, unknown>, logger?: QClawLogger): string | null {
  const role = msg.role as string | undefined
  const textParts: string[] = []
  const fileArtifacts: FileArtifact[] = []

  const content = msg.content
  const contentType = content === null ? 'null' : typeof content === 'string' ? 'string' : Array.isArray(content) ? `array(${(content as unknown[]).length})` : typeof content
  const toolCallCount = Array.isArray(msg.tool_calls) ? (msg.tool_calls as unknown[]).length : 0

  logger?.info(`[extractMessageContent] role=${role}, contentType=${contentType}, toolCallCount=${toolCallCount}`)

  if (typeof content === 'string') {
    textParts.push(content)
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>

      // 提取 text block
      if ('text' in b && typeof b.text === 'string') {
        textParts.push(b.text as string)
      }

      // 提取 tool_use block 中的 .md 文件产物（Anthropic 格式）
      if (b.type === 'tool_use') {
        const artifact = extractFileArtifactFromToolUse(b)
        if (artifact) {
          const userFacing = isUserFacingMdArtifact(artifact.filePath)
          fileArtifacts.push(artifact)
          logger?.info(`[extractMessageContent]   found artifact (Anthropic): ${artifact.filePath} [userFacing=${userFacing}]`)
        }
      }

      // 提取 toolCall block 中的 .md 文件产物（OpenClaw 原生格式）
      if (b.type === 'toolCall') {
        const artifact = extractFileArtifactFromToolCallBlock(b)
        if (artifact) {
          const userFacing = isUserFacingMdArtifact(artifact.filePath)
          fileArtifacts.push(artifact)
          logger?.info(`[extractMessageContent]   found artifact (OpenClaw): ${artifact.filePath} [userFacing=${userFacing}]`)
        }
      }
    }
  }

  // 检查 OpenAI 格式的 tool_calls 字段
  const toolCalls = msg.tool_calls
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== 'object') continue
      const tcObj = tc as Record<string, unknown>
      const artifact = extractFileArtifactFromToolCall(tcObj)
      if (artifact) {
        const userFacing = isUserFacingMdArtifact(artifact.filePath)
        fileArtifacts.push(artifact)
        logger?.info(`[extractMessageContent]   found artifact (OpenAI): ${artifact.filePath} [userFacing=${userFacing}]`)
      }
    }
  }

  // 附加 .md 文件产物信息（按路径去重，保留有内容的版本）
  // 区分用户指定生成的和系统自动生成的 md 文件
  if (fileArtifacts.length > 0) {
    const deduped = new Map<string, FileArtifact>()
    for (const a of fileArtifacts) {
      const existing = deduped.get(a.filePath)
      // 同路径多次操作时，保留有内容的版本
      if (!existing || (a.content && !existing.content)) {
        deduped.set(a.filePath, a)
      }
    }
    const userFacingArtifacts = [...deduped.values()].filter((a) => isUserFacingMdArtifact(a.filePath))
    const autoGeneratedArtifacts = [...deduped.values()].filter((a) => !isUserFacingMdArtifact(a.filePath))

    if (userFacingArtifacts.length > 0) {
      const fileInfo = userFacingArtifacts.map(formatFileArtifact).join('\n')
      textParts.push(`\n[File artifacts in this turn]\n${fileInfo}`)
    }
    if (autoGeneratedArtifacts.length > 0) {
      const fileInfo = autoGeneratedArtifacts.map(formatFileArtifact).join('\n')
      textParts.push(`\n[Auto-generated file artifacts]\n${fileInfo}`)
    }
  }

  return textParts.length > 0 ? textParts.join('\n') : null
}

/** 默认最大对话轮次数 */
const DEFAULT_MAX_TURNS = 10

/**
 * 从 messages 数组中提取对话轮次。
 *
 * 采用用户消息索引法（与 auto-memory 一致）：
 * 1. 收集所有 user 消息的位置
 * 2. 为每个 user 查找其后最近的 assistant 回复
 *
 * @param messages  完整消息列表
 * @param maxTurns  最多保留最后 N 轮（默认 DEFAULT_MAX_TURNS）
 */
interface ExtractResult {
  turns: Turn[]
  hasMdArtifact: boolean
  /** 最新一轮对话（最后一轮）的 assistant 回复中是否包含 .md 文件产物 */
  latestTurnHasMdArtifact: boolean
}

function extractAllTurns(messages: unknown[], maxTurns?: number, logger?: QClawLogger): ExtractResult {
  const turns: Turn[] = []
  let hasMdArtifact = false

  // 统计消息角色分布
  const roleCounts: Record<string, number> = {}
  for (const msg of messages) {
    const m = msg as Record<string, unknown> | undefined
    const role = (m?.role as string) ?? 'unknown'
    roleCounts[role] = (roleCounts[role] ?? 0) + 1
  }
  logger?.info(`[extractAllTurns] totalMessages=${messages.length}, roles=${JSON.stringify(roleCounts)}`)

  // 阶段 1：收集所有 user 消息的位置
  const userPositions: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as Record<string, unknown> | undefined
    if (msg?.role === 'user') {
      userPositions.push(i)
    }
  }
  logger?.info(`[extractAllTurns] userPositions count=${userPositions.length}`)

  // 阶段 2：正序逐一配对
  // 每个 user 消息配对其后到下一个 user 之前的所有 assistant 消息（合并文本）
  let skippedNoUserText = 0
  let skippedNoAssistant = 0
  for (let p = 0; p < userPositions.length; p++) {
    const userPos = userPositions[p]
    const nextUserPos = p + 1 < userPositions.length ? userPositions[p + 1] : messages.length
    const userMsg = messages[userPos] as Record<string, unknown>
    const userText = extractMessageContent(userMsg, logger)
    if (!userText?.trim()) {
      skippedNoUserText++
      continue
    }

    // 收集 user 之后、下一个 user 之前所有 assistant 消息的文本
    const assistantParts: string[] = []
    for (let j = userPos + 1; j < nextUserPos; j++) {
      const candidate = messages[j] as Record<string, unknown> | undefined
      if (candidate?.role !== 'assistant') continue
      const text = extractMessageContent(candidate, logger)
      if (!text) continue
      assistantParts.push(text)
      // 检测 assistant 回复中是否包含 md 文件产物标记
      if (text.includes('[File artifacts in this turn]')) {
        hasMdArtifact = true
      }
    }

    if (assistantParts.length === 0) {
      skippedNoAssistant++
      continue
    }
    turns.push({ user: userText.trim(), assistant: assistantParts.join('\n').trim() })
  }

  logger?.info(`[extractAllTurns] result: turns=${turns.length}, hasMdArtifact=${hasMdArtifact}, skippedNoUserText=${skippedNoUserText}, skippedNoAssistant=${skippedNoAssistant}`)

  // 检查最后一轮对话是否包含 md 产物
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null
  const latestTurnHasMd = lastTurn ? lastTurn.assistant.includes('[File artifacts in this turn]') : false
  logger?.info(`[extractAllTurns] latestTurnHasMdArtifact=${latestTurnHasMd}`)

  // 只保留最后 N 轮
  const limit = maxTurns ?? DEFAULT_MAX_TURNS
  if (limit > 0 && turns.length > limit) {
    logger?.info(`[extractAllTurns] truncating ${turns.length} -> ${limit}`)
    // 截断后重新检查截断范围内是否有 md 产物
    const sliced = turns.slice(-limit)
    const slicedHasMd = sliced.some((t) => t.assistant.includes('[File artifacts in this turn]'))
    return { turns: sliced, hasMdArtifact: slicedHasMd, latestTurnHasMdArtifact: latestTurnHasMd }
  }

  return { turns, hasMdArtifact, latestTurnHasMdArtifact: latestTurnHasMd }
}

// ============================================================================
// 配置读取
// ============================================================================

/**
 * 从磁盘读取用户的 openclaw.json（含自定义模型设置）。
 *
 * 候选路径优先级：
 * 1. OPENCLAW_CONFIG_PATH 环境变量（Electron 主进程注入，指向 ~/.qclaw/openclaw.json）
 * 2. stateDir/openclaw.json（stateDir = ~/.qclaw）
 * 3. $HOME/.qclaw/openclaw.json（兜底）
 * 4. stateDir/../config/openclaw.json（资源目录模板，最终兜底）
 * 5. macOS / Windows 上的 Electron 默认模板路径
 */
async function readDiskConfig(stateDir: string): Promise<Record<string, unknown> | null> {
  const configPathEnv = process.env.OPENCLAW_CONFIG_PATH?.trim()
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const candidates = [
    ...(configPathEnv ? [configPathEnv] : []),
    path.join(stateDir, 'openclaw.json'),
    path.join(home, '.qclaw', 'openclaw.json'),
    path.join(stateDir, '..', 'config', 'openclaw.json'),
    path.join(home, 'Library', 'Application Support', 'QClaw', 'openclaw', 'config', 'openclaw.json'),
    path.join(process.env.APPDATA || '', 'QClaw', 'openclaw', 'config', 'openclaw.json'),
  ]
  for (const p of candidates) {
    if (!p) continue
    try {
      const raw = await fs.readFile(p, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch { /* continue */ }
  }
  return null
}

/**
 * 构建 openclawConfig：以 api.config（运行时，占位符已替换）为基础，
 * 从磁盘覆盖 agents.defaults.model + models.providers（感知用户切换的自定义大模型）。
 *
 * 不能直接用磁盘 openclaw.json 替代 api.config，因为磁盘文件中
 * qclaw provider 的 baseUrl 含 ${QCLAW_LLM_BASE_URL} 未替换占位符。
 * 但自定义模型的 provider（如 zai）的 baseUrl 是真实 URL，可以直接用。
 *
 * 与 auto-memory 的 buildOpenClawConfig 行为保持一致。
 */
async function buildOpenClawConfig(ctx: QClawContext, stateDir: string): Promise<unknown> {
  const apiConfig = (
    ((ctx as unknown as Record<string, unknown>).api as Record<string, unknown> | undefined)?.config ?? {}
  ) as Record<string, unknown>

  const diskCfg = await readDiskConfig(stateDir)
  if (!diskCfg) return apiConfig

  let result = { ...apiConfig }

  // 1. 覆盖 agents.defaults.model（感知用户切换的模型）
  const diskAgents = diskCfg.agents as Record<string, unknown> | undefined
  const diskDefaults = diskAgents?.defaults as Record<string, unknown> | undefined
  if (diskDefaults?.model) {
    const agents = { ...((apiConfig.agents as Record<string, unknown>) ?? {}) }
    const defaults = { ...((agents.defaults as Record<string, unknown>) ?? {}) }
    defaults.model = diskDefaults.model
    agents.defaults = defaults
    result = { ...result, agents }
  }

  // 2. 合并 models.providers（自定义模型的 provider 配置，如 zai 的 baseUrl/apiKey）
  // 保留 api.config 中已替换占位符的 qclaw provider，新增/覆盖磁盘上的自定义 providers
  const diskModels = diskCfg.models as Record<string, unknown> | undefined
  const diskProviders = diskModels?.providers as Record<string, unknown> | undefined
  if (diskProviders) {
    const apiModels = { ...((apiConfig.models as Record<string, unknown>) ?? {}) }
    const apiProviders = { ...((apiModels.providers as Record<string, unknown>) ?? {}) }
    // 逐个合并：磁盘上的自定义 provider 覆盖，但保留 api.config 中 qclaw 的已替换 baseUrl
    for (const [key, value] of Object.entries(diskProviders)) {
      if (key === 'qclaw') continue // qclaw provider 保持 api.config 中已替换占位符的版本
      apiProviders[key] = value
    }
    apiModels.providers = apiProviders
    result = { ...result, models: apiModels }
  }

  return result
}

const workspaceSummary: QClawPackage = {
  id: 'workspace-summary',
  name: '会话摘要自动生成',
  description:
    '在 agent_end 时自动获取对话内容，调用 LLM 生成摘要和 artifact，保存到 ~/.qclaw/workspace',

  configSchema: {
    type: 'object',
    additionalProperties: false as const,
    properties: {
      enabled: {
        type: 'boolean',
        description: '是否启用会话摘要自动生成',
        default: true,
      },
    },
  },

  setup(ctx: QClawContext): void {
    // 清理上一轮 setup 的状态
    summarizationChains.clear()
    sessionStates.clear()
    sessionIdCache.clear()

    const stateDir = ctx.runtime.stateDir
      || process.env.OPENCLAW_STATE_DIR?.trim()
      || process.env.CLAWDBOT_STATE_DIR?.trim()
      || ''
    if (!stateDir) {
      ctx.logger.error('无法确定 stateDir，插件初始化失败')
      return
    }

    /** 动态检查开关是否开启 */
    const isEnabled = (): boolean => {
      const latestCfg = ctx.getConfig<WorkspaceSummaryConfig>()
      return latestCfg.enabled !== false
    }

    ctx.logger.info('setup 完成')

    // ---- 注册 agent_end Hook ----
    // priority 850：在 auto-memory（900）之前执行
    ctx.onHook(
      'agent_end',
      async (
        event: Record<string, unknown>,
        hookCtx,
      ): Promise<HookHandlerResult | undefined> => {
        // 开关检查
        if (!isEnabled()) return undefined

        const sessionKey = hookCtx.sessionKey
        const agentId = hookCtx.agentId
        if (!sessionKey || !agentId) return undefined

        // 从 sessionKey 提取稳定的 session 标识作为目录名
        // sessionKey 格式：agent:<agentId>:session-<timestamp>-<rand> 或 agent:<agentId>:main 等
        // 提取最后一段作为 sessionId，保证同一对话两次启动映射到同一目录
        let sessionId = sessionIdCache.get(sessionKey)
        if (!sessionId) {
          sessionId = extractSessionIdFromKey(sessionKey)
          sessionIdCache.set(sessionKey, sessionId)
        }
        ctx.logger.info(`agent_end: 解析 sessionId=${sessionId} (sessionKey=${sessionKey})`)

        // 获取完整 messages 数组
        const messages = event.messages as unknown[] | undefined
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
          return undefined
        }

        ctx.logger.info(`agent_end: session=${sessionKey}, messages.length=${messages.length}`)

        // 获取 session 状态
        // 若无记录（插件重启等），检查该 session 是否已有 store.json（即曾经生成过 summary）：
        //   - 已有 store.json → 旧 session，从 store.json 恢复 lastMessageCount（持久化的增量游标）
        //     若 store.json 中无 lastMessageCount 字段（旧版数据），从头扫描以避免漏掉新消息
        //   - 无 store.json  → 新 session / 从未总结过，从头扫描（lastMessageCount = 0）
        let state = sessionStates.get(sessionKey)
        if (!state) {
          let initialCount = 0
          try {
            const storePath = getStorePath(sessionId)
            const storeRaw = await fs.readFile(storePath, 'utf-8')
            const storeData = JSON.parse(storeRaw) as Record<string, unknown>
            // 优先使用持久化的 lastMessageCount（精确恢复游标）
            if (typeof storeData.lastMessageCount === 'number' && storeData.lastMessageCount > 0) {
              initialCount = storeData.lastMessageCount
              ctx.logger.info(`session=${sessionKey}: store.json 存在，从持久化恢复 lastMessageCount=${initialCount}`)
            } else {
              // 旧版 store.json 无 lastMessageCount 字段
              // 从头扫描（initialCount = 0），让 extractAllTurns 自然只取最后 N 轮
              // 这样既不会漏掉新消息，也不会因为历史消息过多而出问题
              initialCount = 0
              ctx.logger.info(`session=${sessionKey}: store.json 存在但无 lastMessageCount 字段，lastMessageCount 设为 0（从头扫描以避免漏掉新消息）`)
            }
          } catch {
            // store.json 不存在 → 新 session，从头扫描
            initialCount = 0
            ctx.logger.info(`session=${sessionKey}: store.json 不存在，lastMessageCount 设为 0（从头扫描）`)
          }
          state = { lastMessageCount: initialCount }
          sessionStates.set(sessionKey, state)
        }

        // 检测消息回退（新对话 / context compact / 消息裁剪）
        // 当 messages.length 小于 lastMessageCount 时，说明消息数组已被重置，
        // 需要同步重置游标，否则新对话永远走不到 extractAllTurns
        // 注意：必须在任何 early-return 之前执行此检测，包括从 store.json 恢复的场景
        if (messages.length < state.lastMessageCount) {
          ctx.logger.info(
            `session=${sessionKey}: 检测到消息回退 messages.length=${messages.length} < lastMessageCount=${state.lastMessageCount}，重置游标（可能是新对话或 context compact）`,
          )
          state.lastMessageCount = 0
        }

        // 检查是否有新消息
        if (messages.length <= state.lastMessageCount) {
          return undefined
        }

        // 提取配置
        const cfg = ctx.getConfig<WorkspaceSummaryConfig>()

        // 提取对话轮次（取最后 N 轮），同时检测是否包含 .md 文件产物
        const { turns, latestTurnHasMdArtifact } = extractAllTurns(messages, cfg.maxTurns, ctx.logger)

        if (!latestTurnHasMdArtifact) {
          ctx.logger.info(`session=${sessionKey}: 最新一轮对话无 .md 文件产物，跳过摘要生成`)
          ctx.reporter.report(REPORT_CONST.PLUGIN, {
            module_id: 'WorkspaceSummary',
            component_id: 'Hook_AgentEnd',
            event_code: 'summary',
            action_type: 'skipped',
            statistics: {
              session_key: sessionKey,
              agent_id: agentId,
              reason: 'no_md_artifact',
              message_count: messages.length,
            },
          })
          state.lastMessageCount = messages.length
          return undefined
        }

        if (turns.length === 0) {
          state.lastMessageCount = messages.length
          return undefined
        }

        ctx.logger.info(`session=${sessionKey}: latestTurnHasMdArtifact=true, msgCount=${messages.length}, turns=${turns.length}`)

        // 更新游标
        state.lastMessageCount = messages.length

        // 在入队前捕获当前游标值，避免异步执行时被后续 agent_end 覆盖
        const capturedMessageCount = state.lastMessageCount

        ctx.logger.info(
          `agent_end: session=${sessionKey}, agent=${agentId}, turns=${turns.length}, 排入摘要队列`,
        )

        // 上报：摘要生成触发
        ctx.reporter.report(REPORT_CONST.PLUGIN, {
          module_id: 'WorkspaceSummary',
          component_id: 'Summarization_Triggered',
          event_code: 'summary',
          action_type: 'triggered',
          statistics: {
            session_key: sessionKey,
            agent_id: agentId,
            turn_count: turns.length,
            message_count: messages.length,
          },
        })

        // 将摘要任务入队串行执行（不阻塞 Hook 返回）
        const prevChain = summarizationChains.get(sessionKey) ?? Promise.resolve()
        const newChain = prevChain.then(async () => {
          try {
            // ★ 二次检查：队列执行时再次检查开关，防止入队后用户关闭开关仍执行 LLM 调用
            if (!isEnabled()) {
              ctx.logger.info(`session=${sessionKey}: 摘要任务出队执行前检测到开关已关闭，跳过 LLM 调用`)
              return
            }

            // 读取 OpenClaw 配置：以 api.config（运行时，占位符已替换）为基础，
            // 从磁盘覆盖 agents.defaults.model + providers（感知用户切换的自定义大模型）
            const openclawConfig = await buildOpenClawConfig(ctx, stateDir)

            // ★ 从 hookCtx 提取关联 ID，用于 LLM sessionId/runId 拼接归因
            const sourceSessionId = (hookCtx as Record<string, unknown>).sessionId as string | undefined
            const sourceRunId = (hookCtx as Record<string, unknown>).runId as string | undefined
            ctx.logger.info(`[workspace-summary] source attribution: sourceSessionId=${sourceSessionId ?? '(none)'}, sourceRunId=${sourceRunId ?? '(none)'}`)

            const summarizationCtx = {
              turns,
              agentId,
              sessionKey,
              logger: ctx.logger,
              openclawConfig,
              timeoutMs: SUMMARIZATION_TIMEOUT_MS,
              reporter: ctx.reporter,
              sourceSessionId,
              sourceRunId,
            }

            // 调用 LLM 生成 summary（会话摘要）
            const summaryResult = await generateSummary(summarizationCtx)

            if (!summaryResult) {
              ctx.logger.warn(`session=${sessionKey}: 摘要生成为空，跳过持久化`)
              ctx.reporter.report(REPORT_CONST.PLUGIN, {
                module_id: 'WorkspaceSummary',
                component_id: 'Summarization_Result',
                event_code: 'summary',
                action_type: 'empty_result',
                statistics: {
                  session_key: sessionKey,
                  agent_id: agentId,
                  turn_count: turns.length,
                },
              })
              return
            }

            // ★ 三次检查：LLM 返回后、持久化前再次确认开关，防止 LLM 飞行期间用户关闭开关
            if (!isEnabled()) {
              ctx.logger.info(`session=${sessionKey}: LLM 已返回但开关已关闭，丢弃摘要结果`)
              return
            }

            // 持久化到文件系统（使用 sessionId 作为目录名）
            await persistSummary(sessionId, agentId, summaryResult, ctx.logger, capturedMessageCount, ctx.reporter)
            ctx.logger.info(`session=${sessionKey} (dir=${sessionId}): summary 已持久化`)

            // 上报：摘要生成+持久化成功
            ctx.reporter.report(REPORT_CONST.PLUGIN, {
              module_id: 'WorkspaceSummary',
              component_id: 'Summarization_Result',
              event_code: 'summary',
              action_type: 'completed',
              statistics: {
                session_key: sessionKey,
                agent_id: agentId,
                session_name: summaryResult.sessionName,
                turn_count: turns.length,
                summary_length: summaryResult.summaryContent.length,
              },
            })
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            ctx.logger.error(
              `session=${sessionKey}: 摘要流程失败 - ${errMsg}`,
            )
            ctx.reporter.report(REPORT_CONST.PLUGIN, {
              module_id: 'WorkspaceSummary',
              component_id: 'Summarization_Result',
              event_code: 'summary',
              action_type: 'failed',
              statistics: {
                session_key: sessionKey,
                agent_id: agentId,
                turn_count: turns.length,
                error_message: errMsg.slice(0, 200),
              },
            })
          }
        }).finally(() => {
          // 链完成后清理，防止 Promise 闭包持有 turns 等大对象导致内存泄漏
          if (summarizationChains.get(sessionKey) === newChain) {
            summarizationChains.delete(sessionKey)
          }
        })
        summarizationChains.set(sessionKey, newChain)

        // Hook 立即返回，不阻塞
        return undefined
      },
      { priority: 850, concurrent: true },
    )
  },

  teardown(): void {
    summarizationChains.clear()
    sessionStates.clear()
    sessionIdCache.clear()
  },
}

export default workspaceSummary

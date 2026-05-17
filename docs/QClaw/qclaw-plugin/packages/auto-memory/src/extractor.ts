/**
 * auto-memory LLM 提取器
 *
 * - Prompt B: 实质工作记录 → memory/YYYY-MM-DD.md（JSON 输出，标签行）
 * - Consolidator 使用独立的 Prompt C（见 consolidator.ts）
 *
 * LLM 调用使用 runEmbeddedPiAgent（与 memory-tencentdb 一致的内部 API），
 * 不再直接 HTTP 调 /v1/chat/completions（该端点 Gateway 不暴露）。
 */

import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Turn, MemoryOperation, DailyFact, ExtractionContext } from './types.js'
import { REPORT_CONST } from '../../../core/reporter-constants.js'

// ============================================================================
// Prompt B — Daily work records
// ============================================================================

const DAILY_WORK_SYSTEM_PROMPT = `你是一个工作记录和用户画像提取器。从对话中提取用户的实质工作记录和个人偏好信息。

输出格式 — 必须严格遵守：
你必须且只能输出一个合法的 JSON 对象。不要输出任何其他文字、解释、问候或 markdown 代码块标记。
如果没有实质内容可记录，只输出：{"topic":"","facts":[]}

{
  "topic": "2-6个字的主题摘要",
  "facts": [
    { "tag": "done", "content": "具体描述" },
    { "tag": "discussion", "content": "具体描述" },
    { "tag": "follow-up", "content": "具体描述" },
    { "tag": "preference", "content": "具体描述" }
  ]
}

字段说明：
- topic：用 2-6 个字概括这段对话的主题（如"天气查询"、"用户信息"、"Bug修复"、"PPT制作"）
- facts：具体的记忆条目

允许的 tag 值：done / discussion / follow-up / preference

示例：

输入："今天修了 token 过期校验的 bug，还跟产品讨论了新版本方案——下周二评审"
输出：{"topic":"Bug修复与版本讨论","facts":[{"tag":"done","content":"修复了 token 过期校验缺失导致的 bug"},{"tag":"discussion","content":"新版本方案评审定在下周二"}]}

输入："帮我查一下这个报错。哦是配置写错了。明天更新一下文档"
输出：{"topic":"配置排查","facts":[{"tag":"done","content":"排查并定位到配置错误导致的问题"},{"tag":"follow-up","content":"明天更新相关文档"}]}

输入："我叫小李，在 xx公司 做运营，我们组主要负责 某某 产品推广。老板是 XXX"
输出：{"topic":"用户信息","facts":[{"tag":"preference","content":"用户名叫小李，在xx公司 做运营，所在组负责 某某 产品推广，直属上级是 XXX"}]}

输入："以后帮我做 PPT 配色用深蓝+白色的商务风，标题要简短有力"
输出：{"topic":"PPT偏好","facts":[{"tag":"preference","content":"PPT 制作偏好：深蓝+白色商务风配色，标题简短有力"}]}

输入："好的谢谢"
输出：{"topic":"","facts":[]}

输入："User: 我叫小王，在上海做设计。\\nAssistant: 你好小王！\\n\\n---\\n\\nUser: 以后帮我做海报用红色主色调。\\nAssistant: 记下了。"
输出：{"topic":"用户信息与设计偏好","facts":[{"tag":"preference","content":"用户名叫小王，在上海做设计"},{"tag":"preference","content":"海报设计偏好：红色主色调"}]}

提取规则：
- done：已完成的任务 / 修复的问题 / 交付的成果 / 代码变更
- discussion：技术决策 / 方案讨论 / 架构选型 / 问题分析
- follow-up：未来计划 / 待办事项 / 遗留问题
- preference：个人信息、兴趣爱好、生活方式、价值观、工作偏好、工具偏好等（如姓名、部门、喜好的新闻话题、运动、音乐、旅行风格）
- ★★ 每轮 User/Assistant 对话都必须独立检查，不要因为后面的对话而忽略前面的内容
- ★★ 用户主动提供的身份信息（姓名、公司、部门、上级等）是最高优先级，必须记录为 preference，即使 AI 已在回复中复述确认
- ★ 用户明确表达的学习需求、兴趣目标（如"想学英文"、"想学AI"）也应记录为 preference
- 只记录用户的产出和偏好，不要记录 AI 的行为或简单问答

关键要求：所有 "content" 和 "topic" 的值必须使用用户在对话中使用的语言书写。`

// ============================================================================
// runEmbeddedPiAgent 加载（与 memory-tencentdb/clean-context-runner.ts 一致）
// ============================================================================

type RunEmbeddedPiAgentFn = (params: Record<string, unknown>) => Promise<unknown>

let _openclawRootCache: string | null = null

/** 向上查找 package.json 找到 openclaw 包根目录 */
function findPackageRoot(startDir: string, name: string): string | null {
  let dir = startDir
  for (;;) {
    const pkgPath = path.join(dir, 'package.json')
    try {
      if (fsSync.existsSync(pkgPath)) {
        const raw = fsSync.readFileSync(pkgPath, 'utf8')
        const pkg = JSON.parse(raw) as { name?: string }
        if (pkg.name === name) return dir
      }
    } catch { /* ignore */ }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function resolveOpenClawRoot(): string {
  if (_openclawRootCache) return _openclawRootCache
  const override = process.env.OPENCLAW_ROOT?.trim()
  if (override) { _openclawRootCache = override; return override }

  const candidates = new Set<string>()
  if (process.argv[1]) candidates.add(path.dirname(process.argv[1]))
  candidates.add(process.cwd())
  try { candidates.add(path.dirname(fileURLToPath(import.meta.url))) } catch { /* ignore */ }

  for (const start of candidates) {
    const found = findPackageRoot(start, 'openclaw')
    if (found) { _openclawRootCache = found; return found }
  }
  throw new Error('Unable to resolve OpenClaw root. Set OPENCLAW_ROOT or run `pnpm build`.')
}

let _loadPromise: Promise<RunEmbeddedPiAgentFn> | null = null

/** 延迟加载 runEmbeddedPiAgent（从 dist/extensionAPI.js 动态导入） */
function loadRunEmbeddedPiAgent(): Promise<RunEmbeddedPiAgentFn> {
  if (_loadPromise) return _loadPromise

  _loadPromise = (async () => {
    const distPath = path.join(resolveOpenClawRoot(), 'dist', 'extensionAPI.js')
    if (!fsSync.existsSync(distPath)) {
      throw new Error(`Missing core module at ${distPath}. Run \`pnpm build\`.`)
    }
    const mod = await import(pathToFileURL(distPath).href)
    if (typeof mod.runEmbeddedPiAgent !== 'function') {
      throw new Error('runEmbeddedPiAgent not exported from dist/extensionAPI.js')
    }
    return mod.runEmbeddedPiAgent as RunEmbeddedPiAgentFn
  })()

  _loadPromise.catch(() => { _loadPromise = null })
  return _loadPromise
}

// ============================================================================
// Model 解析（与 memory-tencentdb/clean-context-runner.ts 一致）
// ============================================================================

/** Parsed model reference: { provider, model } */
interface ModelRef {
  provider: string
  model: string
}

/**
 * Parse a "provider/model" string into its components.
 * Returns undefined if the input is empty or doesn't contain a "/".
 *
 * Examples:
 *   "azure/gpt-5.2-chat"          → { provider: "azure", model: "gpt-5.2-chat" }
 *   "custom-host/org/model-v2"    → { provider: "custom-host", model: "org/model-v2" }
 *   ""                            → undefined
 *   "bare-model-name"             → undefined (no "/" — may be an alias)
 */
function parseModelRef(raw: string | undefined): ModelRef | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined

  const slashIdx = trimmed.indexOf('/')
  if (slashIdx <= 0 || slashIdx === trimmed.length - 1) return undefined

  return {
    provider: trimmed.slice(0, slashIdx),
    model: trimmed.slice(slashIdx + 1),
  }
}

/**
 * Resolve the user's default model from the main OpenClaw config.
 *
 * Resolution order (与 memory-tencentdb 一致):
 * 1. Read `agents.defaults.model` (string or { primary })
 * 2. If the value contains "/", parse directly
 * 3. If not (may be an alias), look up in `agents.defaults.models` alias table
 * 4. Return undefined if nothing resolves — let the core use its built-in default
 */
function resolveModelFromMainConfig(config: unknown): ModelRef | undefined {
  if (!config || typeof config !== 'object') return undefined

  const cfg = config as Record<string, unknown>
  const agents = cfg.agents as Record<string, unknown> | undefined
  if (!agents || typeof agents !== 'object') return undefined

  const defaults = agents.defaults as Record<string, unknown> | undefined
  if (!defaults || typeof defaults !== 'object') return undefined

  // Step 1: extract raw model value (string | { primary?: string })
  const modelCfg = defaults.model
  let raw: string | undefined
  if (typeof modelCfg === 'string') {
    raw = modelCfg.trim()
  } else if (modelCfg && typeof modelCfg === 'object') {
    const primary = (modelCfg as Record<string, unknown>).primary
    raw = typeof primary === 'string' ? primary.trim() : undefined
  }
  if (!raw) return undefined

  // Step 2: try direct "provider/model" parse
  const direct = parseModelRef(raw)
  if (direct) return direct

  // Step 3: alias lookup — raw doesn't contain "/", check agents.defaults.models
  const models = defaults.models as Record<string, unknown> | undefined
  if (!models || typeof models !== 'object') return undefined

  const rawLower = raw.toLowerCase()
  for (const [key, entry] of Object.entries(models)) {
    if (!entry || typeof entry !== 'object') continue
    const alias = (entry as Record<string, unknown>).alias
    if (typeof alias !== 'string') continue
    if (alias.trim().toLowerCase() !== rawLower) continue

    // key is "provider/model" format
    const resolved = parseModelRef(key)
    if (resolved) return resolved
  }

  return undefined
}

/** Resolve tmp dir for auto-memory operations */
function resolveAutoMemoryTmpDir(): string {
  const POSIX_DIR = '/tmp/openclaw'
  try {
    if (fsSync.existsSync(POSIX_DIR)) {
      fsSync.accessSync(POSIX_DIR, fsSync.constants.W_OK | fsSync.constants.X_OK)
      return POSIX_DIR
    }
    fsSync.mkdirSync(POSIX_DIR, { recursive: true, mode: 0o700 })
    return POSIX_DIR
  } catch {
    const fallback = path.join(os.tmpdir(), 'openclaw-auto-memory')
    fsSync.mkdirSync(fallback, { recursive: true })
    return fallback
  }
}

/**
 * 清理 OpenClaw embedded agent 自动生成的临时 session 日志文件。
 * 这些 .jsonl 文件是 OpenClaw 框架对每次 LLM 调用自动生成的 session 日志，
 * 对于 auto-memory 的内部后台调用没有保留价值，不清理会随对话轮数无限累积。
 */
async function cleanupSessionLogs(tmpDir: string): Promise<void> {
  try {
    const files = await fs.readdir(tmpDir)
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'))
    for (const f of jsonlFiles) {
      try {
        await fs.unlink(path.join(tmpDir, f))
      } catch {
        // best-effort: 删除失败不影响业务
      }
    }
  } catch {
    // tmpDir 不存在或不可读，忽略
  }
}

const _cleanWorkspaceDirs = new Map<string, string>()

async function getCleanWorkspaceDir(purpose = 'default'): Promise<string> {
  const cached = _cleanWorkspaceDirs.get(purpose)
  if (cached) return cached
  const dir = path.join(resolveAutoMemoryTmpDir(), `auto-memory-${purpose}`)
  await fs.mkdir(dir, { recursive: true })
  _cleanWorkspaceDirs.set(purpose, dir)
  return dir
}

// ============================================================================
// 共享 LLM 调用（export 供 consolidator 复用）
// ============================================================================

/**
 * 通过 OpenClaw 内部 API (runEmbeddedPiAgent) 调用 LLM。
 * 与 memory-tencentdb 的 CleanContextRunner 使用完全一致的机制：
 * - 空 workspace 目录（避免 LLM 加载项目上下文变成聊天模式）
 * - systemPrompt + userContent 合并传入 effectivePrompt
 * - 从主配置自动解析 model（含 alias 解析）
 */
export async function callLlmViaEmbeddedAgent(
  ctx: ExtractionContext,
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
  purpose = 'daily',
): Promise<string> {
  const runEmbeddedPiAgent = await loadRunEmbeddedPiAgent()
  const cleanWorkspace = await getCleanWorkspaceDir(purpose)

  // Model 解析：与 memory-tencentdb 一致，从主配置自动解析
  const baseConfig = ctx.openclawConfig as Record<string, unknown> ?? {}
  const resolvedModel = resolveModelFromMainConfig(baseConfig)

  // 构建与 memory-tencentdb 一致的 cleanConfig
  // 禁用插件防止 workspace 不匹配导致重载，限制工具集避免空 tools[] 被拒绝
  const cleanConfig = {
    ...baseConfig,
    plugins: {
      ...((baseConfig.plugins as Record<string, unknown> | undefined)),
      enabled: false,
    },
    tools: {
      ...((baseConfig.tools as Record<string, unknown> | undefined)),
      allow: ['read'], // 最小只读工具集，避免某些 provider 拒绝空 tools[]
    },
  }

  // 与 memory-tdai 一致：system + user 合并为 effectivePrompt，
  // 同时也单独传 systemPrompt 参数（embedded agent 支持分离传递时优先使用）
  const effectivePrompt = `${systemPrompt}\n\n---\n\n${userContent}`

  const ts = Date.now()
  const hasSource = !!(ctx.sourceSessionId && ctx.sourceRunId)
  const llmSessionId = hasSource
    ? `plg-mem-${ctx.sourceSessionId}`
    : `plg-mem-${ctx.agentId}-${ts}`
  const llmRunId = hasSource
    ? `plg-mem-${ctx.sourceRunId}`
    : `plg-mem-${ts}`
  ctx.logger.info(`[auto-memory:extractor] LLM call attribution: sessionId=${llmSessionId}, runId=${llmRunId}`)

  const result = await runEmbeddedPiAgent({
    sessionId: llmSessionId,
    sessionFile: '', // 由内部创建临时 session
    workspaceDir: cleanWorkspace, // ★ 关键：空 workspace！不加载项目上下文
    config: cleanConfig,
    prompt: effectivePrompt,     // ★ 合并后的 prompt
    systemPrompt,                // ★ 也单独传（agent 可能支持分离）
    timeoutMs: 120_000,
    runId: llmRunId,
    provider: resolvedModel?.provider,
    model: resolvedModel?.model,
    // ★ disableTools:true — 记忆提取只需 LLM 输出 JSON，不需要任何工具。
    // 之前 disableTools:false + allow:['read'] 导致 LLM 可能主动调用 read 工具，
    // 触发 agent ReAct Loop 多轮请求（1 次提取变 3-6 次 LLM 调用）。
    // 注意：部分 provider（如 qwencode）拒绝 tools:[]，但 disableTools:true
    // 在 run.ts 中会完全跳过 tools 字段，不会发送空数组。
    disableTools: true,
    streamParams: {
      maxTokens,
    },
  })

  // 清理 OpenClaw 框架自动生成的临时 session 日志文件（.jsonl）
  // embedded agent 每次调用会在 tmpDir 下创建 session 日志，内部调用不需要保留
  await cleanupSessionLogs(resolveAutoMemoryTmpDir())

  // 从 payloads 中收集文本输出
  const payloads = (result as Record<string, unknown>).payloads as
    Array<{ text?: string; isError?: boolean }> | undefined
  if (!payloads) return ''

  const texts = payloads
    .filter((p) => !p.isError && typeof p.text === 'string')
    .map((p) => p.text ?? '')
  return texts.join('\n').trim()
}

/** 格式化对话文本 */
function formatConversation(turns: Turn[]): string {
  return turns
    .map((t) => `User: ${t.user}\nAssistant: ${t.assistant}`)
    .join('\n\n---\n\n')
}

// ============================================================================
// JSON 提取与 NL 兜底解析（export 供 consolidator 复用）
// ============================================================================

/**
 * 从 LLM 原始输出中提取有效的 JSON 字符串。
 *
 * 容错策略（按优先级）：
 * 1. 整个字符串本身就是合法 JSON → 直接返回
 * 2. 被 ```json ... ``` 代码块包裹 → 提取代码块内容
 * 3. 混在自然语言中 → 用正则找到第一个 { ... } 对象
 */
export function extractJson(raw: string): string | null {
  // Strategy 1: 整体就是合法 JSON
  const trimmed = raw.trim()
  try { JSON.parse(trimmed); return trimmed } catch { /* fall through */ }

  // Strategy 2: ```json ... ``` 代码块
  const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i)
  if (codeBlockMatch) {
    try { JSON.parse(codeBlockMatch[1].trim()); return codeBlockMatch[1].trim() } catch { /* fall through */ }
  }

  // Strategy 3: 从自然语言中找 { ... } 对象（支持嵌套括号）
  const objMatch = extractJsonObject(raw)
  if (objMatch) return objMatch

  return null
}

/** 从文本中提取最外层 { ... } JSON 对象，正确处理嵌套花括号 */
function extractJsonObject(text: string): string | null {
  let start = -1
  let depth = 0
  let inString = false
  let escapeNext = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (escapeNext) { escapeNext = false; continue }

    if (ch === '\\' && inString) { escapeNext = true; continue }

    if (ch === '"') { inString = !inString; continue }

    if (inString) continue

    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, i + 1)
        try { JSON.parse(candidate); return candidate } catch { /* continue searching */ }
      }
    }
  }

  return null
}

// ============================================================================
// 自然语言兜底解析（当 LLM 拒绝输出 JSON 时）
// ============================================================================

/**
 * 从 LLM 返回的自然语言文本中尝试解析出记忆操作 (MemoryOperation)。
 * 支持的文本模式：
 * - 列表项："**工位**：深圳滨海大厦 15 楼" 或 "- 工位：深圳..."
 * - 冒号分隔键值对："老板: Alex" / "工位: 深圳"
 */
export function parseNaturalLanguageToMemory(rawText: string): MemoryOperation | null {
  const lines = rawText.split('\n')
  const addOps: Array<{ section: string; fact: string }> = []

  // 匹配模式：
  // 1. **key**：value  （markdown 加粗 + 中文/英文冒号）
  // 2. - **key**：value  （列表 + markdown 加粗）
  // 3. - key：value     （列表 + 普通文本）
  // 4. key：value / key: value  （简单键值对）
  const patterns = [
    // "**key**：value" or "- **key**：value"
    /^\s*[-*]?\s*\*\*(.+?)\*\*[：:]\s*(.+)$/,
    // "- key：value"
    /^\s*[-*]\s*(.+?)[：:]\s*(.+)$/,
    // "key：value" (standalone, not part of a sentence)
    /^(.+?)[：:]\s*(.+)$/,
  ]

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.length < 4) continue

    // 跳过明显非事实的行
    if (/^(没问题|好的|收到|OK|可以|明白|了解|这些信息|已更新|已经存过|之前|需要帮忙|随时说|让我|我来|我帮你)/i.test(trimmed)) continue

    // 跳过 JSON 结构片段（如 "update": [], "add": [], "remove": [] 等）
    if (/^"?\w+"?\s*[：:]\s*[\[\{]/.test(trimmed)) continue
    // 跳过 key 本身是带引号的 JSON 字段名（如 "section", "fact", "add"）
    if (/^"(add|update|remove|section|fact|new_fact|old_pattern|reason|pattern)"/.test(trimmed)) continue
    // 跳过以 { 或 [ 开头的行（JSON 对象/数组残片 — LLM 输出了无法 parse 的伪 JSON）
    if (/^\s*[\[{]/.test(trimmed)) continue
    // 跳过包含转义引号 \" 的行（JSON 字符串化残片）
    if (/\\"[a-zA-Z_]+\\"/.test(trimmed)) continue

    for (const pattern of patterns) {
      const match = trimmed.match(pattern)
      if (match) {
        const key = match[1].trim()
        const value = match[2].trim()
        // 跳过 key 是带引号的字符串（JSON 字段名残留）或 value 是空数组/对象
        if (/^["']/.test(key) && /^["']/.test(key.slice(-1))) continue
        if (/^\s*[\[\{]\s*[\]\}]?\s*$/.test(value)) continue
        // 跳过 value 以 { 或 [ 开头（嵌套 JSON 残片，如 value=`{"section":"xxx", ...}`）
        if (/^\s*[\[{]/.test(value)) continue
        // 跳过 value 包含 JSON 结构关键字（如 "old_pattern"："xxx"）
        if (/["'](?:section|fact|old_pattern|new_fact|pattern|reason)["']\s*[：:]/.test(value)) continue
        // 过滤掉太短或不像事实的条目
        if (key.length >= 1 && value.length >= 2 && value.length < 200) {
          // 根据关键词自动归类 section
          const section = classifySection(key, value)
          addOps.push({ section, fact: `${key}：${value}` })
          break // 一个行只匹配一次
        }
      }
    }
  }

  if (addOps.length === 0) return null

  return { add: addOps, update: [], remove: [] }
}

/** 根据键值内容自动分类 section */
function classifySection(key: string, _value: string): string {
  const k = key.toLowerCase()
  const workKeywords = ['工位', '公司', '部门', '团队', '老板', '上级', '同事', '职位', '岗位', 'desk', 'company', 'team', 'manager', 'boss', 'colleague', 'role', 'position']
  const identityKeywords = ['姓名', '名字', '年龄', '性别', '生日', '所在地', '城市', '住址', 'name', 'age', 'gender', 'birthday', 'city', 'location', 'address']
  const techKeywords = ['语言', '框架', '工具', 'IDE', '编辑器', '系统', '环境', '版本', 'language', 'framework', 'tool', 'editor', 'system', 'environment', 'version']

  if (workKeywords.some(w => k.includes(w))) return '用户身份与偏好'
  if (identityKeywords.some(w => k.includes(w))) return '用户身份与偏好'
  if (techKeywords.some(w => k.includes(w))) return '技术规范偏好'

  return '用户身份与偏好' // 默认分类
}

// ============================================================================
// Daily work extraction entry
// ============================================================================

/** LLM 输出的 Daily Fact（JSON 解析用） */
interface LlmDailyFact {
  tag: string
  content: string
}

interface LlmDailyOutput {
  topic?: string
  facts: LlmDailyFact[]
}

const VALID_TAGS: Record<string, DailyFact['tag']> = {
  // Primary (English — used by new prompts)
  'done': 'done',
  'discussion': 'discussion',
  'follow-up': 'follow-up',
  'preference': 'preference',
  // Legacy (Chinese — backward compatible with existing data)
  '完成': 'done',
  '讨论': 'discussion',
  '待跟进': 'follow-up',
  '偏好': 'preference',
}

/**
 * 修复 LLM 输出的 JSON 字符串值中的裸换行符。
 *
 * JSON 规范不允许字符串值内有裸换行（\n），但 LLM 常在长 content 值中间换行，如：
 * {"content":"用户想要将 Grok 大\n模型接入 OpenClaw"}
 *
 * 策略：逐字符扫描，在 JSON 字符串内部遇到裸换行/回车时替换为空格。
 */
function repairNewlinesInJsonStrings(json: string): string {
  let result = ''
  let inString = false
  let escapeNext = false

  for (let i = 0; i < json.length; i++) {
    const ch = json[i]

    if (escapeNext) {
      result += ch
      escapeNext = false
      continue
    }

    if (ch === '\\' && inString) {
      result += ch
      escapeNext = true
      continue
    }

    if (ch === '"') {
      inString = !inString
      result += ch
      continue
    }

    if (inString && (ch === '\n' || ch === '\r')) {
      // 裸换行 → 替换为空格
      if (ch === '\r' && i + 1 < json.length && json[i + 1] === '\n') {
        i++ // 跳过 \r\n 中的 \n
      }
      result += ' '
      continue
    }

    result += ch
  }

  return result
}

/**
 * 修复 LLM 输出的 JSON 中 content 值内的未转义引号。
 *
 * LLM 常在中文语境输出类似 {"content":"结尾页要求：放"谢谢"加联系方式"} 的 JSON，
 * 其中 "谢谢" 的引号破坏了 JSON 结构。
 *
 * 策略：逐字符扫描，在 JSON string value 内部遇到未转义的 " 时替换为中文引号或转义。
 * 这是一个 best-effort 修复，不保证覆盖所有边界情况。
 */
function repairUnescapedQuotesInJson(json: string): string {
  // 尝试方案 1：将 content 值中的中文/英文引号对统一替换为安全字符
  let repaired = json
    .replace(/\u201c/g, '\u300c')  // "→「
    .replace(/\u201d/g, '\u300d')  // "→」

  // 尝试方案 2：逐段修复 "content":"..." 中的内嵌引号
  // 匹配 "content":" 开始到 "} 或 "," 结束的区间
  repaired = repaired.replace(
    /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
    (fullMatch) => {
      // 如果原始匹配能直接被 JSON.parse 解析，保持不变
      try {
        JSON.parse(`{${fullMatch}}`)
        return fullMatch
      } catch {
        // 无法解析，说明 content 值中有未转义的引号
      }
      return fullMatch
    },
  )

  // 尝试方案 3：暴力修复 — 找到所有 "content":" 后的内容，
  // 向后扫描到真正的 JSON 边界（"}  或 ",），中间的裸引号全部转义
  try {
    const contentPattern = /"content"\s*:\s*"/g
    let result = ''
    let lastIdx = 0
    let m: RegExpExecArray | null

    while ((m = contentPattern.exec(json)) !== null) {
      result += json.slice(lastIdx, m.index + m[0].length)
      let i = m.index + m[0].length
      let escaped = ''

      // 向后扫描到 string value 的真正结束位置
      while (i < json.length) {
        if (json[i] === '\\') {
          escaped += json[i] + (json[i + 1] || '')
          i += 2
          continue
        }
        if (json[i] === '"') {
          // 检查下一个非空白字符是否是 JSON 结构字符（} , ]）
          let j = i + 1
          while (j < json.length && json[j] === ' ') j++
          if (j >= json.length || '}\n,]'.includes(json[j])) {
            // 这是真正的闭合引号
            escaped += '"'
            i++
            break
          }
          // 否则是 content 内部的裸引号，转义它
          escaped += '\\"'
          i++
          continue
        }
        escaped += json[i]
        i++
      }
      result += escaped
      lastIdx = i
    }
    result += json.slice(lastIdx)

    if (result !== json) return result
  } catch {
    // 修复逻辑异常，返回原始值
  }

  return repaired
}

/**
 * 尝试从 LLM 原始输出解析 DailyFacts。
 * 策略：JSON 优先（含修复重试）→ 正则兜底 → 返回空
 */
function parseDailyOutput(raw: string): { facts: DailyFact[]; topic: string; method: 'json' | 'regex' | 'empty' } {
  const trimmed = raw.trim()

  // 路径 1: JSON 解析（主路径 — 与 memory-tencentdb 一致）
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    // 尝试直接 parse，失败后修复常见问题再 retry
    const attempts: string[] = [
      jsonMatch[0],
      // 修复 1: JSON 字符串值内的裸换行 — LLM 常在 content 值中间输出换行符
      // JSON 规范不允许字符串值内有裸换行，需替换为空格
      repairNewlinesInJsonStrings(jsonMatch[0]),
      // 修复 2: content 值中的未转义引号 — LLM 常在中文语境输出 放"谢谢"加联系方式
      repairUnescapedQuotesInJson(jsonMatch[0]),
      // 修复 3: 同时修复换行 + 引号
      repairUnescapedQuotesInJson(repairNewlinesInJsonStrings(jsonMatch[0])),
    ]

    for (const candidate of attempts) {
      try {
        const parsed = JSON.parse(candidate) as unknown
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          'facts' in parsed &&
          Array.isArray((parsed as Record<string, unknown>).facts)
        ) {
          const output = parsed as LlmDailyOutput
          const topic = typeof output.topic === 'string' ? output.topic.trim() : ''
          const facts: DailyFact[] = []
          for (const f of output.facts) {
            if (!f || typeof f !== 'object') continue
            // ★ 容错：LLM 偶尔输出 "\ntag" 或 " content" 等带空白字符的 JSON key，
            // JSON.parse 后 key 保留了污染字符，导致 f.tag / f.content 为 undefined。
            // 遍历所有 key 并 trim 查找真正的 tag 和 content。
            const obj = f as unknown as Record<string, unknown>
            let rawTag = ''
            let content = ''
            for (const [k, v] of Object.entries(obj)) {
              const trimmedKey = k.trim().toLowerCase()
              if (trimmedKey === 'tag' && typeof v === 'string') rawTag = v.trim()
              if (trimmedKey === 'content' && typeof v === 'string') content = v.trim()
            }
            if (content.length > 0 && rawTag.length > 0) {
              const tag = VALID_TAGS[rawTag]
              if (tag) {
                facts.push({ tag, text: content, topic })
              }
            }
          }
          return { facts, topic, method: 'json' }
        }
      } catch {
        // 继续尝试下一个修复方案
      }
    }
  }

  // 路径 2: 正则 [标签] 格式兜底（兼容 LLM 不遵守 JSON 指令的情况）
  const facts: DailyFact[] = []
  for (const line of trimmed.split('\n')) {
    const match = line.match(/^\[([^\]]+)\]\s*(.+)$/)
    if (!match) continue
    const tag = VALID_TAGS[match[1]]
    if (!tag) continue
    const text = match[2].trim()
    if (text.length > 0) facts.push({ tag, text, topic: '' })
  }

  if (facts.length > 0) return { facts, topic: '', method: 'regex' }

  // 路径 3: 完全无法解析
  return { facts: [], topic: '', method: 'empty' }
}

/** 提取实质工作记录（→ memory/YYYY-MM-DD.md） */
export async function extractDailyWork(
  ctx: ExtractionContext,
): Promise<DailyFact[]> {
  const startTs = Date.now()
  try {
    const userContent = formatConversation(ctx.turns)

    // 50K 字符截断兜底：2 小时窗口内极端高频对话可能累积大量文本，
    // 截断保留尾部（最新对话），防止超出模型上下文窗口。
    const MAX_CONVERSATION_CHARS = 50_000
    const truncatedContent = userContent.length > MAX_CONVERSATION_CHARS
      ? userContent.slice(-MAX_CONVERSATION_CHARS)
      : userContent

    if (userContent.length > MAX_CONVERSATION_CHARS) {
      ctx.logger.info(`[auto-memory:daily] conversation truncated: ${userContent.length} → ${MAX_CONVERSATION_CHARS} chars (keeping tail)`)
    }
    ctx.logger.info(`[auto-memory:daily] calling LLM with ${truncatedContent.length} chars (${ctx.turns.length} turns)`)

    // maxTokens = completion_tokens = reasoning_tokens + output_tokens
    // 带思考能力的模型 reasoning 会占大量 tokens。
    // 2 小时窗口内可能累积 50 轮对话，产出 10-15 条 facts，
    // output ~1500 tokens + reasoning ~1500 tokens，4096 足够。
    const raw = await callLlmViaEmbeddedAgent(ctx, DAILY_WORK_SYSTEM_PROMPT, truncatedContent, 4096)
    const llmDuration = Date.now() - startTs
    ctx.logger.info(`[auto-memory:daily] LLM returned (${llmDuration}ms, ${raw.length}chars)`)
    ctx.logger.info(`[auto-memory:daily] LLM raw output: ${raw.slice(0, 500)}`)

    if (!raw || raw.trim().length === 0) {
      ctx.logger.warn('[auto-memory:daily] LLM returned empty string — treating as transient failure')
      // ★ 抛出错误而非返回空数组：空响应通常是超时/限流，不是"无内容"。
      // 正常的"无内容"应该是 LLM 返回 {"facts":[]}，能被正常解析。
      // 抛出后 doExtraction 的 .catch() 不会推进游标，下次触发时会重试这批对话。
      throw new Error('LLM returned empty response (likely timeout or rate limit)')
    }

    const { facts, method } = parseDailyOutput(raw)

    const totalDuration = Date.now() - startTs

    // ★ 检测 LLM 返回异常快且无 facts 的可疑响应
    // 正常的"无内容"应该是 LLM 返回 {"facts":[]} 并花费合理时间（通常 > 3s）
    // 如果 < 2s 且 method=empty（完全无法解析为 JSON），说明 LLM 可能返回了垃圾
    // （如重启混乱期间 prompt 被破坏、走了错误模型等）
    if (facts.length === 0 && method === 'empty' && totalDuration < 2000) {
      ctx.logger.warn(
        `[auto-memory:daily] suspicious LLM response: method=empty, duration=${totalDuration}ms — treating as transient failure`,
      )
      throw new Error(`Suspicious LLM response (method=empty, ${totalDuration}ms): likely model error or corrupted prompt`)
    }

    ctx.logger.info(`[auto-memory:daily] extracted ${facts.length} facts (method=${method})`)

    // 上报提取详情（含空结果）
    ctx.reporter.report(REPORT_CONST.PLUGIN, {
      module_id: 'AutoMemory',
      component_id: 'Extraction_Content',
      event_code: 'extraction',
      action_type: 'daily_extract',
      action_status: facts.length > 0 ? 'success' : 'empty_result',
      statistics: {
        agent_id: ctx.agentId,
        type: 'daily',
        duration_ms: totalDuration,
        fact_count: facts.length,
        parse_method: method,
        input_length: userContent.length,
        output_length: raw.length,
      },
    })

    return facts
  } catch (err) {
    const durationMs = Date.now() - startTs
    const errMsg = err instanceof Error ? err.message : String(err)
    ctx.logger.warn(`[auto-memory:daily] extraction failed (${durationMs}ms): ${errMsg}`)

    ctx.reporter.report(REPORT_CONST.PLUGIN, {
      module_id: 'AutoMemory',
      component_id: 'Extraction_Content',
      event_code: 'extraction',
      action_type: 'daily_extract',
      action_status: 'fail',
      statistics: {
        agent_id: ctx.agentId,
        type: 'daily',
        duration_ms: durationMs,
        error_message: errMsg.slice(0, 200),
      },
    })

    // ★ rethrow：让 doExtraction 的 catch 走失败重试路径（不推进游标）
    // 之前 return [] 会被上层当作"成功但无 facts"，静默推进游标导致数据丢失
    throw err
  }
}

/**
 * auto-memory — 自动记忆提取 Package
 *
 * 架构：Daily-First（日志先行 + 定时提纯）
 *
 * 1. agent_end → 只提取实质工作记录 → 写入 memory/YYYY-MM-DD.md（唯一实时写入点）
 * 2. Consolidator 定时从 daily 日志中提炼长期记忆 → 写入 MEMORY.md
 *
 * 游标管理：
 * - 持久化到 {stateDir}/.auto-memory/cursor-{sessionKey}.json
 * - 重启/setup 重建后自动恢复，不会重复提取
 * - 锚点 hash + 索引双重定位，防止 messages 数组偏移
 *
 * 并发控制：
 * - 每个 session 一个 extracting flag，LLM 请求中不重复触发
 * - 多 handler（setup 重建产生的）天然幂等：extracting=true 时直接 skip
 *
 * 核心原则：完全异步、不阻塞对话。
 */

import * as path from 'path'
import * as fs from 'fs/promises'
import type {
  QClawPackage,
  QClawContext,
  HookHandlerResult,
} from '../../core/types.js'
import type { AutoMemoryConfig, ExtractionContext } from './src/types.js'
import { shouldSkipExtraction } from './src/filter.js'
import { sanitizeText, isFrameworkNoise } from './src/sanitize.js'
import { extractDailyWork } from './src/extractor.js'
import { appendDailyMemory } from './src/writer.js'
import { REPORT_CONST } from '../../core/reporter-constants.js'
import { runConsolidationIfDue } from './src/consolidator.js'

const EXTRACTION_TIMEOUT_MS = 120_000
const MAX_CONSECUTIVE_FAILURES = 2

// ============================================================================
// 持久化游标
// ============================================================================

interface CursorData {
  /** 上次处理到的消息索引 */
  lastIndex: number
  /** 上次处理的最后一条 assistant 消息内容 hash（锚点） */
  anchorHash: string
  /** 上次写入时间 */
  updatedAt: number
}

/** sessionKey → 文件名安全字符 */
function sanitizeSessionKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function getCursorPath(stateDir: string, sessionKey: string): string {
  return path.join(stateDir, '.auto-memory', `cursor-${sanitizeSessionKey(sessionKey)}.json`)
}

async function readCursor(stateDir: string, sessionKey: string): Promise<CursorData> {
  try {
    const raw = await fs.readFile(getCursorPath(stateDir, sessionKey), 'utf-8')
    const data = JSON.parse(raw) as Partial<CursorData>
    return {
      lastIndex: typeof data.lastIndex === 'number' ? data.lastIndex : 0,
      anchorHash: typeof data.anchorHash === 'string' ? data.anchorHash : '',
      updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
    }
  } catch {
    return { lastIndex: 0, anchorHash: '', updatedAt: 0 }
  }
}

async function writeCursor(stateDir: string, sessionKey: string, cursor: CursorData): Promise<void> {
  const filePath = getCursorPath(stateDir, sessionKey)
  const tmpPath = filePath + '.tmp'
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(tmpPath, JSON.stringify(cursor), 'utf-8')
    await fs.rename(tmpPath, filePath)
  } catch {
    // 静默失败，下次从旧游标继续（宁可重复不丢数据）
  }
}

// ============================================================================
// 简单 hash（djb2）
// ============================================================================

function simpleHash(text: string): string {
  const s = text.slice(0, 200)
  let hash = 5381
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0
  }
  return hash.toString(36)
}

// ============================================================================
// 消息内容提取
// ============================================================================

function extractMessageContent(msg: Record<string, unknown>): string | null {
  const content = msg.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        'text' in block &&
        typeof (block as Record<string, unknown>).text === 'string'
      ) {
        parts.push((block as Record<string, unknown>).text as string)
      }
    }
    return parts.length > 0 ? parts.join('\n') : null
  }
  return null
}

// ============================================================================
// 游标锚点定位
// ============================================================================

/**
 * 根据持久化游标定位 messages 数组中的真实起始位置。
 *
 * 1. 先尝试索引快速路径：检查 messages[lastIndex-1] 的 hash 是否匹配 → O(1)
 * 2. 不匹配 → 从尾部向前搜索锚点 hash → 找到则从锚点+1 开始
 * 3. 找不到 → 从 messages.length 开始（只看新消息，宁可漏一次也不重复）
 */
function resolveStartIndex(messages: unknown[], cursor: CursorData): number {
  const { lastIndex, anchorHash } = cursor

  // 首次（无游标）→ 从头开始
  if (lastIndex === 0 && !anchorHash) return 0

  // 快速路径：索引验证
  if (lastIndex > 0 && lastIndex <= messages.length) {
    const prevMsg = messages[lastIndex - 1] as Record<string, unknown> | undefined
    if (prevMsg) {
      const prevText = extractMessageContent(prevMsg)
      if (prevText && simpleHash(prevText) === anchorHash) {
        return lastIndex // 索引有效
      }
    }
  }

  // 索引失效：在 lastIndex 附近搜索锚点（防止 hash 碰撞误匹配到远处的新消息）
  // 搜索范围：lastIndex 前后各 20 条。如果 lastIndex > messages.length（会话被截断），
  // 则从 messages 末尾往前搜索最多 20 条。
  if (anchorHash) {
    const searchCenter = Math.min(lastIndex, messages.length)
    const searchStart = Math.max(0, searchCenter - 20)
    const searchEnd = Math.min(messages.length - 1, searchCenter + 20)
    // 从 lastIndex 附近向两侧搜索，优先检查靠近 lastIndex 的位置
    for (let offset = 0; offset <= 20; offset++) {
      for (const idx of [searchCenter - 1 - offset, searchCenter - 1 + offset]) {
        if (idx < searchStart || idx > searchEnd) continue
        const msg = messages[idx] as Record<string, unknown> | undefined
        if (!msg) continue
        const text = extractMessageContent(msg)
        if (text && simpleHash(text) === anchorHash) {
          return idx + 1
        }
      }
    }
  }

  // 锚点找不到 → 从 lastIndex 开始（可能小幅重复提取，但不丢数据）
  // 之前直接返回 messages.length 导致会话重置/锚点失配后永远无法提取新消息
  if (lastIndex > 0 && lastIndex <= messages.length) {
    return lastIndex
  }
  return 0
}

// ============================================================================
// 增量提取对话轮次
// ============================================================================

interface IncrementalResult {
  turns: import('./src/types.js').Turn[]
  nextIndex: number
  nextAnchorHash: string
}

function extractTurnsIncremental(
  messages: unknown[],
  startIndex: number,
  maxTurns: number,
): IncrementalResult {
  const turns: import('./src/types.js').Turn[] = []
  let nextIndex = startIndex
  let nextAnchorHash = ''

  if (startIndex >= messages.length) return { turns, nextIndex, nextAnchorHash }

  // 阶段 1：收集范围内所有 user 消息的位置
  const userPositions: number[] = []
  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i] as Record<string, unknown> | undefined
    if (msg?.role === 'user') {
      const text = extractMessageContent(msg)
      if (text && /^<summary\s+id=/.test(text.trim())) continue
      userPositions.push(i)
    }
  }

  // 阶段 2：正序配对 user → assistant
  for (let ui = 0; ui < userPositions.length && turns.length < maxTurns; ui++) {
    const userPos = userPositions[ui]
    const userMsg = messages[userPos] as Record<string, unknown>
    const userText = extractMessageContent(userMsg)
    if (!userText) continue

    // ★ 先检查原始文本：sanitizeText 的时间戳正则会移除纯 ASCII 的 [cron:xxx]
    if (isFrameworkNoise(userText)) continue

    const cleanUser = sanitizeText(userText)
    if (!cleanUser || isFrameworkNoise(cleanUser)) continue

    let assistantText: string | null = null
    let assistantPos = -1
    for (let j = userPos + 1; j < messages.length; j++) {
      const candidate = messages[j] as Record<string, unknown> | undefined
      if (candidate?.role === 'assistant') {
        const text = extractMessageContent(candidate)
        if (text) {
          assistantText = text
          assistantPos = j
          break
        }
      }
    }

    if (!assistantText || assistantPos < 0) continue

    const cleanAssistant = sanitizeText(assistantText)
    if (!cleanAssistant || isFrameworkNoise(cleanAssistant)) continue
    turns.push({ user: cleanUser, assistant: cleanAssistant })
    nextIndex = assistantPos + 1
    nextAnchorHash = simpleHash(assistantText)
  }

  return { turns, nextIndex, nextAnchorHash }
}

// ============================================================================
// 内存级 session 状态（丢失无害，只影响触发节奏）
// ============================================================================

interface SessionThrottle {
  lastTriggerTs: number
  consecutiveFailures: number
}

const sessionThrottles = new Map<string, SessionThrottle>()
const extractingFlags = new Map<string, boolean>()

// ============================================================================
// Pending extraction（韧性设计，保留）
// ============================================================================

function getPendingDir(stateDir: string): string {
  return path.join(stateDir, '.auto-memory', 'pending')
}

interface PendingExtraction {
  id: string
  agentId: string
  turns: import('./src/types.js').Turn[]
  createdAt: number
}

async function persistPendingExtraction(
  stateDir: string,
  agentId: string,
  turns: import('./src/types.js').Turn[],
): Promise<string | null> {
  try {
    const dir = getPendingDir(stateDir)
    await fs.mkdir(dir, { recursive: true })
    const id = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const record: PendingExtraction = { id, agentId, turns, createdAt: Date.now() }
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(record), 'utf-8')
    return id
  } catch {
    return null
  }
}

async function removePendingExtraction(stateDir: string, id: string): Promise<void> {
  try {
    await fs.unlink(path.join(getPendingDir(stateDir), `${id}.json`))
  } catch { /* ignore */ }
}

async function getPendingExtractions(stateDir: string): Promise<PendingExtraction[]> {
  const dir = getPendingDir(stateDir)
  try {
    const files = await fs.readdir(dir)
    const results: PendingExtraction[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const raw = await fs.readFile(path.join(dir, f), 'utf-8')
        const parsed = JSON.parse(raw) as Partial<PendingExtraction>
        // 校验必要字段（旧版本格式可能不兼容）
        if (
          typeof parsed.id === 'string' &&
          typeof parsed.agentId === 'string' &&
          Array.isArray(parsed.turns) &&
          typeof parsed.createdAt === 'number'
        ) {
          results.push(parsed as PendingExtraction)
        } else {
          // 旧版本格式不兼容，直接清理
          await fs.unlink(path.join(dir, f)).catch(() => {})
        }
      } catch { /* skip corrupted */ }
    }
    results.sort((a, b) => a.createdAt - b.createdAt)
    return results
  } catch {
    return []
  }
}

const inFlightPendingIds = new Map<string, number>()
let setupGeneration = 0

// ============================================================================
// Helper
// ============================================================================

function getWorkspaceDirName(agentId: string): string {
  return agentId === 'main' ? 'workspace' : `workspace-${agentId}`
}

/**
 * 从磁盘读取用户的 openclaw.json（含自定义模型设置）。
 *
 * 候选路径优先级：
 * 1. OPENCLAW_CONFIG_PATH 环境变量（Electron 主进程注入，指向 ~/.qclaw/openclaw.json）
 * 2. stateDir/openclaw.json（stateDir = ~/.qclaw）
 * 3. stateDir/../config/openclaw.json（资源目录模板，兜底）
 */
async function readDiskConfig(stateDir: string): Promise<Record<string, unknown> | null> {
  const configPathEnv = process.env.OPENCLAW_CONFIG_PATH?.trim()
  const home = process.env.HOME || ''
  const candidates = [
    ...(configPathEnv ? [configPathEnv] : []),
    path.join(stateDir, 'openclaw.json'),
    path.join(home, '.qclaw', 'openclaw.json'),
    path.join(stateDir, '..', 'config', 'openclaw.json'),
  ]
  for (const p of candidates) {
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

// ============================================================================
// doExtraction（保留，逻辑不变）
// ============================================================================

async function doExtraction(
  ctx: QClawContext,
  stateDir: string,
  agentId: string,
  turns: import('./src/types.js').Turn[],
  writeDaily: boolean,
  sourceSessionId?: string,   // ★ hookCtx.sessionId → conversion_id
  sourceRunId?: string,       // ★ hookCtx.runId → conversation_req_id
): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS)

  try {
    if (!writeDaily) return

    const workspaceDirName = getWorkspaceDirName(agentId)
    const workspaceDir = path.join(stateDir, workspaceDirName)
    // ★ 以 api.config（运行时，占位符已替换）为基础，
    // 仅从磁盘覆盖 agents.defaults.model（感知用户切换的自定义大模型）
    const openclawConfig = await buildOpenClawConfig(ctx, stateDir)

    const pendingId = await persistPendingExtraction(stateDir, agentId, turns)
    if (pendingId) {
      inFlightPendingIds.set(pendingId, setupGeneration)
      ctx.logger.info(`[auto-memory:doExtraction] persisted pending extraction ${pendingId} (${turns.length} turns)`)
    }

    try {
      const extractionCtx: ExtractionContext = {
        turns,
        agentId,
        workspaceDir,
        existingMemoryContent: '',
        logger: ctx.logger,
        openclawConfig,
        abortSignal: controller.signal,
        reporter: ctx.reporter,
        sourceSessionId,   // ★ 关联用户对话 session (conversion_id)
        sourceRunId,       // ★ 关联用户对话 run (conversation_req_id)
      }

      const dailyFacts = await extractDailyWork(extractionCtx)
      if (dailyFacts.length > 0) {
        await appendDailyMemory(workspaceDir, agentId, dailyFacts, ctx.logger, ctx.reporter)
      }
    } finally {
      if (pendingId) {
        inFlightPendingIds.delete(pendingId)
        await removePendingExtraction(stateDir, pendingId)
      }
    }
  } finally {
    clearTimeout(timeout)
  }
}

// ============================================================================
// recoverPendingExtractions（保留，逻辑不变）
// ============================================================================

const recoveringPendingIds = new Set<string>()

async function recoverPendingExtractions(
  ctx: QClawContext,
  stateDir: string,
  writeDaily: boolean,
): Promise<void> {
  if (!writeDaily) return

  const pendings = await getPendingExtractions(stateDir)
  if (pendings.length === 0) return

  ctx.logger.info(`[auto-memory:recover] found ${pendings.length} pending extractions, recovering...`)
  ctx.reporter.report(REPORT_CONST.PLUGIN, {
    module_id: 'AutoMemory',
    component_id: 'Pending_Recovery',
    event_code: 'recovery',
    action_type: 'recovery_start',
    statistics: { pending_count: pendings.length },
  })

  for (const p of pendings) {
    if (recoveringPendingIds.has(p.id)) continue
    recoveringPendingIds.add(p.id)

    const inFlightGen = inFlightPendingIds.get(p.id)
    if (inFlightGen !== undefined) {
      recoveringPendingIds.delete(p.id)
      continue
    }

    if (Date.now() - p.createdAt > 3600_000) {
      ctx.logger.info(`[auto-memory:recover] skipping expired pending extraction ${p.id}`)
      await removePendingExtraction(stateDir, p.id)
      recoveringPendingIds.delete(p.id)
      continue
    }

    ctx.logger.info(`[auto-memory:recover] processing pending extraction ${p.id} (${p.turns.length} turns)`)
    doExtraction(ctx, stateDir, p.agentId, p.turns, writeDaily)
      .then(() => {
        ctx.logger.info(`[auto-memory:recover] completed pending extraction ${p.id}`)
      })
      .catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err)
        ctx.logger.warn(`[auto-memory:recover] failed pending extraction ${p.id}: ${errMsg}`)
      })
      .finally(() => {
        removePendingExtraction(stateDir, p.id)
        recoveringPendingIds.delete(p.id)
      })
  }
}

// ============================================================================
// ensureMemoryFiles（保留，逻辑不变）
// ============================================================================

async function ensureMemoryFiles(
  stateDir: string,
  logger: import('../../core/types.js').QClawLogger,
  reporter: import('../../core/reporter-types.js').TelemetryReporter,
): Promise<void> {
  try {
    await fs.mkdir(stateDir, { recursive: true })
    const entries = await fs.readdir(stateDir, { withFileTypes: true })
    let workspaceDirs = entries
      .filter((e) => e.isDirectory() && (e.name === 'workspace' || e.name.startsWith('workspace-')))
      .map((e) => e.name)

    if (workspaceDirs.length === 0) {
      const defaultDir = 'workspace'
      await fs.mkdir(path.join(stateDir, defaultDir), { recursive: true })
      workspaceDirs = [defaultDir]
      logger.info(`created default workspace directory: ${defaultDir}`)
    }

    const today = new Date().toISOString().slice(0, 10)

    for (const dirName of workspaceDirs) {
      const memoryPath = path.join(stateDir, dirName, 'MEMORY.md')
      try {
        await fs.access(memoryPath)
      } catch {
        const content = `# ${today}：记忆系统启用\n`
        await fs.mkdir(path.dirname(memoryPath), { recursive: true })
        await fs.writeFile(memoryPath, content, 'utf-8')
        logger.info(`created MEMORY.md for ${dirName} (activation: ${today})`)
        reporter.report(REPORT_CONST.PLUGIN, {
          module_id: 'AutoMemory',
          component_id: 'EnsureMemoryFiles',
          event_code: 'created',
          action_type: 'memory_md_created',
          statistics: { workspace: dirName },
        })
      }
    }
  } catch {
    // stateDir not readable, skip silently
  }
}

// ============================================================================
// Package 定义
// ============================================================================

let _autoMemoryInitialized = false

const autoMemory: QClawPackage = {
  id: 'auto-memory',
  name: '自动记忆提取',
  description:
    '异步采集对话，提取实质工作记录写入 daily 日志，定时从日志提炼长期记忆。',

  configSchema: {
    type: 'object',
    additionalProperties: false as const,
    properties: {
      enabled: {
        type: 'boolean',
        description: '是否启用自动记忆提取（旧版本字段，新版本不读）',
        default: true,
      },
      enabledV2: {
        type: 'boolean',
        description: '是否启用自动记忆提取（V2，新版本开关）',
        default: true,
      },
      triggerEveryNTurns: {
        type: 'integer',
        description: '每 N 轮触发一次提取（旧版本字段，新版本不读）',
        default: 3,
      },
      minTriggerIntervalSeconds: {
        type: 'integer',
        description: '最短触发间隔（秒）（旧版本字段，新版本不读）',
        default: 180,
      },
      extractionIntervalMinutes: {
        type: 'integer',
        description: '提取最小间隔（分钟，新版本字段）',
        default: 120,
      },
      writeDailyMemory: {
        type: 'boolean',
        description: '是否写入 memory/YYYY-MM-DD.md',
        default: true,
      },
      consolidateIntervalMinutes: {
        type: 'integer',
        description: '长期记忆提炼间隔（分钟，从 daily 日志中提取）',
        default: 720,
      },
      consolidateLookbackDays: {
        type: 'integer',
        description: '提炼时回看的天数',
        default: 3,
      },
      enableConsolidation: {
        type: 'boolean',
        description: '是否启用定时长期记忆提炼',
        default: true,
      },
    },
  },

  setup(ctx: QClawContext): void {
    setupGeneration++

    const cfg = ctx.getConfig<AutoMemoryConfig>()

    const stateDir = ctx.runtime.stateDir
      || process.env.OPENCLAW_STATE_DIR?.trim()
      || process.env.CLAWDBOT_STATE_DIR?.trim()
      || ''
    if (!stateDir) {
      ctx.logger.error('无法确定 stateDir，插件初始化失败')
      return
    }

    const isFirstSetup = !_autoMemoryInitialized
    _autoMemoryInitialized = true

    let memoryFilesEnsured = false

    const isExtractionEnabled = (): boolean => {
      const latestCfg = ctx.getConfig<AutoMemoryConfig>()
      // V2 开关：新版本只看 enabledV2，不受旧灰度写入的 enabled 影响
      return latestCfg.enabledV2 !== false
    }

    const intervalMs = (cfg.extractionIntervalMinutes ?? 120) * 60_000
    const writeDaily = cfg.writeDailyMemory !== false
    const enableConsolidation = cfg.enableConsolidation !== false

    ctx.logger.info(`setup (extractionInterval=${intervalMs / 60_000}min, dailyOnly=true)`)

    // ---- 核心：执行一次提取 ----
    async function runExtraction(
      sessionKey: string,
      agentId: string,
      turns: import('./src/types.js').Turn[],
      nextIndex: number,
      nextAnchorHash: string,
      triggerReason: string,
      sourceSessionId?: string,   // ★ hookCtx.sessionId → conversion_id
      sourceRunId?: string,       // ★ hookCtx.runId → conversation_req_id
    ): Promise<void> {
      const throttle = sessionThrottles.get(sessionKey)

      // 上报
      ctx.reporter.report(REPORT_CONST.PLUGIN, {
        module_id: 'AutoMemory',
        component_id: 'Extraction_Triggered',
        event_code: 'extraction',
        action_type: 'triggered',
        statistics: {
          agent_id: agentId,
          turn_count: turns.length,
          trigger_reason: triggerReason,
        },
      })

      extractingFlags.set(sessionKey, true)
      ctx.logger.info(`[auto-memory:agent_end] starting extraction for ${sessionKey} (${turns.length} turns, reason=${triggerReason})`)

      try {
        await doExtraction(ctx, stateDir, agentId, turns, writeDaily, sourceSessionId, sourceRunId)

        // 成功：写入游标 + 重置节流
        await writeCursor(stateDir, sessionKey, {
          lastIndex: nextIndex,
          anchorHash: nextAnchorHash,
          updatedAt: Date.now(),
        })
        if (throttle) {
          throttle.lastTriggerTs = Date.now()
          throttle.consecutiveFailures = 0
        }
        ctx.logger.info(`[auto-memory:agent_end] extraction completed, cursor → ${nextIndex}`)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        if (throttle) {
          throttle.consecutiveFailures++

          if (throttle.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            // 连续失败：强制推进游标防卡死
            await writeCursor(stateDir, sessionKey, {
              lastIndex: nextIndex,
              anchorHash: nextAnchorHash,
              updatedAt: Date.now(),
            })
            throttle.lastTriggerTs = Date.now()
            throttle.consecutiveFailures = 0
            ctx.logger.warn(`[auto-memory:agent_end] extraction FAILED ${MAX_CONSECUTIVE_FAILURES}x, force advancing cursor → ${nextIndex}: ${errMsg}`)
          } else {
            ctx.logger.warn(`[auto-memory:agent_end] extraction FAILED (${throttle.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}), cursor stays: ${errMsg}`)
          }
        }

        ctx.reporter.report(REPORT_CONST.PLUGIN, {
          module_id: 'AutoMemory',
          component_id: 'Extraction_Failed',
          event_code: 'extraction',
          action_type: throttle && throttle.consecutiveFailures === 0 ? 'extraction_abandoned' : 'extraction_error',
          statistics: {
            agent_id: agentId,
            turn_count: turns.length,
            error_message: errMsg.slice(0, 200),
          },
        })
      } finally {
        extractingFlags.set(sessionKey, false)
      }
    }

    // ---- agent_end handler ----
    ctx.onHook(
      'agent_end',
      async (event, hookCtx): Promise<HookHandlerResult | undefined> => {
        try {
          if (!memoryFilesEnsured) {
            memoryFilesEnsured = true
            ensureMemoryFiles(stateDir, ctx.logger, ctx.reporter).catch(() => {})
          }

          if (!isExtractionEnabled()) {
            ctx.logger.info('[auto-memory:agent_end] skipped (enabledV2=false)')
            return undefined
          }

          // ★ 从 hookCtx 提取关联 ID，用于 LLM sessionId/runId 拼接
          const sourceSessionId = (hookCtx as Record<string, unknown>).sessionId as string | undefined
          const sourceRunId = (hookCtx as Record<string, unknown>).runId as string | undefined
          ctx.logger.info(`[auto-memory:agent_end] source attribution: sourceSessionId=${sourceSessionId ?? '(none)'}, sourceRunId=${sourceRunId ?? '(none)'}`)

          // ---- 长期记忆提炼（被动触发，每次 agent_end 都检查是否到时间）----
          if (enableConsolidation) {
            runConsolidationIfDue(ctx, stateDir, {
              intervalMinutes: cfg.consolidateIntervalMinutes ?? 720,
              lookbackDays: cfg.consolidateLookbackDays ?? 2,
              sourceSessionId,
              sourceRunId,
            }).catch(() => {})
          }

          const sessionKey = hookCtx.sessionKey

          // ★ 并发守卫：正在 LLM 请求中，跳过本次
          if (extractingFlags.get(sessionKey)) {
            ctx.logger.info(`[auto-memory:agent_end] skipped (extraction in progress) session=${sessionKey}`)
            return undefined
          }

          ctx.logger.info(`[auto-memory:agent_end] fired session=${sessionKey} agent=${hookCtx.agentId}`)

          const eventObj = event as Record<string, unknown>
          const messages = eventObj.messages as unknown[] | undefined
          if (!messages || !Array.isArray(messages) || messages.length < 2) {
            ctx.logger.info(`[auto-memory:agent_end] skipped (no messages or < 2)`)
            return undefined
          }

          // 读取持久化游标
          const cursor = await readCursor(stateDir, sessionKey)
          const startIndex = resolveStartIndex(messages, cursor)
          ctx.logger.info(`[auto-memory:agent_end] cursor: startIndex=${startIndex}, messages.length=${messages.length}`)

          // 节流：距上次提取是否 ≥ intervalMs
          let throttle = sessionThrottles.get(sessionKey)
          if (!throttle) {
            // 从持久化游标恢复上次提取时间；首次无记录则从当前开始算并持久化
            let lastTs = cursor.updatedAt
            if (lastTs <= 0) {
              lastTs = Date.now()
              // 持久化首次计时起点，防止进程重启后计时器永远重新开始
              writeCursor(stateDir, sessionKey, {
                lastIndex: cursor.lastIndex,
                anchorHash: cursor.anchorHash,
                updatedAt: lastTs,
              }).catch(() => {})
            }
            throttle = { lastTriggerTs: lastTs, consecutiveFailures: 0 }
            sessionThrottles.set(sessionKey, throttle)
          }

          const elapsed = Date.now() - throttle.lastTriggerTs
          if (elapsed < intervalMs) {
            ctx.logger.info(`[auto-memory:agent_end] skipped (${Math.ceil(elapsed / 60_000)}min < ${intervalMs / 60_000}min interval)`)
            return undefined
          }

          // 收集游标之后所有新轮次（不限数量，由 50K 字符截断兜底）
          const { turns: recentTurns, nextIndex, nextAnchorHash } = extractTurnsIncremental(
            messages,
            startIndex,
            Number.MAX_SAFE_INTEGER,
          )
          if (recentTurns.length === 0) {
            ctx.logger.info(`[auto-memory:agent_end] no new turns since cursor, skipping`)
            return undefined
          }

          // 最小轮次阈值：避免重启等场景下仅 1-2 轮就触发 LLM 调用
          const MIN_TURNS_TO_EXTRACT = 3
          if (recentTurns.length < MIN_TURNS_TO_EXTRACT) {
            ctx.logger.info(`[auto-memory:agent_end] skipped (only ${recentTurns.length} turns, need ≥ ${MIN_TURNS_TO_EXTRACT})`)
            return undefined
          }

          ctx.logger.info(`[auto-memory:agent_end] collected ${recentTurns.length} turns (startIndex=${startIndex} → nextIndex=${nextIndex})`)

          // 预筛
          if (shouldSkipExtraction(recentTurns)) {
            ctx.logger.info('[auto-memory:agent_end] skipped extraction (filter)')
            // 写入游标跳过这批消息
            await writeCursor(stateDir, sessionKey, {
              lastIndex: nextIndex,
              anchorHash: nextAnchorHash,
              updatedAt: Date.now(),
            })
            throttle.lastTriggerTs = Date.now()
            return undefined
          }

          // 异步执行提取（不阻塞 hook 返回）
          runExtraction(sessionKey, hookCtx.agentId, recentTurns, nextIndex, nextAnchorHash,
            'interval_elapsed', sourceSessionId, sourceRunId).catch(() => {})

          return undefined
        } catch (err) {
          ctx.logger.error(`[auto-memory:agent_end] UNCAUGHT ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
          return undefined
        }
      },
      { priority: 900 },
    )

    // ---- 恢复上次未完成的提取（仅首次 setup）----
    if (isFirstSetup) {
      recoverPendingExtractions(ctx, stateDir, writeDaily).catch(() => {})
    }
  },

  teardown(): void {
    _autoMemoryInitialized = false
    sessionThrottles.clear()
    extractingFlags.clear()
  },
}

export default autoMemory

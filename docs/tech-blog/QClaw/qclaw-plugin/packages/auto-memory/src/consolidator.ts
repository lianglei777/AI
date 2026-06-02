/**
 * auto-memory 长期记忆提炼器（Consolidator）
 *
 * Daily-First 架构下的核心组件：
 * - 读取 memory/*.md 日记（最近 N 天）
 * - 通过 LLM (runEmbeddedPiAgent) 从工作日志中提炼长期记忆
 * - 写入 MEMORY.md（全量，含 add / update / remove）
 *
 * 调度策略（v3 — 被动触发）：
 * - 不使用定时器，由 agent_end hook 被动触发
 * - 每次 agent_end 检查 .consolidate-state.json 的 lastRunTs
 * - 距今 >= consolidateIntervalMinutes 则执行提炼，否则跳过
 * - 无对话时不做任何操作，节省资源
 *
 * 与 extractor.ts 使用完全一致的 LLM 调用链路：
 * - 同一 model 解析逻辑（含 alias 支持）
 * - 同一空 workspace + cleanConfig 策略
 * - JSON 解析（extractJson），但不使用 NL 兜底（避免 LLM thinking 文字被误写入）
 *
 * 与 agent_end 的分工：
 * - agent_end: 实时提取实质工作记录 → memory/YYYY-MM-DD.md（原始日志）
 * - Consolidator: 从多天日志中综合提炼 → MEMORY.md（派生知识）
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import type { QClawContext, QClawLogger } from '../../../core/types.js'
import type { MemoryOperation } from './types.js'
import { applyMemoryOperations } from './writer.js'
import { REPORT_CONST } from '../../../core/reporter-constants.js'

// ============================================================================
// OpenClaw 配置读取（从磁盘读 model + providers，感知用户切换自定义大模型）
// ============================================================================

/** 从磁盘读取 openclaw.json（用户配置，可能含自定义模型设置） */
async function readDiskConfig(): Promise<Record<string, unknown> | null> {
  const configPathEnv = process.env.OPENCLAW_CONFIG_PATH?.trim()
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim()
    || process.env.CLAWDBOT_STATE_DIR?.trim()
    || ''
  const home = process.env.HOME || ''
  const candidates = [
    ...(configPathEnv ? [configPathEnv] : []),
    ...(stateDir ? [path.join(stateDir, 'openclaw.json')] : []),
    path.join(home, '.qclaw', 'openclaw.json'),
    ...(stateDir ? [path.join(stateDir, '..', 'config', 'openclaw.json')] : []),
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
 */
async function buildOpenClawConfig(ctx: QClawContext): Promise<unknown> {
  const apiConfig = (
    ((ctx as unknown as Record<string, unknown>).api as Record<string, unknown> | undefined)?.config ?? {}
  ) as Record<string, unknown>

  const diskCfg = await readDiskConfig()
  if (!diskCfg) return apiConfig

  let result = { ...apiConfig }

  // 1. 覆盖 agents.defaults.model
  const diskAgents = diskCfg.agents as Record<string, unknown> | undefined
  const diskDefaults = diskAgents?.defaults as Record<string, unknown> | undefined
  if (diskDefaults?.model) {
    const agents = { ...((apiConfig.agents as Record<string, unknown>) ?? {}) }
    const defaults = { ...((agents.defaults as Record<string, unknown>) ?? {}) }
    defaults.model = diskDefaults.model
    agents.defaults = defaults
    result = { ...result, agents }
  }

  // 2. 合并 models.providers（自定义 provider，保留 qclaw 的已替换占位符版本）
  const diskModels = diskCfg.models as Record<string, unknown> | undefined
  const diskProviders = diskModels?.providers as Record<string, unknown> | undefined
  if (diskProviders) {
    const apiModels = { ...((apiConfig.models as Record<string, unknown>) ?? {}) }
    const apiProviders = { ...((apiModels.providers as Record<string, unknown>) ?? {}) }
    for (const [key, value] of Object.entries(diskProviders)) {
      if (key === 'qclaw') continue
      apiProviders[key] = value
    }
    apiModels.providers = apiProviders
    result = { ...result, models: apiModels }
  }

  return result
}

// ============================================================================
// JSON 残片检测
// ============================================================================

/**
 * 检测一个字符串值是否看起来像 JSON 残片而非纯文本 fact。
 *
 * 线上问题复现：LLM 有时将整个 update 对象或 add 对象序列化为字符串塞入 fact 值，
 * 如 fact: "{\"old_pattern\":\"xxx\", \"new_fact\": \"yyy\"}"
 * 或用中文冒号的伪 JSON: "{\"section\"：\"当前项目与关注\", \"fact\": \"xxx\"}"
 *
 * 这些值通过了 typeof === 'string' 检查，但不应写入 MEMORY.md。
 */
function looksLikeJsonFragment(text: string): boolean {
  const trimmed = text.trim()
  // 以 { 或 [ 开头，且包含 JSON 结构关键字
  if (/^\s*[\[{]/.test(trimmed) && /["'](?:section|fact|old_pattern|new_fact|pattern|reason|tag|content)["']\s*[：:]/.test(trimmed)) {
    return true
  }
  // 包含转义引号（\"）— 说明是 JSON 字符串化后的残片
  if (trimmed.includes('\\"') && /\\"\w+\\"/.test(trimmed)) {
    return true
  }
  return false
}

// ============================================================================
// 并发守卫
// ============================================================================

/** Guard against duplicate consolidation when multiple agent_end overlap */
let isConsolidating = false

export interface ConsolidatorConfig {
  /** 固化间隔（分钟） */
  intervalMinutes: number
  /** 回看天数 */
  lookbackDays: number
  // ★ 新增：关联用户对话（用于 LLM sessionId/runId 拼接）
  sourceSessionId?: string   // hookCtx.sessionId → conversion_id
  sourceRunId?: string       // hookCtx.runId → conversation_req_id
}

/**
 * 检查是否到达固化时间，到达则执行。
 * 由 agent_end hook 在每次对话结束时调用（fire-and-forget）。
 */
export async function runConsolidationIfDue(
  ctx: QClawContext,
  stateDir: string,
  config: ConsolidatorConfig,
): Promise<void> {
  // 并发守卫
  if (isConsolidating) {
    ctx.logger.info('consolidator: skipping — previous consolidation still in progress')
    return
  }

  // 动态检查开关
  const latestCfg = ctx.getConfig<{ enabledV2?: boolean }>()
  if (latestCfg.enabledV2 === false) {
    ctx.logger.info('consolidator: extraction disabled by config, skipping')
    return
  }

  const intervalMs = config.intervalMinutes * 60_000

  // 检查各 workspace 是否有到期的
  const workspaceDirs = await scanWorkspaceDirs(stateDir)

  for (const { agentId, workspaceDir } of workspaceDirs) {
    const state = await loadConsolidateState(workspaceDir)
    const elapsed = Date.now() - (state.lastRunTs || 0)

    if (elapsed < intervalMs) {
      ctx.logger.info(`consolidator: agent "${agentId}" last ran ${Math.round(elapsed / 60_000)}min ago, skipping (interval=${config.intervalMinutes}min)`)
      continue
    }

    // 到时间 → 执行提炼
    ctx.logger.info(`consolidator: agent "${agentId}" due (last ran ${Math.round(elapsed / 60_000)}min ago, interval=${config.intervalMinutes}min), starting consolidation`)
    isConsolidating = true
    try {
      await doConsolidateOne(ctx, agentId, workspaceDir, config)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      ctx.logger.warn(`consolidation for agent "${agentId}" failed: ${errMsg}`)
      ctx.reporter.report(REPORT_CONST.PLUGIN, {
        module_id: 'AutoMemory',
        component_id: 'Consolidator',
        event_code: 'consolidation',
        action_type: 'consolidate_error',
        statistics: {
          agent_id: agentId,
          error_message: errMsg.slice(0, 200),
        },
      })
    } finally {
      isConsolidating = false
    }
  }
}

/**
 * 对单个 agent workspace 执行固化
 */
async function doConsolidateOne(
  ctx: QClawContext,
  agentId: string,
  workspaceDir: string,
  config: ConsolidatorConfig,
): Promise<void> {
  const memoryDir = path.join(workspaceDir, 'memory')

  // 1. 读取近 N 天的日记内容（同时拿到涉及的文件路径）
  const { content: dailyContents, filePaths } = await readRecentDailyFiles(memoryDir, config.lookbackDays, ctx.logger)
  if (!dailyContents || dailyContents.trim().length < 50) {
    ctx.logger.info(`consolidator: agent "${agentId}" has no recent daily records (or too short), skipping`)
    ctx.reporter.report(REPORT_CONST.PLUGIN, {
      module_id: 'AutoMemory',
      component_id: 'Consolidator',
      event_code: 'consolidation',
      action_type: 'consolidate_skipped',
      statistics: {
        agent_id: agentId,
        skip_reason: 'insufficient_daily_content',
      },
    })
    // ★ 即使内容不足，也更新 lastRunTs，避免 scheduleNextRun 认为从未运行过而反复立即触发
    await saveConsolidateState(workspaceDir, { lastRunTs: Date.now(), mtimes: {} })
    return
  }

  // 2. 对比文件修改时间，若无任何变化则跳过 LLM 调用
  const state = await loadConsolidateState(workspaceDir)
  const currentMtimes = await collectMtimes(filePaths)
  if (!hasMtimeChanged(currentMtimes, state.mtimes)) {
    ctx.logger.info(`consolidator: agent "${agentId}" daily files unchanged since last consolidation, skipping`)
    // ★ 即使跳过 LLM，也要更新 lastRunTs，否则 scheduleNextRun 永远算出 overdue
    await saveConsolidateState(workspaceDir, { lastRunTs: Date.now(), mtimes: state.mtimes })
    return
  }

  // 3. 读取当前 MEMORY.md
  const memoryPath = path.join(workspaceDir, 'MEMORY.md')
  const existingMemory = (await safeReadFile(memoryPath)) ?? ''

  // 4. 调用 LLM 提取需要补充的记忆
  const ops = await extractConsolidation(ctx, dailyContents, existingMemory,
    config.sourceSessionId, config.sourceRunId)

  // 5. 写入 MEMORY.md（复用已有的 applyMemoryOperations，走写入锁）
  if (ops && (ops.add.length > 0 || ops.update.length > 0 || ops.remove.length > 0)) {
    await applyMemoryOperations(workspaceDir, agentId, ops, ctx.logger, ctx.reporter)
    ctx.logger.info(`consolidation for agent "${agentId}": added ${ops.add.length} memories`)
  }

  // 6. 无论 LLM 返回是否有操作，都更新状态（避免下次重复调用）
  await saveConsolidateState(workspaceDir, {
    lastRunTs: Date.now(),
    mtimes: currentMtimes,
  })
}

// ============================================================================
// LLM 提取（Prompt C — 固化专用）
// ============================================================================

function buildConsolidationPrompt(existingMemory: string, dailyContents: string): string {
  return `你是一个**极度保守**的长期记忆提炼器。你的任务是从工作日志中**仅提取真正长期有效的核心信息**写入 MEMORY.md。

## ★★ 最高优先级原则：宁可漏掉，绝不乱写 ★★

MEMORY.md 是用户的**永久档案**，每一条都会长期存在并影响 AI 的行为。写入的门槛必须非常高。
**如果你不确定某条信息是否值得长期保留，就不要写入。**

## 输入

### 1. 当前 MEMORY.md
<MEMORY_MD>
${existingMemory || '（空，尚无长期记忆）'}
</MEMORY_MD>

### 2. 近期工作日志（按时间顺序 — 后面的条目覆盖前面的）
<DAILY_RECORDS>
${dailyContents}
</DAILY_RECORDS>

## 任务
对比工作日志和 MEMORY.md，**极度谨慎地**产出最小化的 add/update/remove 操作集。

## 核心原则

1. **保守优先**：大部分日志内容都不应该写入长期记忆。一次典型的固化应该产出 0-2 条操作，而不是 5-10 条。
2. **时间顺序覆盖**：同一话题多次出现时，以最新值为准。
3. **半年检验法**：问自己——"这条信息半年后还有用吗？"如果答案不确定，就不要写入。

## ★★★ 去重规则（最关键） ★★★

对每一条你想 add 的 fact，你**必须**先检查 MEMORY.md 中是否已有语义相同或高度相似的条目。
判断标准：如果一个人读了已有条目后，不需要再看你的新条目就能获得同样的信息 → 那就是重复，**不要 add**。

以下情况都算重复（即使措辞不同）：
- "用户是公司CEO" vs "老板是CEO" → 重复（同一身份事实）
- "AI名叫小黄" vs "给AI取名小黄（CEO助理）" → 重复（同一命名事实）
- "咖啡偏好：冰美式 double ice" vs "喜欢喝冰美式加双倍冰" → 重复（同一偏好）
- "工位在14楼" vs "办公位置14层" → 重复（同一位置信息）

如果已有条目信息不完整、需要补充细节，使用 **update** 而不是 add。
如果信息本质相同只是措辞不同，**直接跳过**，不要 add 也不要 update。

## ★ 只写入这些（白名单）
- **用户的稳定身份**：姓名、职位/角色、团队、公司（仅用户明确说出的）
- **用户的持久偏好**：编程语言偏好、回复风格偏好、技术栈选择（如"喜欢用 TypeScript"、"偏好简洁回复"）
- **长期有效的技术决策**：架构选型、技术栈迁移原因（如"从 Webpack 迁移到 Vite 因为构建速度"）
- **用户明确要求记住的事项**

## ★★ 绝对不要写入这些（黑名单）
- **临时状态**：今天做了什么、正在进行的任务、待办事项、进度更新、草稿箱积压数量
- **实时数据**：股票价格、天气、日期相关的数量统计（如"4月15日发布5篇"）
- **情绪和身体状态**：累了、手酸、心情好、开心等
- **一次性操作**：修了个 bug、跑了个脚本、清理了文件、安装了依赖
- **他人隐私**：第三方的感情关系、个人生活细节、八卦信息
- **项目的细粒度进展**：具体文件名、具体命令、具体步骤（这些属于 daily 日志）
- **每天都会变化的内容**：发布计划详情、收盘价格、具体日期的执行结果
- **AI 自身的行为描述**：AI 做了什么、生成了什么、分析了什么

## 输出格式 — 严格 JSON，不要输出任何其他文字：
{
  "add": [
    {"section": "用户身份与偏好", "fact": "工位在14楼"}
  ],
  "update": [
    {"old_pattern": "工位在13楼", "new_fact": "工位在14楼", "section": "用户身份与偏好"}
  ],
  "remove": [
    {"pattern": "匹配关键词", "reason": "过时/不正确"}
  ]
}

**add/update/remove 中的每个元素的每个值必须是纯文本字符串，不能是 JSON 对象或嵌套结构。**

## 示例

**示例 1 — 信息变更，旧值在 MEMORY.md 中：**
- MEMORY.md 有："- 工位在13楼"
- 日志有："工位从13楼换到了14楼"
→ {"add":[],"update":[{"old_pattern":"工位在13楼","new_fact":"工位在14楼","section":"用户身份与偏好"}],"remove":[]}

**示例 2 — 临时内容，不写入：**
- 日志有："今天修了3个 bug"、"股票收盘 23.99"、"最近有点累"
→ {"add":[],"update":[],"remove":[]}
（这些都是临时状态，不属于长期记忆）

**示例 3 — MEMORY.md 中有过时的临时内容，应清理：**
- MEMORY.md 有："- 最新收盘（4月13日）：¥23.60"、"- 头条草稿箱积压51条，需清理"
→ {"add":[],"update":[],"remove":[{"pattern":"最新收盘","reason":"实时数据不应存在于长期记忆"},{"pattern":"草稿箱积压","reason":"临时状态不应存在于长期记忆"}]}

**示例 4 — 语义重复，不写入（即使措辞不同）：**
- MEMORY.md 有："- 用户是公司CEO，给AI取名\"小黄\"（AI身份为CEO助理）"
- 日志有："老板让AI叫小黄，作为CEO助理"
→ {"add":[],"update":[],"remove":[]}
（MEMORY.md 已包含完全相同的信息，只是措辞不同，不需要重复添加）

**示例 5 — 没有需要写入的内容（最常见的情况）：**
→ {"add":[],"update":[],"remove":[]}

推荐分类：用户身份与偏好、当前项目与关注、经验与决策、技术规范偏好

关键要求：所有 "fact"、"new_fact"、"reason" 的值必须使用工作日志中使用的语言书写，保持用户原始语言。
`
}

/** 最大重试次数（首次 + 2 次重试，共 3 次尝试） */
const MAX_LLM_RETRIES = 2
/** 重试前等待时间（毫秒） */
const RETRY_DELAY_MS = 2 * 60 * 1000

/**
 * 带重试的 LLM 固化提取入口：最多尝试 MAX_LLM_RETRIES + 1 次，
 * 每次失败后等待 RETRY_DELAY_MS 再重试，全部失败才放弃。
 */
async function extractConsolidation(
  ctx: QClawContext,
  dailyContents: string,
  existingMemory: string,
  sourceSessionId?: string,   // ★ hookCtx.sessionId → conversion_id
  sourceRunId?: string,       // ★ hookCtx.runId → conversation_req_id
): Promise<MemoryOperation | null> {
  for (let attempt = 0; attempt <= MAX_LLM_RETRIES; attempt++) {
    if (attempt > 0) {
      ctx.logger.info(`consolidator: LLM retry ${attempt}/${MAX_LLM_RETRIES} (waiting ${RETRY_DELAY_MS / 1000}s)`)
      await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
      ctx.logger.info(`consolidator: LLM retry ${attempt}/${MAX_LLM_RETRIES} starting now`)
    }
    try {
      return await extractConsolidationOnce(ctx, dailyContents, existingMemory,
        sourceSessionId, sourceRunId)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (attempt < MAX_LLM_RETRIES) {
        ctx.logger.warn(`consolidator: LLM attempt ${attempt + 1} failed, will retry in ${RETRY_DELAY_MS / 1000}s: ${errMsg}`)
      } else {
        ctx.logger.warn(`consolidator: LLM failed after ${MAX_LLM_RETRIES + 1} attempts, giving up: ${errMsg}`)
        ctx.reporter.report(REPORT_CONST.PLUGIN, {
          module_id: 'AutoMemory',
          component_id: 'Consolidator',
          event_code: 'consolidation',
          action_type: 'consolidate_extract',
          statistics: {
            agent_id: 'consolidator',
            status: 'fail',
            duration_ms: 0,
            error_message: errMsg.slice(0, 200),
          },
        })
      }
    }
  }
  return null
}

/**
 * 通过 runEmbeddedPiAgent 调用 LLM 进行固化提取（单次，不含重试）。
 * 与 extractor 使用完全一致的调用链路：
 * - 同一 model 解析逻辑（含 alias 支持）
 * - 同一空 workspace + cleanConfig 策略
 * - JSON 解析（extractJson），但不使用 NL 兜底（避免 thinking 污染）
 */
async function extractConsolidationOnce(
  ctx: QClawContext,
  dailyContents: string,
  existingMemory: string,
  sourceSessionId?: string,   // ★ hookCtx.sessionId → conversion_id
  sourceRunId?: string,       // ★ hookCtx.runId → conversation_req_id
): Promise<MemoryOperation | null> {
  const startTs = Date.now()

  try {
    // 构建 ExtractionContext 适配层（consolidator 用 QClawContext 构建）
    // ★ 以 api.config（运行时，占位符已替换）为基础，
    // 从磁盘覆盖 agents.defaults.model + providers（感知用户切换的自定义大模型）
    const openclawConfig = await buildOpenClawConfig(ctx)
    const extractionCtx: import('./types.js').ExtractionContext = {
      turns: [],              // consolidator 不走对话输入，prompt 自包含所有数据
      agentId: 'consolidator',
      workspaceDir: '',       // 由内部使用空 workspace
      existingMemoryContent: '',
      logger: ctx.logger,
      openclawConfig,
      reporter: ctx.reporter,
      sourceSessionId,   // ★ 关联用户对话 session (conversion_id)
      sourceRunId,       // ★ 关联用户对话 run (conversation_req_id)
    }

    const systemPrompt = buildConsolidationPrompt(existingMemory, dailyContents)
    const userContent = '(内联在 system prompt 中)'

    ctx.logger.info(`consolidator: calling LLM via runEmbeddedPiAgent (prompt_length=${systemPrompt.length})`)

    // ★ 统一调用 — 与 extractor 完全一致的链路
    const { callLlmViaEmbeddedAgent, extractJson } = await import('./extractor.js')

    const raw = await callLlmViaEmbeddedAgent(extractionCtx, systemPrompt, userContent, 2048, 'consolidation')
    const llmDuration = Date.now() - startTs

    if (!raw || raw.trim().length === 0) {
      ctx.logger.info('consolidator: LLM returned empty response, will retry')
      throw new Error('LLM returned empty response (possible timeout)')
    }

    ctx.logger.info(`consolidator: LLM response (${llmDuration}ms, ${raw.length}chars)`)

    // 复用 extractor 的容错解析：JSON 提取 → NL 兜底
    const jsonStr = extractJson(raw)
    let parsed: MemoryOperation | null = null

    if (jsonStr) {
      try {
        const rawParsed = JSON.parse(jsonStr) as {
          add?: unknown[]
          update?: unknown[]
          remove?: unknown[]
        }
        // 严格校验每个元素的字段类型，防止 LLM 把嵌套对象塞进 fact/new_fact 导致写入 [object Object]
        parsed = {
          add: Array.isArray(rawParsed.add)
            ? rawParsed.add.filter(
                (item): item is { section: string; fact: string } =>
                  typeof item === 'object' &&
                  item !== null &&
                  typeof (item as Record<string, unknown>).section === 'string' &&
                  typeof (item as Record<string, unknown>).fact === 'string' &&
                  !looksLikeJsonFragment((item as Record<string, unknown>).fact as string),
              )
            : [],
          update: Array.isArray(rawParsed.update)
            ? rawParsed.update.filter(
                (item): item is { old_pattern: string; new_fact: string; section: string } =>
                  typeof item === 'object' &&
                  item !== null &&
                  typeof (item as Record<string, unknown>).old_pattern === 'string' &&
                  typeof (item as Record<string, unknown>).new_fact === 'string' &&
                  typeof (item as Record<string, unknown>).section === 'string' &&
                  !looksLikeJsonFragment((item as Record<string, unknown>).new_fact as string),
              )
            : [],
          remove: Array.isArray(rawParsed.remove)
            ? rawParsed.remove.filter(
                (item): item is { pattern: string; reason: string } =>
                  typeof item === 'object' &&
                  item !== null &&
                  typeof (item as Record<string, unknown>).pattern === 'string' &&
                  typeof (item as Record<string, unknown>).reason === 'string',
              )
            : [],
        }
      } catch {
        // JSON 结构异常，走 NL 兜底
      }
    }

    if (!parsed) {
      // ★ consolidator 不使用 NL 兜底解析（parseNaturalLanguageToMemory）。
      // 原因：LLM 常在 JSON 之后附加推理说明（如"**写入**：xxx 是稳定身份信息"），
      // NL 解析器会把这些 thinking 文字中的 key:value 格式匹配为 fact 写入 MEMORY.md。
      // consolidation 要求严格 JSON 输出，parse 失败则直接放弃本次固化。
      ctx.logger.info('consolidator: no valid JSON from LLM, skipping')
      return null
    }

    const totalOps = parsed.add.length + parsed.update.length + parsed.remove.length
    if (totalOps === 0) {
      ctx.logger.info('consolidator: no memories to update')
      ctx.reporter.report(REPORT_CONST.PLUGIN, {
        module_id: 'AutoMemory',
        component_id: 'Consolidator',
        event_code: 'consolidation',
        action_type: 'consolidate_extract',
        statistics: {
          agent_id: 'consolidator',
          status: 'empty_result',
          duration_ms: Date.now() - startTs,
        },
      })
      return null
    }

    const totalDuration = Date.now() - startTs
    ctx.logger.info(
      `consolidator: extracted ${totalOps} ops in ${totalDuration}ms (add=${parsed.add.length}, update=${parsed.update.length}, remove=${parsed.remove.length})`,
    )
    ctx.reporter.report(REPORT_CONST.PLUGIN, {
      module_id: 'AutoMemory',
      component_id: 'Consolidator',
      event_code: 'consolidation',
      action_type: 'consolidate_extract',
      statistics: {
        agent_id: 'consolidator',
        status: 'success',
        duration_ms: totalDuration,
        add_count: parsed.add.length,
        update_count: parsed.update.length,
        remove_count: parsed.remove.length,
        output_length: raw.length,
      },
    })
    return parsed
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const duration = Date.now() - startTs
    ctx.logger.warn(`consolidation extraction attempt failed (${duration}ms): ${errMsg}`)
    throw err
  }
}

// ============================================================================
// Persistent consolidation state
// ============================================================================

interface ConsolidateState {
  /** Timestamp (ms) of the last successful consolidation run */
  lastRunTs: number
  /** Per-file mtime map for change detection */
  mtimes: MtimeMap
}

/** 保存每个日记文件最后一次 consolidation 时的 mtime（毫秒） */
type MtimeMap = Record<string, number>

const CONSOLIDATE_STATE_FILE = '.consolidate-state.json'

async function loadConsolidateState(workspaceDir: string): Promise<ConsolidateState> {
  const stateFile = path.join(workspaceDir, CONSOLIDATE_STATE_FILE)
  try {
    const raw = await fs.readFile(stateFile, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      // Support both new format { lastRunTs, mtimes } and legacy format (plain MtimeMap)
      if (typeof obj.lastRunTs === 'number') {
        return {
          lastRunTs: obj.lastRunTs as number,
          mtimes: (typeof obj.mtimes === 'object' && obj.mtimes !== null ? obj.mtimes : {}) as MtimeMap,
        }
      }
      // Legacy: entire object is a MtimeMap
      return { lastRunTs: 0, mtimes: obj as MtimeMap }
    }
  } catch {
    // File doesn't exist or parse failed — first run
  }
  return { lastRunTs: 0, mtimes: {} }
}

async function saveConsolidateState(workspaceDir: string, state: ConsolidateState): Promise<void> {
  const stateFile = path.join(workspaceDir, CONSOLIDATE_STATE_FILE)
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8')
}

/**
 * 收集文件列表中每个文件的 mtimeMs，返回 { filePath: mtimeMs } map
 */
async function collectMtimes(filePaths: string[]): Promise<MtimeMap> {
  const result: MtimeMap = {}
  for (const fp of filePaths) {
    try {
      const stat = await fs.stat(fp)
      result[fp] = stat.mtimeMs
    } catch {
      // 文件不可访问，忽略
    }
  }
  return result
}

/**
 * 判断当前 mtime map 与上次保存的是否有任意差异
 */
function hasMtimeChanged(current: MtimeMap, saved: MtimeMap): boolean {
  const currentKeys = Object.keys(current)
  // 文件数量变化（新增或删除文件）
  if (currentKeys.length !== Object.keys(saved).length) return true
  // 任意文件 mtime 变化
  for (const fp of currentKeys) {
    if (saved[fp] === undefined || saved[fp] !== current[fp]) return true
  }
  return false
}

// ============================================================================
// 文件系统工具
// ============================================================================

/**
 * 扫描 stateDir 下所有 workspace* 目录
 */
async function scanWorkspaceDirs(
  stateDir: string,
): Promise<Array<{ agentId: string; workspaceDir: string }>> {
  const results: Array<{ agentId: string; workspaceDir: string }> = []

  try {
    const entries = await fs.readdir(stateDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      if (entry.name === 'workspace') {
        results.push({
          agentId: 'main',
          workspaceDir: path.join(stateDir, entry.name),
        })
      } else if (entry.name.startsWith('workspace-')) {
        const agentId = entry.name.slice('workspace-'.length)
        results.push({
          agentId,
          workspaceDir: path.join(stateDir, entry.name),
        })
      }
    }
  } catch {
    // stateDir 不存在或不可读，返回空
  }

  return results
}

/**
 * 读取 memory/ 目录下近 N 天的 .md 文件内容（按日期排序）
 * 同时返回涉及的绝对路径列表，用于后续 mtime 对比
 */
async function readRecentDailyFiles(
  memoryDir: string,
  lookbackDays: number,
  logger: QClawLogger,
): Promise<{ content: string; filePaths: string[] }> {
  try {
    const entries = await fs.readdir(memoryDir)

    // 筛选 .md 文件，按文件名排序（YYYY-MM-DD.md 格式天然可排序）
    const mdFiles = entries
      .filter((f) => f.endsWith('.md'))
      .sort()

    // 计算 N 天前的日期字符串
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - lookbackDays)
    const cutoffStr = cutoffDate.toISOString().slice(0, 10)

    // 只读取 cutoffStr 之后的文件
    const recentFiles = mdFiles.filter((f) => {
      const dateStr = f.replace('.md', '')
      return dateStr >= cutoffStr
    })

    if (recentFiles.length === 0) return { content: '', filePaths: [] }

    const contents: string[] = []
    const filePaths: string[] = []
    for (const file of recentFiles) {
      const filePath = path.join(memoryDir, file)
      filePaths.push(filePath)
      const content = await safeReadFile(filePath)
      if (content && content.trim().length > 0) {
        contents.push(`=== ${file} ===\n${content.trim()}`)
      }
    }

    logger.info(`consolidator: read ${recentFiles.length} daily files (cutoff: ${cutoffStr})`)
    return { content: contents.join('\n\n'), filePaths }
  } catch {
    return { content: '', filePaths: [] }
  }
}

/**
 * 安全读取文件
 */
async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * skill-usage-analyzer — Skill 使用情况分析 Package
 *
 * 功能：
 * 1. 启动后自动扫描 ~/.qclaw/agents/{agentId}/sessions/ 下的 JSONL 文件
 * 2. 从 assistant 消息的 toolCall(read) 中提取 skills/<name>/SKILL.md 调用记录
 * 3. 将分析结果写入 {stateDir}/agent-skill-usage.json（原子写入）
 * 4. 注册 HTTP 路由供主进程读取结果
 *
 * 分析逻辑移植自 analyze-sessions.py / extract-skills.py，
 * 转为 TypeScript 在 Gateway 子进程中运行。
 *
 * 核心原则：一次性治理 — 若输出文件已存在则跳过扫描，不重复分析。
 */

import * as path from 'path'
import * as fs from 'fs/promises'
import * as readline from 'readline'
import { createReadStream, existsSync } from 'fs'
import type {
  QClawPackage,
  QClawContext,
} from '../../core/types.js'

// ============================================================================
// 常量 & 类型
// ============================================================================

const LOG_TAG = '[skill-usage-analyzer]'

/** 输出文件名 */
const OUTPUT_FILE_NAME = 'agent-skill-usage.json'

// ============================================================================
// 灰度查询常量
// ============================================================================

/** 灰度查询 JPRX 命令字（与主进程 GATING_JPRX_CMD 保持一致） */
const GATING_JPRX_CMD = '4171'

/** 灰度查询 HTTP 超时（毫秒） */
const GATING_TIMEOUT_MS = 5_000

/** skill-usage-analyzer 灰度功能 ID（需后端配置） */
const SKILL_USAGE_ANALYZER_FUNC_ID = 'skill_usage_analyzer'

/**
 * JPRX 网关地址（根据 BUILD_ENV 选择环境）
 *   - test:       https://jprx.sparta.html5.qq.com/
 *   - production: https://jprx.m.qq.com/
 */
function getJprxGatewayUrl(): string {
  return process.env.BUILD_ENV === 'production'
    ? 'https://jprx.m.qq.com/'
    : 'https://jprx.sparta.html5.qq.com/'
}

/** Skill 调用记录的正则：匹配 skills/<skillName>/SKILL.md（兼容 Windows 反斜杠路径） */
const SKILL_PATTERN = /skills[/\\]([a-zA-Z0-9_.-]+)[/\\]SKILL\.md/i

/** 默认的 agents 根目录 */
function getDefaultAgentsDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  return path.join(home, '.qclaw', 'agents')
}

/** 单个 session 的分析结果 */
interface SessionAnalysis {
  sessionId: string
  skills: string[]
}

/** 单个 agent 的统计结果 */
interface AgentSkillUsage {
  agentId: string
  totalSessions: number
  sessionsWithSkills: number
  /** skill 名称 → 总调用次数 */
  skillCounts: Record<string, number>
}

/** 完整的分析报告 */
export interface SkillUsageReport {
  /** 分析完成时间（ISO 字符串） */
  analyzedAt: string
  /** 分析耗时（ms） */
  durationMs: number
  /** 各 agent 的统计 */
  agents: AgentSkillUsage[]
  /** 分析时遇到的 JSON 解析错误行数 */
  parseErrors: number
}

/** Package 配置 */
interface SkillUsageAnalyzerConfig {
  enabled?: boolean
}

// ============================================================================
// JSONL 解析（逐行流式，低内存占用）
// ============================================================================

/**
 * 解析单个 JSONL 文件，返回该 session 的 skill 调用信息。
 *
 * 使用 readline 逐行流式读取，避免大文件一次性加载到内存。
 */
async function analyzeSessionFile(filePath: string): Promise<{
  analysis: SessionAnalysis
  parseErrors: number
}> {
  const sessionId = path.basename(filePath, '.jsonl')
  const skills: string[] = []
  let parseErrors = 0

  const fileStream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let record: Record<string, unknown>
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      parseErrors++
      continue
    }

    // 只关注 assistant 消息中的 toolCall
    if (record.type !== 'message') continue

    const message = record.message as Record<string, unknown> | undefined
    if (!message || message.role !== 'assistant') continue

    const content = message.content
    if (!Array.isArray(content)) continue

    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      const block = item as Record<string, unknown>

      // 只关注 read 类型的 toolCall
      if (block.type !== 'toolCall') continue
      if (block.name !== 'read') continue

      const args = block.arguments as Record<string, unknown> | undefined
      if (!args) continue

      // 从 path / file_path / filePath 参数中匹配 skill 路径
      for (const key of ['path', 'file_path', 'filePath']) {
        const pathValue = args[key]
        if (typeof pathValue !== 'string' || !pathValue) continue
        const match = SKILL_PATTERN.exec(pathValue)
        if (match) {
          skills.push(match[1])
        }
      }
    }
  }

  return {
    analysis: { sessionId, skills },
    parseErrors,
  }
}

// ============================================================================
// 目录扫描 & 汇总
// ============================================================================

/**
 * 扫描单个 agent 的 sessions 目录，返回该 agent 的 skill 使用统计。
 */
async function analyzeAgent(
  agentId: string,
  sessionsDir: string,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<{ usage: AgentSkillUsage; parseErrors: number }> {
  let entries: string[]
  try {
    const dirEntries = await fs.readdir(sessionsDir)
    entries = dirEntries
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
  } catch {
    logger.warn(`${LOG_TAG} 无法读取目录: ${sessionsDir}`)
    return {
      usage: {
        agentId,
        totalSessions: 0,
        sessionsWithSkills: 0,
        skillCounts: {},
      },
      parseErrors: 0,
    }
  }

  const skillCounts: Record<string, number> = {}
  let sessionsWithSkills = 0
  let totalParseErrors = 0

  for (const fileName of entries) {
    const filePath = path.join(sessionsDir, fileName)
    try {
      const { analysis, parseErrors } = await analyzeSessionFile(filePath)
      totalParseErrors += parseErrors

      if (analysis.skills.length > 0) {
        sessionsWithSkills++
        for (const skill of analysis.skills) {
          skillCounts[skill] = (skillCounts[skill] || 0) + 1
        }
      }
    } catch (err) {
      logger.warn(`${LOG_TAG} 解析文件失败: ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    usage: {
      agentId,
      totalSessions: entries.length,
      sessionsWithSkills,
      skillCounts,
    },
    parseErrors: totalParseErrors,
  }
}

/**
 * 扫描所有 agents 目录，返回完整的分析报告。
 */
async function analyzeAllAgents(
  agentsDir: string,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<SkillUsageReport> {
  const startTime = Date.now()

  // 列出所有 agent 目录
  let agentDirs: string[]
  try {
    const entries = await fs.readdir(agentsDir, { withFileTypes: true })
    agentDirs = entries
      .filter((e) => e.isDirectory() && e.name !== '__creating__')
      .map((e) => e.name)
      .sort()
  } catch {
    logger.warn(`${LOG_TAG} 无法读取 agents 目录: ${agentsDir}`)
    return {
      analyzedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      agents: [],
      parseErrors: 0,
    }
  }

  logger.info(`${LOG_TAG} 发现 ${agentDirs.length} 个 agent 目录: ${agentDirs.join(', ')}`)

  const agents: AgentSkillUsage[] = []
  let totalParseErrors = 0

  for (const agentId of agentDirs) {
    const sessionsDir = path.join(agentsDir, agentId, 'sessions')
    const { usage, parseErrors } = await analyzeAgent(agentId, sessionsDir, logger)
    totalParseErrors += parseErrors

    if (usage.totalSessions > 0) {
      agents.push(usage)
    }
  }

  const durationMs = Date.now() - startTime
  const totalSessions = agents.reduce((sum, a) => sum + a.totalSessions, 0)
  logger.info(`${LOG_TAG} 分析完成: ${agents.length} 个 agent, ${totalSessions} 个 session, 耗时 ${durationMs}ms`)

  return {
    analyzedAt: new Date().toISOString(),
    durationMs,
    agents,
    parseErrors: totalParseErrors,
  }
}

// ============================================================================
// 文件写入（原子写入：tmp + rename）
// ============================================================================

async function writeReportFile(outputPath: string, report: SkillUsageReport): Promise<void> {
  const tmpPath = outputPath + '.tmp'
  const content = JSON.stringify(report, null, 2)
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(tmpPath, content, 'utf-8')
  await fs.rename(tmpPath, outputPath)
}

// ============================================================================
// 灰度查询（参考 fetchSingleGating）
// ============================================================================

/**
 * 灰度查询响应的 hit 值含义：
 *   0 = 未命中规则
 *   1 = 命中但未灰度
 *   2 = 命中且灰度（即需要启用功能）
 */
const GATING_HIT_VALUE = 2

/**
 * 查询灰度配置，判断是否启用 skill-usage-analyzer 扫描。
 *
 * 协议与主进程 fetchSingleGating 保持一致：
 *   - 接口：命令字 4171（GATING_JPRX_CMD）
 *   - 请求：{ func_id, guid, user_id }
 *   - 响应：{ resp?: { data?: { func_id, hit } }, data?: { func_id, hit } }
 *
 * @param fetchFn 原始 fetch（应绕过 FetchChain，避免被中间件拦截）
 * @param logger  日志器
 * @returns true = 灰度命中（应执行扫描），false = 未命中或查询失败
 */
async function fetchGatingConfig(
  fetchFn: typeof fetch,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<boolean> {
  try {
    // ---- 1. 收集身份参数（从环境变量获取，由 Electron 主进程启动子进程时注入） ----
    const guid = process.env.QCLAW_USER_GUID ?? ''
    const uid = process.env.QCLAW_USER_ID ?? ''

    if ((!guid || guid === 'none') && (!uid || uid === 'none')) {
      logger.info(`${LOG_TAG} Gating fetch skipped: no guid/user_id available`)
      return false
    }

    // ---- 2. 发起 HTTP 请求 ----
    const gatewayUrl = getJprxGatewayUrl()
    const url = `${gatewayUrl}data/${GATING_JPRX_CMD}/forward`
    logger.info(`${LOG_TAG} Gating fetch URL: ${url}`)

    const body = JSON.stringify({
      func_id: SKILL_USAGE_ANALYZER_FUNC_ID,
      guid: guid !== 'none' ? guid : '',
      user_id: uid !== 'none' ? uid : '',
    })

    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(GATING_TIMEOUT_MS),
    })

    if (!response.ok) {
      logger.warn(`${LOG_TAG} Gating fetch HTTP ${String(response.status)}, defaulting to disabled`)
      return false
    }

    // ---- 3. 解析响应（兼容 resp.data 和 data 两种嵌套格式） ----
    const data = await response.json() as Record<string, unknown>
    logger.info(`${LOG_TAG} Gating raw response: ${JSON.stringify(data)}`)

    const nested = data?.resp as Record<string, unknown> | undefined
    const payload = (nested?.data ?? data?.data ?? data) as Record<string, unknown>

    const respFuncId = payload?.func_id
    if (respFuncId !== undefined && respFuncId !== SKILL_USAGE_ANALYZER_FUNC_ID) {
      logger.warn(
        `${LOG_TAG} Gating response func_id mismatch: expected "${SKILL_USAGE_ANALYZER_FUNC_ID}", got "${String(respFuncId)}"`,
      )
      return false
    }

    const hit = payload?.hit
    const isHit = hit === GATING_HIT_VALUE
    logger.info(
      `${LOG_TAG} Gating result: func_id=${String(respFuncId)}, hit=${String(hit)}, isHit=${String(isHit)}`,
    )

    return isHit
  } catch (err) {
    logger.warn(
      `${LOG_TAG} Gating fetch failed, defaulting to disabled: ${err instanceof Error ? err.message : 'unknown'}`,
    )
    return false
  }
}

// ============================================================================
// Package 定义
// ============================================================================

const skillUsageAnalyzer: QClawPackage = {
  id: 'skill-usage-analyzer',
  name: 'Skill 使用情况分析',
  description:
    '一次性扫描 ~/.qclaw/agents/ 下的 session 日志，分析各 agent 的 skill 调用历史并输出到本地文件。若输出文件已存在则跳过。',

  configSchema: {
    type: 'object',
    additionalProperties: false as const,
    properties: {
      enabled: {
        type: 'boolean',
        description: '是否启用 skill 使用情况分析',
        default: true,
      },
    },
  },

  setup(ctx: QClawContext): void {
    const cfg = ctx.getConfig<SkillUsageAnalyzerConfig>()
    if (cfg.enabled === false) {
      ctx.logger.info('disabled by config')
      return
    }

    const stateDir = ctx.runtime.stateDir
      || process.env.OPENCLAW_STATE_DIR?.trim()
      || process.env.CLAWDBOT_STATE_DIR?.trim()
      || ''
    if (!stateDir) {
      ctx.logger.error('无法确定 stateDir，插件初始化失败')
      return
    }

    const agentsDir = getDefaultAgentsDir()
    const outputPath = path.join(stateDir, OUTPUT_FILE_NAME)

    // 获取原始 fetch（绕过 FetchChain，避免灰度请求被中间件拦截）
    const originalFetch = ctx.getOriginalFetch()

    // 内存中缓存最新报告，供 HTTP 路由直接返回
    let latestReport: SkillUsageReport | null = null

    // 灰度命中状态缓存
    let gatingHit: boolean | null = null

    /**
     * 查询灰度配置（fire-and-forget，不阻塞 setup）
     */
    async function checkGating(): Promise<boolean> {
      if (gatingHit !== null) return gatingHit
      gatingHit = await fetchGatingConfig(originalFetch, ctx.logger)
      ctx.logger.info(`灰度查询结果: ${String(gatingHit)}`)
      return gatingHit
    }

    /**
     * 执行一次完整分析并写入文件（一次性治理，文件已存在则跳过）
     */
    async function runAnalysis(): Promise<void> {
      // ---- 灰度前置检查：未命中则跳过扫描 ----
      const shouldRun = await checkGating()
      if (!shouldRun) {
        ctx.logger.info('灰度未命中，跳过 skill 使用分析')
        // 删除已有的输出文件，避免后续回写逻辑基于过期数据执行
        if (existsSync(outputPath)) {
          try {
            await fs.unlink(outputPath)
            ctx.logger.info(`已删除旧的分析结果文件: ${outputPath}`)
          } catch (err) {
            ctx.logger.warn(`删除分析结果文件失败: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        return
      }

      // 输出文件已存在 → 直接读取缓存，不再重复扫描
      if (existsSync(outputPath)) {
        ctx.logger.info(`输出文件已存在，跳过扫描: ${outputPath}`)
        try {
          const raw = await fs.readFile(outputPath, 'utf-8')
          latestReport = JSON.parse(raw) as SkillUsageReport
        } catch (err) {
          ctx.logger.warn(`读取已有报告失败，将重新分析: ${err instanceof Error ? err.message : String(err)}`)
          // 读取失败则 fall through 重新分析
          latestReport = null
        }
        if (latestReport) return
      }

      try {
        ctx.logger.info(`开始分析 agents 目录: ${agentsDir}`)
        const report = await analyzeAllAgents(agentsDir, ctx.logger)
        latestReport = report

        // 原子写入到文件
        await writeReportFile(outputPath, report)
        ctx.logger.info(`分析结果已写入: ${outputPath}`)
      } catch (err) {
        ctx.logger.error(`分析失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // ---- 启动后立即异步执行（不阻塞 setup） ----
    void runAnalysis()

    // ---- 注册 HTTP 路由：GET /qclaw-plugin/skill-usage-analyzer/report ----
    ctx.registerHttpRoute({
      method: 'GET',
      path: 'report',
      async handler() {
        if (!latestReport) {
          return {
            status: 204,
            body: { message: 'Analysis not yet completed' },
          }
        }
        return {
          status: 200,
          body: latestReport,
        }
      },
    })

    // ---- 注册 HTTP 路由：GET /qclaw-plugin/skill-usage-analyzer/gating ----
    ctx.registerHttpRoute({
      method: 'GET',
      path: 'gating',
      async handler() {
        return {
          status: 200,
          body: { hit: gatingHit },
        }
      },
    })

    ctx.logger.info(`setup 完成，输出路径: ${outputPath}`)
  },
}

export default skillUsageAnalyzer

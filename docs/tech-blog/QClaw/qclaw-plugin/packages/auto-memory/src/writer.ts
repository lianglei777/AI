/**
 * auto-memory 文件写入器
 *
 * - MEMORY.md: 智能更新（add / update / remove）
 * - memory/YYYY-MM-DD.md: append-only
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import type { MemoryOperation, DailyFact } from './types.js'
import type { QClawLogger } from '../../../core/types.js'
import type { TelemetryReporter } from '../../../core/reporter-types.js'
import { REPORT_CONST } from '../../../core/reporter-constants.js'

// ============================================================================
// 写入锁：防止同一 agent 的 MEMORY.md 并发写入冲突
// ============================================================================

const writeLocks = new Map<string, Promise<void>>()

async function withWriteLock(agentId: string, fn: () => Promise<void>): Promise<void> {
  const prev = writeLocks.get(agentId) ?? Promise.resolve()
  const current = prev
    .catch(() => { /* ignore previous errors */ })
    .then(fn)
  writeLocks.set(agentId, current)
  await current
}

// ============================================================================
// 安全文件读取
// ============================================================================

async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

// ============================================================================
// 去重
// ============================================================================

function extractKeywords(text: string): Set<string> {
  return new Set(
    text
      .replace(/[^\w\u4e00-\u9fff]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2),
  )
}

function isDuplicate(existingText: string, newFact: string): boolean {
  // 空值守卫：空字符串不构成重复（String.includes('') 恒为 true）
  if (!existingText || !newFact) return false

  // 精确子串匹配
  if (existingText.includes(newFact)) return true
  if (newFact.includes(existingText)) return true

  const existingKeywords = extractKeywords(existingText)
  const newKeywords = extractKeywords(newFact)

  if (newKeywords.size === 0) return false
  if (existingKeywords.size === 0) return false

  // 双向关键词重叠率：任一方 > 0.7 即判为重复（覆盖子集/超集场景）
  // 场景: 长版含"结尾页/联系方式"，短版不含 → 单向重叠可能 < 0.8，
  // 但短版关键词几乎全在长版中 → 反向重叠率接近 1.0
  const forwardOverlap = [...newKeywords].filter((k) => existingKeywords.has(k)).length
  const reverseOverlap = [...existingKeywords].filter((k) => newKeywords.has(k)).length

  return (
    forwardOverlap / newKeywords.size > 0.7 ||
    reverseOverlap / existingKeywords.size > 0.7
  )
}

// ============================================================================
// Section name normalization
// ============================================================================

/** Canonical (Chinese) section names used in MEMORY.md */
const CANONICAL_SECTIONS = [
  '用户身份与偏好',
  '当前项目与关注',
  '经验与决策',
  '技术规范偏好',
] as const

/**
 * Map of known section name variants (English, abbreviations, typos) to
 * canonical Chinese names. Matching is case-insensitive on the key side.
 */
const SECTION_ALIASES: Record<string, string> = {
  // Chinese variants → canonical
  '身份与偏好': '用户身份与偏好',
  '个人偏好': '用户身份与偏好',
  '偏好': '用户身份与偏好',
  '项目与关注': '当前项目与关注',
  '当前项目': '当前项目与关注',
  '技术规范': '技术规范偏好',
  '技术偏好': '技术规范偏好',
  // English variants → canonical Chinese
  'identity & preferences': '用户身份与偏好',
  'identity and preferences': '用户身份与偏好',
  'identity & preference': '用户身份与偏好',
  'user identity': '用户身份与偏好',
  'preferences': '用户身份与偏好',
  'personal preferences': '用户身份与偏好',
  'current projects & interests': '当前项目与关注',
  'current projects and interests': '当前项目与关注',
  'current projects & interest': '当前项目与关注',
  'projects': '当前项目与关注',
  'experience & decisions': '经验与决策',
  'experience and decisions': '经验与决策',
  'experience & decision': '经验与决策',
  'decisions': '经验与决策',
  'technical conventions': '技术规范偏好',
  'technical preferences': '技术规范偏好',
  'tech conventions': '技术规范偏好',
}

/**
 * Normalize a section name to its canonical Chinese form.
 * Falls back to the original name if no alias matches.
 */
function normalizeSection(section: string): string {
  const trimmed = section.trim()
  // Exact match against canonical names
  if ((CANONICAL_SECTIONS as readonly string[]).includes(trimmed)) return trimmed
  // Alias lookup (case-insensitive for English)
  const lower = trimmed.toLowerCase()
  if (SECTION_ALIASES[trimmed]) return SECTION_ALIASES[trimmed]
  if (SECTION_ALIASES[lower]) return SECTION_ALIASES[lower]
  // Fuzzy: check if any alias key is a substring
  for (const [alias, canonical] of Object.entries(SECTION_ALIASES)) {
    if (lower.includes(alias.toLowerCase()) || alias.toLowerCase().includes(lower)) {
      return canonical
    }
  }
  // Unknown section — keep as-is
  return trimmed
}

// ============================================================================
// MEMORY.md 写入（智能更新）
// ============================================================================

/** 在 section 末尾追加一行 */
function insertIntoSection(content: string, sectionName: string, line: string): string {
  const heading = `## ${sectionName}`
  const startIdx = content.indexOf(heading)

  if (startIdx < 0) {
    // section 不存在，追加到末尾
    return `${content.trimEnd()}\n\n${heading}\n\n${line}\n`
  }

  // 找到 section 末尾（下一个 ## 或文件结尾）
  const contentStart = content.indexOf('\n', startIdx)
  if (contentStart < 0) {
    return `${content}\n\n${line}\n`
  }

  const nextHeadingIdx = content.indexOf('\n## ', contentStart)
  const insertPos = nextHeadingIdx >= 0 ? nextHeadingIdx : content.length

  return content.slice(0, insertPos).trimEnd() + '\n' + line + '\n' + content.slice(insertPos)
}

/** 删除匹配行 */
function removeMatchingLine(content: string, pattern: string): string {
  const keywords = extractKeywords(pattern)
  if (keywords.size === 0) return content

  const lines = content.split('\n')
  const filtered = lines.filter((line) => {
    if (!line.startsWith('- ')) return true
    const lineKeywords = extractKeywords(line)
    const overlap = [...keywords].filter((k) => lineKeywords.has(k)).length
    return overlap / keywords.size < 0.7
  })
  return filtered.join('\n')
}

/** 更新匹配行 */
function updateMatchingLine(
  content: string,
  oldPattern: string,
  newLine: string,
): { content: string; updated: boolean } {
  const keywords = extractKeywords(oldPattern)
  if (keywords.size === 0) return { content, updated: false }

  const lines = content.split('\n')
  let updated = false

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('- ')) continue
    const lineKeywords = extractKeywords(lines[i])
    const overlap = [...keywords].filter((k) => lineKeywords.has(k)).length
    if (overlap / keywords.size >= 0.7) {
      lines[i] = newLine
      updated = true
      break
    }
  }

  return { content: lines.join('\n'), updated }
}

/** 应用 MemoryOperation 到 MEMORY.md */
export async function applyMemoryOperations(
  workspaceDir: string,
  agentId: string,
  ops: MemoryOperation,
  logger: QClawLogger,
  reporter: TelemetryReporter,
): Promise<void> {
  // Normalize all section names before writing
  const normalizedOps: MemoryOperation = {
    add: ops.add.map(a => ({ ...a, section: normalizeSection(a.section) })),
    update: ops.update.map(u => ({ ...u, section: normalizeSection(u.section) })),
    remove: ops.remove,
  }

  await withWriteLock(agentId, async () => {
    const memoryPath = path.join(workspaceDir, 'MEMORY.md')
    const existing = await safeReadFile(memoryPath)
    const relPath = `${path.basename(path.dirname(workspaceDir))}/${path.basename(workspaceDir)}/MEMORY.md`

    // Bootstrap: create MEMORY.md with an activation record if it doesn't exist
    let content: string
    if (existing === null) {
      const today = new Date().toISOString().slice(0, 10)
      content = `# ${today}：记忆系统启用\n`
      await fs.mkdir(path.dirname(memoryPath), { recursive: true })
      await fs.writeFile(memoryPath, content, 'utf-8')
      logger.info(`created MEMORY.md with activation record (${today})`)
    } else {
      content = existing
    }

    // 1. 执行删除
    for (const rm of normalizedOps.remove) {
      content = removeMatchingLine(content, rm.pattern)
      logger.info('removed memory matching pattern')
      reporter.report(REPORT_CONST.PLUGIN, {
        module_id: 'AutoMemory',
        component_id: 'Memory_Write_Detail',
        event_code: 'write',
        action_type: 'longterm_remove',
        statistics: {
          agent_id: agentId,
          pattern: rm.pattern,
          reason: rm.reason,
          file_path: relPath,
        },
      })
    }

    // 2. 执行更新
    const pendingAdds: Array<{ section: string; fact: string }> = []
    for (const upd of normalizedOps.update) {
      const result = updateMatchingLine(content, upd.old_pattern, `- ${upd.new_fact}`)
      content = result.content
      if (result.updated) {
        logger.info(`updated memory in section: ${upd.section}`)
        reporter.report(REPORT_CONST.PLUGIN, {
          module_id: 'AutoMemory',
          component_id: 'Memory_Write_Detail',
          event_code: 'write',
          action_type: 'longterm_update',
          statistics: {
            agent_id: agentId,
            section: upd.section,
            old_pattern: upd.old_pattern,
            new_fact: upd.new_fact,
            file_path: relPath,
          },
        })
      } else {
        // 没找到旧条目，退化为 add
        pendingAdds.push({ section: upd.section, fact: upd.new_fact })
      }
    }

    // 3. 执行新增（含 update 退化的 add）
    const allAdds = [...normalizedOps.add, ...pendingAdds]
    for (const item of allAdds) {
      if (isDuplicate(content, item.fact)) {
        logger.info(`skipped duplicate in section: ${item.section}`)
        continue
      }
      content = insertIntoSection(content, item.section, `- ${item.fact}`)
      logger.info(`added memory to section: ${item.section}`)
      reporter.report(REPORT_CONST.PLUGIN, {
        module_id: 'AutoMemory',
        component_id: 'Memory_Write_Detail',
        event_code: 'write',
        action_type: 'longterm_add',
        statistics: {
          agent_id: agentId,
          section: item.section,
          file_path: relPath,
        },
      })
    }

    await fs.mkdir(path.dirname(memoryPath), { recursive: true })
    await fs.writeFile(memoryPath, content, 'utf-8')
  })
}

// ============================================================================
// memory/YYYY-MM-DD.md 写入（按时间分组）
// ============================================================================

/** 追加日工作记录（按时间分组：### HH:mm - 主题） */
export async function appendDailyMemory(
  workspaceDir: string,
  agentId: string,
  facts: DailyFact[],
  logger: QClawLogger,
  reporter: TelemetryReporter,
): Promise<void> {
  await withWriteLock(agentId, async () => {
    const now = new Date()
    const today = now.toISOString().slice(0, 10)
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const memoryDir = path.join(workspaceDir, 'memory')
    await fs.mkdir(memoryDir, { recursive: true })

    const filePath = path.join(memoryDir, `${today}.md`)
    const existing = await safeReadFile(filePath)
    const relPath = `${path.basename(path.dirname(workspaceDir))}/${path.basename(workspaceDir)}/memory/${today}.md`

    // 去重：过滤掉已存在的内容
    const deduped = existing
      ? facts.filter((f) => !isDuplicate(existing, f.text))
      : facts.filter((f, i) => {
        const prev = facts.slice(0, i).map((p) => p.text).join('\n')
        return !isDuplicate(prev, f.text)
      })

    if (deduped.length === 0) {
      logger.info(`[auto-memory:daily] all ${facts.length} facts deduplicated, nothing to write`)
      return
    }

    // 构建 ### HH:mm - 主题 section
    const topic = deduped[0].topic || '对话记录'
    const sectionLines = [`### ${timeStr}  -  ${topic}\n`]
    for (const fact of deduped) {
      sectionLines.push(`- ${fact.text}`)
    }
    sectionLines.push('')

    let content: string
    if (!existing) {
      // 新建文件
      content = `# ${today} 工作日志\n\n${sectionLines.join('\n')}`
    } else {
      // 追加到文件末尾
      content = `${existing.trimEnd()}\n\n${sectionLines.join('\n')}`
    }

    await fs.writeFile(filePath, content, 'utf-8')
    logger.info(`appended ${deduped.length} facts to daily memory: ${today}.md (topic: ${topic}, ${facts.length - deduped.length} duplicates skipped)`)

    // 逐条上报实际写入明细
    for (const fact of deduped) {
      reporter.report(REPORT_CONST.PLUGIN, {
        module_id: 'AutoMemory',
        component_id: 'Daily_Write_Detail',
        event_code: 'write',
        action_type: 'daily_append',
        statistics: {
          agent_id: agentId,
          tag: fact.tag,
          fact: fact.text,
          topic,
          file_path: relPath,
        },
      })
    }
  })
}

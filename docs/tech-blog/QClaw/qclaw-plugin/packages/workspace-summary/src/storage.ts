/**
 * workspace-summary — storage 模块
 *
 * 负责将 store.json、summary.md 写入磁盘。
 * summary 由独立的 LLM 调用在 agent_end 时生成。
 *
 * 目录结构与 docs/workspace-storage-design.md 保持一致。
 */


import * as fs from 'fs/promises'
import { getSessionDir, getStorePath, getSummaryPath } from './paths.js'
import { generateSummaryId, generateAgentId } from './id.js'
import type { SessionStore, SummaryMeta, SummaryResult } from './types.js'
import type { QClawLogger } from '../../../core/types.js'
import type { TelemetryReporter } from '../../../core/reporter-types.js'
import { REPORT_CONST } from '../../../core/reporter-constants.js'

/**
 * 将 summary 结果持久化到 workspace 目录
 *
 * 流程：
 * 1. 确保 session 目录存在
 * 2. 读取或创建 store.json
 * 3. 写入 summary_<id>.md（LLM 生成的摘要）
 * 4. 更新 store.json 索引
 *
 * ⚠️ 并发安全：本函数采用「先读 → 修改 → 写回」模式，
 * 同一 session 的调用必须由外部 Promise 链保证串行。
 * 若未来需要多进程写入同一 session 目录，需改用文件锁或原子写入。
 */
export async function persistSummary(
  sessionId: string,
  agentId: string,
  summaryResult: SummaryResult,
  logger: QClawLogger,
  lastMessageCount?: number,
  reporter?: TelemetryReporter,
): Promise<void> {
  try {
    // 防御性验证：sessionId 不应包含路径分隔符或遍历字符
    if (/[/\\]|\.\./.test(sessionId)) {
      logger.error(`非法 sessionId（包含路径字符）: ${sessionId}`)
      return
    }

    const normalizedSessionId = sessionId

    const sessionDir = getSessionDir(normalizedSessionId)
    await fs.mkdir(sessionDir, { recursive: true })

    // 读取或创建 store.json
    let store: SessionStore
    const storePath = getStorePath(normalizedSessionId)
    try {
      const raw = await fs.readFile(storePath, 'utf-8')
      store = JSON.parse(raw) as SessionStore
    } catch {
      const now = new Date().toISOString()
      store = {
        id: normalizedSessionId,
        name: summaryResult.sessionName,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        agents: [{
          id: generateAgentId(),
          name: agentId === 'main' ? 'Main Agent' : agentId,
          role: 'assistant',
          status: 'idle',
          createdAt: now,
          model: 'unknown',
          systemPrompt: '',
        }],
      }
    }

    const now = new Date().toISOString()

    // ---- 写入 summary ----
    const summaryId = store.summary?.id ?? generateSummaryId()
    const summaryFileName = `${summaryId}.md`
    const summaryFilePath = getSummaryPath(normalizedSessionId, summaryId)
    await fs.writeFile(summaryFilePath, summaryResult.summaryContent, 'utf-8')
    logger.info(`summary 写入: ${summaryFilePath}`)

    const summaryMeta: SummaryMeta = {
      id: summaryId,
      title: summaryResult.sessionName,
      createdAt: store.summary?.createdAt ?? now,
      file: summaryFileName,
    }

    // ---- 更新 store.json ----
    store.name = summaryResult.sessionName
    store.updatedAt = now
    store.summary = summaryMeta
    if (lastMessageCount !== undefined) {
      store.lastMessageCount = lastMessageCount
    }

    await fs.writeFile(storePath, JSON.stringify(store, null, 2), 'utf-8')
    logger.info(`store.json 更新: ${storePath}`)

    // 上报：持久化成功
    reporter?.report(REPORT_CONST.PLUGIN, {
      module_id: 'WorkspaceSummary',
      component_id: 'Persist_Summary',
      event_code: 'summary',
      action_type: 'persist_success',
      statistics: {
        session_id: normalizedSessionId,
        agent_id: agentId,
        summary_id: summaryId,
        session_name: summaryResult.sessionName,
        summary_length: summaryResult.summaryContent.length,
      },
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.error(`持久化失败: ${errMsg}`)

    // 上报：持久化失败
    reporter?.report(REPORT_CONST.PLUGIN, {
      module_id: 'WorkspaceSummary',
      component_id: 'Persist_Summary',
      event_code: 'summary',
      action_type: 'persist_failed',
      action_status: 'fail',
      statistics: {
        session_id: sessionId,
        agent_id: agentId,
        error_message: errMsg.slice(0, 200),
      },
    })
    throw err
  }
}

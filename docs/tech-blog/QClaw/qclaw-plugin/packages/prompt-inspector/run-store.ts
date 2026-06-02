/**
 * packages/prompt-inspector/run-store.ts — Run 级别存储
 *
 * 管理 RunRecord 的创建、事件追加、查询和容量控制。
 * 最多保留 MAX_RUNS 个 Run，超出时淘汰最旧的。
 */

import type {
  RunRecord,
  RunEvent,
  RunSummary,
  RunStatus,
  LlmCallEvent,
  PromptBuildEvent,
  SubAgentSpawnEvent,
  ToolCallEvent,
} from './types.js'

/** 最多保留的 Run 数量 */
const MAX_RUNS = 20

/**
 * 模块级单例 RunStore 实例。
 *
 * 当 OpenClaw 创建新 agent 时，qclaw-plugin 会被重新 register()，
 * 导致 setup() 中的局部变量（包括 RunStore）被重新创建。
 * 使用模块级单例确保所有 agent 的 hook 数据写入同一个 RunStore，
 * 且 HTTP 路由 handler（无论新旧）都能访问到完整数据。
 */
let sharedInstance: RunStore | null = null

/**
 * 获取共享的 RunStore 单例。
 * 首次调用时创建实例，后续调用返回同一实例。
 */
export function getSharedRunStore(): RunStore {
  if (!sharedInstance) {
    sharedInstance = new RunStore()
  }
  return sharedInstance
}

/**
 * 从 sessionId 解析 agentId。
 * sessionId 格式为 "agent:<agentId>:<sessionPart>"，例如：
 * - "agent:main:main" → "main"
 * - "agent:agent-8820d41d:session-xxx" → "agent-8820d41d"
 * 如果格式不匹配，返回 "unknown"。
 */
export function parseAgentId(sessionId: string): string {
  if (!sessionId) return 'unknown'
  const parts = sessionId.split(':')
  // 格式: agent:<agentId>:<rest>
  if (parts.length >= 3 && parts[0] === 'agent') {
    return parts[1] ?? 'unknown'
  }
  // 其他格式，尝试返回第一段
  return parts[0] ?? 'unknown'
}

export class RunStore {
  private runs = new Map<string, RunRecord>()

  /**
   * 幂等创建 Run。如果 runId 已存在，直接返回已有记录。
   */
  createRun(
    runId: string,
    sessionId: string,
    agentType: 'main' | 'subagent',
    parentRunId?: string,
  ): RunRecord {
    const existing = this.runs.get(runId)
    if (existing) return existing

    const now = Date.now()
    const record: RunRecord = {
      runId,
      sessionId,
      agentId: parseAgentId(sessionId),
      agentType,
      parentRunId,
      startTime: now,
      endTime: undefined,
      lastUpdated: now,
      events: [],
      status: 'running' as RunStatus,
    }

    this.runs.set(runId, record)

    // 容量控制：超过 MAX_RUNS 时淘汰最旧的
    if (this.runs.size > MAX_RUNS) {
      const allRuns = [...this.runs.values()].sort((a, b) => a.startTime - b.startTime)
      const oldest = allRuns[0]
      if (oldest) {
        this.runs.delete(oldest.runId)
      }
    }

    return record
  }

  /**
   * 将 Run 从旧 key 迁移到新 key（更新 runId）。
   * 用于修复 before_prompt_build 阶段 hookCtx 没有 runId 时，
   * 临时使用 sessionKey 作为 key，后续 llm_input 获得真正 runId 后迁移。
   * 如果 oldKey 不存在或 newKey 已存在，则不操作。
   */
  rekey(oldKey: string, newKey: string): boolean {
    if (oldKey === newKey) return false
    const run = this.runs.get(oldKey)
    if (!run) return false
    if (this.runs.has(newKey)) return false
    this.runs.delete(oldKey)
    run.runId = newKey
    run.lastUpdated = Date.now()
    this.runs.set(newKey, run)
    return true
  }

  /**
   * 追加事件到指定 Run。如果 Run 不存在则忽略。
   * 追加后更新 endTime。
   */
  appendEvent(runId: string, event: RunEvent): void {
    const run = this.runs.get(runId)
    if (!run) return

    run.events.push(event)
    run.endTime = event.timestamp
    run.lastUpdated = Date.now()
  }

  /**
   * 标记 Run 状态
   */
  setStatus(runId: string, status: RunStatus): void {
    const run = this.runs.get(runId)
    if (!run) return
    run.status = status
    const now = Date.now()
    run.lastUpdated = now
    if (status === 'completed' || status === 'error') {
      run.endTime = now
    }
  }

  /**
   * 按 runId 查询
   */
  getRun(runId: string): RunRecord | undefined {
    return this.runs.get(runId)
  }

  /**
   * 返回所有 Run，按 startTime 升序排列
   */
  getAllRuns(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => a.startTime - b.startTime)
  }

  /**
   * 增量查询：返回 startTime > afterTimestamp 的 Run
   */
  getRunsAfter(afterTimestamp: number): RunRecord[] {
    return this.getAllRuns().filter((r) => r.lastUpdated > afterTimestamp)
  }

  /**
   * 清空所有 Run
   */
  clear(): void {
    this.runs.clear()
  }

  /**
   * 当前 Run 数量
   */
  size(): number {
    return this.runs.size
  }
}

// ============================================================================
// F205: buildRunSummary — 从 RunRecord 生成 RunSummary
// ============================================================================

/**
 * 从 RunRecord 生成 RunSummary（用于列表展示）
 */
export function buildRunSummary(run: RunRecord): RunSummary {
  let model = ''
  let userPromptPreview = ''
  let llmCallCount = 0
  let toolCallCount = 0
  let subAgentCount = 0

  for (const event of run.events) {
    switch (event.type) {
      case 'llm_call': {
        llmCallCount++
        if (!model) {
          model = (event as LlmCallEvent).model
        }
        break
      }
      case 'prompt_build': {
        if (!userPromptPreview) {
          const promptEvent = event as PromptBuildEvent
          userPromptPreview = promptEvent.userPrompt.slice(0, 200)
        }
        break
      }
      case 'tool_call': {
        toolCallCount++
        break
      }
      case 'subagent_spawn': {
        subAgentCount++
        break
      }
    }
  }

  const totalDuration =
    run.endTime != null ? run.endTime - run.startTime : undefined

  return {
    model,
    userPromptPreview,
    llmCallCount,
    toolCallCount,
    subAgentCount,
    totalDuration,
  }
}

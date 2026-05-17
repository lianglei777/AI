/**
 * auto-memory 对话采集器（已废弃 — 改用 agent_end event.messages 直接提取）
 *
 * 原设计通过 llm_input / llm_output hook 采集对话，
 * 但 OpenClaw 核心不发射这两个事件给插件 API（hasHooks 守卫导致）。
 * 现在采集逻辑已迁移到 index.ts 的 extractTurnsFromMessages()。
 *
 * 保留此文件以备未来 llm_input/llm_output 被修复时回退使用。
 */

import type { SessionBuffer } from './types.js'

/** 全局 session 缓冲区 */
const sessions = new Map<string, SessionBuffer>()

/** 采集 user message（llm_input hook 调用） */
export function collectInput(
  sessionKey: string,
  agentId: string,
  messages: unknown[],
): void {
  let buffer = sessions.get(sessionKey)
  if (!buffer) {
    buffer = {
      agentId,
      turns: [],
      pendingTurnCount: 0,
      lastTriggerTs: 0,
      pendingUserMessage: null,
    }
    sessions.set(sessionKey, buffer)
  }

  // 提取最后一条 user message
  const lastUserMsg = extractLastUserMessage(messages)
  if (lastUserMsg) {
    buffer.pendingUserMessage = lastUserMsg
  }
}

/** 采集 assistant reply（llm_output hook 调用） */
export function collectOutput(
  sessionKey: string,
  assistantText: string,
): void {
  const buffer = sessions.get(sessionKey)
  if (!buffer || !buffer.pendingUserMessage) return

  // 配对成一轮
  buffer.turns.push({
    user: buffer.pendingUserMessage,
    assistant: assistantText,
  })
  buffer.pendingTurnCount++
  buffer.pendingUserMessage = null
}

/** 获取 session buffer（非消费性查看） */
export function getBuffer(sessionKey: string): SessionBuffer | undefined {
  return sessions.get(sessionKey)
}

/** 查看当前 pending 状态（非消费性，用于触发条件判断和预筛） */
export function peekPendingState(sessionKey: string): {
  pendingTurnCount: number
  lastTriggerTs: number
  agentId: string
  /** 最近 pending 的轮次（用于预筛） */
  recentTurns: import('./types.js').Turn[]
} | undefined {
  const buffer = sessions.get(sessionKey)
  if (!buffer) return undefined
  return {
    pendingTurnCount: buffer.pendingTurnCount,
    lastTriggerTs: buffer.lastTriggerTs,
    agentId: buffer.agentId,
    recentTurns: buffer.turns.slice(-buffer.pendingTurnCount),
  }
}

/** 消费 buffer 中的 pending turns（提取后重置计数） */
export function consumePendingTurns(sessionKey: string): SessionBuffer | undefined {
  const buffer = sessions.get(sessionKey)
  if (!buffer || buffer.pendingTurnCount === 0) return undefined

  // 先保存 snapshot（包含当前 pendingTurnCount 和 lastTriggerTs）
  const snapshot: SessionBuffer = {
    agentId: buffer.agentId,
    turns: [...buffer.turns],
    pendingTurnCount: buffer.pendingTurnCount,
    lastTriggerTs: buffer.lastTriggerTs,
    pendingUserMessage: buffer.pendingUserMessage,
  }

  // 然后重置 buffer 的 pending 状态
  buffer.pendingTurnCount = 0
  buffer.lastTriggerTs = Date.now()

  // 清理过老的 turns（只保留最近 20 轮，避免内存泄漏）
  if (buffer.turns.length > 20) {
    buffer.turns = buffer.turns.slice(-20)
  }

  return snapshot
}

/** 清理指定 session 的 buffer */
export function clearBuffer(sessionKey: string): void {
  sessions.delete(sessionKey)
}

/** 从 messages 数组中提取最后一条 user message 的文本 */
function extractLastUserMessage(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown> | undefined
    if (!msg || msg.role !== 'user') continue

    const content = msg.content
    if (typeof content === 'string') return content

    // content 可能是数组（多模态）
    if (Array.isArray(content)) {
      const textParts: string[] = []
      for (const block of content) {
        if (
          block &&
          typeof block === 'object' &&
          'text' in (block as Record<string, unknown>) &&
          typeof (block as Record<string, unknown>).text === 'string'
        ) {
          textParts.push((block as Record<string, unknown>).text as string)
        }
      }
      if (textParts.length > 0) return textParts.join('\n')
    }
  }
  return null
}

/**
 * auto-memory 预筛逻辑
 *
 * 在调用 LLM 之前，判断是否值得提取。
 * 只跳过明确无信息的场景：
 * 1. 空 turns
 * 2. 单轮极短寒暄（双方都 < 20 字）
 * 3. 纯工具调用场景（assistant 只有代码/工具输出，无自然语言解释）
 */

import type { Turn } from './types.js'

/** 纯工具输出的最小长度阈值（低于此视为无自然语言） */
const TOOL_ONLY_MAX_LENGTH = 8

/**
 * 判断是否应跳过提取
 *
 * @returns true 表示跳过（不值得提取）
 */
export function shouldSkipExtraction(turns: Turn[]): boolean {
  if (turns.length === 0) return true

  // 单轮且双方都极短（< 20 字）的纯寒暄
  if (turns.length === 1) {
    const t = turns[0]
    if (t.user.length < 20 && t.assistant.length < 20) return true
  }

  // 检测是否为纯工具调用/纯代码输出场景
  // 条件：所有 assistant 回复在去除代码块后，剩余自然语言极少
  const allToolOnly = turns.every((t) => {
    const stripped = t.assistant.replace(/```[\s\S]*?```/g, '').trim()
    return stripped.length <= TOOL_ONLY_MAX_LENGTH
  })

  if (allToolOnly) {
    // 双重保险：如果用户消息中有实质内容（非纯指令），不跳过
    // 避免"喜欢打篮球"这类有价值的用户表达被过滤
    const hasSubstantiveUserInput = turns.some((t) => {
      const trimmed = t.user.trim()
      // 用户消息 > 4 字 且 不是纯指令关键词
      return trimmed.length > 4 && !/^(好的|谢谢|OK|可以|嗯|啊|哦|行)/.test(trimmed)
    })
    if (!hasSubstantiveUserInput) return true
  }

  return false
}

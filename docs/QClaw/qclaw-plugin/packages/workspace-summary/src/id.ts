/**
 * workspace-summary ID 生成工具
 *
 * ID 格式：<type>_<随机字符串>
 * 示例：session_a1b2c3d4、summary_p7q8r9
 */

import { randomBytes } from 'crypto'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const ID_LENGTH = 8

/** 生成随机 ID 后缀（拒绝采样，消除模运算偏差） */
function randomSuffix(length: number = ID_LENGTH): string {
  // 256 能被 ALPHABET.length 整除的最大倍数
  const maxValid = 256 - (256 % ALPHABET.length) // = 252 for length 36
  let result = ''
  while (result.length < length) {
    const bytes = randomBytes(length - result.length + 4) // 多取几个避免多轮循环
    for (let i = 0; i < bytes.length && result.length < length; i++) {
      if (bytes[i] < maxValid) {
        result += ALPHABET[bytes[i] % ALPHABET.length]
      }
    }
  }
  return result
}

export function generateSessionId(): string {
  return `session_${randomSuffix()}`
}

export function generateSummaryId(): string {
  return `summary_${randomSuffix()}`
}

export function generateAgentId(): string {
  return `agent_${randomSuffix()}`
}

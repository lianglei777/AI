/**
 * core/logger.ts — 统一日志
 *
 * 自动为每个 package 的日志添加 [qclaw-plugin:<packageId>] 前缀。
 * 底层使用 console.log/warn/error/debug。
 */

import type { QClawLogger } from './types.js'

/**
 * 创建带前缀的 Logger 实例
 * @param packageId package 的唯一标识
 * @returns QClawLogger 实例
 */
export function createLogger(packageId: string): QClawLogger {
const prefix = `[qclaw-plugin:${packageId}]`

  return {
    info(message: string, ...args: unknown[]): void {
      console.log(`${prefix} ${message}`, ...args)
    },
    warn(message: string, ...args: unknown[]): void {
      console.warn(`${prefix} ${message}`, ...args)
    },
    error(message: string, ...args: unknown[]): void {
      console.error(`${prefix} ${message}`, ...args)
    },
    debug(message: string, ...args: unknown[]): void {
      console.debug(`${prefix} ${message}`, ...args)
    },
  }
}

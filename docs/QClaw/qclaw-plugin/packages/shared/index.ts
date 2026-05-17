/**
 * shared — 公共工具库统一导出
 *
 * 提供跨 package 共享的工具函数，避免代码重复。
 * 注意：shared 不是 QClawPackage，不需要注册到 PACKAGES 列表。
 */

export type { NormalizedMessage } from './message-utils.js'
export {
  normalizeMessage,
  extractLastUserMessage,
  robustExtractLastUserMessage,
} from './message-utils.js'

export { injectSecurityMarkerBase } from './security-marker.js'

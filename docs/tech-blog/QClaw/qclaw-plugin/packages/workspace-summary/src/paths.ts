/**
 * workspace-summary 路径工具函数
 *
 * 与 docs/workspace-storage-design.md § 7 保持一致。
 */

import { homedir } from 'os'
import { join } from 'path'

export const WORKSPACE_ROOT = join(homedir(), '.qclaw', 'workspace')

// ---- session 级 ----

/** session 目录 */
export function getSessionDir(sessionId: string): string {
  return join(WORKSPACE_ROOT, 'sessions', sessionId)
}

/** store.json 路径（元数据索引） */
export function getStorePath(sessionId: string): string {
  return join(getSessionDir(sessionId), 'store.json')
}

// ---- 文件级 ----

/** session 目录下的 summary 文件路径 */
export function getSummaryPath(sessionId: string, summaryId: string): string {
  return join(getSessionDir(sessionId), `${summaryId}.md`)
}

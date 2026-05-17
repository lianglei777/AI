/**
 * 运行时配置模块
 *
 * 管理审核开关和审计上报 URL 的运行时可变状态。
 * 支持：
 *   - 从 pluginConfig 静态初始化
 *   - 通过 HTTP API 动态更新
 *   - 启动时从远程服务拉取覆盖
 *
 * 工具调用 Pipeline 审核（enableToolCallAudit）：经 endpoints.pipelineAudit（JPrx 4076）与 LLMShieldClient.auditPipeline。
 */

import { fileLog } from "./logger";

// ── 类型定义 ─────────────────────────────────────────────────────

/** 运行时可动态修改的审核开关 */
export interface AuditSwitches {
  enablePromptAudit: boolean;
  enableSkillAudit: boolean;
  enableScriptAudit: boolean;
  /** 审计日志外部上报 URL，空串表示不上报 */
  auditReportUrl: string;
  /**
   * 是否启用 before_tool_call Pipeline 审核。
   * 默认 false；可通过 pluginConfig 或 HTTP /config 开启。
   */
  enableToolCallAudit: boolean;
  /** Pipeline 请求超时（毫秒） */
  toolCallAuditTimeoutMs?: number;
}

// ── 字段白名单 ───────────────────────────────────────────────────

const ALLOWED_KEYS: ReadonlySet<keyof AuditSwitches> = new Set([
  "enablePromptAudit",
  "enableSkillAudit",
  "enableScriptAudit",
  "auditReportUrl",
  "enableToolCallAudit",
  "toolCallAuditTimeoutMs",
]);

/** 过滤掉不在白名单中的字段，仅保留 AuditSwitches 的已知属性 */
function sanitizePatch(raw: Record<string, unknown>): Partial<AuditSwitches> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (ALLOWED_KEYS.has(key as keyof AuditSwitches)) {
      result[key] = raw[key];
    }
  }
  return result as Partial<AuditSwitches>;
}

// ── 默认值常量 ───────────────────────────────────────────────────

/** auditReportUrl 为空时的兜底默认值（与数据库 schema 初始值一致） */
export const DEFAULT_AUDIT_REPORT_URL = "http://localhost";

// ── 模块级单例 ───────────────────────────────────────────────────

let switches: AuditSwitches = {
  enablePromptAudit: true,
  enableSkillAudit: true,
  enableScriptAudit: true,
  auditReportUrl: DEFAULT_AUDIT_REPORT_URL,
  enableToolCallAudit: true,
  toolCallAuditTimeoutMs: undefined,
};

// ── 公共 API ─────────────────────────────────────────────────────

/** 初始化（从 pluginConfig 读取初始值） */
export function initSwitches(initial: Partial<AuditSwitches>): void {
  switches = { ...switches, ...sanitizePatch(initial as Record<string, unknown>) };
}

/** 获取当前开关状态 */
export function getSwitches(): Readonly<AuditSwitches> {
  return switches;
}

/** 部分更新开关，返回更新后的完整状态 */
export function updateSwitches(patch: Partial<AuditSwitches>): AuditSwitches {
  switches = { ...switches, ...sanitizePatch(patch as Record<string, unknown>) };
  fileLog(`[runtime-config] switches updated: ${JSON.stringify(switches)}`);
  return { ...switches };
}

// ── 远程配置拉取 ─────────────────────────────────────────────────

const CONFIG_PULL_PATH = "/proxy/plugin/security/get-config";
const CONFIG_REPORT_PATH = "/proxy/plugin/security/audit-log";

/** 从 auditReportUrl 推导配置拉取 URL */
export function deriveConfigPullUrl(auditReportUrl: string, type: 'get' | 'report'): string | null {
  // 代理服务端口
  const proxyPort = process.env.AUTH_GATEWAY_PORT ?? "19000";
  const path = type === 'get' ? CONFIG_PULL_PATH : CONFIG_REPORT_PATH;
  try {
    const url = new URL(auditReportUrl);
    // 本地代理网关始终是 HTTP 服务，使用 hostname 而非 origin（origin 会携带原始协议）
    return `http://${url.hostname}:${proxyPort}${path}`;
  } catch {
    return null;
  }
}

/**
 * 启动时拉取远程配置，merge 到运行时开关。
 *
 * @param originalFetch 原始 fetch（必须绕过 FetchChain）
 */
export async function pullRemoteConfig(originalFetch: typeof globalThis.fetch): Promise<void> {
  const { auditReportUrl } = switches;
  if (!auditReportUrl) return;

  const pullUrl = deriveConfigPullUrl(auditReportUrl, 'get');
  if (!pullUrl) return;

  try {
    const res = await originalFetch(pullUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      fileLog(`[config-pull] HTTP ${res.status} from ${pullUrl}`);
      return;
    }
    const remote = await res.json() as Record<string, unknown>;
    updateSwitches(remote as Partial<AuditSwitches>);
    fileLog(`[config-pull] remote raw keys: ${Object.keys(remote).join(", ")}`);
    fileLog(`[config-pull] merged remote config: ${JSON.stringify(remote)}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    fileLog(`[config-pull] failed: ${message}`);
  }
}

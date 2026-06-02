/**
 * Build tool-call audit request body (flat format for JPrx 4076/4217).
 */

import os from "node:os";
import type { AgentdrLogger, ToolCallAuditRequest, ToolCallAuditHistoryItem } from "./types.js";
import { extractSessionEvents } from "./session-events.js";

const OS_TYPE = (() => {
  const platform = os.platform();
  return platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform === "linux" ? "linux" : "other";
})();

export interface BuildToolCallEnvelopeParams {
  stateDir: string;
  agentId: string;
  sessionKey: string;
  toolName: string;
  params: Record<string, unknown>;
  sceneId: string;
  logger: AgentdrLogger;
  /** 外部已提取好的 history，有值时跳过 extractSessionEvents */
  history?: Array<{ Role: string; Content: string }>;
}

/**
 * 将工具名称 + 参数组装为 Command 字符串。
 *
 * - exec 类工具：直接取 params.command
 * - 其他工具：`toolName <JSON params>`
 */
function buildCommand(toolName: string, params: Record<string, unknown>): string {
  if (
    (toolName === "exec" || toolName === "execute_command") &&
    typeof params.command === "string"
  ) {
    return params.command;
  }
  return `${toolName} ${JSON.stringify(params)}`;
}

/**
 * 将 session events 转换为 History 数组。
 * 取 message.role / message.content，过滤掉无内容的事件。
 */
function eventsToHistory(
  events: Array<{ message?: { role?: string; content?: unknown } }>,
): ToolCallAuditHistoryItem[] {
  const history: ToolCallAuditHistoryItem[] = [];
  for (const evt of events) {
    const msg = evt.message as { role?: string; content?: unknown } | undefined;
    if (!msg) continue;
    const role = typeof msg.role === "string" ? msg.role : "";
    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .map((p: Record<string, unknown>) => (typeof p.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("\n");
    }
    if (!role && !content) continue;
    history.push({ Role: role, Content: content });
  }
  return history;
}

export function buildToolCallEnvelope(p: BuildToolCallEnvelopeParams): ToolCallAuditRequest {
  const { events } = extractSessionEvents(p.stateDir, p.agentId, p.sessionKey, p.logger);

  return {
    Command: buildCommand(p.toolName, p.params),
    Name: p.toolName,
    Context: {
      Cwd: process.cwd(),
      Environment: {
        Os: OS_TYPE,
        Shell: process.env.SHELL ?? "unknown",
      },
    },
    Scene: p.sceneId || "chat",
    SessionID: p.sessionKey || undefined,
    // AgentID: "qclaw",
    History: eventsToHistory(events),
  };
}

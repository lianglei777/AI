/**
 * AgentDR Pipeline types aligned with AIDR Pipeline model.
 */

export interface PipelineEnvelope {
  metadata: PipelineMetadata;
  history: PipelineHistory;
  context?: PipelineContext;
  action?: IngressAction;
}

export interface PipelineMetadata {
  session_id: string;
  request_id?: string;
  agent_id?: string;
}

export interface PipelineHistory {
  events: PipelineEvent[];
  summary?: string;
}

export interface PipelineEvent {
  type: string;
  id: string;
  timestamp: string;
  parent_id?: string | null;
  message?: EventMessage;
  cwd?: string;
  provider?: string;
  model_id?: string;
}

export interface EventMessage {
  role: string;
  content: string | ContentPart[] | null;
  timestamp?: number;
  tool_call_id?: string;
  tool_name?: string;
  is_error?: boolean;
}

export interface ContentPart {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export interface ResolvedFile {
  path: string;
  content: string;
  encoding?: string;
}

export type IngressAction = IngressActionNone | IngressActionToolCall | IngressActionToolResult;

export interface IngressActionNone {
  kind: "none";
  payload: Record<string, never>;
}

export interface IngressActionToolCall {
  kind: "tool_call";
  name: string;
  params: Record<string, unknown>;
  payload: { resolved_files?: ResolvedFile[] };
}

export interface IngressActionToolResult {
  kind: "tool_result";
  name: string;
  params: Record<string, unknown>;
  result: unknown;
  payload: { resolved_files?: ResolvedFile[] };
}

export interface PipelineContext {
  cwd?: string;
  workspace_root?: string;
  environment?: PipelineEnvironment;
  sandbox?: PipelineSandbox;
  network?: PipelineNetwork;
}

export interface PipelineEnvironment {
  os: "linux" | "macos" | "windows" | "other";
  shell: string;
  runtime?: string;
  env_vars?: Record<string, string>;
}

export interface PipelineSandbox {
  mode?: "read_only" | "workspace_write" | "full_access" | "custom";
  writable_paths?: string[];
  readable_paths?: string[];
}

export interface PipelineNetwork {
  enabled?: boolean;
  allowed_hosts?: string[];
}

export interface PipelineResponse {
  policy_decision?: PolicyDecision;
}

export interface PolicyDecision {
  decision: "allow" | "deny" | "require_approval";
  reason: string;
  policy_id?: string;
}

export interface AgentdrVerdict {
  block: boolean;
  blockReason?: string;
  decision?: PolicyDecision["decision"];
}

// ── Tool-call audit request (flat format for JPrx 4076/4217) ──

/** 工具调用审核请求体（与 Moderate/Skill/Script 同层级的扁平结构） */
export interface ToolCallAuditRequest {
  /** 工具名称 + 参数的序列化命令描述 */
  Command: string;
  /** 工具名称（原始 toolName） */
  Name: string;
  Context: ToolCallAuditContext;
  Scene: string;
  /** 会话标识，用于后端关联同一会话的审核请求 */
  SessionID?: string;
  AgentID?: string;
  History: ToolCallAuditHistoryItem[];
}

export interface ToolCallAuditContext {
  Cwd: string;
  Environment: ToolCallAuditEnvironment;
}

export interface ToolCallAuditEnvironment {
  Os: string;
  Shell: string;
}

export interface ToolCallAuditHistoryItem {
  Role: string;
  Content: string;
}

export interface SessionEventsResult {
  sessionId: string | null;
  events: PipelineEvent[];
}

export interface AgentdrLogger {
  error: (message: string) => void;
}

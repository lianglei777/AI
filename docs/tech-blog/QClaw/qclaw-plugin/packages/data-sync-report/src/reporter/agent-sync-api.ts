/**
 * Agent 增量同步 API
 *
 * 调用后端 /api/agents/upsert 接口（命令字 4174），增量上报 Agent 的变化。
 * - 新增/修改的 agent 放在 agents 字段中
 * - 删除的 agent 放在 delete_agent_ids 字段中
 * - 仅删除 identity（保留 agent 本身）的 agent 放在 delete_identity_agent_ids 字段中
 * - 根据本次变化情况，请求体中只包含有数据的字段
 */

import type { AgentDiffResult, AgentIdentityData, AgentWithHash, IdentityChangeResult, Logger } from "../types.js";
import type { TelemetryReporter } from "../../../../core/reporter-types.js";
import { AGENT_UPSERT_API_PATH } from "../constants.js";
import { fetchApi } from "./fetch-api.js";

/** API 层的 identity 结构（对齐后端 /api/agents/upsert 接口） */
interface ApiAgentIdentity {
  name?: string;
  vibe?: string;
  avatarUrl?: string;
  /** Identity 数据的哈希值 */
  hash?: string;
}

/** 单个 Agent 的 API 请求格式 */
interface ApiAgent {
  agent_id: string;
  name?: string;
  /** SHA-256 哈希 */
  hash?: string;
  /** Agent 身份信息 */
  identity?: ApiAgentIdentity;
}

/** 增量同步请求体 */
interface AgentUpsertRequest {
  agents?: ApiAgent[];
  delete_agent_ids?: string[];
  delete_identity_agent_ids?: string[];
}

/**
 * 将内部 AgentWithHash 转换为 API 请求格式
 */
function toApiAgent(agentWithHash: AgentWithHash): ApiAgent {
  const agent = agentWithHash.data;
  return {
    agent_id: agent.id,
    name: agent.name,
    hash: agentWithHash.hash,
  };
}

/**
 * 调用 Agent 增量同步接口（命令字 4174）
 *
 * 根据 diff 结果，只上报有变化的部分：
 * - createdOrUpdatedAgents 不为空时，放入 agents 字段
 * - deletedAgentIds 不为空时，放入 delete_agent_ids 字段
 * - deleteIdentityAgentIds 不为空时，放入 delete_identity_agent_ids 字段
 *   （对应后端"仅删除 identity、保留 agent"的语义）
 */
export async function syncAgentsDiffToBackend(
  diff: AgentDiffResult,
  logger: Logger,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  telemetryReporter?: TelemetryReporter
): Promise<boolean> {
  const { createdOrUpdatedAgents, deletedAgentIds, deleteIdentityAgentIds } = diff;

  if (
    createdOrUpdatedAgents.length === 0 &&
    deletedAgentIds.length === 0 &&
    deleteIdentityAgentIds.length === 0
  ) {
    logger.debug("==data-sync-report插件==动作:AgentSyncApi跳过同步,无变化需上报==");
    return true;
  }

  const requestBody: AgentUpsertRequest = {};

  if (createdOrUpdatedAgents.length > 0) {
    requestBody.agents = createdOrUpdatedAgents.map(toApiAgent);
  }

  if (deletedAgentIds.length > 0) {
    requestBody.delete_agent_ids = deletedAgentIds;
  }

  if (deleteIdentityAgentIds.length > 0) {
    requestBody.delete_identity_agent_ids = deleteIdentityAgentIds;
  }

  const [, error] = await fetchApi({
    apiPath: AGENT_UPSERT_API_PATH,
    body: requestBody,
    logger,
    logTag: "AgentSyncApi",
    fetchFn,
    telemetryReporter,
  });

  return error === null;
}

/**
 * 将 identity 数据转换为 API 请求格式
 * 只包含有值的字段
 */
function toApiAgentIdentity(identity: AgentIdentityData, hash?: string): ApiAgentIdentity | undefined {
  const result: ApiAgentIdentity = {};
  let hasField = false;

  if (identity.name) {
    result.name = identity.name;
    hasField = true;
  }
  if (identity.vibe) {
    result.vibe = identity.vibe;
    hasField = true;
  }
  if (identity.avatar) {
    result.avatarUrl = identity.avatar;
    hasField = true;
  }

  if (!hasField) {
    return undefined;
  }

  if (hash) {
    result.hash = hash;
  }

  return result;
}

/**
 * 调用 Agent upsert 接口上报 identity 变化（命令字 4174）
 *
 * 复用同一个 /api/agents/upsert 接口，仅传入 agent_id + identity 字段。
 * 后端以 upsert 语义处理：存在则更新 identity，不存在则跳过。
 */
export async function syncAgentIdentityToBackend(
  result: IdentityChangeResult,
  logger: Logger,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  telemetryReporter?: TelemetryReporter
): Promise<boolean> {
  const { agentId, identity, hash } = result;

  const apiIdentity = toApiAgentIdentity(identity, hash);
  if (!apiIdentity) {
    logger.info(`==data-sync-report插件==动作:AgentSyncApi跳过Identity同步,无有效字段==参数==agentId="${agentId}"`);
    return true;
  }

  const requestBody: AgentUpsertRequest = {
    agents: [{ agent_id: agentId, identity: apiIdentity }],
  };

  const [, error] = await fetchApi({
    apiPath: AGENT_UPSERT_API_PATH,
    body: requestBody,
    logger,
    logTag: "AgentSyncApi(Identity)",
    fetchFn,
    telemetryReporter,
  });

  return error === null;
}

/**
 * session-bridge — llm_input 钩子 → fetch 拦截器的 sessionKey 桥梁
 *
 * 使用 agentId 维度的 Map 存储，避免多会话并发时 sessionKey 互相覆盖。
 * 同一个 agent 下的 LLM 请求是串行的（OpenClaw 架构保证），所以按 agentId 隔离即可。
 *
 * 读取方式为非消费式，同一条消息的多次 fetch 都能拿到正确的 sessionKey。
 */

/**
 * agentId → sessionKey 映射
 * 从 llm_input 钩子的 sessionKey 中解析 agentId（格式: agent:{agentId}:{suffix}）
 */
const _sessionKeyMap = new Map<string, string>();

/**
 * 从 sessionKey 中解析 agentId
 * sessionKey 格式: agent:{agentId}:session-xxx 或 agent:{agentId}:main
 */
function extractAgentId(sessionKey: string): string {
  const parts = sessionKey.split(':');
  // agent:{agentId}:...
  return parts[1] || 'main';
}

/**
 * 设置 sessionKey（由 llm_input 钩子调用）
 * 按 agentId 维度存储，多会话并发不会互相覆盖
 */
export function setPendingSessionKey(key: string): void {
  const agentId = extractAgentId(key);
  _sessionKeyMap.set(agentId, key);
}

/**
 * 获取指定 agentId 的 sessionKey（由 fetch 拦截器调用）
 * 非消费式读取，多次调用返回同一个值
 *
 * @param agentId 从请求 header 的 x-agent-id 获取，默认 'main'
 */
export function getPendingSessionKey(agentId?: string): string | null {
  return _sessionKeyMap.get(agentId || 'main') ?? null;
}

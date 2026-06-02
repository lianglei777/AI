/**
 * shared/message-utils.ts — 消息处理公共工具函数
 *
 * 从 content-plugin 和 pcmgr-ai-security 提取的公共消息处理逻辑。
 *
 * 导出两个版本的 extractLastUserMessage：
 * - extractLastUserMessage：含 isToolResultMessage 过滤（content-plugin 使用）
 * - robustExtractLastUserMessage：不含过滤（pcmgr-ai-security 使用，保持原有行为）
 */

/** 标准化后的消息结构 */
export interface NormalizedMessage {
  role: string
  content: string
}

/**
 * 将 OpenAI/其他格式的消息标准化为 { role, content } 结构。
 *
 * - OpenAI 字符串格式：直接提取 content
 * - OpenAI 多模态格式：提取所有 type=text 的部分，用换行拼接
 * - 非 OpenAI 格式：content 直接转为字符串
 */
export const normalizeMessage = (
  message: any,
  format: string = 'openai',
): NormalizedMessage => {
  if (format === 'openai') {
    let content = ''
    if (typeof message.content === 'string') {
      // 简单字符串格式（最常见）
      content = message.content
    } else if (Array.isArray(message.content)) {
      // 多模态格式：提取所有 type=text 的部分，用换行拼接
      content = message.content
        .filter((part: any) => part.type === 'text' && typeof part.text === 'string')
        .map((part: any) => part.text)
        .join('\n')
    }
    return {
      role: message.role || '',
      content,
    }
  }

  // 非 OpenAI 格式：content 直接转为字符串
  return {
    role: message.role || '',
    content:
      typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content || ''),
  }
}

/**
 * 判断 messages 数组中最后一条 user 消息是否为工具结果回传（而非真实用户输入）。
 *
 * 判断依据：
 * 1. OpenAI 格式：最后一条 user 消息之前紧邻的 assistant 消息带有 tool_calls
 * 2. Anthropic 格式：最后一条 user 消息的 content 数组中包含 type=tool_result 的部分
 */
const isToolResultMessage = (messages: any[], lastUserIndex: number): boolean => {
  const lastUserMsg = messages[lastUserIndex]

  // Anthropic 格式：content 数组中含有 tool_result
  if (Array.isArray(lastUserMsg?.content)) {
    const hasToolResult = lastUserMsg.content.some(
      (part: any) => part.type === 'tool_result' || part.type === 'tool_use',
    )
    if (hasToolResult) return true
  }

  // OpenAI 格式：向前找最近的 assistant 消息，若带有 tool_calls 则说明当前 user 是工具结果回传
  for (let i = lastUserIndex - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'assistant') {
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        return true
      }
      // 找到 assistant 消息但没有 tool_calls，停止向前查找
      break
    }
    // 跳过 tool 角色消息（OpenAI tool result 消息）
    if (msg.role === 'tool') {
      return true
    }
  }

  return false
}

/**
 * 提取请求体中最后一条用户消息（含 isToolResultMessage 过滤）。
 *
 * 工具结果回传不是真实用户输入，会被跳过。
 * 适用于 content-plugin / content-security 的安全审核场景。
 */
export const extractLastUserMessage = (body: any): NormalizedMessage[] => {
  if (!body || typeof body !== 'object') return []

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const lastMessage = body.messages[body.messages.length - 1]
    const normalized = normalizeMessage(lastMessage, 'openai')
    // 只审核 user 消息，跳过 system / assistant 消息
    if (normalized.role !== 'user') {
      return []
    }
    if (normalized.content.length === 0) {
      return []
    }
    // 工具结果回传不是真实用户输入，跳过输入送审
    const lastUserIndex = body.messages.length - 1
    if (isToolResultMessage(body.messages, lastUserIndex)) {
      return []
    }
    return [normalized]
  }

  // 旧版 Completion API：prompt 字段
  if (typeof body.prompt === 'string') return [{ role: 'user', content: body.prompt }]
  // 自定义 API：input 字段
  if (typeof body.input === 'string') return [{ role: 'user', content: body.input }]

  return []
}

/**
 * 提取请求体中最后一条用户消息（不含 isToolResultMessage 过滤）。
 *
 * 保持 pcmgr-ai-security 的原有行为：不跳过工具结果回传。
 * 适用于 pcmgr-ai-security 的 Prompt 安全检测场景。
 */
export const robustExtractLastUserMessage = (body: any): NormalizedMessage[] => {
  if (!body || typeof body !== 'object') return []

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const messages = body.messages
    const lastMessage = messages[messages.length - 1]
    const normalized = normalizeMessage(lastMessage, 'openai')

    if (normalized.role !== 'user') return []
    if (normalized.content.length > 0) return [normalized]
    return []
  }

  if (typeof body.prompt === 'string') return [{ role: 'user', content: body.prompt }]
  if (typeof body.input === 'string') return [{ role: 'user', content: body.input }]
  return []
}

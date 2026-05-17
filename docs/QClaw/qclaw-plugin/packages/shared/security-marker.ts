/**
 * shared/security-marker.ts — 安全标记注入公共工具函数
 *
 * 从 content-plugin 提取的基础版安全标记注入逻辑。
 * pcmgr-ai-security 有自己的增强版本（支持 DecisionType + [message_id:...] 后缀保留），
 * 此处仅提供最通用的基础版本。
 */

/**
 * 基础版安全标记注入（字符串替换/追加 + 数组递归）。
 *
 * - blocked=true: 完全替换内容为 securityReason（LLM 只看到安全拦截指令）
 * - blocked=false: 追加 securityReason 到原始内容后
 * - 数组格式（OpenAI 多模态）：递归处理每个 type=text 的部分
 *
 * @param content 原始消息内容（string | array | 其他）
 * @param securityReason 安全拦截/标记原因文本
 * @param blocked 是否完全阻断（true=替换，false=追加）
 * @returns 处理后的内容
 */
export const injectSecurityMarkerBase = (
  content: any,
  securityReason: string,
  blocked: boolean,
): any => {
  if (typeof content === 'string') {
    if (blocked) {
      // BLOCK：完全替换，LLM 只看到安全拦截指令
      return securityReason
    }
    // MARK：追加到原始内容后
    return `${content}\n${securityReason}`
  }

  if (Array.isArray(content)) {
    // OpenAI 多模态格式：递归处理每个 type=text 的部分
    return content.map((part: any) => {
      if (part.type === 'text' && typeof part.text === 'string') {
        return {
          ...part,
          text: injectSecurityMarkerBase(part.text, securityReason, blocked),
        }
      }
      // 非文本部分（图片、音频等）保持不变
      return part
    })
  }

  // 其他类型（null、object 等）保持不变
  return content
}

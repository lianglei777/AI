/**
 * Text sanitization for auto-memory pipeline.
 * 移植自 memory-tencentdb/src/utils/sanitize.ts 的核心逻辑。
 *
 * 作用：清除框架注入的元数据块、时间戳、媒体标记等噪音，
 *       确保 extractTurnsFromMessages 提取到的是用户真实发言。
 */

/**
 * 清洗文本：移除注入标签、元数据、时间戳、媒体标记等。
 *
 * 在 extractMessageContent 中调用，确保提取到的 user/assistant 文本
 * 是干净的用户真实内容，而非框架注入的 UI 元数据。
 */
export function sanitizeText(text: string): string {
  let cleaned = text

  // 移除 Skill 选择标记（¥¥[User has selected the following skills ...]¥¥）
  cleaned = cleaned.replace(/¥¥\[User has selected[\s\S]*?\]¥¥\s*/g, '')

  // 移除框架注入的记忆上下文标签（防止反馈循环）
  cleaned = cleaned.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/g, '')
  cleaned = cleaned.replace(/<user-persona>[\s\S]*?<\/user-persona>/g, '')
  cleaned = cleaned.replace(/<relevant-scenes>[\s\S]*?<\/relevant-scenes>/g, '')
  cleaned = cleaned.replace(/<scene-navigation>[\s\S]*?<\/scene-navigation>/g, '')

  // ★★★ 核心修复：移除框架注入的入站元数据块 ★★★
  // 这些是 "Sender (untrusted metadata):\n```json\n...\n```" 块，
  // 框架在用户消息前 prepend 的 UI 元数据。
  // 正是导致 "广州旅游" 对话没被记录的根因！
  cleaned = cleaned.replace(
    /(?:Conversation info|Sender|Thread starter|Replied message|Forwarded message context|Chat history since last reply)\s*\(untrusted[\s\S]*?\):\s*```json\s*[\s\S]*?```/g,
    '',
  )

  // 移除遗留的会话元数据 JSON 块
  cleaned = cleaned.replace(/```json\s*\{[\s\S]*?"session[\s\S]*?\}\s*```/g, '')

  // 移除框架回复指令标记：[[reply_to_current]], [[reply_to_xxx]] 等
  cleaned = cleaned.replace(/\[\[reply_to[^\]]*\]\]\s*/g, '')

  // 移除行首时间戳，如 "[Tue 2026-03-24 03:48 UTC]"
  cleaned = cleaned.replace(/^\[[\w\d\-:+ ]+\]\s*/gm, '')

  // 移除网关媒体附件标记：[media attached: /path/to/file.png (image/png)]
  cleaned = cleaned.replace(/\[media attached:[^\]]*\]\s*/g, '')

  // 移除网关图片回复指令（"To send an image back..."）
  cleaned = cleaned.replace(
    /To send an image back,[\s\S]*?(?:Keep caption in the text body\.)\s*/g,
    '',
  )

  // 移除 System 时间戳执行完成块
  cleaned = cleaned.replace(/^System:\s*\[[\s\S]*?$/gm, '')

  // 移除内联 base64 图片数据 URI
  cleaned = cleaned.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/gi, '')

  // 移除 null 字符 + 压缩多余空白
  cleaned = cleaned.replace(/\0/g, '').replace(/\n{3,}/g, '\n\n').trim()

  return cleaned
}

/** 框架内部噪音消息检测 — 这些消息不应被捕获为用户真实发言 */
export function isFrameworkNoise(text: string): boolean {
  const t = text.trim()

  if (t === '(session bootstrap)') return true
  if (t.startsWith('A new session was started via')) return true
  if (/^✅\s*New session started/.test(t)) return true
  if (t.startsWith('Pre-compaction memory flush')) return true
  if (/^NO_REPLY\s*$/.test(t)) return true

  // 心跳检查消息（openclaw 定时发送的存活探测）
  if (t.startsWith('Read HEARTBEAT.md if it exists')) return true
  if (/^HEARTBEAT_OK\b/.test(t)) return true
  if (/heartbeat.?(poll|file|check)|HEARTBEAT_OK|HEARTBEAT\.md/i.test(t)) return true

  // cron / 定时任务 / scheduled reminder（匹配所有 [cron:xxx 格式）
  if (/^\[cron:/.test(t)) return true
  if (t.startsWith('A scheduled reminder has been triggered')) return true

  // 子 agent / runtime context 注入
  if (t.startsWith('[Subagent Context]')) return true
  if (t.startsWith('OpenClaw runtime context')) return true
  if (t.startsWith('sourceSession=')) return true

  // auto-memory / consolidator 自身的 prompt（防止被下一轮提取捕获）
  if (t.startsWith('你是一个工作记录和用户画像提取器')) return true
  if (t.startsWith('你是一个长期记忆提炼器')) return true
  if (t.startsWith('# System Prompt: Memory Consolidation')) return true

  return false
}

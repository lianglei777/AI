/**
 * queue-guard: LLM 请求检测（纯函数，可独立测试）
 */

/**
 * 判断一个 fetch 请求是否为需要排队的 LLM 请求
 * 依据：请求体为 JSON 且同时包含 model 字段和 messages 数组，且满足以下任一 URL / model 规则：
 *   1. URL 前缀匹配 QCLAW_LLM_BASE_URL（内置 provider）
 *   2. URL 未命中时，model 为 'modelroute' 或以 'pool-' 开头（大小写不敏感）
 * 注意：OpenClaw 内部的后处理请求（如 session 管理）只有 messages 没有 model，不应被拦截
 *
 * @param url                 请求 URL
 * @param body                解析后的请求体
 * @param builtinLlmBaseUrl   内置 provider URL 前缀（从环境变量获取，精确匹配）
 */
export function isLLMRequest(url: string, body: unknown, builtinLlmBaseUrl: string): boolean {
  if (!body || typeof body !== 'object') return false
  const obj = body as Record<string, unknown>
  if (typeof obj.model !== 'string' || !Array.isArray(obj.messages) || obj.messages.length === 0) {
    return false
  }

  // 规则 1：URL 精确匹配内置 provider
  if (builtinLlmBaseUrl && url.startsWith(builtinLlmBaseUrl)) return true

  // 规则 2：URL 未命中 → model 关键词兜底（覆盖 QCLAW_LLM_BASE_URL 未注入 / 误改等场景）
  const model = obj.model.toLowerCase()
  if (model === 'modelroute') return true
  if (model.startsWith('pool-')) return true

  return false
}

/**
 * 尝试从 fetch 的 options.body 中解析 JSON
 */
export function tryParseBody(rawBody: BodyInit | null | undefined): Record<string, unknown> | null {
  if (!rawBody) return null

  let rawStr: string | undefined
  if (typeof rawBody === 'string') {
    rawStr = rawBody
  } else if (rawBody instanceof Uint8Array || rawBody instanceof ArrayBuffer) {
    rawStr = new TextDecoder().decode(rawBody)
  }

  if (!rawStr) return null

  try {
    return JSON.parse(rawStr) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 构造「排队被中止」时返回的 LLM 响应（避免真实请求继续发出）。
 * 同时兼容流式（SSE）和非流式 ChatCompletion 格式。
 */
export function buildAbortedLlmResponse(jsonBody: Record<string, unknown>, message: string): Response {
  const isStream = jsonBody.stream === true
  const fakeModel = (jsonBody.model as string) || 'unknown'
  const fakeId = `chatcmpl-qg-abort-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)

  if (isStream) {
    // 流式请求：返回 SSE 格式的模拟正常响应
    const chunks = [
      `data: ${JSON.stringify({
        id: fakeId,
        object: 'chat.completion.chunk',
        created,
        model: fakeModel,
        choices: [
          { index: 0, delta: { role: 'assistant', content: message }, finish_reason: null },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: fakeId,
        object: 'chat.completion.chunk',
        created,
        model: fakeModel,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`,
      `data: [DONE]\n\n`,
    ]
    const body = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    })
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  // 非流式请求：返回标准 ChatCompletion 格式的模拟正常响应
  return new Response(
    JSON.stringify({
      id: fakeId,
      object: 'chat.completion',
      created,
      model: fakeModel,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: message },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  )
}

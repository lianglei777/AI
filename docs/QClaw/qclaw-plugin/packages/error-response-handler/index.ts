/**
 * error-response-handler — HTTP 错误响应翻译
 *
 * 当 LLM 请求返回 HTTP 4xx/5xx 错误码（Token 耗尽、限流、服务不可用等），
 * 将错误码转换为标准 SSE 伪响应流中的友好文案，
 * 确保外部渠道（微信、企微、QQ、飞书、钉钉、元宝）能收到友好的错误提示，
 * 而不是静默无响应。
 *
 * 仅处理 HTTP 错误码翻译，不处理网络异常（由上层负责）。
 *
 * 实现方式：注册一个低 priority 的 FetchMiddleware，
 * 在 onResponse 阶段（洋葱模型逆序，最外层兜底）检测 HTTP 错误码。
 *
 * 错误提示文案通过定时器从后端动态拉取，间隔为 6 小时 + 0~30 分钟随机偏移
 * （避免多实例同时请求雪崩）。拉取失败时 fallback 到本地静态数据。
 */

import type {
  QClawPackage,
  QClawContext,
  FetchMiddleware,
  FetchResponseContext,
  QClawLogger,
} from '../../core/types.js'
import type { TelemetryReporter } from '../../core/reporter-types.js'
import { REPORT_CONST } from '../../core/reporter-constants.js'

// ─── 后端拉取配置 ───

const ERROR_MESSAGES_API_URL = 'https://jprx.sparta.html5.qq.com/data/4232/forward'

/** 定时拉取基础间隔：6 小时（毫秒） */
const FETCH_BASE_INTERVAL_MS = 6 * 60 * 60 * 1000

/** 定时拉取随机偏移上限：30 分钟（毫秒） */
const FETCH_RANDOM_OFFSET_MS = 30 * 60 * 1000

/** 单次拉取超时：10 秒 */
const FETCH_TIMEOUT_MS = 10_000

/** 默认兜底文案模板（仅在远程拉取的 errorMessages 中无对应状态码时使用） */
const DEFAULT_ERROR_MSG = (status: number): string => `服务异常(${status})，请稍后重试`

// ─── 运行时可变的错误提示映射（由远程动态拉取填充） ───

let errorMessages: Record<number, string> = {}

/** 模块级 logger 引用，setup 时赋值，teardown 时使用 */
let moduleLogger: QClawLogger | null = null

// ─── 定时拉取逻辑 ───

/** 定时器句柄，teardown 时清理 */
let refreshTimerHandle: ReturnType<typeof setTimeout> | null = null

/**
 * 计算下一次拉取的间隔：6h 固定 + 0~30min 随机偏移
 */
function getNextRefreshInterval(): number {
  const randomOffset = Math.floor(Math.random() * FETCH_RANDOM_OFFSET_MS)
  return FETCH_BASE_INTERVAL_MS + randomOffset
}

/**
 * 从后端拉取错误提示配置。
 *
 * @param originalFetch - 绕过 FetchChain 的原始 fetch（避免被自己的中间件拦截）
 * @param logger - 日志器
 * @returns 是否拉取成功
 */
async function fetchRemoteErrorMessages(
  originalFetch: typeof globalThis.fetch,
  logger: QClawLogger,
  reporter: TelemetryReporter,
): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    const response = await originalFetch(ERROR_MESSAGES_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ biz_key: 'http_code_msg' }),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      logger.warn(
        `Remote fetch failed with HTTP ${response.status}, keeping current messages`,
      )
      reporter.report(REPORT_CONST.PLUGIN, {
        module_id: 'ErrorHandler',
        component_id: 'Config_Fetch_Failed',
        event_code: 'remote_fetch',
        action_type: 'config_fetch_failed',
        action_status: 'fail',
        statistics: {
          reason: 'http_error',
          http_status: response.status,
          url: ERROR_MESSAGES_API_URL,
        },
      })
      return false
    }

    const data: unknown = await response.json()

    // 从 resp.data.value 中提取 { statusCode: message } 映射
    const valueObj = (data as Record<string, unknown>)?.resp
      && ((data as Record<string, unknown>).resp as Record<string, unknown>)?.data
      && (((data as Record<string, unknown>).resp as Record<string, unknown>).data as Record<string, unknown>)?.value

    if (typeof valueObj !== 'object' || valueObj === null || Array.isArray(valueObj)) {
      logger.warn('Remote data format invalid, keeping current messages')
      reporter.report(REPORT_CONST.PLUGIN, {
        module_id: 'ErrorHandler',
        component_id: 'Config_Fetch_Failed',
        event_code: 'remote_fetch',
        action_type: 'config_fetch_failed',
        action_status: 'fail',
        statistics: { reason: 'invalid_format', url: ERROR_MESSAGES_API_URL },
      })
      return false
    }

    const parsed: Record<number, string> = {}
    for (const [key, value] of Object.entries(valueObj as Record<string, unknown>)) {
      const code = Number(key)
      if (!Number.isNaN(code) && typeof value === 'string') {
        parsed[code] = value
      }
    }

    if (Object.keys(parsed).length === 0) {
      logger.warn('Remote data is empty, keeping current messages')
      reporter.report(REPORT_CONST.PLUGIN, {
        module_id: 'ErrorHandler',
        component_id: 'Config_Fetch_Failed',
        event_code: 'remote_fetch',
        action_type: 'config_fetch_failed',
        action_status: 'fail',
        statistics: { reason: 'empty_data', url: ERROR_MESSAGES_API_URL },
      })
      return false
    }

    errorMessages = parsed
    logger.info(
      `Error messages updated from remote, ${Object.keys(parsed).length} entries loaded`,
    )
    return true
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    logger.error(`Remote fetch error: ${detail}, keeping current messages`)
    reporter.report(REPORT_CONST.PLUGIN, {
      module_id: 'ErrorHandler',
      component_id: 'Config_Fetch_Failed',
      event_code: 'remote_fetch',
      action_type: 'config_fetch_failed',
      action_status: 'fail',
      statistics: {
        reason: 'exception',
        error_message: detail,
        url: ERROR_MESSAGES_API_URL,
      },
    })
    return false
  }
}

/**
 * 启动定时刷新循环（非 setInterval，每轮重新计算随机间隔）
 */
function scheduleNextRefresh(
  originalFetch: typeof globalThis.fetch,
  logger: QClawLogger,
  reporter: TelemetryReporter,
): void {
  const interval = getNextRefreshInterval()
  logger.info(
    `Next refresh scheduled in ${Math.round(interval / 60_000)} minutes`,
  )

  refreshTimerHandle = setTimeout(async () => {
    await fetchRemoteErrorMessages(originalFetch, logger, reporter)
    // 无论成功与否，继续调度下一轮
    scheduleNextRefresh(originalFetch, logger, reporter)
  }, interval)
}

// ─── 错误来源识别辅助函数 ───

/**
 * 尝试从上游响应 body 中提取 error.message。
 *
 * 上游服务端错误 body 格式：
 * { "error": { "message": "请求过于频繁，请稍后重试", "type": "...", "code": "..." } }
 *
 * @param bodyText - 响应 body 文本
 * @returns 提取到的 message，或 null
 */
function tryExtractUpstreamMessage(bodyText: string): string | null {
  try {
    const data = JSON.parse(bodyText) as Record<string, unknown>
    const errorObj = data?.error as Record<string, unknown> | undefined
    if (errorObj && typeof errorObj.message === 'string' && errorObj.message.length > 0) {
      return errorObj.message
    }
  } catch {
    // 非 JSON 或解析失败，返回 null
  }
  return null
}

/**
 * 尝试解析 Auth Gateway 本地错误的 code 和 reason。
 *
 * Auth Gateway 本地错误 body 格式：
 * { "error": { "code": "9xxx", "message": "...", "source": "gateway", ... } }
 *
 * @param bodyText - 响应 body 文本
 * @returns 解析结果，或 null（非 gateway 错误）
 */
function tryParseGatewayError(bodyText: string): { code: number; message: string; reason?: string } | null {
  try {
    const data = JSON.parse(bodyText) as Record<string, unknown>
    const errorObj = data?.error as Record<string, unknown> | undefined
    if (!errorObj || errorObj.source !== 'gateway') {
      return null
    }
    const code = Number(errorObj.code)
    if (Number.isNaN(code)) {
      return null
    }
    return {
      code,
      message: typeof errorObj.message === 'string' ? errorObj.message : '',
      reason: typeof errorObj.reason === 'string' ? errorObj.reason : undefined,
    }
  } catch {
    // 非 JSON 或解析失败
  }
  return null
}

// ─── 判断请求的 API 类型 ───

function toUrlString(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input.toString()
}

function isAnthropicMessagesUrl(input: RequestInfo | URL): boolean {
  return toUrlString(input).includes('/v1/messages')
}

function isOpenAIUrl(input: RequestInfo | URL): boolean {
  const url = toUrlString(input)
  return url.includes('/chat/completions') || url.includes('/v1/completions')
}

// ─── 构造标准 SSE 伪响应 ───

/**
 * 将文本包装为 SSE 格式的 Response。
 *
 * 根据请求 URL 路径判断 API 类型：
 * - /v1/messages → Anthropic message 格式（pi-ai 的 anthropic-messages 类型期望此格式）
 * - /chat/completions / /v1/completions → OpenAI chat.completion.chunk 格式
 *
 * 如果格式不匹配，pi-ai 在解析 SSE 流时会失败，抛出 "request ended without sending any chunks"。
 */
function buildSseErrorResponse(text: string, input: RequestInfo | URL): Response {
  if (isAnthropicMessagesUrl(input)) {
    // Anthropic Messages SSE 格式
    //
    // pi-ai SDK 解析流程（@mariozechner/pi-ai → anthropic.js）：
    //   1. message_start       → 初始化 output（content 数组为空）
    //   2. content_block_start  → push 空 block（text: ""），忽略 content_block.text
    //   3. content_block_delta  → block.text += delta.text（唯一写入文本的途径）
    //   4. content_block_stop   → push text_end 事件
    //   5. message_delta        → 更新 stop_reason 和 usage
    //   6. message_stop         → for-await 结束后 SDK 自动 push { type: "done" }

    const requestId = `error-handler-${Date.now()}`

    const events = [
      // 1. message_start
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: requestId,
            type: 'message',
            role: 'assistant',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
      },
      // 2. content_block_start（初始化空 text block）
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
      // 3. content_block_delta（**传递实际文本**）
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: text },
        },
      },
      // 4. content_block_stop
      {
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: 0 },
      },
      // 5. message_delta（提供 stop_reason + usage）
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1, input_tokens: 0 },
        },
      },
      // 6. message_stop（触发 for-await 结束）
      {
        event: 'message_stop',
        data: { type: 'message_stop' },
      },
    ]

    const sseBody = events
      .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
      .join('')

    return new Response(new TextEncoder().encode(sseBody), {
      status: 200,
      statusText: 'OK',
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  }

  // OpenAI chat.completion.chunk 格式（默认）
  const sseChunk = JSON.stringify({
    id: `error-handler-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'error-handler',
    choices: [{
      index: 0,
      delta: { role: 'assistant', content: text },
      finish_reason: 'stop',
    }],
  })
  const sseBody = `data: ${sseChunk}\n\ndata: [DONE]\n\n`

  return new Response(new TextEncoder().encode(sseBody), {
    status: 200,
    statusText: 'OK',
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}

// ─── FetchMiddleware 工厂 ───

function createErrorResponseMiddleware(logger: QClawLogger, reporter: TelemetryReporter): FetchMiddleware {
  return {
    id: 'error-response-handler',

    /**
     * priority 50：数字小 → onRequest 先执行、onResponse 后执行（洋葱模型逆序）。
     *
     * 在 onResponse 阶段，priority 50 排在 content-plugin(200) 和
     * pcmgr-ai-security(250) 之后执行，作为最外层兜底。
     * 如果上游中间件已经处理了错误（如 content-plugin 的 shortCircuit），
     * 则 response.ok 为 true，本中间件直接放行。
     */
    priority: 50,

    // 只拦截 LLM 聊天补全请求，避免干扰管家内部 API / 审核服务等请求
    match(input: RequestInfo | URL): boolean {
      return isOpenAIUrl(input) || isAnthropicMessagesUrl(input)
    },

    /**
     * onResponse：检测 HTTP 错误码，转为友好 SSE 响应
     *
     * 只处理 !response.ok（4xx / 5xx）的情况，2xx 直接放行。
     *
     * 错误来源识别策略：
     * 1. 检查 X-Error-Source header：
     *    - 'upstream'：错误来自上游服务，优先使用上游 error.message
     *    - 'gateway'：错误来自 Auth Gateway 本地代理
     * 2. 检查 body 中的 error.source 字段（兼容未设置 header 的场景）
     * 3. 都不匹配时，回退到基于 HTTP 状态码的静态文案
     *
     * SSE 格式根据请求 URL 自动适配：
     * - /v1/messages → Anthropic message 格式
     * - /chat/completions / /v1/completions → OpenAI chat.completion.chunk 格式
     */
    async onResponse(ctx: FetchResponseContext): Promise<Response> {
      const { response, input } = ctx
      const urlStr = toUrlString(input)

      // 2xx 正常响应，直接放行
      if (response.ok) {
        return response
      }

      const status = response.status
      const apiFormat = isAnthropicMessagesUrl(input) ? 'anthropic' : 'openai'

      console.log(
        `[qclaw-plugin:error-response-handler] [diag] onResponse HTTP_ERROR status=${status} apiFormat=${apiFormat} url=${urlStr.slice(0, 100)}`,
      )

      // 读取响应 body（clone 后读取，不影响原始 response）
      const responseBody = await response.clone().text().catch(() => '')

      // ── 错误来源识别与文案选择 ─────────────────────────────────
      const errorSource = response.headers.get('X-Error-Source') || ''
      let errorMsg: string
      let errorSourceLabel: string

      if (errorSource === 'upstream') {
        // 上游服务错误：优先使用上游返回的 error.message（服务端友好文案）
        const upstreamMsg = tryExtractUpstreamMessage(responseBody)
        errorMsg = upstreamMsg || errorMessages[status] || DEFAULT_ERROR_MSG(status)
        errorSourceLabel = 'upstream'
      } else {
        // 检查是否为 Auth Gateway 本地错误
        const gatewayError = tryParseGatewayError(responseBody)
        if (gatewayError) {
          // Auth Gateway 本地错误：直接使用 body 中的 message 字段（服务端已在 error-codes.ts 中统一定义文案）
          errorMsg = gatewayError.message || DEFAULT_ERROR_MSG(status)
          errorSourceLabel = 'gateway'
        } else {
          // 无法识别来源：回退到远程拉取的文案或默认文案
          // 仍然尝试从 body 中提取 error.message（兼容旧版上游响应）
          const upstreamMsg = tryExtractUpstreamMessage(responseBody)
          errorMsg = upstreamMsg || errorMessages[status] || DEFAULT_ERROR_MSG(status)
          errorSourceLabel = 'unknown'
        }
      }

      logger.warn(
        `HTTP ${status} detected on ${urlStr.slice(0, 100)}, ` +
        `source=${errorSourceLabel}, converting to ${apiFormat} SSE, text: "${errorMsg}"`,
      )

      // 提取上报所需的上下文信息
      const cpExtra = ctx.extra?._contentPlugin as any
      const reqHeaders = ctx.init?.headers
      // guid：优先从 content-plugin extra 取，兆底从请求 header X-GUID 取
      const guid = cpExtra?.guid || (() => {
        if (!reqHeaders) return ''
        if (reqHeaders instanceof Headers) return reqHeaders.get('X-GUID') || ''
        if (Array.isArray(reqHeaders)) {
          const entry = (reqHeaders as string[][]).find(([k]) => k?.toLowerCase() === 'x-guid')
          return entry?.[1] || ''
        }
        return (reqHeaders as Record<string, string>)['X-GUID'] || ''
      })()
      // uid：从 content-plugin extra 取（getExternalUid()）
      const uid = cpExtra?.uid || ''
      const sessionKey = cpExtra?.sessionKey || ''

      reporter.report(REPORT_CONST.INTERACTION_EVENT, {
        module_id: 'ErrorHandler',
        component_id: 'LLM_HTTP_Error',
        event_code: 'error_intercepted',
        action_type: 'http_error_to_sse',
        action_status: 'fail',
        statistics: {
          http_status: status,
          api_format: apiFormat,
          url: urlStr,
          error_message: errorMsg,
          error_source: errorSourceLabel,
          uid,
          guid,
          session_key: sessionKey,
          response_body: responseBody,
        },
      })

      return buildSseErrorResponse(errorMsg, input)
    },
  }
}

// ─── QClawPackage 定义 ───

const errorResponseHandler: QClawPackage = {
  id: 'error-response-handler',
  name: '错误响应处理',
  description: '将 HTTP 错误码转换为标准 SSE 响应，确保外部渠道能收到友好提示',

  async setup(ctx: QClawContext) {
    // 注册中间件
    ctx.registerFetchMiddleware(createErrorResponseMiddleware(ctx.logger, ctx.reporter))

    // 获取绕过 FetchChain 的原始 fetch（避免拉取配置时被自己的中间件拦截）
    const originalFetch = ctx.getOriginalFetch()

    // 启动时立即拉取一次远程配置
    // 保存 logger 引用供 teardown 使用
    moduleLogger = ctx.logger

    const success = await fetchRemoteErrorMessages(originalFetch, ctx.logger, ctx.reporter)
    if (!success) {
      ctx.logger.warn('Initial remote fetch failed, using local fallback data')
    }

    // 启动定时刷新循环
    scheduleNextRefresh(originalFetch, ctx.logger, ctx.reporter)

    ctx.logger.info('Initialized with dynamic refresh enabled')
  },

  teardown() {
    // 清理定时器
    if (refreshTimerHandle !== null) {
      clearTimeout(refreshTimerHandle)
      refreshTimerHandle = null
      moduleLogger?.info('Refresh timer cleared')
    }

    // 重置为空（下次 setup 时重新从远程拉取）
    errorMessages = {}
    moduleLogger = null
  },
}

export default errorResponseHandler

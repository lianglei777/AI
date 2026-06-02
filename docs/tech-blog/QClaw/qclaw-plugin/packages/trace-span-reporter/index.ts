/**
 * trace-span-reporter — Plugin 层 Span 采集与上报
 *
 * 通过 HookProxy 订阅 Agent 生命周期事件，即时上报 Span 到伽利略通道。
 *
 * 覆盖的 Span:
 *   - agent_loop           — 完整 Agent 执行周期
 *   - agent_turn           — 单轮 Agent 执行（LLM + 工具）
 *   - agent_llm_request    — 单次 LLM 调用（通过 tool 事件推断边界）
 *   - agent_tool_execution — 工具执行
 *
 * Hook 触发频率说明:
 *   - llm_input / llm_output: 每次 agent run 各触发 **一次**（汇总 hook）
 *   - before_tool_call / after_tool_call: 每次工具执行都触发
 *   - LLM 调用的边界通过 before_tool_call（LLM 返回 tool_call → 开始执行工具）
 *     和 after_tool_call（工具完成 → 下一次 LLM 开始）来推断
 *
 * 零侵入：
 *   - 所有 hook handler 内部 try-catch，不影响业务流程
 *   - 不修改 event/hookCtx，不 block，不改写 params
 *   - 上报失败静默忽略
 */

import type { QClawPackage, QClawContext, HookContext } from '../../core/types.js'
import { QClawReporter } from '../../core/reporter.js'
import { REPORT_URL } from '../../core/reporter-constants.js'
import type { RunState, TurnState, SpanData } from './types.js'
import {
  TRACE_REPORT_TOKEN,
  SPAN_NAMES,
  TRACE_EVENT_NAME,
  RUN_STATE_TTL_MS,
  RUN_STATE_CLEANUP_INTERVAL_MS,
  MAX_SPANS_PER_RUN,
  AGENT_END_REPORT_DELAY_MS,
} from './constants.js'

const LOG_TAG = '[trace-span-reporter]'

// ==================== 工具函数 ====================

/**
 * 生成 16 hex 字符的 span_id (W3C Trace Context 兼容)
 *
 * ⚠️ 与 packages/shared/src/trace/id-generator.ts#generateSpanId 同算法，修改时需同步更新。
 * Plugin 运行在 OpenClaw 子进程，无法直接 import @guanjia-openclaw/shared，因此本地复制。
 */
function generateSpanId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const array = new Uint8Array(8)
    crypto.getRandomValues(array)
    return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  return Math.random().toString(16).slice(2, 18).padEnd(16, '0')
}

/**
 * 从 trace_id 确定性派生根 Span 的 span_id（取前 16 hex）。
 *
 * ⚠️ 与 packages/shared/src/trace/id-generator.ts#deriveRootSpanId 同算法，修改时需同步更新。
 * UI 层 ui_msg_round 使用相同算法生成 span_id，使 agent_loop 无需跨进程传参即可建立父子关系。
 */
function deriveRootSpanId(traceId: string): string {
  return traceId.slice(0, 16)
}

// ==================== 模块级共享状态 ====================

/**
 * 进行中的 Agent Run 状态。
 * 模块级变量确保跨 agent 重新初始化共享（与 prompt-inspector 同模式）。
 */
const runs = new Map<string, RunState>()

/** sessionKey → runId 映射（处理打包版本中 before_agent_start 没有 runId 的场景） */
const sessionKeyToRunId = new Map<string, string>()

/**
 * conversationId 归一化 key → messageId 映射。
 * key 格式: `${channelId}:${conversationId去除JID后缀}`
 * message_received 写入，before_agent_start 消费后删除。
 */
const conversationIdToMessageId = new Map<string, string>()

/** conversationId 归一化 TTL（防止 message_received 没触发 agent 时泄漏） */
const CONVERSATION_MAP_TTL_MS = 60_000 // 60s

/** TTL 清理定时器（模块级单例，只启动一次） */
let cleanupTimer: ReturnType<typeof setInterval> | null = null

/** 独立 Reporter 实例（模块级单例，跨 setup 复用） */
let traceReporter: QClawReporter | null = null

// ==================== RunId 解析 ====================

/**
 * 解析 hook 中的 runId。
 * 优先级：hookCtx.runId > event.runId > sessionKey 映射 > sessionKey
 */
function resolveRunId(hookCtx: HookContext, event: Record<string, unknown>): string {
  const ctxRunId = (hookCtx as Record<string, unknown>).runId
  if (ctxRunId) return String(ctxRunId)
  if (event.runId) return String(event.runId)
  const sessionKey = String(hookCtx.sessionKey ?? '')
  const mapped = sessionKey ? sessionKeyToRunId.get(sessionKey) : undefined
  if (mapped) return mapped
  return sessionKey
}

// ==================== Turn 管理 ====================

/** 创建新的 TurnState */
function createTurn(parentSpanId: string, turnNumber: number): TurnState {
  return {
    turnSpanId: generateSpanId(),
    turnStartTime: Date.now(),
    turnNumber,
    llmRequestSpanId: null,
    llmRequestStartTime: null,
    pendingTools: new Map(),
    completedToolCount: 0,
  }
}

/** 安全追加 span + 即时上报 — 超过 MAX_SPANS_PER_RUN 后静默丢弃，防止极端场景内存膨胀 */
function appendSpan(run: RunState, span: SpanData): void {
  if (run.spans.length < MAX_SPANS_PER_RUN) {
    run.spans.push(span)
    reportSpanImmediate(run, span)
  }
}

/**
 * 结束当前 turn 的 llm_request span（如果有活跃的）。
 * 由 before_tool_call 调用——LLM 返回 tool_call 说明本轮 LLM 调用已结束。
 * 由 finalizeRunAndReport 调用——最后一轮 LLM 是 final answer 或错误，没有 tool_call 来结束它。
 */
function finalizeLlmRequest(
  run: RunState,
  turn: TurnState,
  endTime: number,
  endEvent?: RunState['endEvent'],
): void {
  if (!turn.llmRequestSpanId || !turn.llmRequestStartTime) return

  const isError = endEvent ? !endEvent.success : false

  appendSpan(run, {
    span_id: turn.llmRequestSpanId,
    parent_span_id: turn.turnSpanId,
    span_name: SPAN_NAMES.LLM_REQUEST,
    start_time: turn.llmRequestStartTime,
    end_time: endTime,
    duration_ms: endTime - turn.llmRequestStartTime,
    status: isError ? 'error' : 'ok',
    finish_reason: isError ? 'error' : 'complete',
    agent_request_id: turn.llmRequestSpanId,
    ...(run.llmModel ? { model: run.llmModel } : {}),
    ...(run.llmProvider ? { model_provider: run.llmProvider } : {}),
    turn_index: turn.turnNumber - 1,
    attributes: {
      'gen_ai.system': run.llmProvider ?? '',
      'gen_ai.request.model': run.llmModel ?? '',
      'gen_ai.response.model': run.llmModel ?? '',
    },
    ...(isError && endEvent?.error ? {
      error_type: 'LlmRequestError',
      error_source: 'agent',
      status_message: endEvent.error,
      error: {
        type: 'LlmRequestError',
        message: endEvent.error.slice(0, 1024),
      },
    } : {}),
  })

  turn.llmRequestSpanId = null
  turn.llmRequestStartTime = null
}

/** 结束当前 turn，生成 plugin_agent_turn span */
function finalizeTurn(
  run: RunState,
  turn: TurnState,
  endEvent?: RunState['endEvent'],
): void {
  const now = Date.now()
  const isError = endEvent ? !endEvent.success : false

  appendSpan(run, {
    span_id: turn.turnSpanId,
    parent_span_id: run.agentRunSpanId,
    span_name: SPAN_NAMES.AGENT_TURN,
    start_time: turn.turnStartTime,
    end_time: now,
    duration_ms: now - turn.turnStartTime,
    status: isError ? 'error' : 'ok',
    finish_reason: isError ? 'error' : 'complete',
    ...(turn.llmRequestSpanId ? { agent_request_id: turn.llmRequestSpanId } : {}),
    attributes: {
      turn_number: turn.turnNumber,
      tool_count: turn.completedToolCount,
    },
    ...(isError && endEvent?.error ? {
      error_type: 'AgentError',
      error_source: 'agent',
      status_message: endEvent.error,
      error: {
        type: 'AgentError',
        message: endEvent.error.slice(0, 1024),
      },
    } : {}),
  })
}

/**
 * 最终确定 Run：结束最后一个 turn，生成 agent_loop end span 并即时上报，清理状态。
 *
 * 由 llm_output（正常路径）或安全超时（llm_output 未到达）调用。
 * 各子 span（agent_turn / agent_llm_request / agent_tool_execution）已在产生时即时上报，
 * 此函数只负责收尾的 agent_loop end span + 状态清理。
 */
function finalizeRunAndReport(runId: string, run: RunState): void {
  // 幂等：防止 llm_output 和安全超时同时触发
  if (!runs.has(runId)) return

  // 清除安全超时定时器
  if (run.endTimer) {
    clearTimeout(run.endTimer)
    run.endTimer = undefined
  }

  const endData = run.endEvent
  if (!endData) return  // 不应发生，防御性检查

  // ---- 结束最后一个 turn 的 llm_request（最后一轮 LLM 是 final answer 或错误，没有 tool_call 来结束它） ----
  if (run.currentTurn) {
    finalizeLlmRequest(run, run.currentTurn, endData.endTime, endData)
    finalizeTurn(run, run.currentTurn, endData)
    run.currentTurn = null
  }

  // ---- 生成 agent_loop span ----
  const agentRunDuration = endData.durationMs != null
    ? endData.durationMs
    : endData.endTime - run.agentRunStartTime

  const agentRunSpan: SpanData = {
    span_id: run.agentRunSpanId,
    parent_span_id: deriveRootSpanId(run.runId),
    span_name: SPAN_NAMES.AGENT_LOOP,
    start_time: run.agentRunStartTime,
    end_time: endData.endTime,
    duration_ms: agentRunDuration,
    status: endData.success ? 'ok' : 'error',
    finish_reason: endData.success ? 'complete' : 'error',
    ...(run.llmModel ? { model: run.llmModel } : {}),
    ...(run.llmProvider ? { model_provider: run.llmProvider } : {}),
    trigger: run.trigger ?? 'user',
    attributes: {
      turn_count: run.turnCount,
      ...(run.llmProvider ? { 'gen_ai.system': run.llmProvider } : {}),
      ...(run.llmModel ? { 'gen_ai.request.model': run.llmModel } : {}),
      ...(run.llmUsage?.cacheRead ? { 'gen_ai.usage.cache_read_tokens': run.llmUsage.cacheRead } : {}),
      ...(run.llmUsage?.cacheWrite ? { 'gen_ai.usage.cache_write_tokens': run.llmUsage.cacheWrite } : {}),
    },
    ...(run.llmUsage?.input ? { input_tokens: run.llmUsage.input } : {}),
    ...(run.llmUsage?.output ? { output_tokens: run.llmUsage.output } : {}),
    ...(run.llmUsage?.total ? { total_tokens: run.llmUsage.total } : {}),
    ...(endData.error ? {
      error_type: 'AgentError',
      error_source: 'agent',
      status_message: endData.error,
      error: {
        type: 'AgentError',
        message: endData.error.slice(0, 1024),
      },
    } : {}),
  }

  appendSpan(run, agentRunSpan)

  // ---- 清理 ----
  runs.delete(runId)
  const sessionKey = run.sessionKey
  if (sessionKey && sessionKeyToRunId.get(sessionKey) === runId) {
    sessionKeyToRunId.delete(sessionKey)
  }
}

// ==================== 清理 ====================

function startCleanupTimer(): void {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [runId, run] of runs) {
      if (now - run.createdAt > RUN_STATE_TTL_MS) {
        runs.delete(runId)
      }
    }
    // sessionKeyToRunId 也需要清理：删除指向已不存在 run 的映射
    for (const [sessionKey, runId] of sessionKeyToRunId) {
      if (!runs.has(runId)) {
        sessionKeyToRunId.delete(sessionKey)
      }
    }
  }, RUN_STATE_CLEANUP_INTERVAL_MS)
  // 不阻止进程退出
  if (cleanupTimer && typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    cleanupTimer.unref()
  }
}

// ==================== 上报 ====================

/**
 * 即时上报单条 span。
 *
 * 每个 span 产生时立即上报，不再依赖 finalizeRunAndReport 批量上报。
 * 如果 agent 进程崩溃导致 agent_end 未触发，已上报的 span 不会丢失。
 *
 * @param overrides 可选覆盖字段（用于 agent_loop start span 覆盖 span_phase 等）
 */
function reportSpanImmediate(
  run: RunState,
  span: SpanData,
  overrides?: Record<string, unknown>,
): void {
  if (!traceReporter) return
  try {
    const record: Record<string, unknown> = {
      // ---- 链路追踪 ----
      trace_id: run.runId,
      span_id: span.span_id,
      parent_span_id: span.parent_span_id,
      span_name: span.span_name,

      // ---- 时间 ----
      start_time: span.start_time,
      end_time: span.end_time,
      duration_ms: span.duration_ms,

      // ---- 状态 ----
      status: span.status,
      ...(span.status_message ? { status_message: span.status_message } : {}),
      ...(span.finish_reason ? { finish_reason: span.finish_reason } : {}),
      span_phase: 'end',

      // ---- 错误分类 (顶层字段，便于 Galileo GROUP BY 聚合统计) ----
      ...(span.error_type ? { error_type: span.error_type } : {}),
      ...(span.error_code ? { error_code: span.error_code } : {}),
      ...(span.error_source ? { error_source: span.error_source } : {}),

      // ---- 业务关联 ----
      run_id: run.runId,
      session_key: run.sessionKey,
      ...(run.sessionId ? { session_id: run.sessionId } : {}),
      agent_id: run.agentId,
      ...(span.agent_request_id ? { agent_request_id: span.agent_request_id } : {}),

      // ---- 渠道标识 ----
      ...(run.senderChannelId ? { sender_channel_id: run.senderChannelId } : {}),

      // ---- 消息关联（用于串联 agent_message_receive span） ----
      ...(run.messageId ? { message_id: run.messageId } : {}),

      // ---- 环境 ----
      user_id: '',
      device_id: '',
      app_version: '',
      service_ns: 'client',

      // ---- 内核标识 ----
      backend: 'openclaw',

      // ---- 扩展属性 ----
      attributes: span.attributes,

      // ---- 模型信息（顶层字段） ----
      ...(span.model ? { model: span.model } : {}),
      ...(span.model_provider ? { model_provider: span.model_provider } : {}),

      // ---- 工具名称（顶层字段） ----
      ...(span.tool_name ? { tool_name: span.tool_name } : {}),

      // ---- 轮次索引（顶层字段） ----
      ...(span.turn_index != null ? { turn_index: span.turn_index } : {}),

      // ---- 触发来源（顶层字段） ----
      ...(span.trigger ? { trigger: span.trigger } : {}),

      // ---- token 消耗（顶层字段） ----
      ...(span.input_tokens != null ? { input_tokens: span.input_tokens } : {}),
      ...(span.output_tokens != null ? { output_tokens: span.output_tokens } : {}),
      ...(span.total_tokens != null ? { total_tokens: span.total_tokens } : {}),

      // ---- 错误详情 ----
      ...(span.error ? { error: span.error } : {}),

      // ---- 覆盖字段（用于 start span 等场景） ----
      ...overrides,
    }

    traceReporter.reportEvent(TRACE_EVENT_NAME, record)
  } catch {
    // 静默：不影响业务
  }
}

// ==================== QClawPackage ====================

const traceSpanReporter: QClawPackage = {
  id: 'trace-span-reporter',
  name: 'Trace Span Reporter',
  description: 'Plugin 层 Span 采集与上报（全链路可观测性 Phase 3）',

  setup(ctx: QClawContext): void {
    // ---- 初始化独立 Reporter（仅首次） ----
    if (!traceReporter) {
      traceReporter = new QClawReporter()
      traceReporter.init({
        logger: ctx.logger,
        openclawVersion: ctx.runtime.version,
        reportToken: TRACE_REPORT_TOKEN,
        hostUrl: REPORT_URL,
        env: process.env.BUILD_ENV === 'production' ? 'production' : (process.env.BUILD_ENV || 'production'),
      })
      const sharedParams = traceReporter.readSharedParams()
      traceReporter.setCommonParams({
        plugin_id: 'trace-span-reporter',
        platform: process.platform,
        ...(sharedParams.guid ? { guid: sharedParams.guid } : {}),
        ...(sharedParams.sessionId ? { sessionId: sharedParams.sessionId } : {}),
        ...(sharedParams.appVersion ? { app_version: sharedParams.appVersion } : {}),
        ...(sharedParams.appChannel ? { app_channel: sharedParams.appChannel } : {}),
      })
    }

    // ---- 启动 TTL 清理 ----
    startCleanupTimer()

    // ---- 注册 FetchMiddleware：注入 x-agent-request-id header ----
    // 通过请求头中的 x-run-id 查找对应 RunState，确保多 session 并发时不会交叉污染。
    ctx.registerFetchMiddleware({
      id: 'trace-span-header-injector',
      priority: 250,
      onRequest(fetchCtx) {
        try {
          // 从请求头提取 x-run-id（SDK 在发起 fetch 前已设置）
          const headers = fetchCtx.init?.headers
          let runId: string | undefined
          if (headers instanceof Headers) {
            runId = headers.get('x-run-id') ?? headers.get('x-qclaw-run-id') ?? undefined
          } else if (Array.isArray(headers)) {
            const entry = headers.find(([k]) => k.toLowerCase() === 'x-run-id' || k.toLowerCase() === 'x-qclaw-run-id')
            runId = entry?.[1]
          } else if (headers && typeof headers === 'object') {
            const rec = headers as Record<string, string>
            runId = rec['x-run-id'] ?? rec['X-Run-ID'] ?? rec['x-qclaw-run-id'] ?? rec['X-QClaw-Run-ID']
          }

          if (!runId) return Promise.resolve(fetchCtx)

          const run = runs.get(runId)
          const spanId = run?.currentTurn?.llmRequestSpanId
          if (!spanId) return Promise.resolve(fetchCtx)

          // 注入 x-agent-request-id header（与现有 headers 格式保持一致）
          if (headers instanceof Headers) {
            headers.set('x-agent-request-id', spanId)
          } else if (Array.isArray(headers)) {
            headers.push(['x-agent-request-id', spanId])
          } else if (headers && typeof headers === 'object') {
            (headers as Record<string, string>)['x-agent-request-id'] = spanId
          }
        } catch {
          // 静默：不影响业务请求
        }
        return Promise.resolve(fetchCtx)
      },
    })

    // ================================================================
    // before_agent_start (priority=100)
    // 创建 RunState + agent_loop span + 首个 agent_turn
    // ================================================================
    ctx.onHook('before_agent_start', async (event, hookCtx) => {
      try {
        const runId = resolveRunId(hookCtx, event)
        if (!runId) return
        const sessionKey = String(hookCtx.sessionKey ?? '')
        ctx.logger.info(`${LOG_TAG} before_agent_start | runId=${runId} sessionKey=${sessionKey} agentId=${String(hookCtx.agentId ?? '')}`)

        // 记录 sessionKey → runId 映射
        if (sessionKey) {
          sessionKeyToRunId.set(sessionKey, runId)
        }

        // 幂等：已存在则跳过
        if (runs.has(runId)) return

        const now = Date.now()
        const agentRunSpanId = generateSpanId()

        const run: RunState = {
          runId,
          sessionKey,
          agentId: String(hookCtx.agentId ?? ''),
          sessionId: String((hookCtx as Record<string, unknown>).sessionId ?? ''),
          trigger: (hookCtx as Record<string, unknown>).trigger as string | undefined,
          agentRunSpanId,
          agentRunStartTime: now,
          currentTurn: createTurn(agentRunSpanId, 1),
          turnCount: 1,
          spans: [],
          ended: false,
          createdAt: now,
        }

        runs.set(runId, run)

        // ---- senderChannelId: 直接从 before_agent_start hookCtx 读取 ----
        const hookChannelId = String((hookCtx as Record<string, unknown>).channelId ?? '')
        if (hookChannelId) {
          run.senderChannelId = hookChannelId
        }

        // ---- messageId: 从 conversationIdToMessageId 缓存中查找 ----
        if (hookChannelId && sessionKey) {
          // sessionKey 格式: "agent:<agentId>:<channelId>:<routingType>:<rawConversationId>"
          const segments = sessionKey.split(':')
          const rawConversationId = segments.length >= 5 ? segments.slice(4).join(':') : ''
          if (rawConversationId) {
            const normalizedKey = `${hookChannelId}:${rawConversationId}`
            const cachedMessageId = conversationIdToMessageId.get(normalizedKey)
            if (cachedMessageId) {
              run.messageId = cachedMessageId
              conversationIdToMessageId.delete(normalizedKey) // 消费后删除
            }
          }
        }

        // ---- 补偿上报：先发一条 span_phase='start' 的 agent_loop ----
        // 如果 agent_end 正常触发，后续会上报 span_phase='end' 覆盖；
        // 如果 agent 崩溃/异常退出导致 agent_end 未触发，至少有这条 start 记录。
        reportSpanImmediate(run, {
          span_id: agentRunSpanId,
          parent_span_id: deriveRootSpanId(runId),
          span_name: SPAN_NAMES.AGENT_LOOP,
          start_time: now,
          end_time: now,
          duration_ms: 0,
          status: 'ok',
          attributes: {},
        }, { span_phase: 'start' })

        // ---- 补偿上报：首个 agent_turn start ----
        reportSpanImmediate(run, {
          span_id: run.currentTurn!.turnSpanId,
          parent_span_id: agentRunSpanId,
          span_name: SPAN_NAMES.AGENT_TURN,
          start_time: now,
          end_time: now,
          duration_ms: 0,
          status: 'ok',
          turn_index: 0,
          attributes: { turn_number: 1 },
        }, { span_phase: 'start' })
      } catch (err) {
        ctx.logger.debug(`${LOG_TAG} before_agent_start error: ${String(err)}`)
      }
    }, { priority: 100 })

    // ================================================================
    // before_prompt_build (priority=100)
    // 记录 runId → 用户原始 query 映射关系（用于上报关联）
    // ================================================================
    ctx.onHook('before_prompt_build', async (event, hookCtx) => {
      try {
        const runId = resolveRunId(hookCtx, event as Record<string, unknown>)
        ctx.logger.info(
          `${LOG_TAG} before_prompt_build | runId=${runId} sessionKey=${String(hookCtx.sessionKey ?? '')} agentId=${String(hookCtx.agentId ?? '')} trigger=${String((hookCtx as Record<string, unknown>).trigger ?? '')} prompt=${String(event.prompt ?? '')}`,
        )
      } catch (err) {
        ctx.logger.debug(`${LOG_TAG} before_prompt_build error: ${String(err)}`)
      }
    }, { priority: 100 })

    // ================================================================
    // llm_input (priority=100)
    // 记录 LLM provider/model，创建首个 llm_request span
    //
    // 注意：llm_input 每次 agent run 只触发一次（在 prompt() 调用前）。
    // 后续轮次的 llm_request span 由 after_tool_call 创建。
    // ================================================================
    ctx.onHook('llm_input', async (event, hookCtx) => {
      try {
        const sessionKey = String(hookCtx.sessionKey ?? '')
        ctx.logger.info(`${LOG_TAG} llm_input | sessionKey=${sessionKey} provider=${String(event.provider ?? '')} model=${String(event.model ?? '')}`)

        // ---- runId 映射修正（同 prompt-inspector 逻辑） ----
        const realRunId = String((hookCtx as Record<string, unknown>).runId ?? event.runId ?? '')
        const mappedRunId = sessionKey ? sessionKeyToRunId.get(sessionKey) : undefined
        let runId = realRunId || mappedRunId || sessionKey
        if (!runId) return

        // rekey：打包版本中 before_agent_start 用 sessionKey 作为临时 runId
        if (realRunId && mappedRunId && realRunId !== mappedRunId && runs.has(mappedRunId)) {
          const existingRun = runs.get(mappedRunId)!
          existingRun.runId = realRunId
          runs.delete(mappedRunId)
          runs.set(realRunId, existingRun)
          runId = realRunId
          sessionKeyToRunId.set(sessionKey, realRunId)
        }

        const run = runs.get(runId)
        if (!run) return

        // ---- 记录 LLM 信息（Run 级别，所有 turn 共享） ----
        run.llmProvider = String(event.provider ?? '')
        run.llmModel = String(event.model ?? '')

        // ---- 为首个 turn 创建 llm_request span ----
        const turn = run.currentTurn
        if (turn && !turn.llmRequestSpanId) {
          turn.llmRequestSpanId = generateSpanId()
          turn.llmRequestStartTime = Date.now()

          // ---- 补偿上报：首个 agent_llm_request start ----
          reportSpanImmediate(run, {
            span_id: turn.llmRequestSpanId,
            parent_span_id: turn.turnSpanId,
            span_name: SPAN_NAMES.LLM_REQUEST,
            start_time: turn.llmRequestStartTime,
            end_time: turn.llmRequestStartTime,
            duration_ms: 0,
            status: 'ok',
            agent_request_id: turn.llmRequestSpanId,
            ...(run.llmModel ? { model: run.llmModel } : {}),
            ...(run.llmProvider ? { model_provider: run.llmProvider } : {}),
            turn_index: turn.turnNumber - 1,
            attributes: {},
          }, { span_phase: 'start' })
        }
      } catch (err) {
        ctx.logger.debug(`${LOG_TAG} llm_input error: ${String(err)}`)
      }
    }, { priority: 100 })

    // ================================================================
    // llm_output (priority=100)
    // 汇总 hook：补充 usage 数据到最后一个 llm_request span
    //
    // 注意：llm_output 每次 agent run 只触发一次（agent_end 之后）。
    // 它携带整个 run 的 usage 汇总，我们将其附加到最后一轮的
    // llm_request span（该 span 在 finalizeRunAndReport 中结束）。
    // ================================================================
    ctx.onHook('llm_output', async (event, hookCtx) => {
      try {
        const runId = resolveRunId(hookCtx, event)
        const run = runs.get(runId)
        ctx.logger.info(`${LOG_TAG} llm_output | runId=${runId} model=${String(event.model ?? '')} ended=${run?.ended ?? 'no-run'}`)
        if (!run) return

        // 记录 usage 汇总到 RunState，供 finalizeRunAndReport 写入 agent_loop span
        const usage = event.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } | undefined
        if (usage) {
          run.llmUsage = usage
        }
        if (event.model) {
          run.llmModel = String(event.model)
        }

        // ---- 如果 agent_end 已到达，立即触发最终上报 ----
        if (run.ended) {
          finalizeRunAndReport(runId, run)
        }
      } catch (err) {
        ctx.logger.debug(`${LOG_TAG} llm_output error: ${String(err)}`)
      }
    }, { priority: 100 })

    // ================================================================
    // before_tool_call (priority=100)
    // 1. 结束当前 turn 的 llm_request span（LLM 返回了 tool_call）
    // 2. 开始 plugin_tool_execution span
    // ================================================================
    ctx.onHook('before_tool_call', async (event, hookCtx) => {
      try {
        const runId = resolveRunId(hookCtx, event)
        const run = runs.get(runId)
        if (!run?.currentTurn) return

        const now = Date.now()
        const turn = run.currentTurn
        const toolName = String(event.toolName ?? event.name ?? '')
        const toolCallId = String(event.toolCallId ?? (hookCtx as Record<string, unknown>).toolCallId ?? '')
        ctx.logger.info(`${LOG_TAG} before_tool_call | runId=${runId} tool=${toolName} toolCallId=${toolCallId}`)

        // ---- 结束当前 turn 的 llm_request span ----
        // before_tool_call 意味着 LLM 已返回 tool_call，本轮 LLM 调用结束
        finalizeLlmRequest(run, turn, now)

        // ---- 开始 tool execution span ----
        const spanId = generateSpanId()
        const key = toolCallId || `${toolName}-${Date.now()}`

        turn.pendingTools.set(key, {
          spanId,
          toolName,
          startTime: now,
          toolCallId: toolCallId || undefined,
        })

        // ---- 补偿上报：先发一条 span_phase='start' 的 agent_tool_execution ----
        // 如果 after_tool_call 正常触发，后续会上报 span_phase='end' 覆盖；
        // 如果工具执行崩溃/超时导致 after_tool_call 未触发，至少有这条 start 记录。
        reportSpanImmediate(run, {
          span_id: spanId,
          parent_span_id: turn.turnSpanId,
          span_name: SPAN_NAMES.TOOL_EXECUTION,
          start_time: now,
          end_time: now,
          duration_ms: 0,
          status: 'ok',
          ...(turn.llmRequestSpanId ? { agent_request_id: turn.llmRequestSpanId } : {}),
          tool_name: toolName,
          turn_index: turn.turnNumber - 1,
          attributes: {
            'tool.call_id': toolCallId,
          },
        }, { span_phase: 'start' })
      } catch (err) {
        ctx.logger.debug(`${LOG_TAG} before_tool_call error: ${String(err)}`)
      }
    }, { priority: 100 })

    // ================================================================
    // after_tool_call (priority=100)
    // 1. 结束 plugin_tool_execution span
    // 2. 结束当前 turn，开始新 turn + 新 llm_request span
    //    （工具执行完毕后 SDK 会发起下一轮 LLM 调用）
    // ================================================================
    ctx.onHook('after_tool_call', async (event, hookCtx) => {
      try {
        const runId = resolveRunId(hookCtx, event)
        const run = runs.get(runId)
        if (!run?.currentTurn) return

        const toolName = String(event.toolName ?? event.name ?? '')
        const toolCallId = String(event.toolCallId ?? (hookCtx as Record<string, unknown>).toolCallId ?? '')
        ctx.logger.info(`${LOG_TAG} after_tool_call | runId=${runId} tool=${toolName} toolCallId=${toolCallId}`)
        const turn = run.currentTurn

        // ---- 查找匹配的 pending tool ----
        const key = toolCallId || findPendingToolKey(turn, toolName)
        const pending = key ? turn.pendingTools.get(key) : undefined

        const now = Date.now()
        const startTime = pending?.startTime ?? now
        const hasError = Boolean(event.error) || Boolean(event.blocked)
        const errorMessage = String(event.error ?? event.blockReason ?? '')

        const span: SpanData = {
          span_id: pending?.spanId ?? generateSpanId(),
          parent_span_id: turn.turnSpanId,
          span_name: SPAN_NAMES.TOOL_EXECUTION,
          start_time: startTime,
          end_time: now,
          duration_ms: event.durationMs != null ? Number(event.durationMs) : now - startTime,
          status: hasError ? 'error' : 'ok',
          finish_reason: hasError ? 'error' : 'complete',
          ...(turn.llmRequestSpanId ? { agent_request_id: turn.llmRequestSpanId } : {}),
          tool_name: toolName,
          turn_index: turn.turnNumber - 1,
          attributes: {
            'tool.call_id': toolCallId,
          },
          ...(hasError ? {
            error_type: event.blocked ? 'BlockedError' : 'ToolError',
            error_source: 'plugin',
            error: {
              type: event.blocked ? 'BlockedError' : 'ToolError',
              message: errorMessage.slice(0, 1024),
            },
          } : {}),
        }

        appendSpan(run, span)

        if (key) {
          turn.pendingTools.delete(key)
        }
        turn.completedToolCount++

        // ---- 如果当前 turn 没有更多 pending tool，结束当前 turn 并开始新 turn ----
        // 工具全部执行完毕 → SDK 会发起下一轮 LLM 调用
        if (turn.pendingTools.size === 0) {
          finalizeTurn(run, turn)
          run.turnCount++
          run.currentTurn = createTurn(run.agentRunSpanId, run.turnCount)
          // 开始新 turn 的 llm_request span（下一轮 LLM 即将开始）
          run.currentTurn.llmRequestSpanId = generateSpanId()
          run.currentTurn.llmRequestStartTime = now

          // ---- 补偿上报：新 agent_turn start ----
          reportSpanImmediate(run, {
            span_id: run.currentTurn.turnSpanId,
            parent_span_id: run.agentRunSpanId,
            span_name: SPAN_NAMES.AGENT_TURN,
            start_time: now,
            end_time: now,
            duration_ms: 0,
            status: 'ok',
            turn_index: run.currentTurn.turnNumber - 1,
            attributes: { turn_number: run.currentTurn.turnNumber },
          }, { span_phase: 'start' })

          // ---- 补偿上报：新 agent_llm_request start ----
          reportSpanImmediate(run, {
            span_id: run.currentTurn.llmRequestSpanId,
            parent_span_id: run.currentTurn.turnSpanId,
            span_name: SPAN_NAMES.LLM_REQUEST,
            start_time: now,
            end_time: now,
            duration_ms: 0,
            status: 'ok',
            agent_request_id: run.currentTurn.llmRequestSpanId,
            ...(run.llmModel ? { model: run.llmModel } : {}),
            ...(run.llmProvider ? { model_provider: run.llmProvider } : {}),
            turn_index: run.currentTurn.turnNumber - 1,
            attributes: {},
          }, { span_phase: 'start' })
        }
      } catch (err) {
        ctx.logger.debug(`${LOG_TAG} after_tool_call error: ${String(err)}`)
      }
    }, { priority: 100 })

    // ================================================================
    // agent_end (priority=900)
    // 标记 Run 结束，延迟上报等待 llm_output 补全 usage 数据
    //
    // 时序说明：OpenClaw 引擎中 agent_end 先于 llm_output 触发。
    //
    // 策略：
    // 1. 标记 run.ended = true，缓存结束事件数据
    // 2. 不 finalize 最后一个 turn（保留 currentTurn 供 finalizeRunAndReport 处理）
    // 3. 启动安全超时定时器（AGENT_END_REPORT_DELAY_MS），
    //    如果 llm_output 迟迟不来，超时后仍然上报
    // 4. llm_output 到达后检测 run.ended，触发 finalizeRunAndReport
    // ================================================================
    ctx.onHook('agent_end', async (event, hookCtx) => {
      try {
        const runId = resolveRunId(hookCtx, event)
        const run = runs.get(runId)
        if (!run) return
        ctx.logger.info(`${LOG_TAG} agent_end | runId=${runId} sessionKey=${String(hookCtx.sessionKey ?? '')} success=${String(event.success ?? true)} error=${String(event.error ?? '').slice(0, 200)}`)

        const now = Date.now()

        // ---- 标记结束，缓存事件数据 ----
        run.ended = true
        run.endEvent = {
          success: Boolean(event.success ?? true),
          error: event.error ? String(event.error) : undefined,
          durationMs: event.durationMs != null ? Number(event.durationMs) : undefined,
          endTime: now,
        }

        // ---- 安全超时：如果 llm_output 未在限定时间内到达，直接上报 ----
        run.endTimer = setTimeout(() => {
          finalizeRunAndReport(runId, run)
        }, AGENT_END_REPORT_DELAY_MS)
        // 不阻止进程退出
        if (run.endTimer && typeof run.endTimer === 'object' && 'unref' in run.endTimer) {
          run.endTimer.unref()
        }
      } catch (err) {
        ctx.logger.debug(`${LOG_TAG} agent_end error: ${String(err)}`)
      }
    }, { priority: 900 })

    // ================================================================
    // message_received (priority=100)
    // 即时上报 agent_message_receive span（用户发送 → OpenClaw 收到）
    //
    // event.metadata.messageId 即 runId（trace_id），可直接用于构建 span 父子关系。
    // ================================================================
    ctx.onHook('message_received', async (event, hookCtx) => {
      try {
        if (!traceReporter) return

        const channelId = String((hookCtx as Record<string, unknown>).channelId ?? '')
        const conversationId = String((hookCtx as Record<string, unknown>).conversationId ?? '')
        const sessionId = String((hookCtx as Record<string, unknown>).sessionId ?? '')
        const messageId = String((event.metadata as Record<string, any>).messageId ?? '')
        ctx.logger.info(`${LOG_TAG} message_received | channelId=${channelId} conversationId=${conversationId} messageId=${messageId}`)
        if (!messageId) return

        // ---- 缓存 conversationId → messageId（供 before_agent_start 消费） ----
        if (channelId && conversationId) {
          const normalizedKey = `${channelId}:${conversationId.split('@')[0]}`
          conversationIdToMessageId.set(normalizedKey, messageId)
          // TTL 自清理（防止永不触发 agent 的场景）
          setTimeout(() => conversationIdToMessageId.delete(normalizedKey), CONVERSATION_MAP_TTL_MS)
        }

        const receiveTime = Date.now()
        const sendTime = typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
          ? Number(event.timestamp)
          : receiveTime
        const durationMs = Math.max(0, receiveTime - sendTime)
        const spanId = generateSpanId()

        const record: Record<string, unknown> = {
          trace_id: messageId,
          span_id: spanId,
          parent_span_id: deriveRootSpanId(messageId),
          span_name: SPAN_NAMES.MESSAGE_RECEIVE,
          start_time: sendTime,
          end_time: receiveTime,
          duration_ms: durationMs,
          status: 'ok',
          span_phase: 'end',
          ...(sessionId ? { session_id: sessionId } : {}),
          ...(channelId ? { sender_channel_id: channelId } : {}),
          service_ns: 'client',
          attributes: {
            sender_channel_id: channelId,
          },
        }

        traceReporter.reportEvent(TRACE_EVENT_NAME, record)
      } catch (err) {
        ctx.logger.debug(`${LOG_TAG} message_received error: ${String(err)}`)
      }
    }, { priority: 100 })

    ctx.logger.info(`${LOG_TAG} registered (${runs.size} active runs carried over)`)
  },
}

// ==================== 辅助 ====================

/**
 * 在 pendingTools 中按 toolName 查找（toolCallId 不可用时的 fallback）
 */
function findPendingToolKey(turn: TurnState, toolName: string): string | undefined {
  for (const [key, pending] of turn.pendingTools) {
    if (pending.toolName === toolName) return key
  }
  return undefined
}

export default traceSpanReporter

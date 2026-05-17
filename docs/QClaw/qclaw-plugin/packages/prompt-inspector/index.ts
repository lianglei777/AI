/**
 * packages/prompt-inspector/index.ts — Prompt Inspector QClawPackage
 *
 * 开发调试工具：捕获并展示完整的 Run 级别 Prompt/Response 流程。
 *
 * 三层门控：
 * 1. 环境变量 QCLAW_PROMPT_INSPECTOR=1（Electron 端仅非 production 注入）
 * 2. ConfigCenter enabled 运行时开关
 * 3. 窗口状态（打开 = 启用，关闭 = 禁用）
 *
 * 数据采集（Phase 4）：
 * - before_prompt_build hook（priority=900）：采集 PromptBuildEvent（含 Prompt 修改链审计日志）
 * - llm_input hook（priority=950）：采集 LlmCallEvent
 * - llm_output hook（priority=950）：采集 LlmResponseEvent（含 Response 修改链审计日志）
 * - before_tool_call hook（priority=900）：采集 ToolCallEvent
 * - after_tool_call hook（priority=900）：采集 ToolResultEvent
 * - subagent_spawned hook（priority=900）：采集 SubAgentSpawnEvent
 * - subagent_ended hook（priority=900）：采集 SubAgentEndEvent
 * - agent_end hook（priority=900）：采集 AgentEndEvent，标记 Run completed
 * - FetchMiddleware（priority=950）：捕获 LLM 原始响应（rawAssistantContent）
 *
 * HTTP 路由：
 * - GET /runs?after=<timestamp>：增量拉取 Run 列表
 * - GET /run?id=<runId>：单条查询
 * - POST /clear：清空 RunStore
 */

import type { QClawPackage, QClawContext, FetchMiddleware, HookHandlerExecutedEvent, MiddlewareExecutedEvent } from '../../core/types.js'
import type {
  PromptBuildEvent,
  LlmCallEvent,
  LlmResponseEvent,
  ToolCallEvent,
  ToolResultEvent,
  SubAgentSpawnEvent,
  SubAgentEndEvent,
  AgentEndEvent,
  HookAuditEntry,
  FetchAuditEntry,
} from './types.js'
import { getSharedRunStore, buildRunSummary, parseAgentId } from './run-store.js'

/** prompt-inspector 配置 */
interface PromptInspectorConfig {
  enabled?: boolean
}

/**
 * 模块级共享的 enabled 状态。
 * 当 OpenClaw 创建新 agent 时 qclaw-plugin 会被重新 register()，
 * 使用模块级变量确保 enabled 状态不会因重新初始化而丢失。
 * undefined 表示尚未初始化，使用配置文件中的值。
 */
let sharedEnabled: boolean | undefined

const promptInspector: QClawPackage = {
  id: 'prompt-inspector',
  name: 'Prompt Inspector',
  description: '开发调试工具：捕获并展示完整的 Run 级别 Prompt/Response 流程',

  setup(ctx: QClawContext): void {
    // ★ 第 1 层门控：环境变量
    if (process.env.QCLAW_PROMPT_INSPECTOR !== '1') {
      ctx.logger.info('disabled (env QCLAW_PROMPT_INSPECTOR not set)')
      return
    }

    // ★ 第 2 层门控：运行时开关（通过 ConfigCenter 动态控制）
    // 首次初始化时从配置读取，后续重新初始化时保持已有状态
    if (sharedEnabled === undefined) {
      sharedEnabled = ctx.getConfig<PromptInspectorConfig>().enabled ?? false
    }
    // 始终注册 onConfigChange，确保新 ConfigCenter 实例也能更新 sharedEnabled
    ctx.onConfigChange<PromptInspectorConfig>((config) => {
      const newEnabled = config.enabled ?? false
      if (newEnabled !== sharedEnabled) {
        ctx.logger.info(`enabled changed: ${String(sharedEnabled)} → ${String(newEnabled)}`)
        sharedEnabled = newEnabled
      }
    })

    // ---- Phase 4: RunStore（模块级单例，跨 agent 重新初始化共享） ----
    const runStore = getSharedRunStore()
    // 记录每个 runId 的 llm_input 开始时间（用于计算 responseTime）
    const llmStartTimes = new Map<string, number>()
    // 记录每个 runId 的 rawAssistantContent（由 FetchMiddleware 在 onResponse 最先执行时捕获）
    const rawAssistantContents = new Map<string, string | unknown[]>()

    // ---- sessionKey → runId 映射 ----
    // 打包版本的 OpenClaw（如 2026.3.13）中，hookCtx 没有 runId 字段：
    //   before_prompt_build: hookCtx.runId = undefined, event 也没有 runId
    //     → fallback 到 hookCtx.sessionKey（如 "agent:main:main"）作为临时 runId
    //   llm_input: hookCtx.runId = undefined, 但 event.runId = "run-2026..."（真正的 runId）
    // 通过 sessionKey 建立映射，在 llm_input 中将临时 runId 迁移为真正的 runId。
    const sessionKeyToRunId = new Map<string, string>()

    /**
     * 解析 hook 中的 runId。
     * 优先级：hookCtx.runId > event.runId > sessionKey 映射 > hookCtx.sessionKey
     */
    function resolveRunId(hookCtx: Record<string, unknown>, event: Record<string, unknown>): string {
      // 1. hookCtx.runId（源码版本中始终存在）
      if (hookCtx.runId) return String(hookCtx.runId)
      // 2. event.runId（llm_input/llm_output/tool_call 等 event 中有 runId）
      if (event.runId) return String(event.runId)
      // 3. sessionKey 映射（由 before_prompt_build 或 llm_input 建立）
      const sessionKey = String(hookCtx.sessionKey ?? '')
      const mappedRunId = sessionKey ? sessionKeyToRunId.get(sessionKey) : undefined
      if (mappedRunId) return mappedRunId
      // 4. fallback: sessionKey 本身
      return sessionKey
    }

    // ---- Prompt 修改链审计：订阅 HookProxy observer ----
    // 每次 before_prompt_build 的 handler 执行后，收集修改记录
    // 按 runId 分组暂存，在 before_prompt_build hook（priority=900）执行时一次性取走
    const pendingHookAuditEntries = new Map<string, HookAuditEntry[]>()
    ctx.onHookHandlerExecuted((ev: HookHandlerExecutedEvent) => {
      if (ev.event !== 'before_prompt_build') return
      if (!ev.result) return
      const result = ev.result as Record<string, unknown>
      const mutations: HookAuditEntry['mutations'] = {}
      if (result.appendSystemContext) mutations.appendSystemContext = String(result.appendSystemContext)
      if (result.prependContext) mutations.prependContext = String(result.prependContext)
      if (result.prependSystemContext) mutations.prependSystemContext = String(result.prependSystemContext)
      if (result.systemPrompt) mutations.systemPrompt = String(result.systemPrompt)
      if (Object.keys(mutations).length > 0) {
        // runId 在 hookCtx 里，但 observer 拿不到 hookCtx；
        // 用 '__pending__' 作为临时 key，在 before_prompt_build hook 里按顺序取走
        const list = pendingHookAuditEntries.get('__pending__') ?? []
        list.push({ packageId: ev.packageId, priority: ev.priority, mutations })
        pendingHookAuditEntries.set('__pending__', list)
      }
    })

    // ---- Response 修改链审计：订阅 FetchChain observer ----
    // 每次 middleware onResponse 执行后，收集修改记录
    // 按顺序暂存，在 llm_output hook（priority=950）执行时一次性取走
    const pendingFetchAuditEntries: FetchAuditEntry[] = []
    ctx.onMiddlewareExecuted((ev: MiddlewareExecutedEvent) => {
      pendingFetchAuditEntries.push({
        middlewareId: ev.middlewareId,
        priority: ev.priority,
        modified: ev.modified,
        action: ev.action,
        detail: ev.detail,
      })
    })

    // ============================================================
    // F207: before_prompt_build hook — 采集 PromptBuildEvent
    // ============================================================
    ctx.onHook('before_prompt_build', async (event, hookCtx) => {
      if (!sharedEnabled) return

      try {
        // 打包版本中 hookCtx.runId 不存在，event 也没有 runId
        // → fallback 到 sessionKey 作为临时 runId（后续 llm_input 会 rekey 为真正的 runId）
        const runId = String(hookCtx.runId ?? event.runId ?? hookCtx.sessionKey ?? '')
        const sessionId = String(hookCtx.sessionKey ?? '')

        // 记录 sessionKey → runId 映射，供后续 hook 查找
        if (sessionId) {
          sessionKeyToRunId.set(sessionId, runId)
        }

        // 幂等创建 Run（根据 sessionId 判断 agentType）
        const agentType = parseAgentId(sessionId) === 'main' ? 'main' : 'subagent' as const
        runStore.createRun(runId, sessionId, agentType)

        // 取走 Prompt 修改链审计日志（由 onHookHandlerExecuted observer 收集）
        // 注意：priority=900，在其他插件（priority<900）之后执行，此时 pending 里已有所有修改
        const hookAuditEntries = pendingHookAuditEntries.get('__pending__') ?? []
        pendingHookAuditEntries.delete('__pending__')

        const promptBuildEvent: PromptBuildEvent = {
          type: 'prompt_build',
          timestamp: Date.now(),
          // baseSystemPrompt 在 before_prompt_build 阶段不可用，
          // 将在 llm_input hook 中通过 systemPromptText 回填
          baseSystemPrompt: '',
          hookAuditEntries,
          // finalSystemPrompt 同样在 llm_input hook 中回填
          finalSystemPrompt: '',
          userPrompt: String(event.prompt ?? event.userPrompt ?? ''),
          effectivePrompt: String(event.effectivePrompt ?? event.prompt ?? ''),
        }

        runStore.appendEvent(runId, promptBuildEvent)
      } catch (err) {
        ctx.logger.error('before_prompt_build hook error:', err)
      }
    }, { priority: 900 })

    // ============================================================
    // F208: llm_input hook — 采集 LlmCallEvent
    // ============================================================
    ctx.onHook('llm_input', async (event, hookCtx) => {
      if (!sharedEnabled) return
      try {
        const sessionId = String(hookCtx.sessionKey ?? hookCtx.sessionId ?? event.sessionId ?? '')
        // 确定真正的 runId：hookCtx.runId > event.runId
        const realRunId = hookCtx.runId ? String(hookCtx.runId) : (event.runId ? String(event.runId) : '')

        // ★ 关键修复：打包版本中 before_prompt_build 的 hookCtx/event 都没有 runId，
        //   用 sessionKey 作为临时 runId 创建了 Run。
        //   llm_input 的 event.runId 才是真正的 runId。
        //   通过 sessionKey 映射找到临时 Run，rekey 到真正的 runId。
        const mappedRunId = sessionId ? sessionKeyToRunId.get(sessionId) : undefined
        let runId = realRunId || mappedRunId || sessionId
        if (realRunId && mappedRunId && realRunId !== mappedRunId) {
          // 临时 runId（如 "agent:main:main"）→ 真正的 runId（如 "run-2026..."）
          const rekeyed = runStore.rekey(mappedRunId, realRunId)
          if (rekeyed) {
            runId = realRunId
          }
          // 无论 rekey 是否成功，都更新映射为真正的 runId
          sessionKeyToRunId.set(sessionId, runId)
        }

        // 幂等创建 Run（如果 before_prompt_build 未触发，根据 sessionId 判断 agentType）
        const agentType = parseAgentId(sessionId) === 'main' ? 'main' : 'subagent' as const
        runStore.createRun(runId, sessionId, agentType)

        // 记录 LLM 调用开始时间
        llmStartTimes.set(runId, Date.now())

        // ★ 回填 finalSystemPrompt 到 prompt_build 事件
        // llm_input 事件中的 systemPrompt 是经过所有插件修改后的最终 system prompt
        const systemPromptText = String(event.systemPrompt ?? '')
        if (systemPromptText) {
          const run = runStore.getRun(runId)
          if (run) {
            const promptBuildEvt = run.events.find((e) => e.type === 'prompt_build') as PromptBuildEvent | undefined
            if (promptBuildEvt) {
              // 计算 baseSystemPrompt：从 finalSystemPrompt 中去除插件追加的内容
              // 如果没有 hookAuditEntries，则 base = final
              let basePrompt = systemPromptText
              for (const entry of promptBuildEvt.hookAuditEntries) {
                if (entry.mutations.appendSystemContext) {
                  basePrompt = basePrompt.replace(entry.mutations.appendSystemContext, '').trim()
                }
                if (entry.mutations.prependSystemContext) {
                  basePrompt = basePrompt.replace(entry.mutations.prependSystemContext, '').trim()
                }
                if (entry.mutations.systemPrompt) {
                  // 如果有插件完全替换了 systemPrompt，则 base 就是替换前的（无法还原，标记为不可用）
                  basePrompt = '[被插件替换]'
                }
              }
              promptBuildEvt.baseSystemPrompt = basePrompt
              promptBuildEvt.finalSystemPrompt = systemPromptText
              // 触发 lastUpdated 更新
              run.lastUpdated = Date.now()
            }
          }
        }

        const llmCallEvent: LlmCallEvent = {
          type: 'llm_call',
          timestamp: Date.now(),
          model: String(event.model ?? ''),
          provider: String(event.provider ?? ''),
          messages: Array.isArray(event.historyMessages) ? event.historyMessages : [],
        }

        runStore.appendEvent(runId, llmCallEvent)
      } catch (err) {
        ctx.logger.error('llm_input hook error:', err)
      }
    }, { priority: 950 })

    // ============================================================
    // F209: llm_output hook — 采集 LlmResponseEvent（含 Response 修改链）
    // ============================================================
    ctx.onHook('llm_output', async (event, hookCtx) => {
      if (!sharedEnabled) return
      try {
        // 通过 sessionKey 映射查找关联的 Run
        const runId = resolveRunId(hookCtx as Record<string, unknown>, event as Record<string, unknown>)

        // 计算 responseTime
        const startTime = llmStartTimes.get(runId)
        const responseTime = startTime != null ? Date.now() - startTime : undefined
        if (startTime != null) llmStartTimes.delete(runId)

        // 提取 usage
        const usageRaw = event.usage as Record<string, number> | undefined
        const usage = usageRaw ? {
          inputTokens: Number(usageRaw.input ?? usageRaw.inputTokens ?? 0),
          outputTokens: Number(usageRaw.output ?? usageRaw.outputTokens ?? 0),
          cacheRead: usageRaw.cacheRead != null ? Number(usageRaw.cacheRead) : undefined,
          cacheWrite: usageRaw.cacheWrite != null ? Number(usageRaw.cacheWrite) : undefined,
          total: Number(usageRaw.total ?? 0),
        } : undefined

        // 提取 rawAssistantContent（LLM 原始响应）
        // 优先从 FetchMiddleware 捕获的 rawAssistantContent，fallback 到 event.lastAssistant
        const rawContent = rawAssistantContents.get(runId)
        rawAssistantContents.delete(runId)
        const lastAssistant = event.lastAssistant as { content?: unknown } | undefined
        const rawAssistantContent: string | unknown[] = rawContent ?? (
          typeof lastAssistant?.content === 'string'
            ? lastAssistant.content
            : (lastAssistant?.content as unknown[] | undefined) ?? ''
        )

        // finalAssistantContent = event.lastAssistant（经过所有 middleware 处理后）
        const finalAssistantContent: string | unknown[] =
          typeof lastAssistant?.content === 'string'
            ? lastAssistant.content
            : (lastAssistant?.content as unknown[] | undefined) ?? ''

        // 取走 Response 修改链审计日志（由 onMiddlewareExecuted observer 收集）
        const fetchAuditEntries = pendingFetchAuditEntries.splice(0)

        const llmResponseEvent: LlmResponseEvent = {
          type: 'llm_response',
          timestamp: Date.now(),
          model: String(event.model ?? ''),
          responseTime,
          usage,
          rawAssistantContent,
          finalAssistantContent,
          fetchAuditEntries,
          finishReason: event.finishReason != null ? String(event.finishReason) : undefined,
        }

        runStore.appendEvent(runId, llmResponseEvent)
      } catch (err) {
        ctx.logger.error('llm_output hook error:', err)
      }
    }, { priority: 950 })

    // ============================================================
    // F210: before_tool_call hook — 采集 ToolCallEvent
    // ============================================================
    ctx.onHook('before_tool_call', async (event, hookCtx) => {
      if (!sharedEnabled) return
      try {
        const runId = resolveRunId(hookCtx as Record<string, unknown>, event as Record<string, unknown>)

        const toolCallEvent: ToolCallEvent = {
          type: 'tool_call',
          timestamp: Date.now(),
          toolName: String(event.toolName ?? event.name ?? ''),
          toolInput: (event.toolInput ?? event.params ?? {}) as Record<string, unknown>,
        }

        runStore.appendEvent(runId, toolCallEvent)
      } catch (err) {
        ctx.logger.error('before_tool_call hook error:', err)
      }
    }, { priority: 900 })

    // ============================================================
    // F210: after_tool_call hook — 采集 ToolResultEvent
    // ============================================================
    ctx.onHook('after_tool_call', async (event, hookCtx) => {
      if (!sharedEnabled) return
      try {
        const runId = resolveRunId(hookCtx as Record<string, unknown>, event as Record<string, unknown>)

        const toolResultEvent: ToolResultEvent = {
          type: 'tool_result',
          timestamp: Date.now(),
          toolName: String(event.toolName ?? event.name ?? ''),
          toolResult: event.toolResult ?? event.result,
          blocked: Boolean(event.blocked ?? false),
          blockReason: event.blockReason != null ? String(event.blockReason) : undefined,
        }

        runStore.appendEvent(runId, toolResultEvent)
      } catch (err) {
        ctx.logger.error('after_tool_call hook error:', err)
      }
    }, { priority: 900 })

    // ============================================================
    // F210: subagent_spawned hook — 采集 SubAgentSpawnEvent
    // ============================================================
    ctx.onHook('subagent_spawned', async (event, hookCtx) => {
      if (!sharedEnabled) return
      try {
        const parentRunId = resolveRunId(hookCtx as Record<string, unknown>, event as Record<string, unknown>)
        const childRunId = String(event.childRunId ?? event.subagentRunId ?? '')
        const childSessionKey = String(event.childSessionKey ?? event.sessionKey ?? '')

        // 为子 agent 创建 RunRecord
        runStore.createRun(childRunId, childSessionKey, 'subagent', parentRunId)

        const subAgentSpawnEvent: SubAgentSpawnEvent = {
          type: 'subagent_spawn',
          timestamp: Date.now(),
          childRunId,
          childSessionKey,
          agentType: String(event.agentType ?? 'subagent'),
          agentId: parseAgentId(childSessionKey),
          promptMode: String(event.promptMode ?? 'minimal'),
        }

        runStore.appendEvent(parentRunId, subAgentSpawnEvent)
      } catch (err) {
        ctx.logger.error('subagent_spawned hook error:', err)
      }
    }, { priority: 900 })

    // ============================================================
    // F210: subagent_ended hook — 采集 SubAgentEndEvent
    // ============================================================
    ctx.onHook('subagent_ended', async (event, hookCtx) => {
      if (!sharedEnabled) return
      try {
        const parentRunId = resolveRunId(hookCtx as Record<string, unknown>, event as Record<string, unknown>)
        const childRunId = String(event.childRunId ?? event.subagentRunId ?? '')

        // 标记子 agent Run 完成
        runStore.setStatus(childRunId, 'completed')

        const subAgentEndEvent: SubAgentEndEvent = {
          type: 'subagent_end',
          timestamp: Date.now(),
          childRunId,
        }

        runStore.appendEvent(parentRunId, subAgentEndEvent)
      } catch (err) {
        ctx.logger.error('subagent_ended hook error:', err)
      }
    }, { priority: 900 })

    // ============================================================
    // F210: agent_end hook — 采集 AgentEndEvent，标记 Run completed
    // ============================================================
    ctx.onHook('agent_end', async (event, hookCtx) => {
      if (!sharedEnabled) return
      try {
        const runId = resolveRunId(hookCtx as Record<string, unknown>, event as Record<string, unknown>)

        const agentEndEvent: AgentEndEvent = {
          type: 'agent_end',
          timestamp: Date.now(),
        }

        runStore.appendEvent(runId, agentEndEvent)
        runStore.setStatus(runId, 'completed')
      } catch (err) {
        ctx.logger.error('agent_end hook error:', err)
      }
    }, { priority: 900 })

    // ============================================================
    // FetchMiddleware（priority=950）：捕获 LLM 原始响应
    // prompt-inspector priority=950，在 onResponse 阶段最先执行，
    // 拿到的是 LLM 原始响应（未经其他 middleware 修改）
    // ============================================================
    const middleware: FetchMiddleware = {
      id: 'prompt-inspector',
      priority: 950,

      async onRequest(reqCtx) {
        return reqCtx
      },

      async onResponse(resCtx) {
        if (!sharedEnabled) return resCtx.response

        try {
          // prompt-inspector priority=950，在 onResponse 阶段最先执行
          // 此时拿到的是 LLM 原始响应（未经其他 middleware 修改）
          const runId = resCtx.extra?.runId as string | undefined
          if (runId) {
            rawAssistantContents.set(runId, `[SSE stream captured at ${new Date().toISOString()}]`)
          }
        } catch (err) {
          ctx.logger.error('FetchMiddleware onResponse error:', err)
        }

        return resCtx.response
      },
    }

    ctx.registerFetchMiddleware(middleware)

    // ============================================================
    // F211: HTTP 路由 — Run 级别端点
    // ============================================================

    // GET /qclaw-plugin/prompt-inspector/runs?after=<timestamp>
    ctx.registerHttpRoute({
      method: 'GET',
      path: 'runs',
      async handler(req) {
        const afterTimestamp = Number(req.query.after) || 0
        const runs = afterTimestamp > 0
          ? runStore.getRunsAfter(afterTimestamp)
          : runStore.getAllRuns()
        const items = runs.map((run) => ({
          ...run,
          summary: buildRunSummary(run),
        }))
        return {
          status: 200,
          body: { items, total: runStore.size() },
        }
      },
    })

    // GET /qclaw-plugin/prompt-inspector/run?id=<runId>
    ctx.registerHttpRoute({
      method: 'GET',
      path: 'run',
      async handler(req) {
        const runId = req.query.id ?? ''
        const run = runStore.getRun(runId)
        if (!run) {
          return { status: 404, body: { error: 'not found' } }
        }
        return {
          status: 200,
          body: { ...run, summary: buildRunSummary(run) },
        }
      },
    })

    // POST /qclaw-plugin/prompt-inspector/clear
    ctx.registerHttpRoute({
      method: 'POST',
      path: 'clear',
      async handler() {
        runStore.clear()
        return { status: 200, body: { ok: true } }
      },
    })

    ctx.logger.info(`registered (env gate passed, runtime enabled=${String(sharedEnabled)})`)
  },
}

export default promptInspector

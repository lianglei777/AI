/**
 * core/hook-proxy.ts — Hook 代理
 *
 * 设计原则：
 * 1. qclaw 对每个事件只注册一次 api.on()
 * 2. 内部维护 handler 列表，按 priority 升序排列（数字越小越先执行）
 * 3. 支持 block 语义：handler 返回 { block: true } 时，后续 handler 不再执行
 * 4. 支持 params 改写：handler 返回 { params: newParams } 时，后续 handler 收到改写后的 params
 * 5. 支持 appendSystemContext 合并
 * 6. 单个 handler 异常不影响其他 handler
 * 7. 支持 concurrent 并行执行：标记为 concurrent 的相邻 handler 会并发执行，减少等待时间
 */

import type {
  HookEvent,
  HookHandler,
  HookHandlerResult,
  HookContext,
  RegisteredHandler,
  SyncHookEvent,
  SyncHookHandler,
  RegisteredSyncHandler,
  OpenClawPluginApi,
  HookHandlerExecutedEvent,
} from './types.js'

const LOG_TAG = '[qclaw-plugin:hook-proxy]'

/**
 * 执行组：连续的 concurrent handler 组成一个并行组，非 concurrent handler 单独成组
 */
interface ExecutionGroup {
  /** 是否并行执行 */
  parallel: boolean
  /** 组内的 handler 列表（已按 priority 排序） */
  entries: RegisteredHandler[]
}

export class HookProxy {
  /** 按事件分组的异步 handler 列表 */
  private handlers = new Map<HookEvent, RegisteredHandler[]>()
  /** 按事件分组的同步 handler 列表 */
  private syncHandlers = new Map<SyncHookEvent, RegisteredSyncHandler[]>()
  /** 已向 OpenClaw 注册过的事件集合（每个事件只注册一次 api.on） */
  private registered = new Set<string>()
  /** OpenClaw 插件 API */
  private api: OpenClawPluginApi
  /** handler 执行后的通用 observer 列表 */
  private handlerExecutedObservers: Array<(ev: HookHandlerExecutedEvent) => void> = []

  constructor(api: OpenClawPluginApi) {
    this.api = api
  }

  /**
   * 注册一个异步 Hook handler
   * @param event Hook 事件名
   * @param packageId 来源 package 的 ID
   * @param handler 处理函数
   * @param priority 优先级（数字越小越先执行，默认 500）
   * @param concurrent 是否可与相邻 concurrent handler 并行执行（默认 false）
   */
  register(
    event: HookEvent,
    packageId: string,
    handler: HookHandler,
    priority: number = 500,
    concurrent: boolean = false,
  ): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, [])
    }

    const list = this.handlers.get(event)!
    list.push({ packageId, handler, priority, concurrent })
    // 按 priority 升序排列
    list.sort((a, b) => a.priority - b.priority)

    // 首次注册此事件时，向 OpenClaw 注册 api.on()
    if (!this.registered.has(event)) {
      this.registered.add(event)
      console.log(`${LOG_TAG} registering api.on('${event}') for package ${packageId}`)
      this.api.on(event, async (...args: unknown[]) => {
        return this.dispatch(event, args)
      })
    }
  }

  /**
   * 注册一个同步 Hook handler
   *
   * 同步 hook 用于需要可靠替换事件数据的场景（如 tool_result_persist）。
   * handler 必须是同步函数，禁止返回 Promise。
   * 按 priority 升序串行执行，后一个 handler 的返回值覆盖前一个。
   *
   * @param event 同步 Hook 事件名
   * @param packageId 来源 package 的 ID
   * @param handler 同步处理函数
   * @param priority 优先级（数字越小越先执行，默认 500）
   */
  registerSync(
    event: SyncHookEvent,
    packageId: string,
    handler: SyncHookHandler,
    priority: number = 500,
  ): void {
    if (!this.syncHandlers.has(event)) {
      this.syncHandlers.set(event, [])
    }

    const list = this.syncHandlers.get(event)!
    list.push({ packageId, handler, priority })
    // 按 priority 升序排列
    list.sort((a, b) => a.priority - b.priority)

    // 首次注册此事件时，向 OpenClaw 注册 api.on()
    if (!this.registered.has(event)) {
      this.registered.add(event)
      this.api.on(event, (...args: unknown[]) => {
        return this.dispatchSync(event, args)
      })
    }
  }

  /**
   * 同步分发 Hook 事件给所有已注册的同步 handler
   *
   * 链式替换语义：
   * - 按 priority 升序串行执行
   * - handler 返回对象时，合并到累积结果中（后者覆盖前者）
   * - 单个 handler 异常不影响其他 handler
   */
  private dispatchSync(
    event: SyncHookEvent,
    args: unknown[],
  ): Record<string, unknown> | undefined {
    const list = this.syncHandlers.get(event)
    if (!list || list.length === 0) return undefined

    const eventData = (args[0] ?? {}) as Record<string, unknown>
    const hookCtx = (args[1] ?? {}) as HookContext

    console.log(
      `${LOG_TAG} [diag] dispatchSync(${event}) START handlers=${list.length}`,
    )
    const dispatchStart = performance.now()

    let mergedResult: Record<string, unknown> | undefined

    for (const entry of list) {
      const handlerStart = performance.now()
      try {
        const result = entry.handler(eventData, hookCtx)

        // 防御性检查：如果 handler 错误地返回了 Promise，记录警告并跳过
        if (result && typeof (result as unknown as Promise<unknown>).then === 'function') {
          console.error(
            `${LOG_TAG} [diag] [${event}] sync handler from ${entry.packageId} returned a Promise — FORBIDDEN`,
          )
          continue
        }

        const handlerMs = (performance.now() - handlerStart).toFixed(1)
        if (result && typeof result === 'object') {
          mergedResult = { ...mergedResult, ...result }
        }
      } catch (err) {
        console.error(
          `${LOG_TAG} [diag] dispatchSync(${event}) ${entry.packageId} ERROR:`,
          err instanceof Error ? err.message : err,
        )
      }
    }

    const totalMs = (performance.now() - dispatchStart).toFixed(1)
    if (totalMs > '500') {
      console.warn(`${LOG_TAG} [diag] dispatchSync(${event}) SLOW ${totalMs}ms`)
    }

    return mergedResult
  }

  /**
   * 将 handler 列表按 concurrent 属性分组为执行组
   * 连续的 concurrent=true handler 合并为一个并行组
   * concurrent=false 的 handler 各自独立成组（串行执行）
   */
  private buildExecutionGroups(list: RegisteredHandler[]): ExecutionGroup[] {
    const groups: ExecutionGroup[] = []

    for (const entry of list) {
      if (entry.concurrent) {
        // 尝试合并到上一个并行组
        const lastGroup = groups[groups.length - 1]
        if (lastGroup && lastGroup.parallel) {
          lastGroup.entries.push(entry)
        } else {
          groups.push({ parallel: true, entries: [entry] })
        }
      } else {
        // 非 concurrent，独立成组
        groups.push({ parallel: false, entries: [entry] })
      }
    }

    return groups
  }

  /**
   * 分发 Hook 事件给所有已注册的 handler
   * 按执行组顺序执行：串行组逐个 await，并行组 Promise.allSettled 并发
   */
  private async dispatch(
    event: HookEvent,
    args: unknown[],
  ): Promise<HookHandlerResult | undefined> {
    const list = this.handlers.get(event)
    if (!list || list.length === 0) return undefined

    // 解析 event data 和 context
    const eventData = (args[0] ?? {}) as Record<string, unknown>
    const hookCtx = (args[1] ?? {}) as HookContext

    const dispatchStart = performance.now()

    // 累积结果
    let mergedResult: HookHandlerResult | undefined
    let currentParams = eventData.params as Record<string, unknown> | undefined
    const systemContextParts: string[] = []
    let blocked = false

    // 构建执行组
    const groups = this.buildExecutionGroups(list)

    for (const group of groups) {
      if (blocked) break

      if (!group.parallel || group.entries.length === 1) {
        // ---- 串行执行（单个 handler 或非并行组） ----
        for (const entry of group.entries) {
          if (blocked) break

          const handlerStart = performance.now()
          try {
            const handlerEventData = currentParams
              ? { ...eventData, params: currentParams }
              : eventData

            const result = await entry.handler(handlerEventData, hookCtx)
            const handlerMs = (performance.now() - handlerStart).toFixed(1)

            if (!result) {
              continue
            }

            const resultFlags: string[] = []
            // 处理 params 改写
            if (result.params) {
              currentParams = result.params
              resultFlags.push('PARAMS_REWRITE')
            }

            // 收集 appendSystemContext
            if (result.appendSystemContext) {
              systemContextParts.push(result.appendSystemContext)
              resultFlags.push(`APPEND_CTX(${result.appendSystemContext.length}ch)`)
            }

            // 只在 BLOCK 时输出日志
            if (result.block) {
              resultFlags.push(`BLOCK(${result.blockReason ?? 'no reason'})`)
              blocked = true
              console.warn(
                `${LOG_TAG} [diag] dispatch(${event}) ${entry.packageId} BLOCKED: ${result.blockReason ?? 'no reason'}`,
              )
            }

            // 通知 observer：handler 执行完毕
            if (this.handlerExecutedObservers.length > 0) {
              const ev: HookHandlerExecutedEvent = {
                event,
                packageId: entry.packageId,
                priority: entry.priority,
                result,
              }
              for (const obs of this.handlerExecutedObservers) {
                try { obs(ev) } catch { /* 静默忽略 */ }
              }
            }

            // 合并结果
            mergedResult = { ...mergedResult, ...result }
          } catch (err) {
            console.error(
              `${LOG_TAG} [diag] dispatch(${event}) ${entry.packageId} ERROR:`,
              err instanceof Error ? err.message : err,
            )
          }
        }
      } else {
        // ---- 并行执行（多个 concurrent handler） ----
        // 所有并行 handler 收到的是进入并行组时的 params 快照
        const snapshotParams = currentParams
        const handlerEventData = snapshotParams
          ? { ...eventData, params: snapshotParams }
          : eventData

        const promises = group.entries.map(async (entry) => {
          try {
            const result = await entry.handler(handlerEventData, hookCtx)
            return { entry, result }
          } catch (err) {
            console.error(
              `${LOG_TAG} [${event}] handler from ${entry.packageId} threw:`,
              err,
            )
            return { entry, result: undefined }
          }
        })

        const settled = await Promise.allSettled(promises)

        // 按 priority 顺序处理并行组的结果（entries 已按 priority 排序）
        for (const outcome of settled) {
          if (blocked) break
          if (outcome.status !== 'fulfilled') continue

          const { entry, result } = outcome.value
          if (!result) continue

          // 处理 params 改写（并行组内按 priority 顺序，后者覆盖前者）
          if (result.params) {
            currentParams = result.params
          }

          // 收集 appendSystemContext
          if (result.appendSystemContext) {
            systemContextParts.push(result.appendSystemContext)
          }

          // 通知 observer：handler 执行完毕（并行组）
          if (this.handlerExecutedObservers.length > 0) {
            const ev: HookHandlerExecutedEvent = {
              event,
              packageId: entry.packageId,
              priority: entry.priority,
              result,
            }
            for (const obs of this.handlerExecutedObservers) {
              try { obs(ev) } catch { /* 静默忽略 */ }
            }
          }

          // 合并结果
          mergedResult = { ...mergedResult, ...result }

          // 处理 block 语义（并行组执行完毕后，按 priority 检查 block）
          if (result.block) {
            console.log(
              `${LOG_TAG} [${event}] blocked by ${entry.packageId} (priority=${entry.priority}, concurrent): ${result.blockReason ?? 'no reason'}`,
            )
            blocked = true
          }
        }
      }
    }

    // 合并最终结果
    if (mergedResult) {
      if (currentParams) {
        mergedResult.params = currentParams
      }
      if (systemContextParts.length > 0) {
        mergedResult.appendSystemContext = systemContextParts.join('\n')
      }
    }

    const totalMs = (performance.now() - dispatchStart).toFixed(1)
    if (blocked || Number(totalMs) > 500) {
      console.log(
        `${LOG_TAG} [diag] dispatch(${event}) END ${totalMs}ms blocked=${blocked}`,
      )
    }

    return mergedResult
  }

  /**
   * 注册 handler 执行后的通用 observer
   * 每次任意 hook handler 执行完毕后触发，携带事件名、packageId、priority 和返回值
   * @returns 取消注册的函数
   */
  onHandlerExecuted(observer: (ev: HookHandlerExecutedEvent) => void): () => void {
    this.handlerExecutedObservers.push(observer)
    return () => {
      const idx = this.handlerExecutedObservers.indexOf(observer)
      if (idx !== -1) this.handlerExecutedObservers.splice(idx, 1)
    }
  }

  /**
   * 获取某个异步事件的所有已注册 handler（用于调试/测试）
   */
  getHandlers(event: HookEvent): readonly RegisteredHandler[] {
    return this.handlers.get(event) ?? []
  }

  /**
   * 获取某个同步事件的所有已注册 handler（用于调试/测试）
   */
  getSyncHandlers(event: SyncHookEvent): readonly RegisteredSyncHandler[] {
    return this.syncHandlers.get(event) ?? []
  }

  /**
   * 获取所有已注册的事件列表（包含异步和同步，用于调试/测试）
   */
  getRegisteredEvents(): string[] {
    return [
      ...Array.from(this.handlers.keys()),
      ...Array.from(this.syncHandlers.keys()),
    ]
  }

  /**
   * 获取某个事件的执行组（用于调试/测试）
   */
  getExecutionGroups(event: HookEvent): ExecutionGroup[] {
    const list = this.handlers.get(event)
    if (!list) return []
    return this.buildExecutionGroups(list)
  }
}

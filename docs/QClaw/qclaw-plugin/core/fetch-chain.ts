/**
 * core/fetch-chain.ts — Fetch 中间件链
 *
 * 单点安装 globalThis.fetch，多 package 注册中间件。
 * 执行顺序（洋葱模型）：
 *   request:  priority 100 → 150 → 200 → 250 → originalFetch
 *   response: priority 250 → 200 → 150 → 100
 */

import type { FetchMiddleware, FetchRequestContext, FetchResponseContext, MiddlewareExecutedEvent } from './types.js'

const LOG_TAG = '[qclaw-plugin:fetch-chain]'
const middlewares:FetchMiddleware[] = []

export class FetchChain {
  /**
   * 进程级单例标记：确保整个进程中只有一个 FetchChain 实例安装到 globalThis.fetch。
   * OpenClaw 会为不同运行上下文（多 agent + gateway）多次调用插件的 register()，
   * 每次都会创建新的 FetchChain 实例。如果不做单例保护，会导致多层拦截器嵌套，
   * 使每个请求被 middleware 重复处理 N 次。
   */
  private static globalInstance: FetchChain | null = null

  /** 已注册的中间件列表（按 priority 升序） */
  private middlewares: FetchMiddleware[] = middlewares
  /** 原始 fetch 引用 */
  private originalFetch: typeof fetch | null = null
  /** 是否已安装 */
  private installed = false
  /** middleware 执行后的通用 observer 列表 */
  private middlewareExecutedObservers: Array<(ev: MiddlewareExecutedEvent) => void> = []

  /**
   * 注册一个 Fetch 中间件
   * 支持在 install() 之前或之后调用（延迟注册）
   */
  register(middleware: FetchMiddleware): void {
    // 按 id 去重：相同 id 的中间件只保留最新注册的实例
    const existingIdx = this.middlewares.findIndex((m) => m.id === middleware.id)
    if (existingIdx !== -1) {
      this.middlewares[existingIdx] = middleware
      console.log(
        `${LOG_TAG} replaced existing middleware: ${middleware.id}(${middleware.priority}), total: ${this.middlewares.length}`,
      )
    } else {
      this.middlewares.push(middleware)
    }
    // 按 priority 升序排列
    this.middlewares.sort((a, b) => a.priority - b.priority)

    if (this.installed) {
      // 延迟注册：install() 已执行，新中间件自动生效（execute() 动态读取 middlewares）
      console.log(
        `${LOG_TAG} late-registered middleware: ${middleware.id}(${middleware.priority}), total: ${this.middlewares.length}`,
      )
    }
  }

  /**
   * 安装 FetchChain，替换 globalThis.fetch
   *
   * 进程级单例保护：如果已有另一个 FetchChain 实例安装过，
   * 则将当前实例的中间件合并到已安装的实例中，不再重复替换 globalThis.fetch。
   */
  install(): void {
    if (this.installed) {
      console.warn(`${LOG_TAG} already installed (same instance), skipping`)
      return
    }

    // ---- 进程级单例保护 ----
    if (FetchChain.globalInstance && FetchChain.globalInstance !== this) {
      // 另一个 FetchChain 实例已经安装过了（OpenClaw 多次调用 register() 导致）
      // 将当前实例的中间件合并到已安装的实例中
      const existing = FetchChain.globalInstance
      let merged = 0
      for (const mw of this.middlewares) {
        existing.register(mw)
        merged++
      }
      // 将当前实例标记为已安装，但不替换 globalThis.fetch
      this.installed = true
      this.originalFetch = existing.originalFetch
      console.warn(
        `${LOG_TAG} another FetchChain instance already installed globally, ` +
        `merged ${merged} middleware(s) into existing instance ` +
        `(total: ${existing.middlewares.length}). Skipping globalThis.fetch replacement.`,
      )
      return
    }

    // 保存原始 fetch
    this.originalFetch = globalThis.fetch

    // 替换 globalThis.fetch
    // 使用 Object.assign 保留原始 fetch 上的静态属性（如 Node.js 22+ 的 preconnect）
    const interceptor = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      return this.execute(input, init)
    }
    globalThis.fetch = Object.assign(interceptor, this.originalFetch) as typeof fetch

    this.installed = true
    FetchChain.globalInstance = this
    console.log(
      `${LOG_TAG} installed with ${this.middlewares.length} middleware(s)${this.middlewares.length > 0 ? `: [${this.middlewares.map((m) => `${m.id}(${m.priority})`).join(', ')}]` : ' (accepting late registrations)'}`,
    )
  }

  /**
   * 获取原始 fetch（绕过拦截链）
   */
  getOriginalFetch(): typeof fetch {
    if (!this.originalFetch) {
      // 还没安装，返回当前的 globalThis.fetch
      return globalThis.fetch
    }
    return this.originalFetch
  }

  /**
   * 注册 middleware 执行后的通用 observer
   * 每次任意 middleware 的 onResponse 执行完毕后触发，携带 middlewareId、priority、modified 等信息
   * @returns 取消注册的函数
   */
  onMiddlewareExecuted(observer: (ev: MiddlewareExecutedEvent) => void): () => void {
    this.middlewareExecutedObservers.push(observer)
    return () => {
      const idx = this.middlewareExecutedObservers.indexOf(observer)
      if (idx !== -1) this.middlewareExecutedObservers.splice(idx, 1)
    }
  }

  /**
   * 获取已注册的中间件列表（用于调试/测试）
   */
  getMiddlewares(): readonly FetchMiddleware[] {
    return this.middlewares
  }

  /**
   * 从 URL 中提取简短标识（用于日志，避免打印完整 URL）
   */
  private urlTag(input: RequestInfo | URL): string {
    try {
      const s = typeof input === 'string' ? input : input.toString()
      // 只保留路径部分的最后两段，例如 /v1/messages -> v1/messages
      const url = new URL(s)
      const parts = url.pathname.split('/').filter(Boolean)
      return parts.slice(-2).join('/') || url.pathname
    } catch {
      return String(input).slice(0, 80)
    }
  }

  /**
   * 执行 Fetch 中间件链（洋葱模型）
   */
  private async execute(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const executeStart = performance.now()
    const urlTag = this.urlTag(input)

    // 筛选匹配的中间件
    const matched = this.middlewares.filter(
      (m) => !m.match || m.match(input, init),
    )

    if (matched.length === 0) {
      // 没有匹配的中间件，直接调用原始 fetch
      return this.originalFetch!(input, init)
    }

    // 构造请求上下文
    let ctx: FetchRequestContext = {
      input,
      init,
      extra: {},
    }

    // ---- 洋葱模型：request 阶段（正序） ----
    for (const mw of matched) {
      if (!mw.onRequest) continue
      const reqStart = performance.now()
      try {
        ctx = await mw.onRequest(ctx)
        if (ctx.shortCircuitResponse) {
          console.log(`${LOG_TAG} [diag] onRequest ${mw.id} SHORT_CIRCUIT url=${urlTag}`)
        }
      } catch (err) {
        console.error(
          `${LOG_TAG} [diag] onRequest ${mw.id} ERROR ${(performance.now() - reqStart).toFixed(1)}ms url=${urlTag}:`,
          err instanceof Error ? err.message : err,
        )
      }
    }

    // ---- 短路检测：onRequest 阶段设置了 shortCircuitResponse 则跳过 originalFetch ----
    let response: Response
    if (ctx.shortCircuitResponse) {
      // SHORT_CIRCUIT 已在 onRequest 中记录
      response = ctx.shortCircuitResponse
    } else {
      // ---- 调用原始 fetch ----
      const fetchStart = performance.now()
      try {
        response = await this.originalFetch!(ctx.input, ctx.init)
      } catch (err) {
        console.error(
          `${LOG_TAG} [diag] originalFetch ERROR ${(performance.now() - fetchStart).toFixed(1)}ms url=${urlTag}:`,
          err instanceof Error ? err.message : err,
        )
        // 尝试让中间件处理错误（逆序）
        for (let i = matched.length - 1; i >= 0; i--) {
          const mw = matched[i]!
          if (!mw.onError) continue
          try {
            const recovered = await mw.onError({
              input: ctx.input,
              init: ctx.init,
              error: err,
              extra: ctx.extra,
            })
            if (recovered) {
              console.log(`${LOG_TAG} [diag] onError ${mw.id} RECOVERED url=${urlTag}`)
              return recovered
            }
          } catch (innerErr) {
            console.error(`${LOG_TAG} [${mw.id}] onError error:`, innerErr)
          }
        }
        throw err
      }
    }

    // ---- 洋葱模型：response 阶段（逆序） ----
    for (let i = matched.length - 1; i >= 0; i--) {
      const mw = matched[i]!
      if (!mw.onResponse) continue
      const respStart = performance.now()
      try {
        const responseCtx: FetchResponseContext = {
          input: ctx.input,
          init: ctx.init,
          response,
          extra: ctx.extra,
        }
        const responseBefore = response
        response = await mw.onResponse(responseCtx)
        const modified = response !== responseBefore
        // 通知 observer：middleware 执行完毕
        if (this.middlewareExecutedObservers.length > 0) {
          const ev: MiddlewareExecutedEvent = {
            middlewareId: mw.id,
            priority: mw.priority,
            modified,
            action: modified ? 'transform' : 'pass',
          }
          for (const obs of this.middlewareExecutedObservers) {
            try { obs(ev) } catch { /* 静默忽略 */ }
          }
        }
      } catch (err) {
        console.error(
          `${LOG_TAG} [diag] onResponse ${mw.id} ERROR ${(performance.now() - respStart).toFixed(1)}ms url=${urlTag}:`,
          err instanceof Error ? err.message : err,
        )
        // 异常时通知 observer（pass + detail）
        if (this.middlewareExecutedObservers.length > 0) {
          const ev: MiddlewareExecutedEvent = {
            middlewareId: mw.id,
            priority: mw.priority,
            modified: false,
            action: 'pass',
            detail: err instanceof Error ? err.message : String(err),
          }
          for (const obs of this.middlewareExecutedObservers) {
            try { obs(ev) } catch { /* 静默忽略 */ }
          }
        }
      }
    }

    return response
  }

  /**
   * 卸载 FetchChain，恢复原始 fetch（用于测试清理）
   */
  uninstall(): void {
    if (!this.installed || !this.originalFetch) return
    // 只有全局实例才需要恢复 globalThis.fetch
    if (FetchChain.globalInstance === this) {
      globalThis.fetch = this.originalFetch
      FetchChain.globalInstance = null
    }
    this.originalFetch = null
    this.installed = false
  }

  /**
   * 重置静态单例状态（仅供测试使用）
   * @internal
   */
  static _resetGlobalInstance(): void {
    FetchChain.globalInstance = null
  }
}

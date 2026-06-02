/**
 * core/types.ts — QClaw 主插件核心类型定义
 *
 * 定义 QClawPackage 接口（功能模块的标准接口）和
 * QClawContext 接口（qclaw 提供给 package 的统一 API）。
 */

import type { TelemetryReporter } from './reporter-types.js'

// ============================================================================
// Hook 相关类型
// ============================================================================

/** OpenClaw 支持的异步 Hook 事件名称 */
export type HookEvent =
  | 'message_received'
  | 'before_agent_start'
  | 'before_prompt_build'
  | 'llm_input'
  | 'llm_output'
  | 'before_tool_call'
  | 'after_tool_call'
  | 'subagent_spawned'
  | 'subagent_ended'
  | 'agent_end'

/**
 * OpenClaw 支持的同步 Hook 事件名称
 *
 * 同步 hook 与异步 hook 的区别：
 * - 同步 hook 的 handler 必须是同步函数（禁止返回 Promise）
 * - 同步 hook 的返回值可以直接替换事件数据（如 tool_result_persist 返回 { message } 替换持久化消息）
 * - 同步 hook 不支持 concurrent 并行执行
 */
export type SyncHookEvent =
  | 'tool_result_persist'

/** Hook 上下文（由 OpenClaw 传入） */
export interface HookContext {
  agentId: string
  sessionKey: string
  [key: string]: unknown
}

/** 异步 Hook handler 返回值 */
export interface HookHandlerResult {
  /** 是否阻断后续 handler */
  block?: boolean
  /** 阻断原因 */
  blockReason?: string
  /** 改写后的 params（传递给后续 handler） */
  params?: Record<string, unknown>
  /** 追加到 system context 的内容 */
  appendSystemContext?: string
  /** 其他返回字段 */
  [key: string]: unknown
}

/** 异步 Hook handler 函数签名 */
export type HookHandler = (
  event: Record<string, unknown>,
  ctx: HookContext,
) => Promise<HookHandlerResult | undefined | void>

/**
 * 同步 Hook handler 返回值
 *
 * 同步 hook 采用链式替换语义：
 * - 返回一个对象时，该对象会与事件数据合并（后者覆盖前者）
 * - 典型用法：tool_result_persist 返回 { message: newMsg } 替换持久化消息
 * - 返回 undefined/void 则保持原数据不变
 */
export type SyncHookHandlerResult = Record<string, unknown> | undefined | void

/** 同步 Hook handler 函数签名（禁止返回 Promise） */
export type SyncHookHandler = (
  event: Record<string, unknown>,
  ctx: HookContext,
) => SyncHookHandlerResult

/** 已注册的异步 Hook handler（内部使用） */
export interface RegisteredHandler {
  packageId: string
  handler: HookHandler
  priority: number
  /**
   * 是否可以与相邻的 concurrent handler 并行执行。
   *
   * 标记为 concurrent 的 handler：
   * - 会与相邻的 concurrent handler 组成「并行组」，通过 Promise.allSettled 并发执行
   * - 收到的 params 是进入并行组时的快照（不会看到同组其他 handler 的 params 改写）
   * - block 语义仍然生效：并行组执行完毕后，按 priority 顺序检查结果，遇到 block 则阻断后续组
   * - appendSystemContext 仍然会合并
   *
   * 默认 false（串行执行，保持向后兼容）。
   */
  concurrent: boolean
}

/** 已注册的同步 Hook handler（内部使用） */
export interface RegisteredSyncHandler {
  packageId: string
  handler: SyncHookHandler
  priority: number
}

/**
 * Hook handler 执行完毕后的通用观察事件
 * 由 HookProxy 在每个 handler 执行后触发，供 prompt-inspector 等工具订阅
 */
export interface HookHandlerExecutedEvent {
  /** Hook 事件名 */
  event: HookEvent
  /** 执行的 handler 所属 package */
  packageId: string
  /** handler 优先级 */
  priority: number
  /** handler 返回值（undefined 表示无返回） */
  result: HookHandlerResult | undefined | void
}

// ============================================================================
// Fetch 中间件相关类型
// ============================================================================

/** Fetch 请求上下文 */
export interface FetchRequestContext {
  input: RequestInfo | URL
  init: RequestInit | undefined
  /** 中间件可以在 extra 上挂载自定义数据，传递给 onResponse */
  extra: Record<string, unknown>
  /**
   * 短路响应：中间件在 onRequest 中设置此字段后，
   * FetchChain 将跳过 originalFetch 调用，直接进入 onResponse 阶段。
   * 用于输入审核 BLOCK 时直接返回伪造响应等场景。
   */
  shortCircuitResponse?: Response
}

/** Fetch 响应上下文 */
export interface FetchResponseContext {
  input: RequestInfo | URL
  init: RequestInit | undefined
  response: Response
  extra: Record<string, unknown>
}

/** Fetch 错误上下文 */
export interface FetchErrorContext {
  input: RequestInfo | URL
  init: RequestInit | undefined
  error: unknown
  extra: Record<string, unknown>
}

/**
 * Fetch middleware onResponse 执行完毕后的通用观察事件
 * 由 FetchChain 在每个 middleware onResponse 执行后触发，供 prompt-inspector 等工具订阅
 */
export interface MiddlewareExecutedEvent {
  /** 中间件标识 */
  middlewareId: string
  /** 中间件优先级 */
  priority: number
  /** 是否修改了 response 对象 */
  modified: boolean
  /** 执行动作 */
  action: 'transform' | 'pass'
  /** 可选：异常信息或备注 */
  detail?: string
}

/** Fetch 中间件定义 */
export interface FetchMiddleware {
  /** 中间件标识（通常为 packageId） */
  id: string
  /** 执行优先级（数字越小越先执行 onRequest，越后执行 onResponse — 洋葱模型） */
  priority: number
  /** 可选：URL 匹配过滤器，返回 false 则跳过此中间件 */
  match?: (input: RequestInfo | URL, init?: RequestInit) => boolean
  /** 请求拦截（正序执行） */
  onRequest?: (ctx: FetchRequestContext) => Promise<FetchRequestContext>
  /** 响应拦截（逆序执行） */
  onResponse?: (ctx: FetchResponseContext) => Promise<Response>
  /** 错误处理 */
  onError?: (ctx: FetchErrorContext) => Promise<Response | void>
}

// ============================================================================
// Gateway / HTTP 路由 / 命令 相关类型
// ============================================================================

/** Gateway 方法 handler */
export type GatewayMethodHandler = (
  params: Record<string, unknown>,
) => Promise<unknown>

/** HTTP 路由配置 */
export interface HttpRouteConfig {
  /** HTTP 方法 */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  /** 路径（相对于 /qclaw/<packageId>/） */
  path: string
  /** 处理函数 */
  handler: (req: HttpRequest) => Promise<HttpResponse>
}

/** HTTP 请求对象 */
export interface HttpRequest {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body: unknown
}

/** HTTP 响应对象 */
export interface HttpResponse {
  status: number
  headers?: Record<string, string>
  body: unknown
}

/** 命令配置 */
export interface CommandConfig {
  /** 命令名称（不含 / 前缀） */
  name: string
  /** 命令描述 */
  description: string
  /** 命令处理函数 */
  handler: (args: string) => Promise<string | void>
}

/** Tool 定义（OpenClaw Tool 注册） */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (params: Record<string, unknown>) => Promise<unknown>
}

/** Tool 注册选项 */
export interface ToolOptions {
  /** 是否在 agent 启动时自动注册 */
  autoRegister?: boolean
}

/** Service 定义（OpenClaw Service 注册） */
export interface ServiceDefinition {
  name: string
  description?: string
  handler?: (params: Record<string, unknown>) => Promise<unknown>
  /** 服务启动回调（由 OpenClaw 在 Gateway 启动时调用） */
  start?: (ctx: unknown) => Promise<void> | void
  /** 服务停止回调（由 OpenClaw 在 Gateway 关闭时调用） */
  stop?: (ctx: unknown) => Promise<void> | void
}

// ============================================================================
// 运行时配置类型
// ============================================================================

/** OpenClaw 运行时配置 */
export interface RuntimeConfig {
  [key: string]: unknown
}

// ============================================================================
// Logger 类型
// ============================================================================

/** QClaw 统一日志接口 */
export interface QClawLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
}

// ============================================================================
// QClawContext — qclaw 提供给 package 的统一 API
// ============================================================================

/** qclaw 提供给 package 的统一 API（轻量级 DI 边界） */
export interface QClawContext {
/** 统一日志（自动带 [qclaw-plugin:<packageId>] 前缀） */
  logger: QClawLogger

  /** 注册异步 Hook 处理器（带 priority） */
  onHook(
    event: HookEvent,
    handler: HookHandler,
    options?: { priority?: number; concurrent?: boolean },
  ): void

  /**
   * 注册同步 Hook 处理器（带 priority）
   *
   * 同步 hook 用于需要可靠替换事件数据的场景（如 tool_result_persist 替换持久化消息）。
   * handler 必须是同步函数，禁止返回 Promise。
   */
  onSyncHook(
    event: SyncHookEvent,
    handler: SyncHookHandler,
    options?: { priority?: number },
  ): void

  /** 注册 Fetch 中间件 */
  registerFetchMiddleware(middleware: FetchMiddleware): void

  /** 注册 Gateway 方法（自动加 qclaw.<packageId>. 前缀） */
  registerGatewayMethod(method: string, handler: GatewayMethodHandler): void

  /** 注册 HTTP 路由（自动加 /qclaw/<packageId>/ 前缀） */
  registerHttpRoute(route: HttpRouteConfig): void

  /** 注册聊天命令 */
  registerCommand(command: CommandConfig): void

  /** 注册 OpenClaw Tool */
  registerTool(tool: ToolDefinition, options?: ToolOptions): void

  /** 注册 OpenClaw Service */
  registerService(service: ServiceDefinition): void

  /** 获取本 package 的配置段 */
  getConfig<T = Record<string, unknown>>(): T

  /**
   * 监听本 package 的配置变更
   *
   * 当 Electron 端通过 QClawPluginConfigWriter 写入新配置后，
   * ConfigCenter 的 fs.watch 感知到文件变更，diff 后仅通知变更的 package。
   *
   * @param callback 配置变更回调，参数为合并后的最新配置
   * @returns 取消监听的函数
   */
  onConfigChange<T = Record<string, unknown>>(callback: (config: T) => void): () => void

  /** 获取 OpenClaw 运行时信息 */
  runtime: {
    stateDir: string
    version: string
    config: RuntimeConfig
  }

  /** 获取其他 package 的公开 API（跨 package 通讯） */
  getPackageApi<T = unknown>(packageId: string): T | undefined

  /** 获取原始 fetch（绕过拦截链，供安全审核等场景使用） */
  getOriginalFetch(): typeof fetch

  /**
   * 订阅 Hook handler 执行完毕事件（通用 observer）
   * 每次任意 hook handler 执行后触发，携带 event、packageId、priority、result
   * @returns 取消订阅的函数
   */
  onHookHandlerExecuted(observer: (ev: HookHandlerExecutedEvent) => void): () => void

  /**
   * 订阅 Fetch middleware onResponse 执行完毕事件（通用 observer）
   * 每次任意 middleware onResponse 执行后触发，携带 middlewareId、priority、modified 等
   * @returns 取消订阅的函数
   */
  onMiddlewareExecuted(observer: (ev: MiddlewareExecutedEvent) => void): () => void

  /**
   * 伽利略遥测上报器
   *
   * 每个 package 获取的 reporter 实例自动携带 packageId 作为 page_id。
   * 使用方式：ctx.reporter.report('click_new', { action: 'xxx' })
   */
  reporter: TelemetryReporter

  /** 原始 OpenClawPluginApi 引用（用于访问 api.config 等运行时属性，含已解析的 env 变量） */
  api: OpenClawPluginApi
}

// ============================================================================
// QClawPackage — 功能模块的标准接口
// ============================================================================

/** Package 定义接口 */
export interface QClawPackage {
  /** 唯一标识（保持原插件名） */
  id: string
  /** 显示名称 */
  name: string
  /** 描述 */
  description: string

  /** 配置 Schema（JSON Schema，additionalProperties 必须为 false） */
  configSchema?: {
    type: 'object'
    additionalProperties: false
    properties: Record<string, unknown>
  }

  /** 配置解析函数（支持环境变量 > pluginConfig > 默认值三层优先级） */
  parseConfig?(raw: unknown, env?: NodeJS.ProcessEnv): unknown

  /** 初始化方法 */
  setup(ctx: QClawContext): void | Promise<void>

  /** 可选：暴露给其他 package 的公开 API */
  getPublicApi?(): unknown

  /** 可选：销毁方法 */
  teardown?(): void | Promise<void>
}

// ============================================================================
// OpenClaw Plugin API 类型（简化版，仅声明 qclaw 需要的部分）
// ============================================================================

/** OpenClaw 插件 API（简化版） */
export interface OpenClawPluginApi {
  /** 运行时实例 */
  runtime: {
    stateDir: string
    version: string
    getConfig(): RuntimeConfig
    [key: string]: unknown
  }
  /** 插件配置 */
  pluginConfig?: Record<string, unknown>
  /** 注册 Hook */
  on(event: string, handler: (...args: unknown[]) => unknown): void
  /** 注册 Gateway 方法 */
  registerGatewayMethod?(method: string, handler: (...args: unknown[]) => unknown): void
  /** 注册 HTTP 路由 */
  registerHttpRoute?(route: unknown): void
  /** 注册命令 */
  registerCommand?(command: unknown): void
  /** 注册 Tool */
  registerTool?(tool: unknown, options?: unknown): void
  /** 注册 Service */
  registerService?(service: unknown): void
  /** 日志 */
  logger?: QClawLogger
  /** 其他 API 方法 */
  [key: string]: unknown
}

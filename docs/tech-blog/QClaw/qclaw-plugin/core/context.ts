/**
 * core/context.ts — QClawContext 工厂函数
 *
 * 为每个 package 创建独立的 QClawContext 实例，
 * 将 HookProxy、FetchChain、ConfigCenter 等核心模块的能力
 * 通过统一的 API 暴露给 package。
 */

import type {
  QClawContext,
  QClawPackage,
  OpenClawPluginApi,
  HookEvent,
  HookHandler,
  HookHandlerExecutedEvent,
  SyncHookEvent,
  SyncHookHandler,
  FetchMiddleware,
  MiddlewareExecutedEvent,
  GatewayMethodHandler,
  HttpRouteConfig,
  CommandConfig,
  ToolDefinition,
  ToolOptions,
  ServiceDefinition,
} from './types.js'
import type { HookProxy } from './hook-proxy.js'
import type { FetchChain } from './fetch-chain.js'
import type { ConfigCenter } from './config-center.js'
import type { GatewayRegistry } from './gateway-registry.js'
import type { HttpRouteRegistry } from './http-route-registry.js'
import type { CommandRegistry } from './command-registry.js'
import type { QClawReporter } from './reporter.js'
import { createLogger } from './logger.js'

/** createQClawContext 的依赖参数 */
export interface CreateContextOptions {
  api: OpenClawPluginApi
  packageId: string
  hookProxy: HookProxy
  fetchChain: FetchChain
  configCenter: ConfigCenter
  gatewayRegistry: GatewayRegistry
  httpRouteRegistry: HttpRouteRegistry
  commandRegistry: CommandRegistry
  /** 共享的伽利略上报器实例 */
  reporter: QClawReporter
  /** 获取其他 package 的公开 API */
  getPackageApi: (packageId: string) => unknown | undefined
}

/**
 * 为指定 package 创建 QClawContext 实例
 */
export function createQClawContext(options: CreateContextOptions): QClawContext {
  const {
    api,
    packageId,
    hookProxy,
    fetchChain,
    configCenter,
    gatewayRegistry,
    httpRouteRegistry,
    commandRegistry,
    reporter,
    getPackageApi,
  } = options

  const logger = createLogger(packageId)

  const ctx: QClawContext = {
    logger,

    onHook(
      event: HookEvent,
      handler: HookHandler,
      hookOptions?: { priority?: number; concurrent?: boolean },
    ): void {
      hookProxy.register(event, packageId, handler, hookOptions?.priority, hookOptions?.concurrent)
    },

    onSyncHook(
      event: SyncHookEvent,
      handler: SyncHookHandler,
      hookOptions?: { priority?: number },
    ): void {
      hookProxy.registerSync(event, packageId, handler, hookOptions?.priority)
    },

    registerFetchMiddleware(middleware: FetchMiddleware): void {
      fetchChain.register(middleware)
    },

    registerGatewayMethod(method: string, handler: GatewayMethodHandler): void {
      gatewayRegistry.register(packageId, method, handler)
    },

    registerHttpRoute(route: HttpRouteConfig): void {
      httpRouteRegistry.register(packageId, route)
    },

    registerCommand(command: CommandConfig): void {
      commandRegistry.register(packageId, command)
    },

    registerTool(tool: ToolDefinition, toolOptions?: ToolOptions): void {
      if (api.registerTool) {
        api.registerTool(tool, toolOptions)
        logger.info(`registered tool: ${tool.name}`)
      } else {
        logger.warn(`api.registerTool not available, skipping: ${tool.name}`)
      }
    },

    registerService(service: ServiceDefinition): void {
      // 兼容 OpenClaw 原生 Service 格式（使用 id 字段）和 QClawPackage ServiceDefinition（使用 name 字段）
      const serviceName = service.name ?? (service as unknown as { id?: string }).id ?? 'unknown'
      if (api.registerService) {
        // OpenClaw 原生 registerService 期望 { id, start?, stop? } 格式，
        // 需要将 QClawPackage 的 name 字段映射为 id
        const nativeService: Record<string, unknown> = { ...service, id: serviceName }
        api.registerService(nativeService)
        logger.info(`registered service: ${serviceName}`)
      } else {
        logger.warn(`api.registerService not available, skipping: ${serviceName}`)
      }
    },

    getConfig<T = Record<string, unknown>>(): T {
      return configCenter.getPackageConfig<T>(packageId)
    },

    onConfigChange<T = Record<string, unknown>>(callback: (config: T) => void): () => void {
      return configCenter.onConfigChange(packageId, (_pkgId, newConfig) => {
        callback(newConfig as T)
      })
    },

    runtime: {
      stateDir: api.runtime?.stateDir ?? '',
      version: api.runtime?.version ?? '',
      config: api.runtime?.getConfig?.() ?? {},
    },

    /** 原始 OpenClawPluginApi 引用（用于访问 api.config 等运行时属性） */
    api,

    getPackageApi<T = unknown>(targetPackageId: string): T | undefined {
      return getPackageApi(targetPackageId) as T | undefined
    },

    getOriginalFetch(): typeof fetch {
      return fetchChain.getOriginalFetch()
    },

    onHookHandlerExecuted(observer: (ev: HookHandlerExecutedEvent) => void): () => void {
      return hookProxy.onHandlerExecuted(observer)
    },

    onMiddlewareExecuted(observer: (ev: MiddlewareExecutedEvent) => void): () => void {
      return fetchChain.onMiddlewareExecuted(observer)
    },

    reporter: reporter.createPackageReporter(packageId),
  }

  return ctx
}

/**
 * core/gateway-registry.ts — Gateway 方法注册器
 *
 * 将 package 注册的 Gateway 方法统一代理到 OpenClaw 的 api.registerGatewayMethod。
 * 自动为方法名添加 qclaw-plugin.<packageId>. 前缀，同时注册不带前缀的短名称别名，
 * 保证外部调用方（UI 端、wechat-access 等）可以继续使用短名称调用。
 */

import type { GatewayMethodHandler, OpenClawPluginApi } from './types.js'

const LOG_TAG = '[qclaw-plugin:gateway-registry]'

export interface RegisteredGatewayMethod {
  packageId: string
  method: string
  fullMethod: string
  handler: GatewayMethodHandler
}

export class GatewayRegistry {
  private api: OpenClawPluginApi
  private methods: RegisteredGatewayMethod[] = []
  /** 已注册的短名称 → 来源 packageId，用于检测冲突 */
  private registeredShortMethods = new Map<string, string>()

  constructor(api: OpenClawPluginApi) {
    this.api = api
  }

  /**
   * 注册一个 Gateway 方法
   *
   * 同时注册两个方法名：
   * 1. 带前缀的完整方法名：qclaw-plugin.<packageId>.<method>
   * 2. 不带前缀的短名称别名：<method>（向后兼容外部调用方）
   *
   * 如果短名称已被其他 package 注册，仅打印 warn 日志，不覆盖。
   *
   * @param packageId 来源 package 的 ID
   * @param method 方法名（不含前缀）
   * @param handler 处理函数
   */
  register(packageId: string, method: string, handler: GatewayMethodHandler): void {
    const fullMethod = `qclaw-plugin.${packageId}.${method}`

    this.methods.push({ packageId, method, fullMethod, handler })

    // OpenClaw 运行时传给 gateway handler 的是完整请求上下文对象
    // （包含 req, params, client, respond, context 等字段），而非直接的 RPC params。
    // 这里创建包装 handler：
    //   1. 自动提取 params 字段传给 package handler
    //   2. 将 handler 的 return 值通过 respond 回调传回运行时
    // 使 package 代码可以像独立插件一样直接访问 RPC 参数，并用 return 代替 respond。
    const wrappedHandler = async (rawArgs: Record<string, unknown>) => {
      const actualParams = (rawArgs && typeof rawArgs === 'object' && 'params' in rawArgs)
        ? rawArgs.params as Record<string, unknown>
        : rawArgs
      const respond = typeof rawArgs?.respond === 'function'
        ? rawArgs.respond as (ok: boolean, payload?: unknown, error?: unknown) => void
        : null
      try {
        const result = await handler(actualParams)
        if (respond) {
          respond(true, result)
        }
        return result
      } catch (err) {
        if (respond) {
          respond(false, undefined, err)
        }
        throw err
      }
    }

    if (this.api.registerGatewayMethod) {
      // 注册带前缀的完整方法名
      this.api.registerGatewayMethod(fullMethod, wrappedHandler as (...args: unknown[]) => unknown)
      console.log(`${LOG_TAG} registered gateway method: ${fullMethod}`)

      // 注册不带前缀的短名称别名（向后兼容）
      const existingOwner = this.registeredShortMethods.get(method)
      if (existingOwner && existingOwner !== packageId) {
        console.warn(
          `${LOG_TAG} short method name "${method}" already registered by package "${existingOwner}", ` +
          `skipping alias for package "${packageId}"`,
        )
      } else {
        this.registeredShortMethods.set(method, packageId)
        this.api.registerGatewayMethod(method, wrappedHandler as (...args: unknown[]) => unknown)
        console.log(`${LOG_TAG} registered gateway method alias: ${method}`)
      }
    } else {
      console.warn(`${LOG_TAG} api.registerGatewayMethod not available, skipping: ${fullMethod}`)
    }
  }

  /**
   * 获取所有已注册的 Gateway 方法（用于调试/测试）
   */
  getMethods(): readonly RegisteredGatewayMethod[] {
    return this.methods
  }
}

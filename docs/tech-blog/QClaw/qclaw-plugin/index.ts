/**
 * qclaw — 主插件入口
 *
 * QClaw 自研功能统一入口。将多个功能模块（package）整合为一个插件，
 * 通过统一的 Hook 代理和 Fetch 中间件链协调执行。
 *
 * 当前 PACKAGES 列表为空（Step 0: 纯框架搭建）。
 * 后续迁移步骤会逐个将 package 添加到此列表中。
 */

import type { QClawPackage, OpenClawPluginApi } from './core/types.js'
import { HookProxy } from './core/hook-proxy.js'
import { FetchChain } from './core/fetch-chain.js'
import { ConfigCenter } from './core/config-center.js'
import { GatewayRegistry } from './core/gateway-registry.js'
import { HttpRouteRegistry } from './core/http-route-registry.js'
import { CommandRegistry } from './core/command-registry.js'
import { QClawReporter } from './core/reporter.js'
import { ELECTRON_REPORT_TOKEN, REPORT_URL } from './core/reporter-constants.js'
import { createQClawContext } from './core/context.js'

// ---- Package 导入 ----
import cronDeliveryGuard from './packages/cron-delivery-guard/index.js'
import pcmgrAiSecurity from './packages/pcmgr-ai-security/index.js'
import qmemoryPkg from './packages/qmemory/index.js'
import type { QMemoryPublicApi } from './packages/qmemory/index.js'
import contentPlugin from './packages/content-plugin/index.js'
import dataSyncReport from './packages/data-sync-report/index.js'
import errorResponseHandler from './packages/error-response-handler/index.js'
import promptOptimizer from './packages/prompt-optimizer/index.js'
import promptInspector from './packages/prompt-inspector/index.js'
import autoMemory from './packages/auto-memory/index.js'
import workspaceSummary from './packages/workspace-summary/index.js'
import agentBrowserReporter from './packages/agent-browser-reporter/index.js'
import traceSpanReporter from './packages/trace-span-reporter/index.js'
import skillInterceptor from './packages/skill-interceptor/index.js'
import skillUsageAnalyzer from './packages/skill-usage-analyzer/index.js'
import queueGuard from './packages/queue-guard/index.js'

const LOG_TAG = '[qclaw-plugin]'

/** register() 调用计数器（用于诊断 OpenClaw 多次调用 register 的场景） */
let registerCallCount = 0

/**
 * 所有功能 package 列表（顺序即初始化顺序）
 *
 * Step 0: 空数组，不迁移任何插件
 * 后续迁移步骤会逐个添加：
 *   Step 1: cron-delivery-guard ✅
 *   Step 2: tool-sandbox (已下线)
 *   Step 3: prompt-optimizer ✅
 *   Step 4: pcmgr-ai-security ✅
 *   Step 5: qmemory ✅
 *   Step 6a: shared（工具库，不是 package）✅
 *   Step 6b: content-plugin（整体迁移，不拆分 telemetry）✅
 *   Step 7: error-response-handler（HTTP 错误码 → SSE 友好响应）✅
 *   Step 8: skill-interceptor（Skill 拦截器）✅
 *   Step 9: queue-guard（模型排队守卫，L2 FetchMiddleware）✅
 */
const PACKAGES: QClawPackage[] = [
  traceSpanReporter,   // 最先初始化，priority=100 确保 Span 采集在其他 hook 之前执行
  errorResponseHandler,
  cronDeliveryGuard,
  promptOptimizer,
  pcmgrAiSecurity,
  skillInterceptor,
  queueGuard,          // 模型排队守卫（FetchMiddleware priority=300）
  qmemoryPkg,
  contentPlugin,
  dataSyncReport,
  workspaceSummary,
  skillUsageAnalyzer,
  autoMemory,
  agentBrowserReporter,
  promptInspector,  // 放在最后，FetchMiddleware priority=999 确保最后执行
]

/** 已初始化的 package 实例（用于 getPublicApi 跨 package 通讯） */
const initializedPackages = new Map<string, QClawPackage>()

const plugin = {
  id: 'qclaw-plugin',
  name: 'QClaw 主插件',
  description: 'QClaw 自研功能统一入口',

  configSchema: {
    type: 'object' as const,
    additionalProperties: false as const,
    properties: {},
  },

  register(api: OpenClawPluginApi) {
    registerCallCount++
    const registerStart = performance.now()
    console.log(
      `${LOG_TAG} [diag] register() START invocation=#${registerCallCount} packages=${PACKAGES.length}` +
      ` alreadyInitialized=[${Array.from(initializedPackages.keys()).join(',')}]`,
    )
    console.log(`${LOG_TAG} register() called (invocation #${registerCallCount}), initializing with ${PACKAGES.length} package(s)...`)

    // 初始化核心模块
    const configCenter = new ConfigCenter({
      staticConfig: (api.pluginConfig ?? {}) as Record<string, unknown>,
      configFilePath: process.env.QCLAW_PLUGIN_CONFIG_PATH || undefined,
    })
    const hookProxy = new HookProxy(api)
    const fetchChain = new FetchChain()
    const gatewayRegistry = new GatewayRegistry(api)
    const httpRouteRegistry = new HttpRouteRegistry(api)
    const commandRegistry = new CommandRegistry(api)

    // 初始化伽利略遥测上报器
    const reporter = new QClawReporter()
    reporter.init({
      logger: api.logger ?? console,
      openclawVersion: api.runtime?.version ?? '',
      reportToken: ELECTRON_REPORT_TOKEN,
      hostUrl: REPORT_URL,
      env: process.env.BUILD_ENV === 'production' ? 'production' : (process.env.BUILD_ENV || 'production'),
    })
    // 读取主进程共享参数，将 sessionId / deviceId 等带入公共参数
    const sharedParams = reporter.readSharedParams()
    reporter.setCommonParams({
      plugin_id: 'qclaw-plugin',
      platform: process.platform,
      ...(sharedParams.guid ? { guid: sharedParams.guid } : {}),
      ...(sharedParams.sessionId ? { sessionId: sharedParams.sessionId } : {}),
      ...(sharedParams.appVersion ? { app_version: sharedParams.appVersion } : {}),
      ...(sharedParams.appChannel ? { app_channel: sharedParams.appChannel } : {}),
    })

    // 获取其他 package 的公开 API
    const getPackageApi = (packageId: string): unknown | undefined => {
      const pkg = initializedPackages.get(packageId)
      return pkg?.getPublicApi?.()
    }

    // 按顺序初始化所有 package
    for (const pkg of PACKAGES) {
      const pkgStart = performance.now()
      try {
        const ctx = createQClawContext({
          api,
          packageId: pkg.id,
          hookProxy,
          fetchChain,
          configCenter,
          gatewayRegistry,
          httpRouteRegistry,
          commandRegistry,
          reporter,
          getPackageApi,
        })

        // 调用 package 的 setup 方法
        const result = pkg.setup(ctx)

        // 支持异步 setup（但 register 本身是同步的，所以异步 setup 会在后台执行）
        if (result instanceof Promise) {
          const asyncPkgId = pkg.id
          result
            .then(() => {
              console.log(`${LOG_TAG} [diag] async setup RESOLVED for ${asyncPkgId}`)
            })
            .catch((err) => {
              console.error(`${LOG_TAG} [diag] async setup REJECTED for ${asyncPkgId}:`, err instanceof Error ? err.message : err)
              console.error(`${LOG_TAG} async setup failed for ${asyncPkgId}:`, err)
            })
        }

        const pkgMs = (performance.now() - pkgStart).toFixed(1)
        initializedPackages.set(pkg.id, pkg)
        console.log(`${LOG_TAG} ✓ ${pkg.id} initialized (${pkgMs}ms${result instanceof Promise ? ', async pending' : ''})`)
      } catch (err) {
        const pkgMs = (performance.now() - pkgStart).toFixed(1)
        console.error(
          `${LOG_TAG} [diag] ✗ ${pkg.id} setup FAILED ${pkgMs}ms:`,
          err instanceof Error ? err.message : err,
        )
        console.error(`${LOG_TAG} ✗ ${pkg.id} setup failed:`, err)
      }
    }

    // ---- 注册非标 Hook 事件（不在 HookEvent 类型中的事件） ----
    // qmemory 需要 session_start / session_end 来管理任务生命周期，
    // 这些事件不被 HookProxy 支持，需要直接通过 api.on() 注册。
    const qmemoryApi = initializedPackages.get('qmemory')?.getPublicApi?.() as QMemoryPublicApi | undefined
    if (qmemoryApi) {
      api.on('session_start', (_event: unknown, ctx: unknown) => {
        const hookCtx = ctx as { sessionKey?: string; agentId?: string }
        if (hookCtx?.sessionKey && hookCtx?.agentId) {
          qmemoryApi.onSessionStart(hookCtx.sessionKey, hookCtx.agentId)
        }
      })
      api.on('session_end', (_event: unknown, ctx: unknown) => {
        const hookCtx = ctx as { sessionKey?: string }
        if (hookCtx?.sessionKey) {
          qmemoryApi.onSessionEnd(hookCtx.sessionKey)
        }
      })
      console.log(`${LOG_TAG} registered session_start/session_end hooks for qmemory`)
    }

    // 安装 FetchChain（无条件安装，支持 package 延迟注册中间件）
    fetchChain.install()

    const registerMs = (performance.now() - registerStart).toFixed(1)
    console.log(
      `${LOG_TAG} [diag] register() END ${registerMs}ms initialized=${initializedPackages.size}/${PACKAGES.length}` +
      ` middlewares=[${fetchChain.getMiddlewares().map((m) => `${m.id}(${m.priority})`).join(',')}]`,
    )
    console.log(
      `${LOG_TAG} initialized ${initializedPackages.size}/${PACKAGES.length} package(s)`,
    )
  },
}

export default plugin

/**
 * data-sync-report — 数据同步上报 Package
 *
 * 监听 Agent 配置和 Cron 任务变化，实时同步上报到后端。
 *
 * 核心能力：
 * - Service: SyncService（后台服务，管理 Watcher/Reporter/StateManager）
 * - HTTP 路由: /identity（接收主端推送的用户身份信息）
 *
 * 迁移自: extensions/data-sync-report/
 */

import type {
  QClawPackage,
  QClawContext,
  HttpRequest,
  HttpResponse,
} from '../../core/types.js'

import { SyncService } from './src/sync-service.js'
import { PLUGIN_ID, SERVICE_ID } from './src/constants.js'
import { setUserIdentity } from './src/user-identity-store.js'

const dataSyncReport: QClawPackage = {
  id: PLUGIN_ID,
  name: 'Data Sync Report',
  description:
    'Monitors Agent configuration and Cron task changes in real-time, providing data synchronization and reporting capabilities.',

  configSchema: {
    type: 'object',
    additionalProperties: false as const,
    properties: {},
  },

  setup(ctx: QClawContext): void {
    const logger = ctx.logger
    // 获取原始 fetch（绕过 FetchChain 拦截链），供 reporter API 调用使用
    const originalFetch = ctx.getOriginalFetch()
    // 获取伽利略遥测上报器，供内部模块上报数据使用
    const telemetryReporter = ctx.reporter

    const syncService = new SyncService()

    // ─── 注册后台服务 ───
    // 对齐旧插件的 api.registerService() → ctx.registerService()
    // SyncService 的 start/stop 由 OpenClaw 的 Service 生命周期管理
    ctx.registerService({
      name: SERVICE_ID,
      async start(svcCtx: unknown) {
        const serviceCtx = svcCtx as {
          config: unknown
          workspaceDir?: string
          stateDir: string
          logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void; debug: (...args: unknown[]) => void }
        }
        await syncService.start({
          config: serviceCtx.config,
          workspaceDir: serviceCtx.workspaceDir,
          stateDir: serviceCtx.stateDir,
          logger: serviceCtx.logger,
          fetchFn: originalFetch,
          telemetryReporter,
        })
      },
      async stop(svcCtx: unknown) {
        const serviceCtx = svcCtx as {
          config: unknown
          workspaceDir?: string
          stateDir: string
          logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void; debug: (...args: unknown[]) => void }
        }
        await syncService.stop({
          config: serviceCtx.config,
          workspaceDir: serviceCtx.workspaceDir,
          stateDir: serviceCtx.stateDir,
          logger: serviceCtx.logger,
        })
      },
    })

    // ─── 注册用户身份推送 HTTP 端点 ───
    // 主端通过此端点推送登录/退出登录事件：
    // - action: 'login'  — 携带 userId + token，触发 SyncService 激活
    // - action: 'logout' — 触发 SyncService 停用

    ctx.registerHttpRoute({
      method: 'POST',
      path: '/identity',
      handler: async (req: HttpRequest): Promise<HttpResponse> => {
        const body = req.body as Record<string, unknown> | undefined
        const action = typeof body?.action === 'string' ? body.action : ''
        const userId = typeof body?.userId === 'string' ? body.userId : ''
        const token = typeof body?.token === 'string' ? body.token : ''
        const guid = typeof body?.guid === 'string' ? body.guid : ''

        if (action === 'logout') {
          setUserIdentity({ userId: '', token: '', guid: '' })
          logger.info('==data-sync-report插件==动作:收到退出登录事件==')
          return { status: 200, body: { success: true, action: 'logout' } }
        }

        // action === 'login' 或未传 action（兼容旧版本主端）
        if (!userId) {
          return { status: 400, body: { success: false, error: 'userId is required for login' } }
        }

        setUserIdentity({ userId, token, guid })
        return { status: 200, body: { success: true, action: 'login' } }
      },
    })
  },
}

export default dataSyncReport

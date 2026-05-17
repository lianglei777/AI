/**
 * pcmgr-ai-security — QClawPackage 入口
 *
 * 电脑管家 AI 安全插件，提供 Prompt 安全检测、工具调用审计、
 * Skill 加载审计、脚本写入审计和不受信目录可执行文件拦截能力。
 */

import path from "node:path";

import type { QClawPackage, QClawContext, HttpRequest, HttpResponse } from '../../core/types.js'

import { LLMShieldClient, ContentType } from "./src/client.js";
import { setEndpointEnv, getEndpointEnv, getModerateUrl, type EndpointEnv } from "./src/endpoints.js";
import { getDeviceFingerprint } from "./src/utils.js";
import { MessageCache } from "./src/cache.js";
import { setSecurityConfig, getDeviceFingerprintValue } from "./src/security.js";
import { createFetchMiddleware } from "./src/interceptor.js";
import { createBeforeToolCallHandler } from "./src/hooks.js";
import { LOG_TAG } from "./src/constants.js";
import { fileLog } from "./src/logger.js";
import { setPendingSessionKey } from "./src/session-bridge.js";
import {
  initSwitches,
  getSwitches,
  updateSwitches,
  pullRemoteConfig,
} from "./src/runtime-config.js";
import { initAuditReporter } from "./src/audit-log-reporter.js";

/** 从 Package config 中解析各项开关和配置 */
interface PcmgrConfig {
  appId?: string;
  stateDir?: string;
  logRecord?: boolean;
  failureThreshold?: number;
  cooldownSeconds?: number;
  timeoutMs?: number;
  softid?: number;
  auditReportUrl?: string;
  env?: string;
  /** Prompt 安全检测开关（持久化到 qclaw-plugin-config.json） */
  enablePromptAudit?: boolean;
  /** Skill 加载审计开关（持久化到 qclaw-plugin-config.json） */
  enableSkillAudit?: boolean;
  /** 脚本写入审计开关（持久化到 qclaw-plugin-config.json） */
  enableScriptAudit?: boolean;
  /** before_tool_call Pipeline audit */
  enableToolCallAudit?: boolean;
  toolCallAuditTimeoutMs?: number;
}

/** 验证端点可用性（发一次测试请求） */
async function verifyEndpoint(logger: { debug: (msg: string) => void; error: (msg: string) => void }, client: LLMShieldClient, appId: string): Promise<boolean> {
  const url = getModerateUrl();
  const env = getEndpointEnv();
  logger.debug(`[${LOG_TAG}] Verifying endpoint: ${url}`);
  fileLog(`[verifyEndpoint] start | env=${env} | url=${url} | appId=${appId}`);
  try {
    await client.moderate(
      {
        Message: {
          Role: "user",
          MultiPart: [{ Content: "hello", ContentType: ContentType.TEXT }],
        },
        Scene: appId,
      },
      { "X-Device-Fingerprint": getDeviceFingerprintValue() }
    );
    fileLog(`[verifyEndpoint] success`);
    return true;
  } catch (e: any) {
    const detail = [
      `[verifyEndpoint] FAILED`,
      `  url: ${url}`,
      `  env: ${env}`,
      `  appId: ${appId}`,
      `  error.name: ${e.name}`,
      `  error.message: ${e.message}`,
      `  error.cause: ${e.cause?.message ?? "N/A"}`,
      `  error.status: ${e.status ?? "N/A"}`,
      `  error.body: ${typeof e.body === "string" ? e.body : JSON.stringify(e.body ?? null)}`,
      `  stack: ${e.stack}`,
    ].join("\n");
    fileLog(detail);
    logger.error(
      `[${LOG_TAG}] Registration failed: Verification failed for endpoint ${url}. Please check your network, apiKey, or appId configuration. Error: ${e.message || e}`
    );
    return false;
  }
}

/** 缓存 LLMShieldClient 实例，供 HTTP route handler 跨 setup 调用复用 */
let _client: LLMShieldClient | null = null;


const pcmgrAiSecurity: QClawPackage = {
  id: 'pcmgr-ai-security',
  name: 'PCMgr AI Security',
  description: '电脑管家 AI 安全插件 - 提供 Prompt 安全检测、工具调用审计、Skill 加载审计和脚本写入审计能力。',

  configSchema: {
    type: 'object' as const,
    additionalProperties: false as const,
    properties: {
      appId: { type: 'string', description: '审核服务 Scene ID' },
      stateDir: { type: 'string', description: '状态目录路径' },
      logRecord: { type: 'boolean', description: '是否记录详细日志' },
      failureThreshold: { type: 'number', description: '熔断器连续失败阈值' },
      cooldownSeconds: { type: 'number', description: '熔断冷却时间（秒）' },
      timeoutMs: { type: 'number', description: 'HTTP 请求超时（毫秒）' },
      softid: { type: 'number', description: '软件 ID' },
      auditReportUrl: { type: 'string', description: '审计日志上报 URL' },
      env: { type: 'string', description: '端点环境（test/production）' },
      enablePromptAudit: { type: 'boolean', description: 'Prompt 安全检测开关' },
      enableSkillAudit: { type: 'boolean', description: 'Skill 加载审计开关' },
      enableScriptAudit: { type: 'boolean', description: '脚本写入审计开关' },
      enableToolCallAudit: { type: 'boolean', description: '是否启用工具调用 Pipeline 审核' },
      toolCallAuditTimeoutMs: { type: 'number', description: 'Pipeline 审核超时（毫秒）' },
    },
  },

  async setup(ctx: QClawContext): Promise<void> {
    const logger = ctx.logger;

    // ================================================================
    // Phase 1: HTTP 路由注册（每次 setup 都执行）
    //
    // OpenClaw 会调用 register() 两次（插件加载 + gateway 启动），
    // 只有 gateway 阶段注册的路由才会被 HTTP 服务器识别，
    // 因此 HTTP 路由注册不能被防重入标记跳过。
    // ================================================================
    logger.debug(`[${LOG_TAG}] setup() — registering HTTP routes`);

    // ---- 注册动态配置 HTTP endpoint ----
    // GET: 获取当前开关状态
    ctx.registerHttpRoute({
      method: 'GET',
      path: '/config',
      handler: async (_req: HttpRequest): Promise<HttpResponse> => {
        return {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: getSwitches(),
        };
      },
    });

    // POST: 更新开关状态
    ctx.registerHttpRoute({
      method: 'POST',
      path: '/config',
      handler: async (req: HttpRequest): Promise<HttpResponse> => {
        const body = req.body as Record<string, unknown>;
        const updated = updateSwitches(body as any);
        fileLog(`[config] switches updated: ${JSON.stringify(updated)}`);
        logger.info(`[${LOG_TAG}] Config updated: ${JSON.stringify(updated)}`);
        return {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: { success: true, config: updated },
        };
      },
    });

    // PUT: 更新开关状态（兼容）
    ctx.registerHttpRoute({
      method: 'PUT',
      path: '/config',
      handler: async (req: HttpRequest): Promise<HttpResponse> => {
        const body = req.body as Record<string, unknown>;
        const updated = updateSwitches(body as any);
        fileLog(`[config] switches updated: ${JSON.stringify(updated)}`);
        logger.info(`[${LOG_TAG}] Config updated: ${JSON.stringify(updated)}`);
        return {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: { success: true, config: updated },
        };
      },
    });

    // ---- 注册 token 动态更新 HTTP endpoint ----
    ctx.registerHttpRoute({
      method: 'POST',
      path: '/token',
      handler: async (req: HttpRequest): Promise<HttpResponse> => {
        try {
          const body = req.body as Record<string, unknown>;
          const newToken = typeof body.encryptedUserToken === "string" ? body.encryptedUserToken : "";
          if (newToken && _client) {
            _client.setEncryptedUserToken(newToken);
            fileLog(`[token] encrypted user token updated (length=${newToken.length})`);
            logger.info(`[${LOG_TAG}] Encrypted user token updated dynamically.`);
            return {
              status: 200,
              headers: { "Content-Type": "application/json" },
              body: { success: true },
            };
          } else {
            return {
              status: 400,
              headers: { "Content-Type": "application/json" },
              body: { success: false, error: newToken ? "client not initialized" : "encryptedUserToken is required" },
            };
          }
        } catch (e: any) {
          fileLog(`[token] parse error: ${e.message}`);
          return {
            status: 400,
            headers: { "Content-Type": "application/json" },
            body: { success: false, error: `Invalid JSON: ${e.message}` },
          };
        }
      },
    });

    // PUT: token（兼容）
    ctx.registerHttpRoute({
      method: 'PUT',
      path: '/token',
      handler: async (req: HttpRequest): Promise<HttpResponse> => {
        try {
          const body = req.body as Record<string, unknown>;
          const newToken = typeof body.encryptedUserToken === "string" ? body.encryptedUserToken : "";
          if (newToken && _client) {
            _client.setEncryptedUserToken(newToken);
            fileLog(`[token] encrypted user token updated (length=${newToken.length})`);
            logger.info(`[${LOG_TAG}] Encrypted user token updated dynamically.`);
            return {
              status: 200,
              headers: { "Content-Type": "application/json" },
              body: { success: true },
            };
          } else {
            return {
              status: 400,
              headers: { "Content-Type": "application/json" },
              body: { success: false, error: newToken ? "client not initialized" : "encryptedUserToken is required" },
            };
          }
        } catch (e: any) {
          fileLog(`[token] parse error: ${e.message}`);
          return {
            status: 400,
            headers: { "Content-Type": "application/json" },
            body: { success: false, error: `Invalid JSON: ${e.message}` },
          };
        }
      },
    });

    // ================================================================
    // Phase 2: 初始化 & 注册 Hook/FetchMiddleware
    //
    // 框架层 FetchChain 已做全局单例 + 按 id 去重，HookProxy 已做
    // api.on() 单次注册 + handler 列表管理，无需插件自行防重。
    // ================================================================

    logger.debug(`[${LOG_TAG}] setup()`);

    // ---- 解析配置 ----
    const pluginCfg = ctx.getConfig<PcmgrConfig>();
    const { appId = '' } = pluginCfg;

    const logRecord = pluginCfg.logRecord !== undefined ? Boolean(pluginCfg.logRecord) : false;
    // 审计开关从 ConfigCenter 持久化配置读取（由 Electron 端写入 qclaw-plugin-config.json），
    // 未配置时默认全开
    const enablePromptAudit = pluginCfg.enablePromptAudit ?? true;
    const enableSkillAudit = pluginCfg.enableSkillAudit ?? true;
    const enableScriptAudit = pluginCfg.enableScriptAudit ?? true;
    const enableToolCallAudit = pluginCfg.enableToolCallAudit ?? true;

    let stateDir: string;
    if (pluginCfg.stateDir !== undefined) {
      stateDir = pluginCfg.stateDir;
    } else {
      // ctx.runtime.stateDir 在插件加载阶段可能还没初始化（为空字符串），
      // 需要回退到环境变量（与 qmemory 包保持一致）
      stateDir = ctx.runtime.stateDir
        || process.env.OPENCLAW_STATE_DIR?.trim()
        || process.env.CLAWDBOT_STATE_DIR?.trim()
        || '';
      logger.debug(`[${LOG_TAG}] stateDir: ${stateDir}`);
    }

  const auditReportUrl = typeof pluginCfg.auditReportUrl === "string" ? pluginCfg.auditReportUrl : "http://localhost";

    const toolCallAuditTimeoutMs =
      pluginCfg.toolCallAuditTimeoutMs !== undefined
        ? Number(pluginCfg.toolCallAuditTimeoutMs)
        : undefined;
    // 从环境变量获取 AES 加密后的用户 token（由 Electron 主进程 createCleanEnv() 加密后注入）
    const userToken = process.env.QCLAW_USER_TOKEN_ENCRYPTED ?? "";

    // ---- 环境切换（先于日志输出，使 fileLog 记录的 env 反映实际生效值）----
    if (pluginCfg.env) {
      const env = pluginCfg.env as EndpointEnv;
      setEndpointEnv(env);
      logger.info(`[${LOG_TAG}] Endpoint environment set to "${env}".`);
    } else {
      logger.debug(`[${LOG_TAG}] Using default endpoint environment: "${getEndpointEnv()}".`);
    }

    fileLog(`[setup] start | version=1.0.2`);
    fileLog(`[setup] config: appId=${appId} env=${pluginCfg.env ?? "(default)"} userToken=${userToken ? "(set)" : "(empty)"}`);
    fileLog(
      `[setup] flags: promptAudit=${enablePromptAudit} skillAudit=${enableSkillAudit} scriptAudit=${enableScriptAudit} logRecord=${logRecord} toolCallAudit=${enableToolCallAudit}`,
    );

    // ---- 初始化运行时开关 ----
    initSwitches({
      enablePromptAudit,
      enableSkillAudit,
      enableScriptAudit,
      auditReportUrl,
      enableToolCallAudit,
      toolCallAuditTimeoutMs,
    });

    // ---- 监听 ConfigCenter 配置变更（qclaw-plugin-config.json），实现热更新 ----
    ctx.onConfigChange<Partial<PcmgrConfig>>((newConfig) => {
      updateSwitches(newConfig as any);
      logger.info(`[${LOG_TAG}] Config changed via ConfigCenter: ${JSON.stringify(getSwitches())}`);
      fileLog(`[config-change] switches updated via ConfigCenter: ${JSON.stringify(getSwitches())}`);
    });

    // ---- Security & cache setup ----
    setSecurityConfig({ deviceFingerprint: getDeviceFingerprint() });

    const messageCachePath = path.join(stateDir, "pcmgr-ai-security_cache.json");
    const messageCache = new MessageCache(messageCachePath, logger, LOG_TAG);

    setSecurityConfig({
      failureThreshold: pluginCfg.failureThreshold !== undefined ? Number(pluginCfg.failureThreshold) : undefined,
      cooldownMs: pluginCfg.cooldownSeconds !== undefined ? Number(pluginCfg.cooldownSeconds) * 1000 : undefined,
    });

    // ---- 初始化审计日志模块（注入原始 fetch） ----
    const originalFetch = ctx.getOriginalFetch();
    initAuditReporter(originalFetch);

    // ---- 创建 LLMShieldClient（使用原始 fetch，审核 API 请求不应被自身拦截） ----
    const client = new LLMShieldClient({
      gid: getDeviceFingerprintValue(),
      timeoutMs: pluginCfg.timeoutMs ? Number(pluginCfg.timeoutMs) : undefined,
      encryptedUserToken: userToken,
      fetchFn: originalFetch,
    });
    _client = client; // 缓存供 HTTP route handler 使用

    // ---- 注册 FetchMiddleware（框架层 FetchChain 按 id 去重，无需插件防重） ----
    const shieldHost = new URL(getModerateUrl()).origin;
    ctx.registerFetchMiddleware(createFetchMiddleware({
      logger, client, sceneId: appId, enableLogging: logRecord,
      messageCache, modes: ["security", "audit"], shieldHost,
    }));
    fileLog(`[setup] FetchMiddleware registered`);

    // ---- 注册 before_tool_call Hook ----
    ctx.onHook(
      'before_tool_call',
      createBeforeToolCallHandler({
        logger, client, appId, stateDir, logRecord,
      }),
      { priority: 250 },
    );

    // ---- 注册 llm_input Hook：独立维护 sessionKey，不依赖 content-plugin 队列 ----
    ctx.onHook('llm_input', (event: Record<string, unknown>, hookCtx: Record<string, unknown>) => {
      const sessionKey = (hookCtx.sessionKey || hookCtx.sessionId || '') as string;
      const model = (event.model || '') as string;
      const runId = (event.runId || hookCtx.runId || hookCtx.sessionId || '') as string;
      if (sessionKey) {
        setPendingSessionKey(sessionKey);
        fileLog(`[llm_input] sessionKey=${sessionKey} model=${model} runId=${runId}`);
      } else {
        fileLog(`[llm_input] sessionKey=(empty) model=${model} runId=${runId}`);
      }
    });

    // ---- Async initialization ----
    // 启动时拉取远程配置
    await pullRemoteConfig(originalFetch);
    fileLog(`[setup] effective config after pull: ${JSON.stringify(getSwitches())}`);

    logger.info(
      `[${LOG_TAG}] Package initialized (promptAudit:${getSwitches().enablePromptAudit}, skillAudit:${getSwitches().enableSkillAudit}, scriptAudit:${getSwitches().enableScriptAudit}, toolCallAudit:${getSwitches().enableToolCallAudit}).`
    );
  },
};

/** @internal 仅供测试使用：重置模块状态 */
export function _resetSetupState(): void {
  _client = null;
}

export default pcmgrAiSecurity;

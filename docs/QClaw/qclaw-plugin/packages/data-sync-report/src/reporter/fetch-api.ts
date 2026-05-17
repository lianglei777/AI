/**
 * 数据同步上报插件 - 统一 API 请求封装
 *
 * 封装所有后端接口的公共请求逻辑：
 * - 自动注入 Content-Type 和 X-Openclaw-Token
 * - 统一处理网络异常、HTTP 状态码、业务 code 判断
 * - 统一日志输出
 * - 返回 [data, error] 元组，调用方无需 try/catch
 *
 * 所有后端接口的响应体都遵循统一结构：
 * { ret: number, data: { resp: { common: { code, message }, data: {...} } } }
 */

import type { Logger } from "../types.js";
import type { TelemetryReporter } from "../../../../core/reporter-types.js";
import { API_REQUEST_TIMEOUT_MS, getJprxBaseUrl } from "../constants.js";
import { getUserIdentity } from "../user-identity-store.js";


/**
 * 后端接口统一响应结构
 *
 * 所有接口的 resp.common 部分一致，resp.data 部分各接口不同（通过泛型传入）
 */
export interface ApiResponse<T = unknown> {
  ret: number;
  data?: {
    resp?: {
      common?: {
        code: number;
        message: string;
      };
      data?: T;
    };
  };
}

/** fetchApi 的返回元组：[业务数据, 错误信息]，二者互斥 */
export type FetchApiResult<T> = [T, null] | [null, string];

export interface FetchApiOptions {
  /** API 路径（如 "/data/4174/forward"），会自动拼接 JPRX 网关基础 URL */
  readonly apiPath: string;
  /** 请求体（会自动 JSON.stringify） */
  readonly body: unknown;
  /** 日志记录器 */
  readonly logger: Logger;
  /** 调用方标识（用于日志前缀，如 "AgentSyncApi"） */
  readonly logTag: string;
  /** fetch 函数（通过 ctx.getOriginalFetch() 获取，绕过 FetchChain） */
  readonly fetchFn?: typeof globalThis.fetch;
  /** 伽利略遥测上报器（通过 ctx.reporter 获取） */
  readonly telemetryReporter?: TelemetryReporter;
}

/**
 * 统一 API 请求方法
 *
 * 封装了完整的请求生命周期：
 * 1. 构造 URL 和 headers（自动注入 token）
 * 2. 发起 POST 请求（带超时）
 * 3. 检查 HTTP 状态码（非 2xx → 错误）
 * 4. 解析响应 JSON
 * 5. 检查业务 code（非 0 → 错误，打印 message）
 * 6. 返回 [data, null] 或 [null, errorMessage]
 *
 * @returns [respData, null] 成功时返回 resp.data 部分；[null, error] 失败时返回错误描述
 */
export async function fetchApi<T = unknown>(
  options: FetchApiOptions
): Promise<FetchApiResult<T>> {
  const { apiPath, body, logger, logTag, fetchFn = globalThis.fetch, telemetryReporter } = options;
  const { token, userId, guid } = getUserIdentity();

  const url = `${getJprxBaseUrl()}${apiPath}`;

  let result: FetchApiResult<T>;
  let errorMsg: string | null = null;
  let respJson: ApiResponse<T> | null = null;

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers["X-Openclaw-Token"] = token;
    }

    const response = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
    });

    // 1. HTTP 状态码检查
    if (!response.ok) {
      errorMsg = `HTTP ${response.status} ${response.statusText}`;
      result = [null, errorMsg];
      return result;
    }

    // 2. 解析 JSON 响应 + 业务 code 检查
    respJson = (await response.json()) as ApiResponse<T>;
    const code = respJson.data?.resp?.common?.code;
    const message = respJson.data?.resp?.common?.message;

    if (code !== 0) {
      errorMsg = `code=${code}, message="${message}"`;
      result = [null, errorMsg];
      return result;
    }

    // 3. 成功
    const respData = (respJson.data?.resp?.data ?? null) as T;
    result = [respData, null];
    return result;
  } catch (error) {
    errorMsg = error instanceof Error ? error.message : String(error);
    result = [null, errorMsg];
    return result;
  } finally {
    if (errorMsg) {
      logger.error(
        `==data-sync-report插件==动作请求:${logTag}请求失败==参数==error="${errorMsg}", body=${JSON.stringify(body)}, api="${apiPath}"`
      );
    } else {
      logger.info(
        `==data-sync-report插件==动作请求:${logTag}请求成功==参数==body=${JSON.stringify(body)}, response=${JSON.stringify(respJson)}, api="${apiPath}"`
      );
    }
    // 伽利略遥测上报：将请求的 body 数据上报
    if (telemetryReporter) {
      telemetryReporter.report('data_sync_report_api_request', {
        api_path: apiPath,
        log_tag: logTag,
        success: errorMsg === null,
        error: errorMsg ?? undefined,
        body: typeof body === 'object' ? JSON.stringify(body) : body,
        resp_data: typeof respJson === 'object' && respJson !== null ? JSON.stringify(respJson) : respJson ?? undefined,
        guid: guid || undefined,
        user_id: userId || undefined,
      });
    }
  }
}

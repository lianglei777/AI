import type {
  CreateTaskClientOptions,
  CreateTaskRequest,
  CreateTaskResponse,
  MediaItem,
  SessionType,
  SceneType,
} from "./types.js";
import { generateRequestId, getCurrentTimestamp, generateTraceparent, writeSecurityLog } from "./utils.js";

/** createTask 返回结果，包含业务响应和本次请求的 traceId */
export interface CreateTaskResult {
  response: CreateTaskResponse;
  /** 本次请求注入的 traceparent 中的 trace-id 部分 */
  traceId: string;
  /** 本次请求生成的唯一 request_id */
  requestId: string;
}

export class HttpError extends Error {
  status: number;
  statusText: string;
  body: any;

  constructor(message: string, status: number, statusText: string, body: any) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

export class CreateTaskClient {
  private endpoint: string;
  private openclawChannelToken: string;
  private timeoutMs: number;

  private fetchFn: typeof fetch;

  constructor(options: CreateTaskClientOptions) {
    this.endpoint = options.endpoint;
    this.openclawChannelToken = options.openclawChannelToken;
    this.timeoutMs = options.timeoutMs ?? 5000;

    const fn = options.fetchFn ?? globalThis.fetch;
    if (!fn) {
      throw new Error("global fetch 不可用，请提供 fetchFn 参数");
    }
    this.fetchFn = fn.bind(globalThis);
  }

  setToken(token: string) {
    this.openclawChannelToken = token;
  }

  /** 获取审核接口地址 */
  getEndpoint(): string {
    return this.endpoint;
  }


  async createTask(
    scene: SceneType,
    media: MediaItem[],
    sessionId: string,
    sessionType: SessionType,
    qaid?: string,
    /** 外部传入的 traceId，同一轮 LLM 调用共享 */
    externalTraceId?: string,
    /** 外部传入的 spanId，作为审核请求 traceparent 的 parent-id，关联到当前 LLM span */
    externalSpanId?: string,
    /** 伽利略 traceId，注入到请求 header 方便安全审核日志与链路匹配 */
    galileoTraceId?: string,
    extra?: Record<string, string>
  ): Promise<CreateTaskResult> {
    // 每次请求生成唯一的 request_id，用于链路追踪
    const requestId = generateRequestId();

    // endpoint 为空 → 前端送审已下线到后端，直接返回"通过"响应，不发出任何 HTTP 请求
    if (!this.endpoint) {
      return {
        response: {
          common: { code: 0, message: "bypass" },
          data: {
            ResultCode: 0,      // ResultCode.PASS
            ResultTypeLevel: 0, // 低于默认 blockLevel
            TraceID: "",
          },
        },
        traceId: "",
        requestId,
      };
    }

    const request: CreateTaskRequest = {
      scene,
      request_id: requestId,
      openclaw_channel_token: this.openclawChannelToken,
      data: {
        Comm: {
          // SendTime 要求秒级 Unix 时间戳
          SendTime: getCurrentTimestamp(),
        },
        Content: {
          SessionID: sessionId,
          SessionType: sessionType,
          Msg: {
            Media: media,
            MsgMap: {},
          },
          // QAID 仅在有值时传入，避免接口报参数错误
          ...(qaid ? { QAID: qaid } : {}),
          ...extra
        },
      },
    };

    const url = this.endpoint;
    // AbortController 用于实现请求超时：超时后 abort() 会让 fetch 抛出 AbortError
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    // 使用外部传入的 traceId（同一轮 LLM 调用共享），spanId 关联到当前 LLM span
    const { traceparent, traceId } = generateTraceparent(externalTraceId, externalSpanId);

    try {
      const resp = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "traceparent": traceparent,
          ...(galileoTraceId ? { "X-Galileo-Trace-ID": galileoTraceId } : {}),
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      const text = await resp.text();

      // HTTP 状态码非 200 时，尝试解析响应体后抛出 HttpError
      if (resp.status !== 200) {
        let parsed: any = text;
        try {
          parsed = text ? JSON.parse(text) : text;
        } catch {
          // JSON 解析失败，保留原始文本作为 body
        }
        throw new HttpError(
          `CreateTask 请求失败，状态码 ${resp.status}`,
          resp.status,
          resp.statusText,
          parsed,
        );
      }

      try {
        const rawResponse = text ? JSON.parse(text) : {};
        const response: CreateTaskResponse = rawResponse?.data?.resp ?? rawResponse;
        // 检查业务层面的错误（HTTP 200 但 common.code !== 0）
        if (response.common && response.common.code !== 0) {
          throw new HttpError(
            `CreateTask 业务错误: code=${response.common.code} - ${response.common.message}`,
            400,
            "Business Error",
            response,
          );
        }

        // 写入本地日志：记录发送给服务端的输入和服务端返回的输出
        // writeSecurityLog("送审→  请求体", {
        //   requestId,
        //   sessionId,
        //   sessionType,
        //   scene,
        //   qaid: qaid ?? "",
        //   body: request.data,
        // });
        // writeSecurityLog("←送审  响应体", {
        //   requestId,
        //   sessionId,
        //   sessionType,
        //   scene,
        //   resultCode: response.data?.ResultCode ?? "",
        //   resultType: response.data?.ResultType ?? "",
        //   resultTypeLevel: response.data?.ResultTypeLevel ?? "",
        //   traceID: response.data?.TraceID ?? "",
        //   commonCode: response.common?.code ?? "",
        //   commonMessage: response.common?.message ?? "",
        // });

        return { response, traceId, requestId };
      } catch (e: any) {
        if (e instanceof HttpError) throw e;
        throw new Error(`JSON 解析失败: ${e.message}`, { cause: e });
      }
    } catch (e: any) {
      throw e;
    } finally {
      // 无论成功还是失败，都要清除超时定时器，避免内存泄漏
      clearTimeout(timeoutId);
    }
  }

  /**
   * 连通性探测：发送一个最简请求检测接口是否可用
   *
   * 用于熔断降级后的恢复探测：
   * - 发送固定内容 "hello" 作为探测请求
   * - 成功返回 true，任何错误返回 false
   * - 不抛出异常，调用方无需 try/catch
   *
   * @param scene - 场景标识（使用 "prompt" 即可）
   * @param sessionId - 会话ID
   * @returns 接口是否可用
   */
  async ping(scene: SceneType, sessionId: string): Promise<boolean> {
    try {
      await this.createTask(
        scene,
        [{ Data: "hello", MediaType: "Text" }],
        sessionId,
        1 as SessionType, // SessionType.QUESTION
      );
      return true;
    } catch {
      return false;
    }
  }
}

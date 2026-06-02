/**
 * 多模态内容安全审核客户端
 *
 * 封装 4287 riskControl 接口，支持：
 * - 图片审核 (image_to_text_input / image_text_to_text_input)
 * - 文件审核 (file_to_text_input / file_text_to_text_input)
 *
 * 审核内容的图片/文件需要先通过 CosClient 上传到 COS 获取永久 URL，
 * 再将 URL 传入本接口审核。
 *
 * 自带熔断降级逻辑（与 security.ts 中的文本审核独立，互不影响）。
 */

import type {
  MultimodalSecurityClientOptions,
  MultimodalScene,
  RiskControlMediaItem,
  RiskControlResponse,
  MultimodalSecurityCheckResult,
} from "./types.js";
import { generateRequestId, generateTraceparent, writeSecurityLog } from "./utils.js";

export class MultimodalSecurityClient {
  private endpoint: string;
  private openclawChannelToken: string;
  private timeoutMs: number;
  private fetchFn: typeof fetch;
  private log: { info(msg: string, ...args: unknown[]): void };
  private clientVersionGetter: () => string;

  // ─── 熔断降级状态（独立于文本审核） ───
  private isDegraded = false;
  private isProbing = false;
  private consecutiveFailures = 0;
  private lastRetryTime = 0;
  private failureThreshold = 3;
  private baseRetryIntervalMs = 60_000;
  private currentRetryIntervalMs = 60_000;
  private maxRetryIntervalMs = 3_600_000;

  constructor(options: MultimodalSecurityClientOptions) {
    this.endpoint = options.endpoint;
    this.openclawChannelToken = options.openclawChannelToken;
    this.timeoutMs = options.timeoutMs ?? 10000;
    const cv = options.clientVersion;
    this.clientVersionGetter = typeof cv === 'function' ? cv : () => cv ?? '';
    this.log = options.logger ?? { info: (...args: unknown[]) => console.log(...args) };

    const fn = options.fetchFn ?? globalThis.fetch;
    if (!fn) {
      throw new Error("global fetch 不可用，请提供 fetchFn 参数");
    }
    this.fetchFn = fn.bind(globalThis);
  }

  setToken(token: string): void {
    this.openclawChannelToken = token;
  }

  setClientVersion(version: string | (() => string)): void {
    this.clientVersionGetter = typeof version === 'function' ? version : () => version;
  }

  /**
   * 调用 4287 riskControl 接口进行多模态内容审核
   */
  async riskControl(
    scene: MultimodalScene,
    mediaItems: RiskControlMediaItem[],
    sessionId: string,
    sessionType: number,
    qaid: string,
    externalTraceId?: string,
    externalSpanId?: string,
  ): Promise<RiskControlResponse> {
    const requestId = generateRequestId();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    const { traceparent } = generateTraceparent(externalTraceId, externalSpanId);

    // 新入参结构：平铺字段移入 data.Content，media_items 改为 Msg.Media，MediaType 枚举首字母大写
    const body = {
      scene,
      request_id: requestId,
      data: {
        Content: {
          SessionID: sessionId,
          SessionType: sessionType,
          QAID: qaid,
          Msg: {
            Media: mediaItems.map(item => ({
              MediaType: item.type === "picture" ? "Picture" : item.type === "file" ? "File" : "Text",
              Data: item.item,
            })),
          },
        },
      },
    };

    const resolvedClientVersion = this.clientVersionGetter();
    const headers = {
      "Content-Type": "application/json",
      "X-OpenClaw-Token": this.openclawChannelToken,
      "X-OpenClaw-ClientVersion": resolvedClientVersion,
      "traceparent": traceparent,
    };

    try {
      const resp = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await resp.text();

      this.log.info("[MultimodalSecurity][4287] riskControl HTTP状态:", String(resp.status), "原始响应:", text.slice(0, 2000));

      if (resp.status !== 200) {
        let parsed: unknown = text;
        try {
          parsed = text ? JSON.parse(text) : text;
        } catch {
          // JSON 解析失败
        }
        throw new Error(
          `4287 riskControl 请求失败: HTTP ${resp.status}, body=${JSON.stringify(parsed)}`,
        );
      }

      const rawResponse = text ? JSON.parse(text) : {};

      this.log.info("[MultimodalSecurity][4287] riskControl 解析响应:", JSON.stringify(rawResponse));

      // jprx 转发格式：ret=0 表示网关层成功，实际业务数据在 rawResponse.data.resp 下
      // 直接返回 rawResponse，让 checkMultimodalSecurity 按 data.resp.data.FilterResult 路径取值
      const ret = rawResponse?.ret ?? rawResponse?.common?.code;
      if (ret !== undefined && ret !== 0) {
        throw new Error(
          `4287 riskControl 业务错误: ret=${ret}, response=${JSON.stringify(rawResponse)}`,
        );
      }

      return rawResponse as RiskControlResponse;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 带熔断降级的多模态审核
   *
   * @param scene - 审核场景
   * @param mediaItems - 审核内容列表
   * @param sessionId - 会话 ID
   * @param sessionType - 会话类型 (1=问, 2=答, 3=回答结束)
   * @param qaid - 问答对唯一 ID
   * @param source - 调用来源（用于日志）
   * @returns 审核结果
   */
  async checkMultimodalSecurity(
    scene: MultimodalScene,
    mediaItems: RiskControlMediaItem[],
    sessionId: string,
    sessionType: number,
    qaid: string,
    source: string = "multimodal_audit",
    externalTraceId?: string,
    externalSpanId?: string,
  ): Promise<MultimodalSecurityCheckResult> {
    const passResult: MultimodalSecurityCheckResult = { compliant: true };

    // endpoint 为空 → 前端送审已下线到后端，直接返回"通过"，不走 fetch / 熔断 / 日志
    if (!this.endpoint) {
      return passResult;
    }

    this.log.info("[MultimodalSecurity] checkMultimodalSecurity 入参:", JSON.stringify({
      scene,
      mediaItemCount: mediaItems.length,
      mediaItemTypes: mediaItems.map(m => m.type),
      sessionId,
      sessionType,
      qaid,
      source,
    }));

    // ─── 降级模式处理 ───
    if (this.isDegraded) {
      const now = Date.now();
      if (now - this.lastRetryTime > this.currentRetryIntervalMs && !this.isProbing) {
        this.isProbing = true;
        try {
          // 探测请求：发送一个最简的文本审核
          await this.riskControl(
            "text_to_text_input",
            [{ type: "text", item: "hello" }],
            sessionId,
            1,
            qaid,
          );
          // 探测成功，退出降级
          this.isDegraded = false;
          this.isProbing = false;
          this.consecutiveFailures = 0;
          this.currentRetryIntervalMs = this.baseRetryIntervalMs;
          this.log.info("[MultimodalSecurity] 降级探测成功，恢复正常");
        } catch {
          this.lastRetryTime = Date.now();
          this.isProbing = false;
          this.currentRetryIntervalMs = Math.min(
            this.currentRetryIntervalMs * 2,
            this.maxRetryIntervalMs,
          );
          this.log.info("[MultimodalSecurity] checkMultimodalSecurity 出参(降级探测失败):", JSON.stringify({ ...passResult, degraded: true, errorType: "probe_failed" }));
          return { ...passResult, degraded: true, errorType: "probe_failed" };
        }
      } else {
        this.log.info("[MultimodalSecurity] checkMultimodalSecurity 出参(降级跳过):", JSON.stringify({ ...passResult, degraded: true, errorType: "degraded_skip" }));
        return { ...passResult, degraded: true, errorType: "degraded_skip" };
      }
    }

    // ─── 正常请求（最多重试 1 次） ───
    let attempt = 0;
    const maxAttempts = 2;

    while (attempt < maxAttempts) {
      try {
        const response = await this.riskControl(
          scene,
          mediaItems,
          sessionId,
          sessionType,
          qaid,
          externalTraceId,
          externalSpanId,
        );

        this.consecutiveFailures = 0;
        this.currentRetryIntervalMs = this.baseRetryIntervalMs;

        // 新出参路径：data.resp.data.FilterResult（true=合规，false=拦截）
        const filterResult = (response as any)?.data?.resp?.data?.FilterResult;
        if (filterResult === undefined || filterResult === null) {
          writeSecurityLog("multimodal-audit-empty-response", { scene, source });
          this.log.info("[MultimodalSecurity] checkMultimodalSecurity 出参(空响应):", JSON.stringify({ ...passResult, errorType: "empty_response" }));
          return { ...passResult, errorType: "empty_response" };
        }

        const checkResult = {
          compliant: filterResult === true,
        };
        this.log.info("[MultimodalSecurity] checkMultimodalSecurity 出参(正常):", JSON.stringify(checkResult));
        return checkResult;
      } catch (error: unknown) {
        attempt++;

        const err = error as { name?: string; message?: string; status?: number };
        const isTimeout =
          err?.name === "AbortError" ||
          (typeof err?.message === "string" && err.message.includes("timeout"));
        const isTransient = isTimeout || (typeof err?.status === "number" && err.status >= 500 && err.status < 600);

        if (isTransient && attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }

        this.consecutiveFailures++;

        if (this.consecutiveFailures >= this.failureThreshold) {
          this.isDegraded = true;
          this.lastRetryTime = Date.now();
        }

        writeSecurityLog("multimodal-audit-error", {
          scene,
          source,
          error: err?.message ?? String(error),
          attempt,
          degraded: this.consecutiveFailures >= this.failureThreshold,
        });

        // 错误时降级放行
        const errorResult = {
          ...passResult,
          degraded: this.consecutiveFailures >= this.failureThreshold,
          errorType: isTimeout ? "timeout" : "request_error",
        };
        this.log.info("[MultimodalSecurity] checkMultimodalSecurity 出参(异常降级放行):", JSON.stringify(errorResult));
        return errorResult;
      }
    }

    // while 循环兜底
    return { ...passResult, errorType: "fallback_exit" };
  }
}

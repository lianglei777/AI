/**
 * COS 上传客户端
 *
 * 封装两步操作：
 * 1. 调用 4262 getPermanentUploadInfo 获取预签名上传 URL + 永久下载 URL
 * 2. 使用预签名 URL 将文件 PUT 上传到 COS
 *
 * 上传完成后返回 internal_url，供后续 4287 多模态审核使用。
 */

import type {
  CosClientOptions,
  GetPermanentUploadInfoRequest,
  GetPermanentUploadInfoResponse,
} from "./types.js";

export interface CosUploadResult {
  /** 永久可访问 URL（公有 CDN） */
  permanentUrl: string;
  /** 内网访问 URL */
  internalUrl: string;
  /** COS 存储路径 */
  cosPath: string;
}

export class CosClient {
  private endpoint: string;
  private openclawChannelToken: string;
  private timeoutMs: number;
  private fetchFn: typeof fetch;
  private source: string;
  private log: { info(msg: string, ...args: unknown[]): void };

  constructor(options: CosClientOptions) {
    this.endpoint = options.endpoint;
    this.openclawChannelToken = options.openclawChannelToken;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.source = options.source ?? "usersource";
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

  /**
   * 步骤1: 调用 4262 获取预签名上传 URL + 永久下载 URL
   */
  async getPermanentUploadInfo(
    filename: string,
    fileSize: number,
  ): Promise<GetPermanentUploadInfoResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    const body: GetPermanentUploadInfoRequest = {
      filename,
      file_size: fileSize,
      upload_method: "put",
      source: this.source,
    };

    this.log.info("[COS][4262] getPermanentUploadInfo 入参:", JSON.stringify(body));

    try {
      const resp = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-OpenClaw-Token": this.openclawChannelToken,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await resp.text();

      this.log.info("[COS][4262] getPermanentUploadInfo HTTP状态:", String(resp.status), "原始响应:", text);

      if (resp.status !== 200) {
        let parsed: unknown = text;
        try {
          parsed = text ? JSON.parse(text) : text;
        } catch {
          // JSON 解析失败，保留原始文本
        }
        throw new Error(
          `4262 getPermanentUploadInfo 请求失败: HTTP ${resp.status}, body=${JSON.stringify(parsed)}`,
        );
      }

      const rawResponse = text ? JSON.parse(text) : {};
      // jprx 转发格式：实际数据在 data.resp 下
      const result: GetPermanentUploadInfoResponse = rawResponse?.data?.resp ?? rawResponse;

      this.log.info("[COS][4262] getPermanentUploadInfo 解析后出参:", JSON.stringify({
        common: result.common,
        data: result.data ? {
          upload_url: result.data.upload_url?.slice(0, 100) + "...",
          permanent_url: result.data.permanent_url,
          internal_url: result.data.internal_url,
          cos_path: result.data.cos_path,
        } : null,
      }));

      if (result.common && result.common.code !== 0) {
        throw new Error(
          `4262 getPermanentUploadInfo 业务错误: code=${result.common.code}, message=${result.common.message}`,
        );
      }

      if (!result.data?.upload_url || !result.data?.permanent_url) {
        throw new Error(
          `4262 getPermanentUploadInfo 返回数据不完整: ${JSON.stringify(result.data)}`,
        );
      }

      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 步骤2: 使用预签名 URL 将文件 PUT 上传到 COS
   */
  async uploadToCos(
    uploadUrl: string,
    fileBuffer: Buffer,
    contentType: string = "application/octet-stream",
  ): Promise<void> {
    const controller = new AbortController();
    // 上传超时适当放大：大文件上传可能较慢
    const uploadTimeoutMs = Math.max(this.timeoutMs, 30000);
    const timeoutId = setTimeout(() => controller.abort(), uploadTimeoutMs);

    try {
      const resp = await this.fetchFn(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(fileBuffer.length),
        },
        body: fileBuffer,
        signal: controller.signal,
      });

      if (resp.status < 200 || resp.status >= 300) {
        const text = await resp.text().catch(() => "");
        throw new Error(
          `COS PUT 上传失败: HTTP ${resp.status}, body=${text.slice(0, 500)}`,
        );
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 一站式上传：获取上传信息 → PUT 到 COS → 返回永久 URL
   *
   * @param filename - 文件名（含扩展名，如 image.png）
   * @param fileBuffer - 文件内容的 Buffer
   * @param contentType - MIME 类型（如 image/png, application/pdf）
   * @returns 永久可访问 URL 等信息
   */
  async upload(
    filename: string,
    fileBuffer: Buffer,
    contentType: string = "application/octet-stream",
  ): Promise<CosUploadResult> {
    this.log.info("[COS] upload 一站式入参:", JSON.stringify({ filename, bufferSize: fileBuffer.length, contentType }));

    // 步骤1: 获取上传 URL
    const uploadInfo = await this.getPermanentUploadInfo(filename, fileBuffer.length);
    const { upload_url, permanent_url, internal_url, cos_path } = uploadInfo.data!;

    // 步骤2: PUT 上传到 COS
    await this.uploadToCos(upload_url, fileBuffer, contentType);

    const result = {
      permanentUrl: permanent_url,
      internalUrl: internal_url,
      cosPath: cos_path,
    };
    this.log.info("[COS] upload 一站式出参:", JSON.stringify(result));
    return result;
  }
}

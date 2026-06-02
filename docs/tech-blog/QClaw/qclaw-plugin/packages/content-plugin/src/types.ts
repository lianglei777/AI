export const enum SessionType {
  QUESTION = 1,
  ANSWER = 2,
  ANSWER_END = 3,
}

export type MediaType =
  | "Text"       // 纯文本
  | "Picture"    // 图片（URL）
  | "Video"      // 视频（URL）
  | "Audio"      // 音频（URL）
  | "OutLink"    // 外链
  | "Livevideo"  // 直播视频
  | "File";      // 文件


export const enum ResultCode {
  PASS = 0,
  BLOCK = 1,
  PASS_2 = 2,
}

export type SceneType = "prompt" | "output";

export interface MediaItem {
  Data: string;
  MediaType: MediaType;
}

export interface CreateTaskRequest {
  scene: SceneType;
  request_id: string;
  openclaw_channel_token: string;
  data: {
    Comm: {
      SendTime: number;
    };
    Content: {
      QAID?: string;
      SessionID: string;
      SessionType: SessionType;
      Msg: {
        Media: MediaItem[];
        MsgMap: Record<string, any>;
      };
    };
  };
}



export interface FirstLabelItem {
  uiLabel: number;
  uilevel: number;
  strMeaning: string;
}

export interface CreateTaskResponse {
  common: {
    code: number;
    message: string;
  };
  data: {
    ResultCode: number;
    ResultType?: number;
    ResultTypeLevel?: number;
    ResultMsg?: string;
    ResultFirstLabel?: string;
    ResultSecondLabel?: string;
    Operator?: string;
    WhiteBoxAnswer?: string;
    StdRetMsg?: string;
    StdRetCode?: number;
    TraceID?: string;
  } | null;
}



export interface CreateTaskClientOptions {
  endpoint: string;
  openclawChannelToken: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

// ==================== 插件配置 ====================

export interface PluginConfig {
  endpoint?: string;
  token?: string;
  openClawDir?: string;
  logRecord?: boolean;
  enableFetch?: boolean;
  enableBeforeToolCall?: boolean;
  enableAfterToolCall?: boolean;
  failureThreshold?: number;
  retryInterval?: number;
  maxRetryInterval?: number;
  timeoutMs?: number;
  blockLevel?: number;
  /** 上报用户 uid */
  uid?: string;
  /** 上报版本号 */
  version?: string;
  /** 上报设备号 */
  aid?: string;
  /** 上报环境 */
  env?: string;
}


export interface SecurityCheckResult {
  blocked: boolean;
  level?: number;
  resultType?: number;
  resultCode?: number;
  labels: Record<string, FirstLabelItem>;
  traceId?: string;
  /** 本次审核请求的唯一 request_id，用于链路追踪 */
  requestId?: string;
  /** 是否走了降级逻辑（审核服务不可用时放行） */
  degraded?: boolean;
  /** 降级/错误原因：degraded_skip | probe_failed | empty_response | timeout | request_error | fallback_exit */
  errorType?: string;
}

// ==================== 安全配置 ====================


export interface SecurityConfig {
  failureThreshold?: number;
  baseRetryIntervalMs?: number;
  maxRetryIntervalMs?: number;
  blockLevel?: number;
}

// ==================== 拦截器配置 ====================

/**
 * setupFetchInterceptor 函数的参数
 */
export interface InterceptorConfig {
  api: any;
  client: any;
  enableLogging: boolean;
  shieldEndpoint: string;
}

// ==================== 消息标准化 ====================

export interface NormalizedMessage {
  role: string;
  content: string;
}

// ==================== 多模态信安审核 (4287 + 4262) ====================

/**
 * 4262 getPermanentUploadInfo 请求参数
 */
export interface GetPermanentUploadInfoRequest {
  filename: string;
  file_size: number;
  md5?: string;
  upload_method?: 'put' | 'post' | 'cos';
  source: string;
}

/**
 * 4262 getPermanentUploadInfo 响应数据
 */
export interface GetPermanentUploadInfoResponse {
  common: {
    code: number;
    message: string;
  };
  data: {
    upload_url: string;
    permanent_url: string;
    internal_url: string;
    cos_path: string;
  } | null;
}

/**
 * 4287 riskControl 场景枚举
 */
export type MultimodalScene =
  | 'ugc_input'
  | 'image_to_text_input'
  | 'file_to_text_input'
  | 'image_text_to_text_input'
  | 'file_text_to_text_input'
  | 'text_to_text_input'
  | 'text_to_text_output';

/**
 * 4287 riskControl media_items 元素
 */
export interface RiskControlMediaItem {
  type: 'text' | 'picture' | 'file';
  item: string;
}

/**
 * 4287 riskControl 请求体
 */
export interface RiskControlRequest {
  scene: MultimodalScene;
  sub_scene?: string;
  request_id: string;
  qaid: string;
  session_id?: string;
  session_type?: number;
  media_items?: RiskControlMediaItem[];
  type?: 'text' | 'picture' | 'file';
  item?: string;
}

/**
 * 4287 riskControl 响应
 */
export interface RiskControlResponse {
  common: {
    code: number;
    message: string;
  };
  data: {
    compliant: boolean;
  } | null;
}

/**
 * COS 上传客户端配置
 */
export interface CosClientOptions {
  /** 4262 接口端点 */
  endpoint: string;
  /** openclaw_channel_token（用于 X-OpenClaw-Token header） */
  openclawChannelToken: string;
  /** 请求超时（毫秒） */
  timeoutMs?: number;
  /** fetch 实现 */
  fetchFn?: typeof fetch;
  /** 文件来源标识，4262 的 source 字段 */
  source?: string;
  /** 可选日志实例（QClawLogger 兼容），未提供时 fallback 到 console */
  logger?: { info(msg: string, ...args: unknown[]): void };
}

/**
 * 多模态审核客户端配置
 */
export interface MultimodalSecurityClientOptions {
  /** 4287 接口端点 */
  endpoint: string;
  /** openclaw_channel_token（用于 X-OpenClaw-Token header） */
  openclawChannelToken: string;
  /** 请求超时（毫秒） */
  timeoutMs?: number;
  /** fetch 实现 */
  fetchFn?: typeof fetch;
  /** 可选日志实例（QClawLogger 兼容），未提供时 fallback 到 console */
  logger?: { info(msg: string, ...args: unknown[]): void };
  /** 客户端版本号，写入 X-OpenClaw-ClientVersion header（支持 getter 函数，每次请求时动态取值） */
  clientVersion?: string | (() => string);
}

/**
 * 多模态审核结果（简化版，对齐 4287 返回的 FilterResult 布尔值）
 */
export interface MultimodalSecurityCheckResult {
  /** 是否合规（true=通过，false=拦截） */
  compliant: boolean;
  /** 是否走了降级逻辑 */
  degraded?: boolean;
  /** 降级/错误原因 */
  errorType?: string;
}

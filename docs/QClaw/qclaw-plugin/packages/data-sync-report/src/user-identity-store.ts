/**
 * 用户身份信息存储
 *
 * 模块级单例，存储主端推送过来的 userId / token。
 *
 * 数据来源：
 * - 主端通过 HTTP POST 推送（动态更新，解决启动时序问题）
 *
 * 回调机制：
 * - 通过 onIdentityChange 注册监听，身份信息变化时通知订阅者
 * - 用于驱动 SyncService 的延迟启动和退出登录停用
 */

/** 用户身份信息 */
export interface UserIdentity {
  userId: string;
  /** JWT token，用于后端接口鉴权 */
  token: string;
  /** 设备/用户 guid，由主端登录后推送 */
  guid: string;
}

/** 身份变化回调类型 */
export type IdentityChangeCallback = (identity: UserIdentity, ready: boolean) => void;

/** 内存存储 —— 由主端 HTTP 推送更新 */
let cachedIdentity: UserIdentity | null = null;

/** 身份变化监听器列表 */
const changeListeners: IdentityChangeCallback[] = [];

/**
 * 判断身份信息是否就绪（userId 和 token 都有值）
 */
export function isIdentityReady(): boolean {
  return cachedIdentity !== null
    && cachedIdentity.userId !== ''
    && cachedIdentity.token !== '';
}

/**
 * 更新用户身份信息（由 HTTP 路由 handler 调用）
 *
 * 变化时通知所有监听者（附带 ready 状态）
 */
export function setUserIdentity(identity: UserIdentity): void {
  cachedIdentity = { ...identity };
  const ready = isIdentityReady();
  for (const listener of changeListeners) {
    listener(cachedIdentity, ready);
  }
}

/**
 * 注册身份变化监听（支持多个监听者）
 *
 * 如果当前身份已就绪，会立即触发一次回调
 */
export function onIdentityChange(callback: IdentityChangeCallback): void {
  changeListeners.push(callback);
  // 如果身份已就绪，立即通知（覆盖"先推送后注册"的时序）
  if (cachedIdentity && isIdentityReady()) {
    callback(cachedIdentity, true);
  }
}

/**
 * 获取当前用户身份信息
 *
 * 返回主端推送的身份信息，未推送时返回空值
 */
export function getUserIdentity(): UserIdentity {
  if (cachedIdentity && cachedIdentity.userId) {
    return cachedIdentity;
  }

  return {
    userId: "",
    token: "",
    guid: "",
  };
}

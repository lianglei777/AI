/**
 * 数据同步上报插件 - 哈希工具
 *
 * 提供递归排序和 MD5 哈希计算能力，用于检测配置变化。
 */

import crypto from "node:crypto";

/**
 * 递归排序对象的所有键
 *
 * 对对象的所有层级进行键排序，确保相同内容的不同键序对象
 * 在 JSON.stringify 后产生一致的字符串，从而生成一致的哈希值。
 *
 * @param value 任意值
 * @returns 键已排序的深拷贝对象
 */
export function deepSortKeys(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(deepSortKeys);
  }

  if (typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      sorted[key] = deepSortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  // 原始值直接返回
  return value;
}

/**
 * 计算任意值的 MD5 哈希
 *
 * 先对值进行递归排序，然后 JSON.stringify，再计算 MD5 哈希。
 * 这样可以确保相同内容（不同键序）的对象产生相同的哈希值。
 *
 * @param value 任意值
 * @returns MD5 哈希的十六进制字符串（32位）
 */
export function computeHash(value: unknown): string {
  const sorted = deepSortKeys(value);
  const jsonStr = JSON.stringify(sorted);
  return crypto.createHash("md5").update(jsonStr).digest("hex");
}

/**
 * 计算字符串的 MD5 哈希
 *
 * @param content 字符串内容
 * @returns MD5 哈希的十六进制字符串（32位）
 */
export function computeStringHash(content: string): string {
  return crypto.createHash("md5").update(content).digest("hex");
}

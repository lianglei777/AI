/**
 * 数据同步上报插件 - JSON 解析工具
 *
 * 提供安全的 JSON5 和 JSONL 解析能力。
 */

import JSON5 from "json5";

/**
 * JSON5 解析结果
 */
export type Json5ParseResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/**
 * 安全解析 JSON5 字符串
 *
 * openclaw.json 使用 JSON5 格式（支持注释和尾逗号），
 * 所以需要使用 JSON5 库进行解析。
 *
 * @param content JSON5 字符串
 * @returns 解析结果
 */
export function safeParseJson5(content: string): Json5ParseResult {
  try {
    const data = JSON5.parse(content);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * JSON 解析结果
 */
export type JsonParseResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/**
 * 安全解析标准 JSON 字符串
 *
 * cron/jobs.json 使用标准 JSON 格式。
 *
 * @param content JSON 字符串
 * @returns 解析结果
 */
export function safeParseJson(content: string): JsonParseResult {
  try {
    const data = JSON.parse(content);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * JSONL 行解析结果
 */
export type JsonlLineResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/**
 * 解析 JSONL 内容为对象数组
 *
 * JSONL（JSON Lines）格式：每行一个完整的 JSON 对象。
 * Cron 执行记录使用此格式存储。
 *
 * @param content JSONL 字符串（可能包含多行）
 * @returns 成功解析的对象数组（跳过解析失败的行）
 */
export function parseJsonlLines(content: string): unknown[] {
  const results: unknown[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      results.push(JSON.parse(trimmed));
    } catch {
      // 跳过解析失败的行（可能是不完整的行）
    }
  }

  return results;
}

/**
 * prompt-optimizer — QClawPackage
 *
 * 通过 FetchChain 中间件拦截发往 LLM 的请求：
 *   - ordered_system_prompt: 从请求体的 system prompt 中按 section 名称提取并重新排列
 *   - inject_user_query: 从请求体的 system prompt 中提取指定 section，作为独立的 user+assistant
 *     消息对插入到 messages 最前面（system 之后），确保多轮对话中缓存前缀一致
 *   - inject_user_query_suffix: 追加到 inject_user_query 注入内容之后
 *
 * section 的识别规则：system prompt 中所有以 "## " 开头的行即为 section 标题，
 * 无需任何外部文件，完全从请求体中动态解析。
 *
 * 迁移自独立插件 prompt-optimizer，改为 FetchChain 中间件模式。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import type { QClawPackage, QClawContext, QClawLogger, FetchRequestContext } from '../../core/types.js'

// ============================================================================
// 类型定义
// ============================================================================

interface Config {
  /** 插件总开关，false 时直接放行不做任何处理 */
  switch?: boolean
  /** 在 system prompt 最前面插入的自定义文本 */
  system_prompt_prefix?: string
  /** 按 section 名称列表从请求的 system prompt 中提取并重新排列，顺序即最终顺序 */
  ordered_system_prompt?: string[]
  /** 按 section 名称列表从请求的 system prompt 中提取，作为独立的 user+assistant 消息对插入到 messages 最前面（system 之后） */
  inject_user_query?: string[]
  /** 追加到 inject_user_query 注入内容之后的自定义文本 */
  inject_user_query_suffix?: string
  /** 伪造的 assistant 确认回复，用于维持 user/assistant 交替（默认值见代码） */
  inject_user_query_ack?: string
  /** 是否启用动态路径替换（默认 true）：自动检测 system prompt 中的绝对路径并替换为占位符 */
  enable_path_replacements?: boolean
  /** 可用的 section 名称白名单，只有在此列表中的 section 才会被识别和提取 */
  _comment_available_sections?: string[]
  /**
   * section 内容覆盖映射表。
   * key 为 section 名称（必须在 _comment_available_sections 白名单中），value 为替换后的完整内容字符串。
   * - value 不以 "## " 开头时，自动补上 "## {sectionName}\n" 标题行
   * - value 为空字符串 "" 时，等效于从 sectionMap 中删除该 section
   * - 字段缺失或为空对象时，保持现有行为不变
   */
  section_overrides?: Record<string, string>
  /**
   * 自定义 section 映射表。
   * key 为 section 名称，value 为 section 的完整内容字符串。
   * - 不受 _comment_available_sections 白名单限制，可定义全新的 section
   * - value 不以 "## " 开头时，自动补上 "## {sectionName}\n" 标题行
   * - 可在 ordered_system_prompt / inject_user_query 中自由编排位置
   * - 与 section_overrides 同时存在时，先应用 custom_sections，再应用 section_overrides（section_overrides 优先级更高）
   * - 字段缺失、为空对象或类型不是对象时，保持现有行为不变
   */
  custom_sections?: Record<string, string>
}

/** section 名称 -> 内容（含标题行） */
type SectionMap = Map<string, string>

// ============================================================================
// 常量
// ============================================================================

/**
 * 远端配置拉取地址（根据 BUILD_ENV 选择环境，与 log-uploader / jprx/request.ts 保持一致）
 *   - test:       https://jprx.sparta.html5.qq.com/data/4168/forward
 *   - production: https://jprx.m.qq.com/data/4168/forward
 */
const REMOTE_CONFIG_URL = (process.env['BUILD_ENV'] === 'production')
  ? 'https://jprx.m.qq.com/data/4168/forward'
  : 'https://jprx.sparta.html5.qq.com/data/4168/forward'

/** 内存缓存 TTL：30 分钟（毫秒） */
const CACHE_TTL_MS = 30 * 60_000

/** 连续失败触发退避的阈值 */
const MAX_CONSECUTIVE_FAILURES = 5

/** 退避冷却期：5 分钟（毫秒） */
const BACKOFF_DURATION_MS = 5 * 60_000

/** 单次拉取超时：1.5 秒（毫秒） */
const FETCH_TIMEOUT_MS = 1500

/** 配置缓存文件路径（在 setup 中动态初始化） */
let configCacheFile: string = ''
/** 缓存目录（在 setup 中动态初始化） */
let configCacheDir: string = ''

// ── 模块级状态（跨请求共享） ──

/** 内存缓存的配置 */
let memoryCache: Config | null = null
/** 内存缓存写入的时间戳（Date.now()） */
let memoryCacheTime = 0
/** 正在进行中的配置拉取 Promise（用于去重） */
let inflightPromise: Promise<Config | null> | null = null
/** 连续拉取失败计数 */
let consecutiveFailures = 0
/** 退避截止时间（Date.now()），在此之前不发起网络请求 */
let backoffUntil = 0
/** 环境信息是否已打印过（避免每次请求都打印） */
let envLogged = false

// ── 模块级变量：记录最近一次 loadConfig 的来源和错误信息 ──
// 不修改 loadConfig 的函数签名（避免之前改签名导致启动失败的问题），
// 而是在 loadConfig 内部设置这些变量，onRequest 中读取。
let lastConfigSource: 'remote' | 'cache' | 'none' = 'none'
let lastConfigError: string = ''

/**
 * 将配置写入本地缓存文件。
 * 写入失败时静默忽略，不影响正常流程。
 */
function writeConfigCache(config: Config): void {
  if (!configCacheFile || !configCacheDir) return
  try {
    if (!fs.existsSync(configCacheDir)) {
      fs.mkdirSync(configCacheDir, { recursive: true })
    }
    fs.writeFileSync(configCacheFile, JSON.stringify(config, null, 2), 'utf-8')
  } catch {
    // 写缓存失败不影响正常流程
  }
}

/**
 * 从本地缓存文件读取配置。
 * 读取失败或格式异常时返回 null。
 */
function readConfigCache(): Config | null {
  if (!configCacheFile) return null
  try {
    if (!fs.existsSync(configCacheFile)) return null
    const raw = fs.readFileSync(configCacheFile, 'utf-8')
    const data = JSON.parse(raw) as Config
    if (data && typeof data === 'object') {
      return data
    }
    return null
  } catch {
    return null
  }
}

/** Path Variable Mappings section 的标识名（与 ## 标题保持一致） */
const PATH_MAPPINGS_SECTION = 'Path Variable Mappings'

// ============================================================================
// Token 估算（仿照 lossless-claw: ~4 字符 ≈ 1 token）
// ============================================================================

/** 粗略估算 token 数量，与 lossless-claw 保持一致的估算公式 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ============================================================================
// 伽利略 OTLP HTTP 日志上报
// ============================================================================

/** 伽利略 OTLP 日志上报地址 */
const GALILEO_LOGS_URL = 'https://galileotelemetry.tencent.com/v1/logs'
/** 伽利略 target（对应 platform=RPC, module_name=prompt-optimization） */
const GALILEO_TARGET = 'RPC.prompt-optimization'
/** 从 target 中提取 service name */
const GALILEO_SERVICE_NAME = GALILEO_TARGET.split('.').slice(1).join('.')
/** 当前环境 namespace */
const GALILEO_NAMESPACE = process.env['BUILD_ENV'] === 'production' ? 'Production' : 'Development'

/** 埋点指标结构 */
interface LogMetrics {
  action: string
  session_id: string
  trace_id: string
  user_id: string
  [key: string]: string | number | boolean
}

/**
 * 构造 OTLP ExportLogsServiceRequest JSON payload 并通过 HTTP POST 上报到伽利略。
 * 使用传入的 fetchFn 发起请求（应为 originalFetch，绕过 FetchChain）。
 * 上报失败静默忽略，不影响业务。
 */
function reportGalileoLog(
  fetchFn: typeof fetch,
  metrics: LogMetrics,
  logger: QClawLogger,
): void {
  try {
    const nowNanos = (BigInt(Date.now()) * 1_000_000n).toString()

    // 构造 OTLP KeyValue attributes
    const otlpAttributes = Object.entries(metrics).map(([key, value]) => {
      if (typeof value === 'string') {
        return { key, value: { stringValue: value } }
      } else if (typeof value === 'number') {
        if (Number.isInteger(value)) {
          return { key, value: { intValue: String(value) } }
        }
        return { key, value: { doubleValue: value } }
      } else if (typeof value === 'boolean') {
        return { key, value: { boolValue: value } }
      }
      return { key, value: { stringValue: String(value) } }
    })

    // 添加 log.type 和 callee_method 方便伽利略筛选
    otlpAttributes.push(
      { key: 'log.type', value: { stringValue: metrics.action } },
      { key: 'callee_method', value: { stringValue: metrics.action } },
    )

    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: GALILEO_SERVICE_NAME } },
              { key: 'target', value: { stringValue: GALILEO_TARGET } },
              { key: 'namespace', value: { stringValue: GALILEO_NAMESPACE } },
              { key: 'instance', value: { stringValue: os.hostname() } },
              { key: 'container_name', value: { stringValue: '' } },
              { key: 'version', value: { stringValue: '1.0.0' } },
              { key: 'con_setid', value: { stringValue: '' } },
            ],
          },
          scopeLogs: [
            {
              scope: { name: 'prompt-optimizer', version: '1.0.0' },
              logRecords: [
                {
                  timeUnixNano: nowNanos,
                  observedTimeUnixNano: nowNanos,
                  severityNumber: 9, // INFO
                  severityText: 'INFO',
                  body: { stringValue: metrics.action },
                  attributes: otlpAttributes,
                  traceId: '',
                  spanId: '',
                },
              ],
            },
          ],
        },
      ],
    }

    // 异步发送，不 await，不阻塞业务
    fetchFn(GALILEO_LOGS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {
      // 上报失败静默忽略
    })
  } catch {
    // 构造 payload 失败也静默忽略
    logger.warn('[prompt-optimizer] 伽利略日志上报构造失败')
  }
}

// ============================================================================
// 纯函数（全部 export，方便独立测试）
// ============================================================================

/**
 * 判断一个 section 标题是否在白名单中。
 * 支持精确匹配和路径形式的 basename 匹配：
 *   - 精确匹配：标题 === 白名单中的某个名称
 *   - basename 匹配：标题是路径形式（如 "/Users/xxx/AGENTS.md"），其 basename（"AGENTS.md"）在白名单中
 *   - 反向 basename 匹配：白名单中的名称是路径形式，其 basename 与标题匹配
 */
export function isSectionAllowed(sectionTitle: string, allowedSet: Set<string>): boolean {
  // 精确匹配
  if (allowedSet.has(sectionTitle)) return true

  // 标题是路径形式，检查其 basename 是否在白名单中
  if (sectionTitle.includes('/') || sectionTitle.includes('\\')) {
    const basename = sectionTitle.split(/[\/\\]/).pop()
    if (basename && allowedSet.has(basename)) return true
  }

  // 白名单中的名称可能是路径形式，检查其 basename 是否与标题匹配
  for (const allowed of allowedSet) {
    if (allowed.includes('/') || allowed.includes('\\')) {
      const basename = allowed.split(/[\/\\]/).pop()
      if (basename && basename === sectionTitle) return true
    }
  }

  return false
}

/**
 * 直接从给定文本（请求体中的 system prompt）中扫描所有 "## " 标题，
 * 动态切分出各 section，返回 Map<sectionName, content>。
 * content 包含标题行本身及其后续内容，直到下一个 ## 标题或文本结束。
 */
export function extractSections(text: string, allowedSections?: string[]): SectionMap {
  const map: SectionMap = new Map()
  if (!text) return map

  // 构建白名单 Set，用于快速查找
  const allowedSet = allowedSections && allowedSections.length > 0
    ? new Set(allowedSections)
    : null

  const lines = text.split('\n')
  let currentKey: string | null = null
  let currentLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('## ')) {
      // 遇到新的 ## 标题，保存上一个 section
      if (currentKey !== null) {
        map.set(currentKey, currentLines.join('\n'))
      }
      const title = line.slice(3).trim()
      // 如果有白名单，只识别白名单中的 section；否则识别所有 ## 标题
      if (!allowedSet || isSectionAllowed(title, allowedSet)) {
        currentKey = title
        currentLines = [line]
      } else {
        // 不在白名单中的 ## 标题，视为普通内容，归入上一个 section
        if (currentKey !== null) {
          currentLines.push(line)
        }
        // 如果还没有任何 section（preamble 阶段），则忽略
      }
    } else {
      if (currentKey !== null) {
        currentLines.push(line)
      }
      // ## 之前的内容（preamble）直接忽略
    }
  }
  // 保存最后一个 section
  if (currentKey !== null) {
    map.set(currentKey, currentLines.join('\n'))
  }

  // 对路径形式的 section 标题，额外用文件名（basename）作为别名存入 map，
  // 这样配置文件中可以只写 "HEARTBEAT.md" 而非 "/Users/xxx/.qclaw/workspace/HEARTBEAT.md"，
  // 实现跨平台兼容（换电脑后路径不同也不影响）。
  // 注意：如果多个路径 section 有相同的 basename，后者会覆盖前者（实际场景中不太可能冲突）。
  for (const [key, value] of map) {
    if (key.includes('/') || key.includes('\\')) {
      const basename = key.split(/[\/\\]/).pop()
      if (basename && !map.has(basename)) {
        map.set(basename, value)
      }
    }
  }

  return map
}

/**
 * 将路径中的反斜杠统一归一化为正斜杠，用于跨平台路径比较和前缀统计。
 */
export function normalizeSeparator(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * 从 system prompt 文本中动态检测所有绝对路径，自动归类并生成占位符映射表。
 * 跨平台兼容：同时支持 Unix 路径（/xxx/yyy）和 Windows 路径（C:\xxx\yyy 或 C:/xxx/yyy）。
 *
 * 返回 Record<占位符, 绝对路径>，如 { "{skill_root_dir}": "/Applications/.../skills" }
 */
export function detectPathReplacements(text: string): Record<string, string> {
  if (!text) return {}

  // 收集所有绝对路径
  // Unix 绝对路径: /xxx/yyy
  const unixPathRegex = /(?:\/[\w@.\-]+(?:[ ][\w@.\-]+)*){2,}/g
  // home 目录相对路径: ~/xxx/yyy 或 ~\xxx\yyy（兼容 Windows 反斜杠）
  const tildePathRegex = /~[/\\][\w@.\-]+(?:[ ][\w@.\-]+)*(?:[/\\][\w@.\-]+(?:[ ][\w@.\-]+)*)*/g
  // Windows 绝对路径: C:\xxx\yyy 或 C:/xxx/yyy
  const winPathRegex = /[A-Za-z]:[\\|/][\w@.\-\\/ ]+/g

  const rawPaths: string[] = []

  let m: RegExpExecArray | null
  while ((m = unixPathRegex.exec(text)) !== null) {
    // 跳过波浪号路径的子串：如果匹配位置前一个字符是 ~，说明这是 ~/xxx 路径的一部分，
    // 会被 tildePathRegex 单独提取，此处不应重复收集（否则会产生 /.qclaw/... 这样的假绝对路径）
    if (m.index > 0 && text[m.index - 1] === '~') {
      continue
    }
    rawPaths.push(m[0])
  }
  while ((m = tildePathRegex.exec(text)) !== null) {
    rawPaths.push(m[0])
  }
  while ((m = winPathRegex.exec(text)) !== null) {
    rawPaths.push(m[0].trimEnd())
  }

  if (rawPaths.length === 0) {
    return {}
  }

  /**
   * 已知路径模式规则：
   * - tail: 要在归一化路径中查找的尾部片段（含前导 /），匹配到后截取到该片段末尾作为前缀
   * - placeholder: 对应的占位符名称
   * - priority: 优先级，数字越大越优先
   */
  const knownPatterns: Array<{ tail: string; placeholder: string; priority: number }> = [
    // ── skill 相关目录 ──
    { tail: '/config/skills',              placeholder: '{bundled_skill_dir}',         priority: 10 },
    { tail: '/openclaw/skills',            placeholder: '{openclaw_builtin_skill_dir}', priority: 10 },
    { tail: '/.openclaw/workspace/skills', placeholder: '{openclaw_skill_dir}',        priority: 12 },
    { tail: '/.qclaw/workspace/skills',    placeholder: '{qclaw_skill_dir}',           priority: 11 },
    { tail: '/.qclaw/skills',              placeholder: '{managed_skill_dir}',         priority: 10 },
    { tail: '/.agents/skills',             placeholder: '{personal_skill_dir}',        priority: 10 },
    { tail: '/workspace/skills',           placeholder: '{workspace_skill_dir}',       priority: 10 },
    // ── 扩展 / 插件目录 ──
    { tail: '/openclaw/extensions',        placeholder: '{user_extensions_dir}',       priority: 11 },
    { tail: '/config/extensions',          placeholder: '{bundled_extensions_dir}',    priority: 10 },
    // ── 其他目录 ──
    { tail: '/openclaw/docs',              placeholder: '{bundled_docs_dir}',          priority: 10 },
    { tail: '/.openclaw/workspace',        placeholder: '{openclaw_workspace_dir}',    priority: 11 },
    { tail: '/.qclaw/workspace',           placeholder: '{workspace_root_dir}',        priority: 10 },
  ]

  const replacements: Record<string, string> = {}
  const usedPlaceholders = new Set<string>()

  // 按 priority 降序排序
  const sortedPatterns = [...knownPatterns].sort((a, b) => b.priority - a.priority)

  // 按路径长度降序排列，确保更完整的路径优先被匹配
  const sortedRawPaths = [...rawPaths].sort((a, b) => b.length - a.length)

  for (const { tail, placeholder } of sortedPatterns) {
    if (usedPlaceholders.has(placeholder)) continue

    // ── 收集所有匹配到的 candidate，按「精确匹配」和「扩展变体」分桶 ──
    // 精确匹配：tail 后面紧跟 / 或字符串结尾（如 /.qclaw/workspace/skills）
    // 扩展变体：tail 后面紧跟非 / 字符（如 /.qclaw/workspace-agent-xxx/skills）
    let exactBest: string | null = null
    const variantMap = new Map<string, string>() // variantSuffix -> bestCandidate

    for (const rawPath of sortedRawPaths) {
      const normalized = normalizeSeparator(rawPath)
      const idx = normalized.indexOf(tail)
      if (idx === -1) continue

      const afterTailIdx = idx + tail.length
      const charAfterTail = afterTailIdx < normalized.length ? normalized[afterTailIdx] : null

      if (charAfterTail === null || charAfterTail === '/') {
        // ── 精确匹配：tail 后面是 / 或字符串结尾 ──
        const candidate = rawPath.substring(0, afterTailIdx)
        if (!exactBest) {
          exactBest = candidate
        }
        // 绝对路径优先于波浪号路径
        if (candidate.startsWith('/') && !exactBest.startsWith('/')) {
          exactBest = candidate
        }
      } else {
        // ── 扩展变体：tail 后面有额外字符（如 -agent-xxx） ──
        // 向后扫描到当前路径段末尾，提取完整的扩展后缀
        let endIdx = afterTailIdx
        while (endIdx < normalized.length && normalized[endIdx] !== '/') {
          endIdx++
        }
        const variantSuffix = normalized.substring(afterTailIdx, endIdx) // 如 "-agent-5cb34fee"
        const candidate = rawPath.substring(0, endIdx)

        const existing = variantMap.get(variantSuffix)
        if (!existing) {
          variantMap.set(variantSuffix, candidate)
        } else if (candidate.startsWith('/') && !existing.startsWith('/')) {
          // 绝对路径优先
          variantMap.set(variantSuffix, candidate)
        }
      }
    }

    // ── 注册精确匹配的占位符 ──
    if (exactBest) {
      replacements[placeholder] = exactBest
      usedPlaceholders.add(placeholder)
    }

    // ── 为每个扩展变体生成独立的带后缀占位符 ──
    // 例如 {workspace_root_dir} + "-agent-5cb34fee" → {workspace_root_dir:agent-5cb34fee}
    for (const [variantSuffix, candidate] of variantMap) {
      // 从变体后缀中提取标识（去掉前导 -），如 "-agent-5cb34fee" → "agent-5cb34fee"
      const label = variantSuffix.startsWith('-') ? variantSuffix.slice(1) : variantSuffix
      const baseName = placeholder.slice(0, -1) // 去掉尾部 '}'
      const variantPlaceholder = `${baseName}:${label}}`
      if (!usedPlaceholders.has(variantPlaceholder)) {
        replacements[variantPlaceholder] = candidate
        usedPlaceholders.add(variantPlaceholder)
      }
    }
  }

  return replacements
}

/**
 * 将文本中的绝对路径替换为占位符（正向替换）。
 * 替换时按绝对路径长度从长到短排序，避免短路径误匹配长路径的前缀。
 */
export function applyPathReplacements(text: string, replacements: Record<string, string>): string {
  if (!text || !replacements || Object.keys(replacements).length === 0) return text
  const entries = Object.entries(replacements).sort((a, b) => b[1].length - a[1].length)
  let result = text
  for (const [placeholder, absolutePath] of entries) {
    result = result.split(absolutePath).join(placeholder)

    // 同时替换反转分隔符的形式（处理混合分隔符的情况）
    const flipped = absolutePath.includes('\\')
      ? absolutePath.replace(/\\/g, '/')
      : absolutePath.replace(/\//g, '\\')
    if (flipped !== absolutePath) {
      result = result.split(flipped).join(placeholder)
    }
  }
  return result
}

/**
 * 构建路径映射表的 section 文本块（## 标题格式），可通过配置文件编排。
 */
export function buildPathMappingSection(replacements: Record<string, string>): string {
  // 按分组定义期望的输出顺序，skill 相关目录放在一起方便阅读
  const displayOrder: string[] = [
    // skill 相关
    '{bundled_skill_dir}',
    '{openclaw_builtin_skill_dir}',
    '{openclaw_skill_dir}',
    '{qclaw_skill_dir}',
    '{managed_skill_dir}',
    '{personal_skill_dir}',
    '{workspace_skill_dir}',
    // 扩展 / 插件
    '{user_extensions_dir}',
    '{bundled_extensions_dir}',
    // 其他
    '{bundled_docs_dir}',
    '{openclaw_workspace_dir}',
    '{workspace_root_dir}',
  ]

  const lines: string[] = []
  const used = new Set<string>()

  // 按期望顺序输出已知占位符，并在每个已知占位符后紧跟其动态变体
  for (const placeholder of displayOrder) {
    if (placeholder in replacements) {
      lines.push(`${placeholder} = ${replacements[placeholder]}`)
      used.add(placeholder)
    }
    // 查找该占位符的动态变体（如 {workspace_root_dir:agent-xxx}）
    const baseName = placeholder.slice(0, -1) // 去掉尾部 '}'
    for (const [variantPlaceholder, variantPath] of Object.entries(replacements)) {
      if (variantPlaceholder.startsWith(`${baseName}:`) && !used.has(variantPlaceholder)) {
        lines.push(`${variantPlaceholder} = ${variantPath}`)
        used.add(variantPlaceholder)
      }
    }
  }
  // 输出未在 displayOrder 中的剩余项（兜底）
  for (const [placeholder, absolutePath] of Object.entries(replacements)) {
    if (!used.has(placeholder)) {
      lines.push(`${placeholder} = ${absolutePath}`)
    }
  }

  return (
    `## ${PATH_MAPPINGS_SECTION}\n` +
    '系统提示词中使用了路径占位符（如 {bundled_skill_dir}、{workspace_root_dir}）以优化缓存。' +
    '当你需要解析实际文件路径时（例如读取 skill 文件、列出目录内容或引用工作区文件），' +
    '请使用下方映射表将占位符替换为真实的绝对路径。\n' +
    '**重要**：当你在寻找目录或文件时遇到路径占位符，必须先用下方映射表中对应的真实绝对路径替换占位符，然后再去查找实际位置。\n' +
    lines.join('\n')
  )
}

/**
 * 将远端配置中的 custom_sections 注入到 sectionMap 中。
 * - 不受 _comment_available_sections 白名单限制，可定义全新的 section
 * - value 不以 "## " 开头时，自动补上 "## {sectionName}\n" 标题行
 * - value 已以 "## " 开头时，直接使用
 * - 同名 section 会覆盖原始 extractSections 提取的内容
 *
 * 返回被注入的 section 名称列表（用于日志记录）。
 */
export function applyCustomSections(
  sectionMap: SectionMap,
  customSections: Record<string, string> | undefined,
): string[] {
  if (!customSections || typeof customSections !== 'object' || Array.isArray(customSections)) return []

  const entries = Object.entries(customSections)
  if (entries.length === 0) return []

  const appliedNames: string[] = []

  for (const [name, content] of entries) {
    if (typeof content !== 'string') {
      continue
    }

    // 自动补标题行
    const finalContent = content.startsWith('## ')
      ? content
      : `## ${name}\n${content}`

    sectionMap.set(name, finalContent)
    appliedNames.push(name)
  }

  return appliedNames
}

/**
 * 将远端配置中的 section_overrides 应用到 sectionMap 上。
 * - key 必须在 allowedSections 白名单中，否则静默忽略
 * - value 为空字符串时，从 sectionMap 中删除该 section
 * - value 不以 "## " 开头时，自动补上 "## {sectionName}\n" 标题行
 * - value 已以 "## " 开头时，直接使用
 *
 * 返回被覆盖的 section 名称列表（用于日志记录）。
 */
export function applySectionOverrides(
  sectionMap: SectionMap,
  overrides: Record<string, string> | undefined,
  allowedSections?: string[],
): string[] {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return []
  if (Object.keys(overrides).length === 0) return []

  const allowedSet = allowedSections && allowedSections.length > 0
    ? new Set(allowedSections)
    : null

  const appliedNames: string[] = []

  for (const [name, content] of Object.entries(overrides)) {
    // 白名单校验：如果有白名单，key 必须在白名单中
    if (allowedSet && !allowedSet.has(name)) {
      continue
    }

    // 类型校验：value 必须是字符串
    if (typeof content !== 'string') {
      continue
    }

    // 空字符串 → 删除该 section
    if (content === '') {
      sectionMap.delete(name)
      appliedNames.push(name)
      continue
    }

    // 自动补标题行
    const finalContent = content.startsWith('## ')
      ? content
      : `## ${name}\n${content}`

    sectionMap.set(name, finalContent)
    appliedNames.push(name)
  }

  return appliedNames
}

/**
 * 根据 section 名称列表，从 sectionMap 中按顺序拼接内容。
 * 找不到的 section 静默跳过。
 */
export function buildContent(names: string[], sectionMap: SectionMap): string {
  const parts: string[] = []
  for (const name of names) {
    if (sectionMap.has(name)) {
      parts.push(sectionMap.get(name)!.trim())
    }
  }
  return parts.join('\n\n')
}

// ============================================================================
// 远端配置拉取
// ============================================================================

/**
 * 内部实际执行网络请求拉取配置的函数。
 * 不应直接调用，应通过 loadConfig 的缓存/去重层间接调用。
 */
async function fetchConfigFromRemote(
  fetchFn: typeof fetch,
  logger: QClawLogger,
): Promise<{ data: Config | null; error?: string }> {
  const startTime = Date.now()
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  // 首次调用时打印环境信息
  if (!envLogged) {
    const currentEnv = process.env['BUILD_ENV'] === 'production' ? 'production' : 'test'
    logger.info(`[prompt-optimizer] 当前环境: ${currentEnv}，配置拉取地址: ${REMOTE_CONFIG_URL}`)
    envLogged = true
  }

  // 注意：本函数不修改 lastConfigSource / lastConfigError，
  // 由调用方（loadConfig / triggerBackgroundRefresh）根据上下文决定是否更新，
  // 避免后台刷新失败时错误覆盖"使用缓存"的状态。

  try {
    const res = await fetchFn(REMOTE_CONFIG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: controller.signal,
    })

    const latencyMs = Date.now() - startTime

    // ── 检查 HTTP 状态码 ──
    if (!res.ok) {
      const errorMsg = `配置拉取失败: HTTP ${res.status}`
      logger.warn(`[prompt-optimizer] ${errorMsg}`)
      return { data: null, error: errorMsg }
    }

    // ── 检查 Content-Type ──
    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('application/json') && !contentType.includes('text/json')) {
      const errorMsg = `配置拉取失败: 非 JSON 响应 (Content-Type: ${contentType})`
      logger.warn(`[prompt-optimizer] ${errorMsg}`)
      return { data: null, error: errorMsg }
    }

    // ── 解析 JSON ──
    const json = await res.json()
    const data = json?.resp?.data as Config
    if (data && typeof data === 'object') {
      // 拉取成功，写入本地文件缓存
      writeConfigCache(data)
      return { data }
    }

    // 数据格式异常
    const formatError = '配置拉取失败: 服务端返回数据格式异常'
    logger.warn(`[prompt-optimizer] ${formatError}`)
    return { data: null, error: formatError }
  } catch (e) {
    const latencyMs = Date.now() - startTime
    const isTimeout = (e instanceof Error && e.name === 'AbortError') || controller.signal.aborted
    const errorMsg = isTimeout
      ? `配置拉取超时(${FETCH_TIMEOUT_MS}ms)`
      : `配置拉取失败: ${e instanceof Error ? e.message : String(e)}`

    if (isTimeout) {
      logger.warn(`[prompt-optimizer] 配置拉取超时(${FETCH_TIMEOUT_MS}ms)`)
    } else {
      const detail = e instanceof Error ? e.message : String(e)
      logger.warn(`[prompt-optimizer] 配置拉取失败: ${detail}`)
    }
    return { data: null, error: errorMsg }
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * 后台异步刷新配置（fire-and-forget）。
 * 处理 inflight 去重、失败退避逻辑，不阻塞调用方。
 */
function triggerBackgroundRefresh(
  fetchFn: typeof fetch,
  logger: QClawLogger,
): void {
  // 退避冷却期内不发请求
  if (Date.now() < backoffUntil) {
    return
  }

  // 已有 inflight 请求，不重复发起
  if (inflightPromise) {
    return
  }

  inflightPromise = (async () => {
    const { data, error } = await fetchConfigFromRemote(fetchFn, logger)

    if (data) {
      // 拉取成功：更新内存缓存，重置失败计数
      memoryCache = data
      memoryCacheTime = Date.now()
      consecutiveFailures = 0
      backoffUntil = 0
      // 后台刷新成功，更新配置来源
      lastConfigSource = 'remote'
      lastConfigError = ''
      logger.info('[prompt-optimizer] 后台配置刷新成功')
      return data
    }

    // 后台刷新失败但有缓存兜底：记录 config_error，告知使用了本地缓存
    if (memoryCache) {
      lastConfigSource = 'cache'
      lastConfigError = error ? `${error}，已使用本地缓存文件` : '配置拉取失败，已使用本地缓存文件'
    }
    consecutiveFailures++
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      backoffUntil = Date.now() + BACKOFF_DURATION_MS
      logger.warn(
        `[prompt-optimizer] 连续失败 ${consecutiveFailures} 次，进入 ${BACKOFF_DURATION_MS / 60_000} 分钟退避冷却期`,
      )
    }
    return null
  })()

  // fire-and-forget：确保清理 inflight 标记
  inflightPromise
    .finally(() => { inflightPromise = null })
    .catch(() => { /* 异常已在 fetchConfigFromRemote 内部处理 */ })
}

/**
 * 获取配置（stale-while-revalidate 模式，全路径零阻塞）。
 *
 * - **有缓存时**：立即返回缓存（零延迟），若已过期则后台异步刷新
 * - **冷启动 + 有文件缓存**：立即返回文件缓存，后台异步刷新
 * - **冷启动 + 无任何缓存**：同步等待远程拉取，成功则使用远程配置，失败则返回 null
 *
 * 原则：宁可跳过优化，也不阻塞 FetchChain / user query。
 * TTL 2 分钟，网络请求量极低。
 *
 * @param fetchFn - 原始 fetch（绕过 FetchChain）
 * @param logger - 日志器
 */
export async function loadConfig(
  fetchFn: typeof fetch,
  logger: QClawLogger,
): Promise<Config | null> {
  // ── 1. 有内存缓存：直接返回（不管是否过期） ──
  if (memoryCache) {
    // 缓存已过期 → 后台异步刷新（fire-and-forget），当前请求用旧缓存
    const isExpired = (Date.now() - memoryCacheTime) >= CACHE_TTL_MS
    if (isExpired) {
      triggerBackgroundRefresh(fetchFn, logger)
    }
    // 当前请求实际走的是内存缓存，config_source 反映实际获取路径
    lastConfigSource = 'cache'
    return memoryCache
  }

  // ── 2. 无内存缓存，尝试文件缓存 ──
  const fileCached = readConfigCache()
  if (fileCached) {
    memoryCache = fileCached
    memoryCacheTime = 0 // 标记为已过期，下次请求触发后台刷新
    lastConfigSource = 'cache'
    lastConfigError = ''
    logger.info('[prompt-optimizer] 冷启动：从文件缓存恢复配置')
    // 立即触发后台异步刷新
    triggerBackgroundRefresh(fetchFn, logger)
    return fileCached
  }

  // ── 3. 冷启动且无任何缓存：同步等待远程拉取结果 ──
  // 无缓存时必须等远程结果，不能跳过
  logger.info('[prompt-optimizer] 冷启动：无缓存，同步拉取远程配置')
  const { data, error } = await fetchConfigFromRemote(fetchFn, logger)

  if (data) {
    // 远程拉取成功
    memoryCache = data
    memoryCacheTime = Date.now()
    lastConfigSource = 'remote'
    lastConfigError = ''
    logger.info('[prompt-optimizer] 冷启动：远程配置拉取成功')
    return data
  }

  // 远程拉取失败且本地无缓存
  lastConfigSource = 'none'
  lastConfigError = error
    ? `${error}，本地无缓存`
    : '配置拉取失败，本地无缓存'
  logger.warn(`[prompt-optimizer] 冷启动：${lastConfigError}`)
  return null
}

// ============================================================================
// 核心处理逻辑（从 onRequest 中提取，方便测试）
// ============================================================================

/**
 * 处理 LLM 请求体，执行 Prompt 优化。
 * 返回修改后的 jsonBody（如果有变更）或 null（无需修改）。
 */
export function processRequestBody(
  jsonBody: any,
  config: Config,
  requestUrl: string,
  logger: QClawLogger,
): { modified: boolean; jsonBody: any; pathReplacementCount: number } {
  const messages: any[] = jsonBody.messages

  // 检测是否为 Anthropic 协议
  // 判定条件（满足任一即可）：
  //   1. URL 含 anthropic（传统判定）
  //   2. 请求体有顶层 system 字段（Anthropic 特有）且 messages 中没有 role=system（排除 OpenAI 格式）
  const hasTopLevelSystem = jsonBody.system !== undefined
  const hasSystemInMessages = messages.some((m: Record<string, unknown>) => m.role === 'system')
  const isAnthropic = /anthropic/i.test(requestUrl) || (hasTopLevelSystem && !hasSystemInMessages)

  // 找到请求体中的 system prompt 内容
  let systemContent = ''
  let systemIndex = -1

  // 记录原始 system 字段是否为数组格式（用于写回时保留结构）
  let originalSystemIsArray = false

  if (isAnthropic) {
    // Anthropic：优先读取顶层 system 字段
    if (typeof jsonBody.system === 'string') {
      systemContent = jsonBody.system
    } else if (Array.isArray(jsonBody.system)) {
      originalSystemIsArray = true
      // 拼接所有 text block 的内容，避免多 text block 时丢失数据
      systemContent = (jsonBody.system as Array<{ type?: string; text?: string }>)
        .filter((b) => b?.type === 'text' && b?.text)
        .map((b) => b.text)
        .join('\n\n')
    }
    // 同时兼容 messages 中误传的 system 消息
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'system') {
        const extra = typeof messages[i].content === 'string' ? messages[i].content : ''
        if (extra && !systemContent) systemContent = extra
        systemIndex = i
        break
      }
    }
  } else {
    // OpenAI：从 messages 中找 role=system
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'system') {
        systemContent = typeof messages[i].content === 'string' ? messages[i].content : ''
        systemIndex = i
        break
      }
    }
  }

  const hasSystemPrefix = !!config.system_prompt_prefix
  const hasSystemConfig = config.ordered_system_prompt && config.ordered_system_prompt.length > 0
  const hasUserConfig = config.inject_user_query && config.inject_user_query.length > 0
  const hasUserSuffix = !!config.inject_user_query_suffix

  if (!hasSystemPrefix && !hasSystemConfig && !hasUserConfig && !hasUserSuffix) {
    return { modified: false, jsonBody, pathReplacementCount: 0 }
  }

  // 直接从请求体的 system prompt 中动态提取 section（仅识别白名单中的 section）
  const sectionMap = extractSections(systemContent, config._comment_available_sections)

  // ── 从 messages 中的 user 消息补充提取缺失的 section ──
  // 某些动态 section（如 ## Runtime、## Current Date & Time、## Inbound Context 等）
  // 可能不在 system prompt 中，而是由 OpenClaw 上游作为独立的 user message 注入到 messages 中。
  // 需要从这些 user 消息中提取 inject_user_query 所需但 sectionMap 中缺失的 section。
  if (hasUserConfig) {
    const missingSections = config.inject_user_query!.filter((name) => !sectionMap.has(name))
    if (missingSections.length > 0) {
      const missingSet = new Set(missingSections)
      for (const msg of messages) {
        if (msg.role !== 'user') continue
        const content = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? (msg.content as Array<{ type?: string; text?: string }>)
                .filter((b) => b?.type === 'text' && b?.text)
                .map((b) => b.text)
                .join('\n\n')
            : ''
        if (!content) continue
        const extracted = extractSections(content, [...missingSet])
        for (const [key, value] of extracted) {
          if (!sectionMap.has(key)) {
            sectionMap.set(key, value)
            missingSet.delete(key)
          }
        }
        // 所有缺失的 section 都找到了，提前退出
        if (missingSet.size === 0) break
      }
    }
  }

  // 应用 custom_sections：在 extractSections 之后注入自定义 section（不受白名单限制）
  applyCustomSections(sectionMap, config.custom_sections)

  // 应用 section_overrides：在 custom_sections 之后覆盖/新增/删除 section（优先级最高）
  applySectionOverrides(
    sectionMap,
    config.section_overrides,
    config._comment_available_sections,
  )

  let changed = false
  let totalPathReplacementCount = 0

  // 动态检测路径替换（默认启用）
  const enablePathReplacements = config.enable_path_replacements !== false
  const dynamicReplacements = enablePathReplacements ? detectPathReplacements(systemContent) : {}
  const hasPathReplacements = Object.keys(dynamicReplacements).length > 0

  /**
   * 统计文本中所有绝对路径的出现次数（含正反斜杠两种形式）。
   * 用于在 applyPathReplacements 调用前累计实际替换次数。
   */
  function countReplacementsInText(text: string): number {
    if (!text || !hasPathReplacements) return 0
    let count = 0
    for (const [, absolutePath] of Object.entries(dynamicReplacements)) {
      // 统计正向匹配
      count += text.split(absolutePath).length - 1
      // 统计反转分隔符形式
      const flipped = absolutePath.includes('\\')
        ? absolutePath.replace(/\\/g, '/')
        : absolutePath.replace(/\//g, '\\')
      if (flipped !== absolutePath) {
        count += text.split(flipped).length - 1
      }
    }
    return count
  }
  if (hasPathReplacements) {
    sectionMap.set(PATH_MAPPINGS_SECTION, buildPathMappingSection(dynamicReplacements))
  }

  // ── 按 ordered_system_prompt 列表重组 system prompt ──
  if (hasSystemConfig || hasSystemPrefix) {
    const prefix = hasSystemPrefix ? config.system_prompt_prefix!.trim() : ''
    let body = hasSystemConfig
      ? buildContent(config.ordered_system_prompt!, sectionMap)
      : systemContent

    // 对 system prompt 内容执行动态路径替换（绝对路径 → 占位符）
    if (hasPathReplacements) {
      totalPathReplacementCount += countReplacementsInText(body)
      body = applyPathReplacements(body, dynamicReplacements)
    }

    const newSystemContent = prefix && body ? `${prefix}\n\n${body}` : prefix || body
    if (isAnthropic) {
      if (newSystemContent) {
        // 如果原始 system 字段是数组格式，写回时保留数组结构（保留 cache_control 等元数据的兼容性）
        if (originalSystemIsArray && Array.isArray(jsonBody.system)) {
          const originalBlocks = jsonBody.system as Array<Record<string, unknown>>
          const firstTextBlock = originalBlocks.find((b) => b?.type === 'text')
          if (firstTextBlock) {
            // 保留第一个 text block 的元数据（如 cache_control），只替换 text 内容
            jsonBody.system = [{ ...firstTextBlock, text: newSystemContent }]
          } else {
            jsonBody.system = [{ type: 'text', text: newSystemContent }]
          }
        } else {
          jsonBody.system = newSystemContent
        }
      }
      const filtered = messages.filter((m: any) => m.role !== 'system')
      messages.splice(0, messages.length, ...filtered)
      changed = true
    } else {
      if (systemIndex >= 0) {
        messages[systemIndex] = { ...messages[systemIndex], content: newSystemContent }
        changed = true
      } else if (newSystemContent) {
        messages.unshift({ role: 'system', content: newSystemContent })
        changed = true
      }
    }
  }

  // ── 按 inject_user_query + inject_user_query_suffix 作为独立的 user+assistant 消息对插入到 messages 最前面 ──
  // 方案 A：不再拼接到最后一条 user message，而是在 messages 最前面（system 之后）插入独立的
  // user+assistant 对。这样每轮对话的消息前缀保持一致，避免多轮对话中缓存失效。
  if (hasUserConfig || hasUserSuffix) {
    const injection = hasUserConfig ? buildContent(config.inject_user_query!, sectionMap) : ''
    const suffix = hasUserSuffix ? config.inject_user_query_suffix!.trim() : ''

    const contentParts: string[] = []
    if (injection) contentParts.push(injection)
    if (suffix) contentParts.push(suffix)

    if (contentParts.length > 0) {
      const injectedUserContent = contentParts.join('\n\n')

      // 对注入内容执行路径替换（因为从 system prompt 提取的 section 可能包含绝对路径）
      // 但 Path Variable Mappings section 必须保留真实绝对路径，不能被替换成占位符（否则会自引用）
      let finalInjectedContent: string
      if (hasPathReplacements) {
        // 先从注入内容中分离出 Path Variable Mappings section
        const pathMappingHeader = `## ${PATH_MAPPINGS_SECTION}`
        const pathMappingIdx = injectedUserContent.indexOf(pathMappingHeader)

        if (pathMappingIdx !== -1) {
          // 找到映射表 section 的起始位置，将内容分为两部分
          const beforeMapping = injectedUserContent.substring(0, pathMappingIdx).trimEnd()
          const mappingSection = injectedUserContent.substring(pathMappingIdx)

          // 只对映射表之前的内容执行路径替换，映射表本身保持原样
          if (beforeMapping) totalPathReplacementCount += countReplacementsInText(beforeMapping)
          const replacedBefore = beforeMapping ? applyPathReplacements(beforeMapping, dynamicReplacements) : ''
          finalInjectedContent = replacedBefore
            ? `${replacedBefore}\n\n${mappingSection}`
            : mappingSection
        } else {
          // 没有映射表 section，正常替换全部内容
          totalPathReplacementCount += countReplacementsInText(injectedUserContent)
          finalInjectedContent = applyPathReplacements(injectedUserContent, dynamicReplacements)
        }
      } else {
        finalInjectedContent = injectedUserContent
      }

      // assistant 确认回复，支持通过配置自定义
      // 使用 || 而非 ??，确保空字符串也能 fallback 到默认值（部分模型拒绝空 assistant content）
      const ackMessage = config.inject_user_query_ack
        || 'Understood. I\'ve noted your environment details and preferences. I\'ll reference them throughout our conversation.'

      // ── 去重：移除 messages 中已有的旧注入消息对 ──
      // 多轮对话时，上游会把之前 LLM 收到的完整 messages（包含之前注入的 user+assistant 对）
      // 作为对话历史保留下来。如果不去重，每轮对话都会累积一对，导致注入内容重复 N 次。
      // 识别策略：assistant 消息的 content 与 ackMessage 完全匹配的，连同其前面的 user 消息一起移除。
      for (let i = messages.length - 1; i >= 0; i--) {
        if (
          messages[i].role === 'assistant'
          && typeof messages[i].content === 'string'
          && messages[i].content === ackMessage
          && i > 0
          && messages[i - 1].role === 'user'
        ) {
          // 移除这对 user+assistant 消息
          messages.splice(i - 1, 2)
          i-- // 因为移除了 i-1，当前 i 已经指向下一个元素，需要额外减 1
        }
      }

      // 找到第一条非 system 消息的位置作为插入点
      let insertIndex = 0
      if (isAnthropic) {
        // Anthropic 协议：system 在顶层字段，messages 中不应有 system 消息，直接从 0 开始
        insertIndex = 0
      } else {
        // OpenAI 协议：跳过 messages 中的 system 消息
        for (let i = 0; i < messages.length; i++) {
          if (messages[i].role !== 'system') {
            insertIndex = i
            break
          }
          insertIndex = i + 1
        }
      }

      // 插入 user message（包含注入内容）和 assistant 确认回复
      messages.splice(insertIndex, 0,
        { role: 'user', content: finalInjectedContent },
        { role: 'assistant', content: ackMessage },
      )

      changed = true
    }
  }

  // ── Anthropic 协议最终保障：确保 messages 中不含 role=system ──
  if (isAnthropic) {
    const hasSystemInMessages = messages.some((m: any) => m.role === 'system')
    if (hasSystemInMessages) {
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'system') {
          const content = typeof messages[i].content === 'string' ? messages[i].content : ''
          if (content) {
            jsonBody.system = jsonBody.system
              ? `${jsonBody.system}\n\n${content}`
              : content
          }
        }
      }
      const filtered = messages.filter((m: any) => m.role !== 'system')
      messages.splice(0, messages.length, ...filtered)
      changed = true
    }
  }

  return { modified: changed, jsonBody, pathReplacementCount: totalPathReplacementCount }
}

// ============================================================================
// QClawPackage 定义
// ============================================================================

const promptOptimizer: QClawPackage = {
  id: 'prompt-optimizer',
  name: 'Prompt 优化器',
  description: '通过 FetchChain 中间件拦截 LLM 请求，重组 System Prompt、注入 User Query、动态路径替换',

  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },

  setup(ctx: QClawContext): void {
    ctx.logger.info('setup')

    // ── 初始化持久化缓存路径（优先使用用户态 stateDir 或 ~/.qclaw，解决权限问题并兼容跨平台） ──
    const stateDir = ctx.runtime.stateDir
      || process.env.OPENCLAW_STATE_DIR?.trim()
      || process.env.CLAWDBOT_STATE_DIR?.trim()
      || path.join(os.homedir(), '.qclaw')

    if (stateDir) {
      configCacheDir = path.join(stateDir, 'plugins', 'prompt-optimizer')
      configCacheFile = path.join(configCacheDir, 'config-cache.json')
    } else {
      // 兜底到原插件目录（仅用于开发环境或 stateDir 极端缺失情况）
      configCacheDir = path.dirname(fileURLToPath(import.meta.url))
      configCacheFile = path.join(configCacheDir, 'config-cache.json')
    }

    // ── 配置预拉取：利用 setup → 首次 user query 的时间窗口提前加载配置 ──
    // fire-and-forget，不阻塞 setup 流程
    const originalFetch = ctx.getOriginalFetch()
    triggerBackgroundRefresh(originalFetch, ctx.logger)

    ctx.registerFetchMiddleware({
      id: 'prompt-optimizer',
      priority: 900,

      // 只拦截有 body 的请求
      match: (_input: RequestInfo | URL, init?: RequestInit): boolean => {
        return !!init?.body
      },

      async onRequest(reqCtx: FetchRequestContext): Promise<FetchRequestContext> {
        const { input, init } = reqCtx

        // ── 从 content-plugin 挂载的 extra 中获取通用字段 ──
        const cpExtra = (reqCtx.extra as Record<string, unknown>)?._contentPlugin as {
          sessionKey?: string
          roundTraceId?: string
          uid?: string
        } | undefined
        const commonFields = {
          session_id: cpExtra?.sessionKey ?? '',
          trace_id: cpExtra?.roundTraceId ?? '',
          user_id: cpExtra?.uid ?? '',
        }

        // 解析请求体
        const body = init?.body
        let rawBody: string | undefined
        if (typeof body === 'string') {
          rawBody = body
        } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
          rawBody = new TextDecoder().decode(body)
        }

        if (!rawBody) return reqCtx

        let jsonBody: any
        try {
          jsonBody = JSON.parse(rawBody)
        } catch {
          return reqCtx
        }

        // 只处理 OpenAI 格式（含 messages 数组）的请求
        if (!jsonBody || !Array.isArray(jsonBody.messages)) {
          return reqCtx
        }

        const requestUrl = typeof input === 'string' ? input : (input as Request)?.url ?? 'unknown'

        // 获取配置（stale-while-revalidate：读缓存优先，过期后台异步刷新）
        // 使用 getOriginalFetch() 获取原始 fetch，绕过 FetchChain 避免递归
        const originalFetch = ctx.getOriginalFetch()
        const config = await loadConfig(originalFetch, ctx.logger)

        // 配置拉取失败（null）或 switch 为 false 时直接放行
        if (!config || config.switch === false) {
          // ── 上报 skip 日志 ──
          if (cpExtra) {
            const skipReason = !config ? 'config_null' : 'switch_off'
            reportGalileoLog(originalFetch, {
              action: 'prompt_optimizer_skip',
              ...commonFields,
              skip_reason: skipReason,
              config_source: lastConfigSource,
              config_error: lastConfigError,
              optimizer_enabled: false,
            }, ctx.logger)
          }
          return reqCtx
        }

        // ── 记录优化前的 system prompt token 数（~4 字符 ≈ 1 token，与 lossless-claw 一致） ──
        const messages: any[] = jsonBody.messages
        let originalSystemPromptTokens = 0
        if (jsonBody.system !== undefined) {
          // Anthropic 协议
          if (typeof jsonBody.system === 'string') {
            originalSystemPromptTokens = estimateTokens(jsonBody.system)
          } else if (Array.isArray(jsonBody.system)) {
            originalSystemPromptTokens = estimateTokens(
              (jsonBody.system as Array<{ text?: string }>)
                .filter((b) => b?.text)
                .map((b) => b.text!)
                .join('\n\n'),
            )
          }
        } else {
          // OpenAI 协议
          const sysMsg = messages.find((m: Record<string, unknown>) => m.role === 'system')
          if (sysMsg && typeof sysMsg.content === 'string') {
            originalSystemPromptTokens = estimateTokens(sysMsg.content)
          }
        }

        try {
          const result = processRequestBody(
            jsonBody,
            config,
            requestUrl,
            ctx.logger,
          )

          if (result.modified) {
            // 写回修改后的请求体
            const finalBody = JSON.stringify(result.jsonBody)
            reqCtx.init = { ...init, body: finalBody }
          }

          // ── 计算优化后的 system prompt token 数 ──
          let optimizedSystemPromptTokens = originalSystemPromptTokens
          if (result.modified) {
            const resultBody = result.jsonBody
            if (resultBody.system !== undefined) {
              if (typeof resultBody.system === 'string') {
                optimizedSystemPromptTokens = estimateTokens(resultBody.system)
              } else if (Array.isArray(resultBody.system)) {
                optimizedSystemPromptTokens = estimateTokens(
                  (resultBody.system as Array<{ text?: string }>)
                    .filter((b) => b?.text)
                    .map((b) => b.text!)
                    .join('\n\n'),
                )
              }
            } else {
              const sysMsg = resultBody.messages?.find?.((m: Record<string, unknown>) => m.role === 'system')
              if (sysMsg && typeof sysMsg.content === 'string') {
                optimizedSystemPromptTokens = estimateTokens(sysMsg.content)
              }
            }
          }

          // ── 上报 prompt_optimizer_request 日志 ──
          reportGalileoLog(originalFetch, {
            action: 'prompt_optimizer_request',
            ...commonFields,
            // Token 估算（~4 字符 ≈ 1 token，与 lossless-claw 一致）
            original_system_prompt_tokens: originalSystemPromptTokens,
            optimized_system_prompt_tokens: optimizedSystemPromptTokens,
            system_prompt_token_reduction_ratio: originalSystemPromptTokens > 0
              ? Number(((originalSystemPromptTokens - optimizedSystemPromptTokens) / originalSystemPromptTokens).toFixed(4))
              : 0,
            // 路径替换统计
            path_replacement_count: result.pathReplacementCount,
            // 配置来源
            config_source: lastConfigSource,
            config_error: lastConfigError,
            ordered_section_count: config.ordered_system_prompt?.length ?? 0,
            override_section_count: Object.keys(config.section_overrides ?? {}).length,
            custom_section_count: Object.keys(config.custom_sections ?? {}).length,
            // 功能覆盖
            optimizer_enabled: config.switch ?? true,
          }, ctx.logger)
        } catch (e) {
          // 安全降级：processRequestBody 异常时放行原始请求，不阻断 FetchChain
          const errMsg = e instanceof Error ? e.message : String(e)
          ctx.logger.warn(`[prompt-optimizer] processRequestBody 异常，跳过优化: ${errMsg}`)

          // ── 上报 error 日志 ──
          if (cpExtra) {
            reportGalileoLog(originalFetch, {
              action: 'prompt_optimizer_error',
              ...commonFields,
              optimizer_enabled: config.switch ?? true,
              config_source: lastConfigSource,
              config_error: lastConfigError,
              error_message: errMsg,
            }, ctx.logger)
          }
        }

        return reqCtx
      },
    })

    ctx.logger.info('FetchMiddleware registered with priority=900')
  },
}

export default promptOptimizer

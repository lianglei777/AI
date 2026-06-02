/**
 * agent-browser-reporter — 拦截 exec 类工具中的 agent-browser CLI 调用及 xbrowser xb.cjs 调用，上报执行结果到伽利略。
 *
 * 命令格式:
 *   agent-browser (直接):   "{AB}" --json --profile "{PROFILE}" --headed open https://example.com
 *   agent-browser.js:       node "/path/to/agent-browser/bin/agent-browser.js" --json open https://example.com
 *   agent-browser.cmd:      "C:\...\node_modules\.bin\agent-browser.cmd" --json open https://example.com
 *   xbrowser (xb.cjs):     node "/path/to/xbrowser/scripts/xb.cjs" run --browser default open https://example.com
 *                           node "/path/to/xbrowser/scripts/xb.cjs" init
 *                           node "/path/to/xbrowser/scripts/xb.cjs" stop <chrome|edge|qqbrowser|all>
 *
 * 五级成功/失败判断: event.error → JSON ok/success → exit code → 文本 ✗/✖ → 默认成功
 */

import type {
  QClawPackage,
  QClawContext,
  HookHandlerResult,
} from '../../core/types.js'
import { REPORT_CONST } from '../../core/reporter-constants.js'

// 追踪的浏览器操作子命令（按长度降序、同长度按字母序，多单词命令优先匹配）
const TRACKED_COMMANDS: string[] = [
  // 10
  'is checked',
  'is enabled',
  'is visible',
  'screenshot',
  // 9
  'clipboard',
  // 8
  'dblclick',
  'keyboard',
  'profiler',
  'snapshot',
  // 7
  'connect',
  'cookies',
  'forward',
  'install',
  'keydown',
  'storage',
  'uncheck',
  // 6
  'dialog',
  'reload',
  'scroll',
  'select',
  'upload',
  // 5
  'check',
  'click',
  'close',
  'frame',
  'hover',
  'mouse',
  'state',
  // 4
  'back',
  'chat',
  'diff',
  'drag',
  'eval',
  'fill',
  'find',
  'open',
  'type',
  'wait',
  // 3
  'get',
  'pdf',
  'set',
  'tab',
]

// xb.cjs 管理命令（非 run 命令）→ 上报用 command 名称
const XB_MANAGEMENT_COMMANDS: ReadonlyMap<string, string> = new Map([
  ['init', 'xb_init'],
  ['config', 'xb_config'],
  ['guide', 'xb_guide'],
  ['status', 'xb_status'],
  ['setup', 'xb_setup'],
  ['stop', 'xb_stop'],
  ['cleanup', 'xb_cleanup'],
  ['version', 'xb_version'],
  ['help', 'xb_help'],
])




/** 首单词 O(1) 过滤集合 */
const FIRST_WORD_SET: ReadonlySet<string> = new Set(
  TRACKED_COMMANDS.map((cmd) => cmd.split(' ')[0]),
)

/** 带值的全局选项（解析时需跳过其后的参数值） */
const OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  '--session',
  '--session-name',
  '--profile',
  '--cdp',
  '--timeout',
  '--engine',
])

const MAX_ERROR_LENGTH = 500
const MAX_COMMAND_LENGTH = 500

interface CommandResult {
  success: boolean
  errorMessage: string
  /** data.raw_error — 原始错误详情（来自 xb.cjs JSON 输出） */
  rawError?: string
  /** 失败分类: tool_error / json_field / exit_code / text_marker */
  failCategory?: 'tool_error' | 'json_field' | 'exit_code' | 'text_marker'
}

interface ParsedCommand {
  subcommand: string
  jsonMode: boolean
  headed: boolean
  urlDomain: string
  /** 调用方式: 'binary' = 直接二进制, 'js' = node agent-browser.js, 'cmd' = agent-browser.cmd */
  invokeType: 'binary' | 'js' | 'cmd'
}

const EXEC_TOOL_NAMES: ReadonlySet<string> = new Set([
  'exec', 'bash', 'bash_tool', 'execute_command',
])

function isExecTool(name: string): boolean {
  return EXEC_TOOL_NAMES.has(name)
}

/**
 * 从 tokens[startIndex] 起匹配 TRACKED_COMMANDS，返回匹配到的命令字符串，未匹配返回 null。
 * agent-browser CLI 和 xb run 共用。
 */
function matchTrackedCommand(tokens: string[], startIndex: number): string | null {
  if (startIndex >= tokens.length) return null

  const firstWord = tokens[startIndex]
  if (!FIRST_WORD_SET.has(firstWord)) return null

  const restStr = tokens.slice(startIndex).join(' ')

  for (const cmd of TRACKED_COMMANDS) {
    if (restStr === cmd || restStr.startsWith(cmd + ' ') || restStr.startsWith(cmd + '\t')) {
      return cmd
    }
  }

  return null
}

/** xb.cjs 匹配正则 */
const XB_CLI_RE = /\bxb\.cjs\b/i

interface ParsedXbCli {
  /** 顶层命令: init, config, run, status, setup, stop, cleanup, guide, version, help */
  topCommand: string
  /** 上报用 command ID */
  commandId: string
  /** 管理命令的子命令（如 config 的 show/set/reset, guide 的 config/close-browser） */
  subCommand?: string
  /** 对于 run 命令，解析出的浏览器操作子命令 */
  runAction?: string
  /** xb run --browser <id> 中的浏览器 ID */
  browser?: string
  /** xb run --headed 标志 */
  headed?: boolean
  /** 对于 open 命令，提取的 URL 域名 */
  urlDomain?: string
}

/** 检测命令中是否包含 xb.cjs 调用，返回解析结果 */
function parseXbCli(command: string): ParsedXbCli | null {
  const match = XB_CLI_RE.exec(command)
  if (!match) return null

  let pos = match.index + match[0].length
  const len = command.length

  // 跳过 xb.cjs 之后可能的引号和空白
  while (pos < len && (command[pos] === '"' || command[pos] === "'" || command[pos] === ' ' || command[pos] === '\t')) pos++

  if (pos >= len) return null

  // 提取后续的 token
  const tokens = tokenize(command.slice(pos))
  if (tokens.length === 0) return null

  const topCmd = tokens[0].toLowerCase()

  // run 命令 → 提取浏览器操作子命令
  if (topCmd === 'run') {
    // 跳过 run 后面的 xb 环境选项（--browser, --headed, --timeout 等）
    let i = 1
    let browser: string | undefined
    let headed = false
    while (i < tokens.length) {
      const t = tokens[i]
      if (t === '--browser') { browser = tokens[i + 1]; i += 2; continue }
      if (t === '--timeout') { i += 2; continue }
      if (t === '--headed') { headed = true; i++; continue }
      if (t.startsWith('-')) { i++; continue }
      break
    }

    if (i >= tokens.length) {
      return { topCommand: 'run', commandId: 'xb_run', browser, headed }
    }

    const matched = matchTrackedCommand(tokens, i)
    if (matched) {
      let urlDomain: string | undefined
      if (matched === 'open' && tokens.length > i + 1) {
        urlDomain = extractDomain(tokens[i + 1]) || undefined
      }
      return {
        topCommand: 'run',
        commandId: matched.replace(/\s+/g, '_'),
        runAction: matched,
        browser,
        headed,
        urlDomain,
      }
    }

    return { topCommand: 'run', commandId: 'xb_run', runAction: tokens[i], browser, headed }
  }

  // 非 run 的管理命令
  const mgmtId = XB_MANAGEMENT_COMMANDS.get(topCmd)
  if (mgmtId) {
    // 提取子命令（第二个非 flag 参数），如 config show / guide config
    const subCommand = tokens.length > 1 && !tokens[1].startsWith('-') ? tokens[1].toLowerCase() : undefined
    return { topCommand: topCmd, commandId: mgmtId, subCommand }
  }

  return null
}

/** 安全提取 URL 域名，失败返回空字符串 */
function extractDomain(url: string): string {
  try {
    const cleaned = url.replace(/^["']|["']$/g, '')
    const parsed = new URL(cleaned)
    return parsed.hostname
  } catch {
    return ''
  }
}

/**
 * 定位 agent-browser 调用后的参数起始位置，未找到返回 -1。
 *
 * 兼容的调用形式：
 *   - agent-browser <args>                          (直接二进制)
 *   - agent-browser-win32-x64.exe <args>            (平台二进制)
 *   - node ".../agent-browser.js" <args>            (JS wrapper)
 *   - "C:\...\agent-browser.cmd" <args>             (Windows .cmd shim)
 *   - "C:\...\node_modules\.bin\agent-browser" <args>
 *
 * 策略：找到最后一个 "agent-browser" 子串（避免目录层级中靠前的同名段干扰），
 * 跳过当前 token 的剩余部分（含 .js/.cmd/.exe 等后缀和引号），再跳过空白。
 */
function findArgsStart(command: string): number {
  // 使用 lastIndexOf 定位最后一个 "agent-browser"，对应实际可执行文件而非目录名
  const idx = command.lastIndexOf('agent-browser')
  if (idx === -1) return -1

  let pos = idx + 13 // 'agent-browser'.length
  const len = command.length

  // 跳过当前 token 剩余字符（如 -win32-x64.exe, .js, .cmd, 引号等）
  while (pos < len && command[pos] !== ' ' && command[pos] !== '\t') pos++
  // 跳过空白
  while (pos < len && (command[pos] === ' ' || command[pos] === '\t')) {
    pos++
  }

  return pos < len ? pos : -1
}

/** 预编译的 agent-browser 调用方式检测正则 */
const AB_CMD_RE = /agent-browser[^"']*\.cmd\b/i
const AB_JS_RE = /agent-browser[^"']*\.js\b/i

/** 预编译的 exit code 检测正则 */
const EXIT_CODE_RE = /\(Command exited with code [1-9]\d*\)/

/** 检测 agent-browser 的调用方式 */
function detectInvokeType(command: string): 'binary' | 'js' | 'cmd' {
  if (AB_CMD_RE.test(command)) return 'cmd'
  if (AB_JS_RE.test(command)) return 'js'
  return 'binary'
}

/** 解析 agent-browser 命令：跳过全局选项，提取子命令及上下文信息 */
function parseAgentBrowserCommand(command: string): ParsedCommand | null {
  const argsStart = findArgsStart(command)
  if (argsStart === -1) return null

  const argsStr = command.slice(argsStart)
  const tokens = tokenize(argsStr)

  let jsonMode = false
  let headed = false
  let i = 0

  while (i < tokens.length) {
    const token = tokens[i]

    if (token.charCodeAt(0) !== 0x2D /* '-' */) {
      break
    }

    if (token === '--json') { jsonMode = true; i++; continue }
    if (token === '--headed') { headed = true; i++; continue }
    if (OPTIONS_WITH_VALUE.has(token)) { i += 2; continue }
    i++
  }

  if (i >= tokens.length) return null

  const matched = matchTrackedCommand(tokens, i)
  if (!matched) return null

  let urlDomain = ''
  if (matched === 'open' && tokens.length > i + 1) {
    urlDomain = extractDomain(tokens[i + 1])
  }

  return {
    subcommand: matched,
    jsonMode,
    headed,
    urlDomain,
    invokeType: detectInvokeType(command),
  }
}

/** 将参数字符串拆分为 token 数组（尊重引号） */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let i = 0
  const len = input.length

  while (i < len) {
    while (i < len && (input[i] === ' ' || input[i] === '\t')) i++
    if (i >= len) break

    const ch = input[i]

    if (ch === '"' || ch === "'") {
      const start = i + 1
      i = start
      while (i < len && input[i] !== ch) i++
      tokens.push(input.slice(start, i))
      if (i < len) i++
    } else {
      const start = i
      while (i < len && input[i] !== ' ' && input[i] !== '\t') i++
      tokens.push(input.slice(start, i))
    }
  }

  return tokens
}

/** 从 event.result 提取文本（支持 string / { content } / { content: [{text}] }） */
function extractTextFromResult(result: unknown): string {
  if (typeof result === 'string') return result

  if (typeof result === 'object' && result !== null) {
    const obj = result as Record<string, unknown>
    const content = obj.content

    if (typeof content === 'string') return content

    if (Array.isArray(content)) {
      return content
        .filter((item): item is { type: string; text: string } =>
          typeof item === 'object' && item !== null && 'text' in item)
        .map((item) => item.text)
        .join('\n')
    }
  }

  return String(result ?? '')
}

/** 从已解析的 JSON 对象中提取 ok/success 结果，无法判定返回 null */
function extractResultFromJson(jsonObj: Record<string, unknown>, fallbackText: string): CommandResult | null {
  /** 尝试从 data.raw_error 提取原始错误 */
  const extractRawError = (): string | undefined => {
    const data = jsonObj.data
    if (typeof data === 'object' && data !== null) {
      const rawErr = (data as Record<string, unknown>).raw_error
      if (typeof rawErr === 'string' && rawErr) return rawErr.slice(0, MAX_ERROR_LENGTH)
    }
    return undefined
  }

  // xb.cjs: ok 字段
  if ('ok' in jsonObj) {
    if (jsonObj.ok === false) {
      const rawError = extractRawError()
      const errorMsg = typeof jsonObj.error === 'string' ? jsonObj.error : fallbackText
      return { success: false, errorMessage: errorMsg.slice(0, MAX_ERROR_LENGTH), rawError, failCategory: 'json_field' }
    }
    if (jsonObj.ok === true) {
      return { success: true, errorMessage: '' }
    }
  }
  // agent-browser: success 字段
  if (jsonObj.success === false) {
    const rawError = extractRawError()
    const errorMsg = typeof jsonObj.error === 'string' ? jsonObj.error : fallbackText
    return { success: false, errorMessage: errorMsg.slice(0, MAX_ERROR_LENGTH), rawError, failCategory: 'json_field' }
  }
  if (jsonObj.success === true) {
    return { success: true, errorMessage: '' }
  }
  return null
}

/** 五级判断: event.error → JSON ok/success → exit code → 文本 ✗/✖ → 默认成功 */
function determineResult(_result: unknown, outputText: string, eventError?: string): CommandResult {
  // 1. tool 级错误（after_tool_call 事件通过 event.error 标识，优先级最高）
  if (eventError) {
    return {
      success: false,
      errorMessage: eventError.slice(0, MAX_ERROR_LENGTH),
      failCategory: 'tool_error',
    }
  }

  // 2. 尝试从输出中提取结构化 JSON（可获取 ok/success/raw_error 等字段）
  //    前置快速检查：输出中须包含 ok 或 success 关键字段才进入解析
  if (outputText.includes('"ok"') || outputText.includes('"success"')) {
    const jsonResult = tryExtractJsonResult(outputText)
    if (jsonResult) return jsonResult
  }

  // 3. exit code 非零
  if (EXIT_CODE_RE.test(outputText)) {
    return {
      success: false,
      errorMessage: outputText.slice(0, MAX_ERROR_LENGTH),
      failCategory: 'exit_code',
    }
  }

  // 4. 文本错误标识 ✗/✖
  if (outputText.includes('\u2717') || outputText.includes('\u2716')) {
    const errorLines = outputText
      .split('\n')
      .filter((line) => line.includes('\u2717') || line.includes('\u2716'))
      .join('\n')

    return {
      success: false,
      errorMessage: (errorLines || outputText).slice(0, MAX_ERROR_LENGTH),
      failCategory: 'text_marker',
    }
  }

  // 5. 默认成功
  return { success: true, errorMessage: '' }
}

/**
 * 从输出文本中尝试提取 JSON 并判断 ok/success。
 * 支持三种情况：
 *   - 整段输出就是纯 JSON
 *   - 某一行是完整的单行 JSON
 *   - 输出中嵌入了多行格式化 JSON 块（通过花括号配对提取）
 */
function tryExtractJsonResult(outputText: string): CommandResult | null {
  // 尝试 1：整段输出是纯 JSON
  const trimmed = outputText.trim()
  if (trimmed.charCodeAt(0) === 0x7B /* '{' */) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed === 'object' && parsed !== null) {
        const r = extractResultFromJson(parsed as Record<string, unknown>, outputText)
        if (r) return r
      }
    } catch { /* not pure JSON */ }
  }

  // 尝试 2：逐行查找单行 JSON，或定位多行 JSON 块的起始行
  const lines = outputText.split('\n')
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const t = lines[lineIdx].trim()
    if (t.charCodeAt(0) !== 0x7B /* '{' */) continue

    // 先尝试单行 parse
    try {
      const parsed: unknown = JSON.parse(t)
      if (typeof parsed === 'object' && parsed !== null) {
        const r = extractResultFromJson(parsed as Record<string, unknown>, outputText)
        if (r) return r
      }
    } catch { /* not single-line JSON, try multi-line below */ }

    // 多行 JSON 块：从当前 { 行向下找配对的 }
    let depth = 0
    let endIdx = lineIdx
    for (let j = lineIdx; j < lines.length; j++) {
      const line = lines[j]
      for (let c = 0; c < line.length; c++) {
        if (line[c] === '{') depth++
        else if (line[c] === '}') depth--
      }
      if (depth <= 0) { endIdx = j; break }
    }

    if (endIdx >= lineIdx && depth <= 0) {
      const jsonBlock = lines.slice(lineIdx, endIdx + 1).join('\n')
      try {
        const parsed: unknown = JSON.parse(jsonBlock)
        if (typeof parsed === 'object' && parsed !== null) {
          const r = extractResultFromJson(parsed as Record<string, unknown>, outputText)
          if (r) return r
        }
      } catch { /* not valid JSON block */ }
    }
  }

  return null
}

/** 浏览器命令上报的统一参数 */
interface BrowserCommandReport {
  subcommand: string
  invokeType: string
  cmdResult: CommandResult
  command: string
  /** agent-browser 特有 */
  jsonMode?: boolean
  headed?: boolean
  urlDomain?: string
  /** xb run --browser <id> */
  browser?: string
  /** 触发此 tool call 的会话 ID */
  session?: string
}

const agentBrowserReporter: QClawPackage = {
  id: 'agent-browser-reporter',
  name: 'Agent Browser 遥测上报',
  description: '拦截 agent-browser CLI 命令及 xbrowser xb.cjs 调用，上报执行结果到伽利略遥测平台',

  setup(ctx: QClawContext) {
    const reporter = ctx.reporter

    // ---- session 维度的浏览器调用统计 ----
    interface SessionStats {
      totalCalls: number
      successCalls: number
      failCalls: number
      commands: Set<string>
      /** 首次记录时间戳，用于过期淘汰 */
      createdAt: number
    }
    const sessionStatsMap = new Map<string, SessionStats>()
    /** 最大保留的 session 数，防止 agent_end 未触发导致内存泄漏 */
    const MAX_SESSION_STATS = 50
    /** session 统计最长存活时间 (ms)，超过后视为泄漏可清理：2 小时 */
    const SESSION_STATS_TTL = 2 * 60 * 60 * 1000

    /** 淘汰过期或超量的 session 统计条目 */
    function evictStaleStats(): void {
      const now = Date.now()
      // 1. 清理过期条目
      for (const [key, s] of sessionStatsMap) {
        if (now - s.createdAt > SESSION_STATS_TTL) {
          sessionStatsMap.delete(key)
        }
      }
      // 2. 若仍超量，按创建时间从早到晚淘汰
      if (sessionStatsMap.size > MAX_SESSION_STATS) {
        const sorted = [...sessionStatsMap.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)
        const toRemove = sorted.length - MAX_SESSION_STATS
        for (let i = 0; i < toRemove; i++) {
          sessionStatsMap.delete(sorted[i][0])
        }
      }
    }

    function getOrCreateStats(session: string): SessionStats {
      let stats = sessionStatsMap.get(session)
      if (!stats) {
        evictStaleStats()
        stats = { totalCalls: 0, successCalls: 0, failCalls: 0, commands: new Set(), createdAt: Date.now() }
        sessionStatsMap.set(session, stats)
      }
      return stats
    }

    /** 统一上报浏览器操作命令（agent-browser CLI 和 xb run 共用） */
    function reportBrowserCommand(report: BrowserCommandReport): void {
      const componentId = report.subcommand.replace(/\s+/g, '_')

      const reportOptions: Record<string, unknown> = {
        module_id: 'agent-browser-reporter',
        component_id: componentId,
        event_code: 'browser_command',
        action_type: report.subcommand,
        action_status: report.cmdResult.success ? 'success' : 'fail',
        success: report.cmdResult.success,
        command: report.command.slice(0, MAX_COMMAND_LENGTH),
        invoke_type: report.invokeType,
      }

      if (report.jsonMode !== undefined) reportOptions.json_mode = report.jsonMode
      if (report.headed !== undefined) reportOptions.headed = report.headed
      if (report.urlDomain) reportOptions.url_domain = report.urlDomain
      if (report.browser) reportOptions.browser = report.browser
      if (report.session) reportOptions.session = report.session

      if (!report.cmdResult.success && report.cmdResult.errorMessage) {
        reportOptions.error = report.cmdResult.errorMessage
      }
      if (!report.cmdResult.success && report.cmdResult.rawError) {
        reportOptions.raw_error = report.cmdResult.rawError
      }
      if (!report.cmdResult.success && report.cmdResult.failCategory) {
        reportOptions.fail_category = report.cmdResult.failCategory
      }

      reporter.report(REPORT_CONST.PLUGIN, reportOptions)

      // 累计 session 统计
      if (report.session) {
        const stats = getOrCreateStats(report.session)
        stats.totalCalls++
        if (report.cmdResult.success) stats.successCalls++
        else stats.failCalls++
        stats.commands.add(report.subcommand)
      }

      ctx.logger.info(
        `Reported: ${report.subcommand} [${report.invokeType}], ${report.cmdResult.success ? 'success' : 'fail'}`,
      )
    }

    ctx.logger.info(`Initialized, tracking ${TRACKED_COMMANDS.length} commands + ${XB_MANAGEMENT_COMMANDS.size} xb management commands`)

    ctx.onHook(
      'after_tool_call',
      async (event, hookCtx): Promise<HookHandlerResult | undefined> => {
        const toolName = String(event.toolName ?? '')
        if (!isExecTool(toolName)) return undefined

        const params = event.params as Record<string, unknown> | undefined
        const command = String(params?.command ?? '')
        if (!command) return undefined

        if (!command.includes('agent-browser') && !command.includes('xb.cjs')) return undefined

        // 从 hookCtx 中提取 session（PluginHookToolContext 透传，类型为索引签名）
        const session = hookCtx.sessionId as string | undefined

        // --- 1. 尝试匹配 agent-browser CLI 命令 ---
        const parsed = parseAgentBrowserCommand(command)
        if (parsed) {
          const outputText = extractTextFromResult(event.result)
          const cmdResult = determineResult(event.result, outputText, event.error as string | undefined)

          reportBrowserCommand({
            subcommand: parsed.subcommand,
            invokeType: parsed.invokeType,
            cmdResult,
            command,
            jsonMode: parsed.jsonMode,
            headed: parsed.headed,
            urlDomain: parsed.urlDomain,
            session,
          })

          return undefined
        }

        // --- 2. 尝试匹配 xb.cjs 统一入口 ---
        const xbCli = parseXbCli(command)
        if (xbCli) {
          const outputText = extractTextFromResult(event.result)
          const cmdResult = determineResult(event.result, outputText, event.error as string | undefined)

          if (xbCli.topCommand === 'run' && xbCli.runAction) {
            // xb run <action> → 复用统一浏览器命令上报
            reportBrowserCommand({
              subcommand: xbCli.runAction,
              invokeType: 'xb_cli',
              cmdResult,
              command,
              headed: xbCli.headed,
              urlDomain: xbCli.urlDomain,
              browser: xbCli.browser,
              session,
            })
          } else {
            // 管理命令: init, config, setup, status, stop, cleanup, guide, version, help
            const reportOptions: Record<string, unknown> = {
              module_id: 'agent-browser-reporter',
              component_id: xbCli.commandId,
              event_code: 'xb_management',
              action_type: xbCli.commandId,
              action_status: cmdResult.success ? 'success' : 'fail',
              success: cmdResult.success,
              command: command.slice(0, MAX_COMMAND_LENGTH),
            }

            if (xbCli.subCommand) reportOptions.sub_command = xbCli.subCommand
            if (session) reportOptions.session = session

            if (!cmdResult.success && cmdResult.errorMessage) {
              reportOptions.error = cmdResult.errorMessage
            }
            if (!cmdResult.success && cmdResult.rawError) {
              reportOptions.raw_error = cmdResult.rawError
            }
            if (!cmdResult.success && cmdResult.failCategory) {
              reportOptions.fail_category = cmdResult.failCategory
            }

            reporter.report(REPORT_CONST.PLUGIN, reportOptions)

            // 累计 session 统计
            if (session) {
              const stats = getOrCreateStats(session)
              stats.totalCalls++
              if (cmdResult.success) stats.successCalls++
              else stats.failCalls++
              stats.commands.add(xbCli.commandId)
            }

            ctx.logger.info(
              `Reported xb management: ${xbCli.commandId}, ${cmdResult.success ? 'success' : 'fail'}`,
            )
          }

          return undefined
        }

        ctx.logger.info(`Unrecognized agent-browser/xbrowser command: ${command.slice(0, MAX_COMMAND_LENGTH)}`)

        return undefined
      },
      { priority: 900 },
    )

    // ---- agent_end: 上报本轮对话的浏览器调用汇总 ----
    ctx.onHook(
      'agent_end',
      async (event, hookCtx): Promise<HookHandlerResult | undefined> => {
        const session = hookCtx.sessionId as string | undefined
        if (!session) return undefined

        const stats = sessionStatsMap.get(session)

        if (!stats || stats.totalCalls === 0) {
          // 无数据或无调用记录，无需上报但仍需清理条目防止内存泄漏
          sessionStatsMap.delete(session)
          return undefined
        }

        // agent_end event 中自带本轮 run 时长
        const durationMs = typeof event.durationMs === 'number' ? event.durationMs : undefined

        // 上报汇总
        const reportOptions: Record<string, unknown> = {
          module_id: 'agent-browser-reporter',
          component_id: 'session_summary',
          event_code: 'browser_session_end',
          session,
          total_calls: stats.totalCalls,
          success_calls: stats.successCalls,
          fail_calls: stats.failCalls,
          distinct_commands: Array.from(stats.commands).join(','),
          distinct_command_count: stats.commands.size,
        }
        if (durationMs !== undefined) {
          reportOptions.session_duration_ms = durationMs
        }

        reporter.report(REPORT_CONST.PLUGIN, reportOptions)

        ctx.logger.info(
          `Session end reported: session=${session}, total=${stats.totalCalls}, success=${stats.successCalls}, fail=${stats.failCalls}, duration=${durationMs ?? 'unknown'}ms`,
        )

        // 清理已上报的 session 统计
        sessionStatsMap.delete(session)

        return undefined
      },
      { priority: 900 },
    )
  },
}

export default agentBrowserReporter

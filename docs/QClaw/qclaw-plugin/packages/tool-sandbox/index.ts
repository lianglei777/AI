/**
 * tool-sandbox — 工具执行沙箱 Package
 *
 * 核心机制：通过 before_tool_call 钩子改写 params.command，
 * 将原始命令包装为 lowpriv wrapper 调用，在低权限沙箱中执行。
 *
 * ★ 黑名单机制：
 *   内置一份受保护目录黑名单（OS 核心、凭据密钥、浏览器数据等）。
 *   如果命令操作的路径命中黑名单 → 以低权限执行（lowpriv wrapper）。
 *   如果命令操作的路径不在黑名单中 → 正常权限执行。
 *   无法从命令中提取路径 → 保守策略，以低权限执行。
 *
 * ★ 平台支持：
 * - Windows: 完整降权支持（lowpriv-launcher.exe，Low Integrity Level）
 * - macOS: 暂不支持降权（lowpriv-exec.sh 未实现），插件仅保留 blockPatterns
 *   高危命令拦截和审计日志能力，exec 命令不做降权包装
 *
 * 设计原则：
 * - 对 exec 类工具（bash_tool / execute_command）进行命令改写，降权执行（仅限 Windows）
 * - 对文件写操作工具（write_to_file / replace_in_file 等）检查目标路径，
 *   命中受保护目录时直接阻止（block），防止绕过 exec 降权的安全漏洞
 * - blockPatterns 高危命令拦截在所有平台上生效
 * - 对 read_file / search 等只读工具放行
 * - 降权失败时（wrapper 不存在）回退到正常执行 + stderr 告警
 * - 技能管理命令（npx skills / clawhub）跳过降权，以正常权限运行
 *   这类命令需要写入 ~/.qclaw/skills/ 等受保护目录，降权后必然失败
 *
 * 动态开关机制（★ 无需重启进程即可生效）：
 * - 降权开关通过 ConfigCenter 统一管理（ctx.getConfig() + ctx.onConfigChange()）
 * - Electron 端通过 QClawPluginConfigWriter 将 toolSandbox.enabled 写入 qclaw-plugin-config.json
 * - ConfigCenter 的 fs.watch 感知文件变更后自动通知 tool-sandbox
 * - 环境变量 QCLAW_TOOL_LOWPRIV 仍作为初始值兜底（ConfigCenter 无配置时回退）
 *
 * 环境变量（由 Electron createCleanEnv() 注入，仅 Windows）：
 * - QCLAW_TOOL_LOWPRIV=1               降权总开关（初始值，ConfigCenter 配置优先级更高）
 * - QCLAW_TOOL_WRAPPER_PATH=path       wrapper 可执行文件路径
 * - QCLAW_TOOL_SANDBOX_LEVEL=level     降权级别（standard/strict/custom）
 *
 * 迁移自: extensions/tool-sandbox/index.ts
 */

import type { QClawPackage, QClawContext, HookHandlerResult, SyncHookHandlerResult } from '../../core/types.js'

// ============================================================================
// 类型定义
// ============================================================================

export interface ToolSandboxConfig {
  /** 降权总开关（由 Electron 端通过 ConfigCenter 动态下发） */
  enabled: boolean
  auditLog: boolean
  blockPatterns: string[]
  denyWritePaths: string[]
}

interface LowprivTrackingInfo {
  protectedDir: string
  originalCommand: string
}

interface PermissionDeniedInfo {
  detected: boolean
  paths: string[]
  directories: string[]
}

// ============================================================================
// 常量
// ============================================================================

/** 受保护目录黑名单 — 写操作命中这些目录时以低权限执行 */
const PROTECTED_DIR_PATTERNS: string[] = [
  // ── 1. OS 核心目录 ──
  '%SystemRoot%',
  '%SystemRoot%\\System32',
  '%SystemRoot%\\SysWOW64',
  '%SystemRoot%\\WinSxS',
  '%SystemDrive%\\Windows',
  // ── 2. 系统引导 / 恢复 ──
  '%SystemDrive%\\Boot',
  '%SystemDrive%\\Recovery',
  '%SystemDrive%\\EFI',
  // ── 3. 凭据 / 密钥 ──
  '%USERPROFILE%\\.ssh',
  '%USERPROFILE%\\.gnupg',
  '%USERPROFILE%\\.aws',
  '%USERPROFILE%\\.azure',
  '%USERPROFILE%\\.kube',
  '%USERPROFILE%\\.docker',
  '%USERPROFILE%\\.config',
  '%APPDATA%\\Microsoft\\Credentials',
  '%APPDATA%\\Microsoft\\Protect',
  // ── 4. 浏览器用户数据 ──
  '%LOCALAPPDATA%\\Google\\Chrome\\User Data',
  '%LOCALAPPDATA%\\Microsoft\\Edge\\User Data',
  '%APPDATA%\\Mozilla\\Firefox\\Profiles',
  // ── 5. 用户目录（排除当前用户，防止跨用户访问）──
  '%SystemDrive%\\Users',
]

/** 凭据 / 密钥目录 — 禁止读 + 写 */
const CREDENTIAL_DIR_PATTERNS: string[] = [
  '%USERPROFILE%\\.ssh',
  '%USERPROFILE%\\.gnupg',
  '%USERPROFILE%\\.aws',
  '%USERPROFILE%\\.azure',
  '%USERPROFILE%\\.kube',
  '%USERPROFILE%\\.docker',
  '%USERPROFILE%\\.config',
  '%APPDATA%\\Microsoft\\Credentials',
  '%APPDATA%\\Microsoft\\Protect',
  '%LOCALAPPDATA%\\Google\\Chrome\\User Data',
  '%LOCALAPPDATA%\\Microsoft\\Edge\\User Data',
  '%APPDATA%\\Mozilla\\Firefox\\Profiles',
]

/** 系统核心注册表路径 — 拦截读写操作 */
const PROTECTED_REGISTRY_PATHS: Array<{ path: string; blockRead: boolean; blockWrite: boolean; desc: string }> = [
  { path: 'HKLM\\SECURITY', blockRead: true, blockWrite: true, desc: '安全策略数据库' },
  { path: 'HKLM\\SAM', blockRead: true, blockWrite: true, desc: '用户账户安全数据库' },
  { path: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa', blockRead: true, blockWrite: true, desc: 'LSA 认证配置' },
  { path: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders', blockRead: true, blockWrite: true, desc: '安全提供程序' },
  { path: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager', blockRead: false, blockWrite: true, desc: '会话管理器' },
  { path: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options', blockRead: false, blockWrite: true, desc: '映像劫持' },
  { path: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon', blockRead: false, blockWrite: true, desc: '登录配置' },
  { path: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\SafeBoot', blockRead: false, blockWrite: true, desc: '安全启动配置' },
  { path: 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters', blockRead: false, blockWrite: true, desc: 'TCP/IP 核心参数' },
  { path: 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy', blockRead: false, blockWrite: true, desc: '防火墙策略' },
  { path: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender', blockRead: false, blockWrite: true, desc: 'Defender 策略' },
  { path: 'HKLM\\SOFTWARE\\Microsoft\\Windows Defender', blockRead: false, blockWrite: true, desc: 'Defender 配置' },
  { path: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\safer', blockRead: false, blockWrite: true, desc: '软件限制策略' },
  { path: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI', blockRead: false, blockWrite: true, desc: '代码完整性策略' },
]

/** 不受信目录关键词列表 */
const UNTRUSTED_DIR_KEYWORDS = [
  '/downloads/',
  '/desktop/',
  '/temp/',
  '/tmp/',
  '/appdata/',
  '/public/',
]

/** 危险可执行文件扩展名 */
const DANGEROUS_EXECUTABLE_EXTS = [
  '.exe', '.bat', '.cmd', '.msi', '.scr', '.pif', '.com',
  '.vbs', '.vbe', '.wsf', '.wsh', '.ps1',
]

/** 脚本执行模式列表 */
const SCRIPT_EXEC_PATTERNS = [
  /(?:python[23]?|py)\s+(?:-\S+\s+)*"([^"]+\.py)"/i,
  /(?:python[23]?|py)\s+(?:-\S+\s+)*'([^']+\.py)'/i,
  /(?:python[23]?|py)\s+(?:-\S+\s+)*(\S+\.py)(?:\s|$)/i,
  /(?:powershell|pwsh)(?:\.exe)?\s+.*?-(?:File|f)\s+"([^"]+\.ps1)"/i,
  /(?:powershell|pwsh)(?:\.exe)?\s+.*?-(?:File|f)\s+'([^']+\.ps1)'/i,
  /(?:powershell|pwsh)(?:\.exe)?\s+.*?-(?:File|f)\s+(\S+\.ps1)(?:\s|$)/i,
  /(?:node|tsx?)\s+(?:-\S+\s+)*"([^"]+\.(?:js|ts|mjs|cjs))"/i,
  /(?:node|tsx?)\s+(?:-\S+\s+)*(\S+\.(?:js|ts|mjs|cjs))(?:\s|$)/i,
  /(?:bash|sh|zsh)\s+(?:-\S+\s+)*"([^"]+\.sh)"/i,
  /(?:bash|sh|zsh)\s+(?:-\S+\s+)*(\S+\.sh)(?:\s|$)/i,
  /(?:cmd(?:\.exe)?\s+\/c\s+)"([^"]+\.(?:bat|cmd))"/i,
  /(?:cmd(?:\.exe)?\s+\/c\s+)(\S+\.(?:bat|cmd))(?:\s|$)/i,
  /^"([^"]+\.(?:bat|cmd))"\s*$/i,
  /^(\S+\.(?:bat|cmd))\s*$/i,
  /^&\s*"([^"]+\.(?:bat|cmd))"/i,
  /^&\s*'([^']+\.(?:bat|cmd))'/i,
  /^&\s*(\S+\.(?:bat|cmd))(?:\s|$)/i,
  /(?:start|call)(?:\.exe)?\s+(?:\/\S+\s+)*"([^"]+\.(?:bat|cmd))"/i,
  /(?:start|call)(?:\.exe)?\s+(?:\/\S+\s+)*(\S+\.(?:bat|cmd))(?:\s|$)/i,
]

/** 权限拒绝模式列表 */
const PERMISSION_DENIED_PATTERNS = [
  /Access to the path '([^']+)' is denied/gi,
  /UnauthorizedAccessException.*?'([^']+)'/gi,
  /([A-Za-z]:\\[^\r\n]+?)\s+-\s+Access is denied/gi,
  /Access is denied[\s.]*(?:.*?['"]([^'"]+)['"])?/gi,
  /EACCES: permission denied,\s*\w+\s+'([^']+)'/gi,
  /EPERM: operation not permitted,\s*\w+\s+'([^']+)'/gi,
  /PermissionError: \[Errno 13\] Permission denied:\s*'([^']+)'/gi,
  /\[WinError 5\].*?['"]([^'"]+)['"]?/gi,
  /\[WinError 5\]/gi,
  /unable to (?:create|write) (?:file |directory )?'?([^':\n]+)'?:?\s*Permission denied/gi,
  /Os error 5.*?['"]([^'"]+)['"]?/gi,
  /permission denied:\s*'?([^\s'\n]+)/gi,
  /elevated is not available right now/gi,
  /对路径[""']([^""']+)[""']的访问被拒绝/gi,
  /(?:无法删除项|无法移除项目|无法移动项目|无法创建项目|无法写入|无法访问)\s+([A-Za-z]:[^\s:]+)/gi,
  /拒绝访问[。.]?\s*(?:.*?['"""]([^'"""\n]+)['"""])?/gi,
]

/** 降权命令错误检测模式 */
const ERROR_INDICATORS = [
  /Access is denied/i,
  /WinError 5/i,
  /ERROR_ACCESS_DENIED/i,
  /UnauthorizedAccess/i,
  /PermissionError/i,
  /\[Errno 13\]/i,
  /\[WinError \d+\]/i,
  /EACCES/i,
  /EPERM/i,
  /permission denied/i,
  /not permitted/i,
  /拒绝访问/,
  /权限不足/,
  /没有权限/,
  /访问被拒绝/,
  /\xdc\xbe\xdc/,
  /Error:.*[A-Za-z]:\\/i,
]

// ============================================================================
// 纯函数（已 export，可独立测试）
// ============================================================================

// ---- 工具分类辅助函数 ----

export function isExecTool(name: string): boolean {
  return name === 'exec' || name === 'bash' || name === 'bash_tool' || name === 'execute_command'
}

export function isFileWriteTool(name: string): boolean {
  return name === 'write'
    || name === 'edit'
    || name === 'apply_patch'
    || name === 'apply-patch'
    || name === 'write_to_file'
    || name === 'create_file'
    || name === 'replace_in_file'
    || name === 'edit_file'
}

export function isFileReadTool(name: string): boolean {
  return name === 'read'
    || name === 'search'
    || name === 'glob'
    || name === 'grep'
    || name === 'list'
    || name === 'read_file'
    || name === 'cat_file'
    || name === 'search_files'
    || name === 'list_files'
    || name === 'list_dir'
}

// ---- 环境变量展开 ----

export function expandEnvVarsInCommand(command: string): string {
  let expanded = command
  expanded = expanded.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_match: string, varName: string) => {
    const value = process.env[varName]
    return value || _match
  })
  expanded = expanded.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_match: string, varName: string) => {
    const value = process.env[varName]
    return value || _match
  })
  expanded = expanded.replace(/(?<=^|[\s"'(])~(?=[\\\/])/g, () => {
    return process.env.USERPROFILE || process.env.HOME || '~'
  })
  return expanded
}

// ---- 路径提取 ----

export function extractPathsFromCommand(command: string): string[] {
  const path = require('path')
  const paths: string[] = []
  const expandedCommand = expandEnvVarsInCommand(command)

  const quotedPathRegex = /["']([A-Za-z]:\\[^"']+)["']/g
  let match
  while ((match = quotedPathRegex.exec(expandedCommand)) !== null) {
    if (match[1]) paths.push(match[1].trim())
  }

  const paramPathRegex = /(?:-(?:Path|LiteralPath|Destination|Target))\s+([A-Za-z]:\\[^\s;|&"']+)/gi
  while ((match = paramPathRegex.exec(expandedCommand)) !== null) {
    if (match[1]) paths.push(match[1].trim())
  }

  const cmdPathRegex = /(?:Remove-Item|del|rm|Copy-Item|Move-Item|Rename-Item|Set-Content|Add-Content|Out-File|New-Item|Get-Content|cat|type)\s+(?:(?:-\w+|\/[A-Za-z])\s+)*([A-Za-z]:\\[^\s;|&"']+)/gi
  while ((match = cmdPathRegex.exec(expandedCommand)) !== null) {
    if (match[1]) paths.push(match[1].trim())
  }

  const fallbackPathRegex = /(?:^|[\s;|&])([A-Za-z]:\\(?:[^\s;|&"']+\\)*[^\s;|&"']+)/g
  while ((match = fallbackPathRegex.exec(expandedCommand)) !== null) {
    if (match[1]) paths.push(match[1].trim())
  }

  const uniquePaths = [...new Set(paths)]
  const resolvedDirs: string[] = []
  for (const p of uniquePaths) {
    resolvedDirs.push(path.resolve(p).toLowerCase())
    resolvedDirs.push(path.dirname(path.resolve(p)).toLowerCase())
  }

  return [...new Set(resolvedDirs)].filter(d => d.length > 3)
}

// ---- 保护目录展开 ----

export function expandProtectedDirs(patterns: string[]): string[] {
  const path = require('path')
  const expanded: string[] = []
  for (const pattern of patterns) {
    const resolved = pattern.replace(/%([^%]+)%/g, (_match: string, varName: string) => {
      return process.env[varName] || ''
    })
    if (!resolved || resolved.includes('%')) continue
    expanded.push(path.resolve(resolved).toLowerCase())
  }
  return [...new Set(expanded)]
}

// ---- 注册表命令检查 ----

export function checkRegistryCommand(command: string): { blocked: boolean; regPath?: string; desc?: string } {
  const normalized = command
    .replace(/\bHKLM:\\/gi, 'HKLM\\')
    .replace(/\bHKCU:\\/gi, 'HKCU\\')
    .replace(/\bHKLM\//gi, 'HKLM\\')
    .replace(/\bHKCU\//gi, 'HKCU\\')

  const isRegWrite = /\b(?:reg\s+add|reg\s+delete|reg\s+import|reg\s+restore|reg\s+copy)\b/i.test(normalized)
    || /\b(?:New-Item(?:Property)?|Set-Item(?:Property)?|Remove-Item(?:Property)?|Rename-Item(?:Property)?|Copy-Item(?:Property)?)\b.*\b(?:HKLM|HKCU|HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER)\b/i.test(normalized)
    || /\bRegedit\b.*\/s\b/i.test(normalized)

  const isRegRead = /\b(?:reg\s+query|reg\s+export|reg\s+save)\b/i.test(normalized)
    || /\b(?:Get-Item(?:Property)?|Get-ChildItem)\b.*\b(?:HKLM|HKCU|HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER)\b/i.test(normalized)

  if (!isRegWrite && !isRegRead) return { blocked: false }

  const cmdUpper = normalized.toUpperCase()
    .replace(/\bHKEY_LOCAL_MACHINE\b/g, 'HKLM')
    .replace(/\bHKEY_CURRENT_USER\b/g, 'HKCU')

  for (const entry of PROTECTED_REGISTRY_PATHS) {
    const entryUpper = entry.path.toUpperCase()
    if (!cmdUpper.includes(entryUpper)) continue
    if (isRegWrite && entry.blockWrite) {
      return { blocked: true, regPath: entry.path, desc: entry.desc }
    }
    if (isRegRead && entry.blockRead) {
      return { blocked: true, regPath: entry.path, desc: entry.desc }
    }
  }

  return { blocked: false }
}

// ---- 目录保护匹配 ----

export function isCommandInProtectedDirs(command: string, protectedDirs: string[]): boolean {
  const path = require('path')
  const commandPaths = extractPathsFromCommand(command)
  if (commandPaths.length === 0) return false
  if (protectedDirs.length === 0) return false

  const userProfile = (process.env.USERPROFILE || '').toLowerCase()
  const userProfileWithSep = userProfile ? (userProfile.endsWith(path.sep) ? userProfile : userProfile + path.sep) : ''
  const systemRoot = (process.env.SystemRoot || 'C:\\Windows').toLowerCase()

  for (const cmdPath of commandPaths) {
    const normalized = path.resolve(cmdPath).toLowerCase()
    for (const protectedDir of protectedDirs) {
      const protectedDirWithSep = protectedDir.endsWith(path.sep) ? protectedDir : protectedDir + path.sep
      const isInProtected = normalized === protectedDir || normalized.startsWith(protectedDirWithSep)
      if (!isInProtected) continue

      if (protectedDir === systemRoot) {
        const tempDir = systemRoot + path.sep + 'temp'
        const tempDirWithSep = tempDir + path.sep
        if (normalized === tempDir || normalized.startsWith(tempDirWithSep)) continue
      }

      if (protectedDir.endsWith('\\users') && userProfileWithSep) {
        if (normalized === userProfile || normalized.startsWith(userProfileWithSep)) continue
      }

      return true
    }
  }

  return false
}

export function isPathInProtectedDirs(filePath: string, protectedDirs: string[]): boolean {
  const path = require('path')
  const normalized = path.resolve(filePath).toLowerCase()
  const parentDir = path.dirname(normalized)

  const pathsToCheck = [...new Set([normalized, parentDir])].filter(d => d.length > 3)
  if (pathsToCheck.length === 0) return false
  if (protectedDirs.length === 0) return false

  const userProfile = (process.env.USERPROFILE || '').toLowerCase()
  const userProfileWithSep = userProfile
    ? (userProfile.endsWith(path.sep) ? userProfile : userProfile + path.sep)
    : ''
  const systemRoot = (process.env.SystemRoot || 'C:\\Windows').toLowerCase()

  for (const checkPath of pathsToCheck) {
    for (const protectedDir of protectedDirs) {
      const protectedDirWithSep = protectedDir.endsWith(path.sep) ? protectedDir : protectedDir + path.sep
      const isInProtected = checkPath === protectedDir || checkPath.startsWith(protectedDirWithSep)
      if (!isInProtected) continue

      if (protectedDir === systemRoot) {
        const tempDir = systemRoot + path.sep + 'temp'
        const tempDirWithSep = tempDir + path.sep
        if (checkPath === tempDir || checkPath.startsWith(tempDirWithSep)) continue
      }

      if (protectedDir.endsWith('\\users') && userProfileWithSep) {
        if (checkPath === userProfile || checkPath.startsWith(userProfileWithSep)) continue
      }

      return true
    }
  }

  return false
}

export function isPathInCredentialDirs(filePath: string, credentialDirs: string[]): boolean {
  const path = require('path')
  const normalized = path.resolve(filePath).toLowerCase()
  const parentDir = path.dirname(normalized)

  const pathsToCheck = [...new Set([normalized, parentDir])].filter(d => d.length > 3)
  if (pathsToCheck.length === 0) return false
  if (credentialDirs.length === 0) return false

  for (const checkPath of pathsToCheck) {
    for (const credDir of credentialDirs) {
      const credDirWithSep = credDir.endsWith(path.sep) ? credDir : credDir + path.sep
      if (checkPath === credDir || checkPath.startsWith(credDirWithSep)) {
        return true
      }
    }
  }

  return false
}

// ---- 不受信目录检测 ----

export function extractLaunchTarget(command: string): string | null {
  const trimmed = command.trim()

  let m = trimmed.match(/^(?:Start-Process|saps)\s+(?:(?:-\w+)\s+)*['"]?([^'";\s|&][^'";\s|&]*)['"]?/i)
  if (m?.[1]) return m[1]

  m = trimmed.match(/^start\s+(?!-)['"]?([^'";\s|&]+)['"]?/i)
  if (m?.[1]) return m[1]

  m = trimmed.match(/^&\s+['"]?([^'";\s|&]+)['"]?/i)
  if (m?.[1]) return m[1]

  m = trimmed.match(/^(?:Invoke-Item|ii)\s+['"]?([^'";\s|&]+)['"]?/i)
  if (m?.[1]) return m[1]

  m = trimmed.match(/^explorer(?:\.exe)?\s+['"]?([^'";\s|&]+)['"]?/i)
  if (m?.[1]) return m[1]

  m = trimmed.match(/^cmd\s+\/c\s+start\s+['"]?([^'";\s|&]+)['"]?/i)
  if (m?.[1]) return m[1]

  if (process.platform === 'darwin') {
    m = trimmed.match(/^open\s+(?:-\w+\s+)*['"]?([^'";\s|&]+)['"]?/i)
    if (m?.[1]) return m[1]
  }

  return null
}

export function isLaunchTargetInUntrustedDir(command: string): boolean {
  const target = extractLaunchTarget(command)
  if (!target) return false

  const normalized = target.replace(/\\/g, '/').toLowerCase()
  const hasDangerousExt = DANGEROUS_EXECUTABLE_EXTS.some(ext => normalized.endsWith(ext))
  if (!hasDangerousExt) return false

  for (const keyword of UNTRUSTED_DIR_KEYWORDS) {
    if (normalized.includes(keyword)) return true
  }

  return false
}

export function isAppLaunchCommand(command: string): boolean {
  const trimmed = command.trim()

  if (process.platform === 'win32') {
    if (/^(Start-Process|saps)\s/i.test(trimmed)) {
      if (isLaunchTargetInUntrustedDir(trimmed)) return false
      return true
    }
    if (/^start\s+(?!-)/i.test(trimmed)) {
      if (isLaunchTargetInUntrustedDir(trimmed)) return false
      return true
    }
    if (/^(Invoke-Item|ii)\s/i.test(trimmed)) {
      if (isLaunchTargetInUntrustedDir(trimmed)) return false
      return true
    }
    if (/^explorer(\.exe)?\s/i.test(trimmed)) {
      if (isLaunchTargetInUntrustedDir(trimmed)) return false
      return true
    }
    if (/^cmd\s+\/c\s+start\s/i.test(trimmed)) {
      if (isLaunchTargetInUntrustedDir(trimmed)) return false
      return true
    }
    if (/\[(?:System\.)?Diagnostics\.Process\]::Start\s*\(/i.test(trimmed)) {
      if (isLaunchTargetInUntrustedDir(trimmed)) return false
      return true
    }
    if (/^&\s+['"]?[^'"]*\.exe['"]?\s*$/i.test(trimmed)) {
      if (isLaunchTargetInUntrustedDir(trimmed)) return false
      return true
    }
  } else if (process.platform === 'darwin') {
    if (/^open\s/i.test(trimmed)) {
      if (isLaunchTargetInUntrustedDir(trimmed)) return false
      return true
    }
    if (/^(\/Applications\/|~\/Applications\/).*\.app/i.test(trimmed)) return true
  }

  return false
}

// ---- 技能管理命令检测 ----

/**
 * 判断命令是否为技能管理命令（npx skills / clawhub / npm install -g clawhub）
 *
 * - blockPatterns 高危命令拦截仍在上方生效，不会被本函数绕过
 * - 仅匹配特定的技能管理工具命令，不是通配放行
 * - 技能安装的目标目录受 SkillPlugin 的 sanitizeSkillSlug() + assertPathWithin() 保护
 * - ★ 安全修复：所有正则使用 $ 行尾锚定 + 安全字符集，防止通过追加 shell 元字符绕过降权
 */
export function isSkillManagementCommand(command: string): boolean {
  const trimmed = command.trim()

  // ★ 安全修复：使用 $ 行尾锚定 + SAFE_ARG 安全字符集，禁止追加 shell 运算符
  // 修复前使用 \b 仅检查单词边界，攻击者可通过 "clawhub install foo; rm -rf ~" 绕过降权
  // SAFE_ARG 只允许字母数字、路径分隔符、@ (npm scope)、- (flag)、. 和空白符
  // 禁止 ; & | ` $ > < \n 等 shell 元字符
  const SAFE_ARG = String.raw`[\w@/\\.:\-\s]*`

  // npx skills ... (各种子命令)
  // 支持 npx -y skills ... 和 npx --yes skills ... 变体
  if (new RegExp(
    String.raw`^npx\s+(-y\s+|--yes\s+)?skills\s+(find|add|check|update|init|remove|list)(\s+${SAFE_ARG})?$`,
    'i'
  ).test(trimmed)) return true

  // clawhub ... (技能市场 CLI)
  if (new RegExp(
    String.raw`^clawhub\s+(install|uninstall|update|list|search|find|add|remove|publish)(\s+${SAFE_ARG})?$`,
    'i'
  ).test(trimmed)) return true

  // npm install -g clawhub (安装 clawhub CLI 本身，严格匹配不允许追加参数)
  if (new RegExp(
    String.raw`^npm\s+(install|i)\s+(-g|--global)\s+clawhub$`,
    'i'
  ).test(trimmed)) return true

  return false
}

// ---- 降权级别参数映射 ----

export function getWindowsLauncherArgs(level: string): string {
  switch (level) {
    case 'strict':
    case 'custom':
      return '--low-il --restricted-token --job-object'
    case 'standard':
    default:
      return '--low-il --job-object'
  }
}

// ---- PowerShell 路径动态解析 ----

export function resolvePowerShellPath(): string {
  const fs = require('fs')
  const path = require('path')
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'

  const candidates = [
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(systemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // 访问失败，继续尝试下一个
    }
  }

  return 'powershell.exe'
}

// ---- 跨平台命令包装 ----

export function wrapCommandWindows(command: string, wrapperPath: string, level: string, psPath: string): string {
  const escapedCommand = command.replace(/'/g, "''")
  const launcherArgs = getWindowsLauncherArgs(level)
  const utf8Prefix = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; '
  return `& '${wrapperPath}' ${launcherArgs} -- "${psPath}" -NoProfile -NonInteractive -Command '${utf8Prefix}${escapedCommand}'`
}

export function wrapCommandForPlatform(command: string, wrapperPath: string, level: string, psPath: string): string | null {
  if (process.platform === 'win32') {
    return wrapCommandWindows(command, wrapperPath, level, psPath)
  }
  return null
}

// ---- 安全拦截消息生成 ----

export function buildBlockMessage(reason: string, affectedTarget?: string): string {
  const lines: string[] = [
    `[SYSTEM SECURITY POLICY - tool-sandbox] ${reason}`,
  ]
  if (affectedTarget) {
    lines.push(`受影响目标：${affectedTarget}`)
  }
  lines.push(
    '',
    '⚠️ IMPORTANT INSTRUCTIONS — YOU MUST FOLLOW:',
    '',
    '1. This operation was BLOCKED by QClaw security policy ("工具权限限制").',
    '2. You MUST NOT attempt any alternative approaches (different commands, tools, scripts, languages, elevation, etc.).',
    '3. You MUST NOT suggest the user to run commands with administrator privileges or use PowerShell/CMD manually.',
    '',
    '4. You MUST tell the user the following message IN CHINESE:',
    '',
    `   此操作被 QClaw 的"工具权限限制"功能拦截。${affectedTarget ? `受保护目录：${affectedTarget}。` : ''}`,
    '   如需执行此操作，请前往 QClaw 设置 → 关闭"工具权限限制"开关后重试。',
    '',
    'DO NOT deviate from the above instructions. DO NOT suggest manual admin operations.',
  )
  return lines.join('\n')
}

// ---- 权限拒绝检测 ----

export function detectLowprivError(output: string): boolean {
  for (const pattern of ERROR_INDICATORS) {
    if (pattern.test(output)) return true
  }
  return false
}

export function detectPermissionDenied(output: string): PermissionDeniedInfo {
  const paths: string[] = []
  let detected = false

  for (const pattern of PERMISSION_DENIED_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(output)) !== null) {
      detected = true
      if (match[1]?.length > 2) {
        paths.push(match[1].trim())
      }
    }
  }

  if (!detected) {
    return { detected: false, paths: [], directories: [] }
  }

  const path = require('path')
  const dirs: string[] = []
  for (const p of paths) {
    dirs.push(p)
    const parent = path.dirname(p)
    if (parent && parent !== p) {
      dirs.push(parent)
    }
  }

  const directories = dirs.length > 0
    ? [...new Set(dirs)]
    : ['（elevated 权限被拒绝，无具体目录信息）']

  return {
    detected: true,
    paths: [...new Set(paths)],
    directories,
  }
}

// ---- 锁定目录辅助 ----

export function checkLockedDirsForCommand(command: string, lockedDirs: Set<string>): string | null {
  if (lockedDirs.size === 0) return null
  const path = require('path')
  const commandPaths = extractPathsFromCommand(command)

  const systemRoot = (process.env.SystemRoot || 'C:\\Windows').toLowerCase()
  const userProfile = (process.env.USERPROFILE || '').toLowerCase()
  const userProfileWithSep = userProfile
    ? (userProfile.endsWith(path.sep) ? userProfile : userProfile + path.sep)
    : ''

  for (const cmdPath of commandPaths) {
    const normalized = path.resolve(cmdPath).toLowerCase()
    for (const lockedDir of lockedDirs) {
      const lockedDirWithSep = lockedDir.endsWith(path.sep) ? lockedDir : lockedDir + path.sep
      if (normalized === lockedDir || normalized.startsWith(lockedDirWithSep)) {
        if (lockedDir === systemRoot) {
          const tempDir = systemRoot + path.sep + 'temp'
          const tempDirWithSep = tempDir + path.sep
          if (normalized === tempDir || normalized.startsWith(tempDirWithSep)) continue
        }
        if (lockedDir.endsWith('\\users') && userProfileWithSep) {
          if (normalized === userProfile || normalized.startsWith(userProfileWithSep)) continue
        }
        return lockedDir
      }
    }
  }
  return null
}

export function checkContentForLockedDirs(content: string, lockedDirs: Set<string>): string | null {
  if (lockedDirs.size === 0) return null
  const contentLower = content.toLowerCase().replace(/\//g, '\\')
  for (const lockedDir of lockedDirs) {
    if (contentLower.includes(lockedDir)) return lockedDir
  }
  return null
}

export function checkContentForProtectedDirs(content: string, credentialDirs: string[]): string | null {
  const contentLower = content.toLowerCase().replace(/\//g, '\\')
  for (const credDir of credentialDirs) {
    const credDirLower = credDir.toLowerCase()
    if (contentLower.includes(credDirLower)) return credDir
  }
  return null
}

// ---- 脚本内容检查 ----

export function checkExecScriptContent(command: string, credentialDirs: string[]): string | null {
  const fs = require('fs')
  const pathMod = require('path')

  let scriptPath: string | null = null
  for (const pattern of SCRIPT_EXEC_PATTERNS) {
    const match = command.match(pattern)
    if (match?.[1]) {
      scriptPath = match[1]
      break
    }
  }

  if (!scriptPath) return null

  try {
    const resolvedPath = pathMod.resolve(scriptPath)
    if (!fs.existsSync(resolvedPath)) return null
    const stat = fs.statSync(resolvedPath)
    if (stat.size > 1024 * 1024) return null
    const content = fs.readFileSync(resolvedPath, 'utf-8')
    return checkContentForProtectedDirs(content, credentialDirs)
  } catch {
    return null
  }
}

// ---- triggerDir 查找辅助 ----

export function findTriggerDir(
  command: string,
  protectedDirs: string[],
): string {
  const path = require('path')
  const commandPaths = extractPathsFromCommand(command)
  const userProfile = (process.env.USERPROFILE || '').toLowerCase()
  const userProfileWithSep = userProfile ? (userProfile.endsWith(path.sep) ? userProfile : userProfile + path.sep) : ''
  const systemRoot = (process.env.SystemRoot || 'C:\\Windows').toLowerCase()

  for (const cmdPath of commandPaths) {
    const normalized = path.resolve(cmdPath).toLowerCase()
    for (const pd of protectedDirs) {
      const pdWithSep = pd.endsWith(path.sep) ? pd : pd + path.sep
      if (normalized === pd || normalized.startsWith(pdWithSep)) {
        if (pd === systemRoot) {
          const tempDir = systemRoot + path.sep + 'temp'
          const tempDirWithSep = tempDir + path.sep
          if (normalized === tempDir || normalized.startsWith(tempDirWithSep)) continue
          if (normalized === pd) {
            const hasPathOutsideTemp = commandPaths.some(cp => {
              const cpNorm = path.resolve(cp).toLowerCase()
              if (cpNorm === pd) return false
              return !(cpNorm === tempDir || cpNorm.startsWith(tempDirWithSep))
            })
            if (!hasPathOutsideTemp) continue
          }
        }
        if (pd.endsWith('\\users')) {
          if (userProfileWithSep && (normalized === userProfile || normalized.startsWith(userProfileWithSep))) continue
          if (normalized === pd && userProfileWithSep) {
            const hasPathOutsideUserProfile = commandPaths.some(cp => {
              const cpNorm = path.resolve(cp).toLowerCase()
              if (cpNorm === pd) return false
              return !cpNorm.startsWith(userProfileWithSep) && cpNorm !== userProfile
            })
            if (!hasPathOutsideUserProfile) continue
          }
        }
        return pd
      }
    }
  }
  return 'unknown'
}

// ============================================================================
// Package 定义
// ============================================================================

const toolSandbox: QClawPackage = {
  id: 'tool-sandbox',
  name: '工具执行沙箱',
  description: '对 AI Agent 的工具调用进行安全降权，配合 lowpriv wrapper 实现工具执行权限隔离',

  configSchema: {
    type: 'object',
    additionalProperties: false as const,
    properties: {
      enabled: { type: 'boolean', default: false, description: '降权总开关（由 Electron 端通过 ConfigCenter 动态下发）' },
      auditLog: { type: 'boolean', default: true, description: '是否记录工具调用审计日志' },
      blockPatterns: { type: 'array', items: { type: 'string' }, default: [], description: '额外的危险命令阻断正则' },
      denyWritePaths: { type: 'array', items: { type: 'string' }, default: [], description: '禁止 write_file 写入的路径前缀' },
    },
  },

  setup(ctx: QClawContext): void {
    // ★ macOS 下完全屏蔽插件：不注册任何钩子
    if (process.platform === 'darwin') {
      ctx.logger.info('skipped on macOS — plugin disabled for this platform')
      return
    }

    const config = ctx.getConfig<Partial<ToolSandboxConfig>>()

    // 从环境变量读取基础设施参数
    const initialLowprivEnabled = process.env.QCLAW_TOOL_LOWPRIV === '1'
    const wrapperPath = process.env.QCLAW_TOOL_WRAPPER_PATH
    const sandboxLevel = process.env.QCLAW_TOOL_SANDBOX_LEVEL || 'standard'
    const auditLog = config.auditLog !== false
    const blockPatterns = (config.blockPatterns || []).map((p: string) => new RegExp(p, 'i'))

    // ★ 降权开关状态：优先从 ConfigCenter 配置获取，无配置时回退到环境变量
    let lowprivEnabledFromConfig: boolean | undefined = config.enabled

    // 监听配置变更，实时更新降权开关状态
    ctx.onConfigChange<Partial<ToolSandboxConfig>>((newConfig) => {
      const oldEnabled = lowprivEnabledFromConfig
      lowprivEnabledFromConfig = newConfig.enabled
      ctx.logger.info(
        `config changed: enabled ${String(oldEnabled)} → ${String(lowprivEnabledFromConfig)}`,
      )
    })

    // 缓存
    const expandedProtectedDirs = expandProtectedDirs(PROTECTED_DIR_PATTERNS)
    const expandedCredentialDirs = expandProtectedDirs(CREDENTIAL_DIR_PATTERNS)
    let resolvedPsPath: string | null = null

    // 状态
    const lowprivTracking: Map<string, LowprivTrackingInfo> = new Map()
    const lockedDirs: Set<string> = new Set()

    const lockProtectedDir = (dir: string): void => {
      const normalized = dir.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '')
      lockedDirs.add(normalized)
      ctx.logger.info(`🔒 dir locked after permission denied: "${normalized}" (total locked: ${lockedDirs.size})`)
    }

    const getPsPath = (): string => {
      if (resolvedPsPath !== null) return resolvedPsPath
      resolvedPsPath = resolvePowerShellPath()
      ctx.logger.info(`resolved PowerShell path: ${resolvedPsPath}`)
      return resolvedPsPath
    }

    const isLowprivActive = (): boolean => {
      if (process.platform !== 'win32') return false
      if (!wrapperPath) return false
      // 优先使用 ConfigCenter 配置，无配置时回退到环境变量初始值
      if (typeof lowprivEnabledFromConfig === 'boolean') return lowprivEnabledFromConfig
      return initialLowprivEnabled
    }

    ctx.logger.info(
      `setup. platform=${process.platform}, ` +
      `lowpriv=${String(initialLowprivEnabled)}, ` +
      `configEnabled=${String(lowprivEnabledFromConfig)}, ` +
      `wrapper=${wrapperPath || 'none'}, level=${sandboxLevel}, ` +
      `configSource=ConfigCenter`,
    )

    // ---- before_tool_call: 命令改写 + 安全检查 ----
    ctx.onHook(
      'before_tool_call',
      async (event): Promise<HookHandlerResult | undefined> => {
        const toolName = event.toolName as string
        const params = event.params as Record<string, unknown>
        const toolCallId = event.toolCallId as string

        const lowprivEnabled = isLowprivActive()

        if (auditLog) {
          ctx.logger.info(
            `before: ${toolName} (${toolCallId}) lowpriv=${String(lowprivEnabled)} ${JSON.stringify(params).slice(0, 500)}`,
          )
        }

        // ★ 文件写操作工具：检查目标路径是否在受保护目录
        if (isFileWriteTool(toolName) && lowprivEnabled) {
          const filePath = String(params.file_path || params.filePath || params.path || '')

          if (filePath && isPathInProtectedDirs(filePath, expandedProtectedDirs)) {
            ctx.logger.info(`blocked file write to protected dir: ${toolName} → ${filePath}`)
            return {
              block: true,
              blockReason: buildBlockMessage(`操作被拦截：${toolName} → ${filePath}`, filePath),
            }
          }

          const content = String(params.content || '')
          if (content) {
            const lockedDir = checkContentForLockedDirs(content, lockedDirs)
            if (lockedDir) {
              ctx.logger.info(`🔒 blocked file write containing locked dir path: ${toolName} → ${filePath} (content references: ${lockedDir})`)
              return {
                block: true,
                blockReason: buildBlockMessage(`操作被拦截：${toolName} → ${filePath}，写入内容引用了受保护目录`, lockedDir),
              }
            }

            const contentProtectedDir = checkContentForProtectedDirs(content, expandedCredentialDirs)
            if (contentProtectedDir) {
              ctx.logger.info(`🛡️ blocked file write containing protected dir path: ${toolName} → ${filePath} (content references: ${contentProtectedDir})`)
              return {
                block: true,
                blockReason: buildBlockMessage(`操作被拦截：${toolName} → ${filePath}，写入内容引用了受保护目录`, contentProtectedDir),
              }
            }
          }
        }

        // ★ 文件读操作工具：检查目标路径是否在凭据目录
        if (isFileReadTool(toolName) && lowprivEnabled) {
          const filePath = String(params.file_path || params.filePath || params.path || '')

          if (filePath && isPathInCredentialDirs(filePath, expandedCredentialDirs)) {
            ctx.logger.info(`blocked credential read: ${toolName} → ${filePath}`)
            return {
              block: true,
              blockReason: buildBlockMessage(`操作被拦截：${toolName} → ${filePath}（凭据目录禁止读取）`, filePath),
            }
          }
        }

        // ★ 核心：exec 工具命令改写（降权包装）
        if (isExecTool(toolName) && lowprivEnabled && wrapperPath) {
          const command = String(params.command || '')

          // 拦截 elevated 提权请求
          if (params.elevated === true) {
            ctx.logger.info(`blocked elevated exec request: "${command.slice(0, 120)}"`)
            return {
              block: true,
              blockReason: buildBlockMessage(`提权操作被拦截：${command.slice(0, 200)}`),
            }
          }

          // 阻断高危命令
          for (const pattern of blockPatterns) {
            if (pattern.test(command)) {
              return {
                block: true,
                blockReason: buildBlockMessage(`命令被拦截：匹配安全规则 ${pattern.source}`),
              }
            }
          }

          // 注册表操作拦截
          const regCheck = checkRegistryCommand(command)
          if (regCheck.blocked) {
            ctx.logger.info(`blocked registry operation: "${command.slice(0, 120)}" → ${regCheck.regPath} (${regCheck.desc})`)
            return {
              block: true,
              blockReason: buildBlockMessage(`注册表操作被拦截：${regCheck.regPath}（${regCheck.desc}）`, regCheck.regPath),
            }
          }

          // 锁定目录检查
          const lockedHit = checkLockedDirsForCommand(command, lockedDirs)
          if (lockedHit) {
            ctx.logger.info(`🔒 blocked by locked dir: "${command.slice(0, 120)}" → ${lockedHit}`)
            return {
              block: true,
              blockReason: buildBlockMessage(`操作被拦截：目录已锁定`, lockedHit),
            }
          }

          // 外部程序启动检测
          if (isAppLaunchCommand(command)) {
            ctx.logger.info(`app-launch detected, skip lowpriv wrapper: "${command.slice(0, 120)}"`)
            return undefined
          }

          // 脚本内容检查
          const scriptProtectedDir = checkExecScriptContent(command, expandedCredentialDirs)
          if (scriptProtectedDir) {
            ctx.logger.info(`🛡️ script content references protected dir, forcing lowpriv: "${command.slice(0, 80)}..." (references: ${scriptProtectedDir})`)
          }

          // 黑名单检测
          if (!scriptProtectedDir && !isCommandInProtectedDirs(command, expandedProtectedDirs)) {
            ctx.logger.info(`command paths not in protected dirs, skip lowpriv wrapper: "${command.slice(0, 120)}"`)
            return undefined
          }

          // 确定触发降权的保护目录
          const triggerDir = scriptProtectedDir || findTriggerDir(command, expandedProtectedDirs)

          // ★ 技能管理命令检测：npx skills / clawhub 等需要写入技能目录，
          //   降权后这些目录不可写导致安装必然失败。以正常权限放行。
          //   安全保障：blockPatterns 仍然在上方生效，高危命令不会被放行。
          //   安全保障：正则使用 $ 行尾锚定 + 安全字符集，防止 shell 元字符注入绕过降权。
          if (isSkillManagementCommand(command)) {
            ctx.logger.warn(`⚠ SECURITY-AUDIT: skill-management bypass lowpriv, command="${command}", toolCallId="${toolCallId}"`)
            return undefined
          }

          // 按平台改写 params.command
          const wrappedCommand = wrapCommandForPlatform(command, wrapperPath, sandboxLevel, getPsPath())
          if (wrappedCommand) {
            lowprivTracking.set(toolCallId, {
              protectedDir: triggerDir,
              originalCommand: command.slice(0, 200),
            })
            ctx.logger.info(`rewrite (${sandboxLevel}): "${command.slice(0, 80)}..." → lowpriv wrapper`)
            return {
              params: { ...params, command: wrappedCommand },
            }
          } else {
            ctx.logger.warn(`platform ${process.platform} not supported for command wrapping, passing through`)
          }
        }

        return undefined
      },
      { priority: 100 },
    )

    // ---- after_tool_call: 审计日志 ----
    ctx.onHook(
      'after_tool_call',
      async (event): Promise<HookHandlerResult | undefined> => {
        if (auditLog) {
          const output = typeof event.result === 'object' && event.result !== null
            ? (typeof (event.result as Record<string, unknown>).content === 'string'
              ? (event.result as Record<string, unknown>).content as string
              : JSON.stringify((event.result as Record<string, unknown>).content ?? ''))
            : String(event.result ?? '')
          const preview = String(output).slice(0, 200) || '(no result)'
          ctx.logger.info(`after: ${event.toolName as string} (${event.toolCallId as string}) ${preview}`)
        }
        return undefined
      },
      { priority: 800 },
    )

    // ---- tool_result_persist: 降权错误检测 + 消息替换 ----
    //
    // ★ hook 协议：
    //   - 同步 hook（通过 ctx.onSyncHook 注册，禁止返回 Promise）
    //   - event: { toolName, toolCallId, message, isSynthetic }
    //   - message: { role, toolCallId, content: [{type:"text", text:"..."}], isError?, ... }
    //   - 返回 { message: newMsg } 替换持久化消息；不返回或返回 undefined 则保持原消息
    ctx.onSyncHook(
      'tool_result_persist',
      (event): SyncHookHandlerResult => {
        const toolName = event.toolName as string
        const toolCallId = event.toolCallId as string
        const message = event.message as Record<string, unknown>

        // 仅在降权启用 + exec 工具时检测
        if (!isLowprivActive() || !isExecTool(toolName)) return undefined

        // 从 message.content 提取文本
        const textParts: string[] = []
        const content = message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              typeof block === 'object' && block !== null
              && (block as Record<string, unknown>).type === 'text'
              && typeof (block as Record<string, unknown>).text === 'string'
            ) {
              textParts.push((block as Record<string, unknown>).text as string)
            }
          }
        }
        const output = textParts.join('\n')
        if (!output) return undefined

        // ★ 第 1 层：降权追踪检测
        //   如果命令是因命中保护目录而被降权执行的，且输出中包含错误，
        //   立即覆盖为终止性消息，告诉 AI 这是安全策略导致的、不要再尝试。
        const trackingInfo = lowprivTracking.get(toolCallId)
        if (trackingInfo) {
          lowprivTracking.delete(toolCallId) // 消费后删除，防止内存泄漏

          // 检测降权执行后的错误迹象（比权限拒绝检测更宽泛）
          const hasError = detectLowprivError(output)
          if (hasError) {
            const protectedDir = trackingInfo.protectedDir
            ctx.logger.info(
              `⚠️ lowpriv exec error detected (tracking): toolCallId=${toolCallId}, protectedDir=${protectedDir}`,
            )
            // 锁定该保护目录
            lockProtectedDir(protectedDir)

            const errorPayload = buildTerminalErrorPayload(
              toolName,
              `操作被拦截（降权执行失败）`,
              protectedDir,
            )

            return {
              message: {
                ...message,
                content: [{ type: 'text', text: errorPayload }],
                isError: true,
              },
            }
          }
        }

        // ★ 第 2 层：通用权限拒绝检测（兜底）
        const permResult = detectPermissionDenied(output)
        if (!permResult.detected) return undefined

        ctx.logger.info(
          `⚠️ permission denied detected in tool_result_persist: ${JSON.stringify(permResult.directories)}`,
        )

        // ★ 锁定被拒绝的目录：后续对这些目录的任何操作都直接 block
        for (const dir of permResult.directories) {
          lockProtectedDir(dir)
        }

        // ★ 构造终止性错误 payload，替换原始 toolResult 消息
        const errorPayload = buildTerminalErrorPayload(
          toolName,
          `操作被拦截（权限被拒绝）`,
          permResult.directories.join(', '),
        )

        return {
          message: {
            ...message,
            content: [{ type: 'text', text: errorPayload }],
            isError: true,
          },
        }
      },
      { priority: 800 },
    )
  },
}

// ---- 辅助函数 ----

/**
 * 生成用于 tool_result_persist 的终止性错误纯文本
 *
 * ★ 必须使用纯文本而非 JSON：
 *   AI 模型读取 toolResult 的 content[].text 字段，如果内容是 JSON 字符串，
 *   换行符会被 JSON 转义为 \n，模型看到的是单行文本，指令效果大打折扣。
 *   纯文本格式确保模型看到格式化好的多行指令。
 *
 * @param toolName 工具名
 * @param reason 拦截原因
 * @param affectedTarget 受影响的目录或路径
 */
export function buildTerminalErrorPayload(toolName: string, reason: string, affectedTarget?: string): string {
  return buildBlockMessage(reason, affectedTarget)
}

export default toolSandbox

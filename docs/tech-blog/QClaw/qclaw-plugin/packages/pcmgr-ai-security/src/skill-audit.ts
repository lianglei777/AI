/**
 * Skill 审核模块
 *
 * 维护 skillDirMap (SkillDir → SkillName)，
 * 在 before_tool_call 中判断是否属于 Skill 操作并调用 /v2/moderate/skill。
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { LOG_TAG } from "./constants.js";
import {
  LLMShieldClient,
  ContentType,
  DecisionType,
  SkillAuditRequest,
  SkillAuditResponse,
  SkillPackageAuditResponse,
} from "./client.js";
import { getDeviceFingerprintValue } from "./security.js";
import { globalCircuitBreaker } from "./circuit-breaker.js";
import { generateRequestId, recordLogEvent } from "./utils.js";
import { getLabelName } from "./labels.js";
import { fileLog, isDebugMode } from "./logger.js";
import { packDirectoryToZip, MAX_PACKAGE_SIZE } from "./zip-pack.js";

import type { QClawLogger } from '../../../core/types.js'

export interface SkillAuditResult {
  handled: boolean;
  block?: boolean;
  /** 需要用户确认（DecisionType.MARK） */
  mark?: boolean;
  blockReason?: string;
  reasonText?: string;
  skillName?: string;
}

const skillDirMap = new Map<string, string>();
const skillAuditCache = new Map<string, SkillAuditResult>();
const skillPackageCache = new Map<string, { block: boolean; mark?: boolean; blockReason?: string; reasonText?: string }>();

export interface SkillPackageAuditOutcome {
  success: boolean;
  block?: boolean;
  /** 需要用户确认（DecisionType.MARK） */
  mark?: boolean;
  blockReason?: string;
  reasonText?: string;
}

const pendingPackageAudits = new Map<string, Promise<SkillPackageAuditOutcome>>();

function makeSkillCacheKey(skillName: string, fileType: string): string {
  return `${skillName}:${fileType}`;
}

const READ_TOOLS = new Set(["read", "read_file"]);
const USE_SKILL_TOOL = "use_skill";

/**
 * 命令执行类工具名集合。
 * 当 LLM 通过这些工具调用 shell 命令读取 skill 文件时，需要被拦截审计。
 */
const EXEC_TOOLS = new Set([
  "exec", "execute_command", "run_command", "run_script",
  "shell", "terminal", "bash", "powershell",
]);

/**
 * 跨平台的文件读取命令模式。
 * 匹配 `<read-command> [flags] <path>` 并捕获 path（可带引号）。
 *
 * 支持的命令:
 *   Windows  — type, Get-Content (gc), more
 *   Unix     — cat, head, tail, less, more, bat, batcat
 *
 * (?:...) 非捕获组包含所有命令关键字（大小写不敏感）。
 * (?:\s+[\-\/]\S+)* 跳过命令行 flags（如 -n 10、/c 等）。
 * 最后捕获带引号或不带引号的路径。
 *
 * 前缀还支持双引号 "，覆盖 powershell -Command "Get-Content ..." 嵌套场景。
 */
const FILE_READ_CMD_RE = new RegExp(
  '(?:^|[;&|"]\\s*)' +                             // 行首、管道/分隔符、或双引号之后
  "(?:type|cat|head|tail|less|more|bat|batcat|Get-Content|gc)" +  // 命令
  "(?:\\s+[\\-/]\\S+)*" +                           // 可选 flags
  "\\s+" +                                          // 至少一个空白
  "(?:" +
    '"([^"]+)"' +                                   // 捕获组1: 双引号路径
    "|" +
    "'([^']+)'" +                                   // 捕获组2: 单引号路径
    "|" +
    "(\\S+)" +                                      // 捕获组3: 无引号路径
  ")",
  "i",
);

/**
 * /skills/ 路径段判定（跨平台，兼容正斜杠和反斜杠）。
 */
const SKILLS_PATH_SEG_RE = /[/\\]skills[/\\]/i;

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function resolvePath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    p = path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

function parseSkillNameFromFrontmatter(content: string): string | undefined {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return undefined;
  const endIdx = trimmed.indexOf("---", 3);
  if (endIdx < 0) return undefined;
  const frontmatter = trimmed.slice(3, endIdx);
  const match = frontmatter.match(/^\s*name\s*:\s*(.+)/m);
  if (!match) return undefined;
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function isSkillMd(filePath: string): boolean {
  const name = path.basename(filePath);
  return name === "SKILL.md";
}

function resolveFileType(relPath: string): "definition" | "reference" | "script" | "asset" {
  const normalized = relPath.replace(/\\/g, "/");
  if (normalized === "SKILL.md") return "definition";
  if (normalized.startsWith("scripts/") || normalized.startsWith("bin/")) return "script";
  if (normalized.startsWith("references/")) return "reference";
  if (normalized.startsWith("assets/")) return "asset";
  return "reference";
}

function tryReadSkillContent(command: string): { content: string; filePath: string; skillDir: string } | undefined {
  fileLog(`[skill_audit] tryReadSkillContent: command="${command}"`);
  const basename = path.basename(command).toLowerCase();
  if (basename === "skill.md") {
    const resolved = resolvePath(command);
    const exists = fs.existsSync(resolved);
    fileLog(`[skill_audit] tryReadSkillContent: case1 (basename=skill.md), resolved="${resolved}", exists=${exists}`);
    if (exists) {
      try {
        const content = fs.readFileSync(resolved, "utf-8");
        const skillDir = path.dirname(resolved);
        fileLog(`[skill_audit] tryReadSkillContent: case1 read ok, contentLen=${content.length}, skillDir="${skillDir}"`);
        return { content, filePath: resolved, skillDir };
      } catch (err: any) {
        fileLog(`[skill_audit] tryReadSkillContent: case1 readFileSync ERROR: ${err.message}`);
      }
    }
  }

  const asDir = resolvePath(command);
  fileLog(`[skill_audit] tryReadSkillContent: case2 checking dir="${asDir}"`);
  for (const name of ["skill.md", "SKILL.md"]) {
    const candidate = path.join(asDir, name);
    const exists = fs.existsSync(candidate);
    fileLog(`[skill_audit] tryReadSkillContent: case2 candidate="${candidate}", exists=${exists}`);
    if (exists) {
      try {
        const content = fs.readFileSync(candidate, "utf-8");
        fileLog(`[skill_audit] tryReadSkillContent: case2 read ok, contentLen=${content.length}`);
        return { content, filePath: candidate, skillDir: asDir };
      } catch (err: any) {
        fileLog(`[skill_audit] tryReadSkillContent: case2 readFileSync ERROR: ${err.message}`);
      }
    }
  }

  fileLog(`[skill_audit] tryReadSkillContent: no SKILL.md found for command="${command}"`);
  return undefined;
}

function findSkillDir(filePath: string): { skillDir: string; skillName: string; relPath: string } | undefined {
  const normalized = normalizePath(filePath);
  for (const [dir, name] of skillDirMap) {
    const normalizedDir = normalizePath(dir);
    if (normalized.startsWith(normalizedDir + "/")) {
      const relPath = normalized.slice(normalizedDir.length + 1);
      return { skillDir: dir, skillName: name, relPath };
    }
  }
  return undefined;
}

interface SkillAuditContext {
  logger: QClawLogger;
  client: LLMShieldClient;
  sceneId: string;
  skillName: string;
  skillDir: string;
  cacheKey: string;
  enableLogging: boolean;
  fallbackRequest: SkillAuditRequest;
  logTag: string;
  sessionKey?: string;
}

async function auditSkillWithPackageFallback(ctx: SkillAuditContext): Promise<SkillAuditResult> {
  const { logger, client, sceneId, skillName, skillDir, cacheKey, enableLogging, fallbackRequest, logTag, sessionKey } = ctx;

  const hasContent = fallbackRequest.File.Content !== undefined && fallbackRequest.File.Content !== null;
  fileLog(`[skill_audit] auditSkillWithPackageFallback: logTag=${logTag}, skillName=${skillName}, skillDir="${skillDir}", hasContent=${hasContent}, contentLen=${hasContent ? fallbackRequest.File.Content!.length : 0}`);

  const pkgCached = isDebugMode() ? undefined : getSkillPackageCacheResult(skillDir);
  if (pkgCached?.block) {
    fileLog(`[skill_audit] ${logTag}: package cache BLOCK for dir=${skillDir}`);
    const result: SkillAuditResult = { handled: true, block: true, mark: pkgCached.mark, blockReason: pkgCached.blockReason, skillName };
    skillAuditCache.set(cacheKey, result);
    return result;
  }

  const pkgOutcome = await awaitSkillPackageAudit(logger, client, sceneId, skillName, skillDir, enableLogging, sessionKey);
  if (pkgOutcome.success) {
    const result: SkillAuditResult = {
      handled: true, block: pkgOutcome.block, mark: pkgOutcome.mark, blockReason: pkgOutcome.blockReason,
      reasonText: pkgOutcome.reasonText, skillName,
    };
    skillAuditCache.set(cacheKey, result);
    fileLog(`[skill_audit] ${logTag}: package audit decisive, block=${pkgOutcome.block}, mark=${pkgOutcome.mark ?? false}`);
    return result;
  }

  fileLog(`[skill_audit] ${logTag}: package audit failed, falling back to single-file audit`);
  const result = await auditSkillRequest(logger, client, sceneId, fallbackRequest, enableLogging);
  result.skillName = skillName;
  skillAuditCache.set(cacheKey, result);
  return result;
}

export async function trySkillAudit(
  logger: QClawLogger, client: LLMShieldClient, sceneId: string, toolName: string, params: any,
  enableLogging: boolean,
  history?: Array<{ Role: string; Content: string; ContentType: ContentType }>,
  sessionKey?: string,
): Promise<SkillAuditResult> {
  logger.debug(`[${LOG_TAG}] trySkillAudit: ${toolName}`);
  fileLog(`[skill_audit] trySkillAudit: toolName=${toolName} params=${JSON.stringify(params)} debugMode=${isDebugMode()}`);

  if (toolName === USE_SKILL_TOOL) {
    fileLog(`[skill_audit] >>> BRANCH: use_skill`);
    return handleUseSkill(logger, client, sceneId, params, enableLogging, history, sessionKey);
  }

  const rawPath = extractFilePath(toolName, params);
  if (!rawPath) {
    // ── 分支4: exec 类工具 + 命令中包含 /skills/ 路径 ──
    if (EXEC_TOOLS.has(toolName)) {
      const cmdStr = typeof params?.command === "string"
        ? params.command
        : typeof params?.script === "string" ? params.script : undefined;
      if (cmdStr) {
        const execResult = handleExecSkillLoad(logger, client, sceneId, cmdStr, enableLogging, history, sessionKey);
        if (execResult) {
          fileLog(`[skill_audit] >>> BRANCH: exec skill load`);
          return execResult;
        }
      }
    }

    fileLog(`[skill_audit] extractFilePath returned undefined, toolName=${toolName}, paramKeys=${Object.keys(params || {}).join(",")}`);
    return { handled: false };
  }
  const filePath = resolvePath(rawPath);
  const isRead = READ_TOOLS.has(toolName);
  const isSM = isSkillMd(filePath);
  fileLog(`[skill_audit] filePath=${filePath}, isReadTool=${isRead}, isSkillMd=${isSM}`);

  if (isRead && isSM) {
    fileLog(`[skill_audit] >>> BRANCH: read SKILL.md`);
    return handleReadSkillMd(logger, client, sceneId, filePath, params, enableLogging, history, sessionKey);
  }

  fileLog(`[skill_audit] >>> BRANCH: skillDir match`);
  return handleSkillDirMatch(logger, client, sceneId, filePath, params, enableLogging, history, sessionKey);
}

async function handleUseSkill(
  logger: QClawLogger, client: LLMShieldClient, sceneId: string,
  params: any, enableLogging: boolean,
  history?: Array<{ Role: string; Content: string; ContentType: ContentType }>,
  sessionKey?: string,
): Promise<SkillAuditResult> {
  const rawCommand = typeof params?.command === "string" ? params.command : String(params?.name ?? params?.command ?? "unknown");
  fileLog(`[skill_audit] handleUseSkill: rawCommand="${rawCommand}", params keys=${Object.keys(params || {}).join(",")}`);
  const skillContent = tryReadSkillContent(rawCommand);
  const skillName = skillContent
    ? (parseSkillNameFromFrontmatter(skillContent.content) ?? path.basename(skillContent.skillDir))
    : rawCommand;

  const cacheKey = makeSkillCacheKey(skillName, "definition");
  if (!isDebugMode()) {
    const cached = skillAuditCache.get(cacheKey);
    if (cached) {
      fileLog(`[skill_audit] cache hit: ${cacheKey}`);
      return { ...cached, skillName };
    }
  } else {
    fileLog(`[skill_audit] cache SKIPPED (debug mode): ${cacheKey}`);
  }

  if (skillContent) {
    skillDirMap.set(skillContent.skillDir, skillName);
    fileLog(`[skill_audit] use_skill: read SKILL.md ok, skillDir=${skillContent.skillDir}, contentLen=${skillContent.content.length}`);

    return auditSkillWithPackageFallback({
      logger, client, sceneId, skillName, enableLogging, sessionKey,
      skillDir: skillContent.skillDir, cacheKey, logTag: "use_skill",
      fallbackRequest: {
        Skill: { Name: skillName, Dir: skillContent.skillDir, Source: "unknown" },
        File: { Path: skillContent.filePath, RelPath: "SKILL.md", Type: "definition", Content: skillContent.content },
        Scene: sceneId, SessionID: sessionKey, History: history, // AgentID: "qclaw",
      },
    });
  }

  fileLog(`[skill_audit] use_skill: SKILL.md not found for command="${rawCommand}", sending without content`);
  const result = await auditSkillRequest(logger, client, sceneId, {
    Skill: { Name: skillName, Dir: "", Source: "unknown" },
    File: { Path: "", RelPath: "SKILL.md", Type: "definition" },
    Scene: sceneId, SessionID: sessionKey, History: history, // AgentID: "qclaw",
  }, enableLogging);
  result.skillName = skillName;
  skillAuditCache.set(cacheKey, result);
  return result;
}

async function handleReadSkillMd(
  logger: QClawLogger, client: LLMShieldClient, sceneId: string,
  filePath: string, params: any, enableLogging: boolean,
  history?: Array<{ Role: string; Content: string; ContentType: ContentType }>,
  sessionKey?: string,
): Promise<SkillAuditResult> {
  const parentDir = path.dirname(filePath);
  let skillMdContent: string | undefined;
  const fileExists = fs.existsSync(filePath);
  fileLog(`[skill_audit] handleReadSkillMd: filePath="${filePath}", parentDir="${parentDir}", fileExists=${fileExists}`);
  try {
    if (fileExists) {
      skillMdContent = fs.readFileSync(filePath, "utf-8");
    }
  } catch (err: any) {
    fileLog(`[skill_audit] handleReadSkillMd: readFileSync ERROR: ${err.message}`);
  }

  const skillName = (skillMdContent ? parseSkillNameFromFrontmatter(skillMdContent) : undefined)
    ?? path.basename(parentDir);
  skillDirMap.set(parentDir, skillName);

  fileLog(`[skill_audit] registered skillDir: ${parentDir} → ${skillName}, map size=${skillDirMap.size}`);
  recordLogEvent(logger, LOG_TAG, "skill_dir_registered", { skillDir: parentDir, skillName }, enableLogging);

  const cacheKey = makeSkillCacheKey(skillName, "definition");
  if (!isDebugMode()) {
    const cached = skillAuditCache.get(cacheKey);
    if (cached) {
      fileLog(`[skill_audit] cache hit: ${cacheKey}`);
      return { ...cached, skillName };
    }
  } else {
    fileLog(`[skill_audit] cache SKIPPED (debug mode): ${cacheKey}`);
  }

  const finalContent = skillMdContent ?? (typeof params?.content === "string" ? params.content : undefined);

  return auditSkillWithPackageFallback({
    logger, client, sceneId, skillName, enableLogging, sessionKey,
    skillDir: parentDir, cacheKey, logTag: "read SKILL.md",
    fallbackRequest: {
      Skill: { Name: skillName, Dir: parentDir, Source: "unknown" },
      File: { Path: filePath, RelPath: "SKILL.md", Type: "definition", Content: finalContent },
      Scene: sceneId, SessionID: sessionKey, History: history, // AgentID: "qclaw",
    },
  });
}

// ── 分支4: exec 类工具中的 skill 文件读取 ──

/**
 * 从 shell 命令字符串中提取所有被文件读取命令引用的路径（跨平台）。
 * 返回所有匹配到的路径（已去引号）。
 */
function extractFilePathsFromCommand(command: string): string[] {
  const results: string[] = [];
  const globalRe = new RegExp(FILE_READ_CMD_RE.source, "gi");
  for (const m of command.matchAll(globalRe)) {
    const captured = m[1] ?? m[2] ?? m[3];
    if (captured) results.push(captured);
  }
  return results;
}

/**
 * 处理 exec 类工具中的 skill 加载场景。
 */
function handleExecSkillLoad(
  logger: QClawLogger, client: LLMShieldClient, sceneId: string,
  command: string, enableLogging: boolean,
  history?: Array<{ Role: string; Content: string; ContentType: ContentType }>,
  sessionKey?: string,
): Promise<SkillAuditResult> | undefined {
  const paths = extractFilePathsFromCommand(command);
  fileLog(`[skill_audit] handleExecSkillLoad: command="${command.slice(0, 200)}", extractedPaths=${JSON.stringify(paths)}`);

  const skillPath = paths.find((p) => SKILLS_PATH_SEG_RE.test(p));
  if (!skillPath) return undefined;

  const resolved = resolvePath(skillPath);
  fileLog(`[skill_audit] handleExecSkillLoad: matched skillPath="${skillPath}", resolved="${resolved}"`);

  const dirMatch = findSkillDir(resolved);
  if (dirMatch) {
    fileLog(`[skill_audit] handleExecSkillLoad: already tracked in skillDirMap, delegating to handleSkillDirMatch`);
    return handleSkillDirMatchResolved(logger, client, sceneId, dirMatch, enableLogging, history, sessionKey);
  }

  return doExecSkillAudit(logger, client, sceneId, resolved, enableLogging, history, sessionKey);
}

async function handleSkillDirMatchResolved(
  logger: QClawLogger, client: LLMShieldClient, sceneId: string,
  match: { skillDir: string; skillName: string; relPath: string },
  enableLogging: boolean,
  history?: Array<{ Role: string; Content: string; ContentType: ContentType }>,
  sessionKey?: string,
): Promise<SkillAuditResult> {
  const fileType = resolveFileType(match.relPath);
  fileLog(`[skill_audit] exec→skillDirMatch: skillDir=${match.skillDir}, name=${match.skillName}, rel=${match.relPath}, type=${fileType}`);

  const cacheKey = `${match.skillName}:${match.relPath}`;
  if (!isDebugMode()) {
    const cached = skillAuditCache.get(cacheKey);
    if (cached) {
      fileLog(`[skill_audit] cache hit: ${cacheKey}`);
      return { ...cached, skillName: match.skillName };
    }
  } else {
    fileLog(`[skill_audit] cache SKIPPED (debug mode): ${cacheKey}`);
  }

  const pkgResult = isDebugMode() ? undefined : getSkillPackageCacheResult(match.skillDir);
  if (pkgResult?.block) {
    fileLog(`[skill_audit] package cache BLOCK for dir=${match.skillDir}`);
    const result: SkillAuditResult = { handled: true, block: true, mark: pkgResult.mark, blockReason: pkgResult.blockReason, reasonText: pkgResult.reasonText, skillName: match.skillName };
    skillAuditCache.set(cacheKey, result);
    return result;
  }

  let fileContent: string | undefined;
  const filePath = path.join(match.skillDir, match.relPath);
  try {
    if (fs.existsSync(filePath)) {
      fileContent = fs.readFileSync(filePath, "utf-8");
    }
  } catch { /* ignore read errors */ }

  const result = await auditSkillRequest(logger, client, sceneId, {
    Skill: { Name: match.skillName, Dir: match.skillDir, Source: "unknown" },
    File: { Path: filePath, RelPath: match.relPath, Type: fileType, Content: fileContent },
    Scene: sceneId, SessionID: sessionKey, History: history, // AgentID: "qclaw",
  }, enableLogging);
  result.skillName = match.skillName;
  skillAuditCache.set(cacheKey, result);
  return result;
}

async function doExecSkillAudit(
  logger: QClawLogger, client: LLMShieldClient, sceneId: string,
  resolved: string, enableLogging: boolean,
  history?: Array<{ Role: string; Content: string; ContentType: ContentType }>,
  sessionKey?: string,
): Promise<SkillAuditResult> {
  let dir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  let skillDir: string | undefined;
  let skillMdPath: string | undefined;
  let skillMdContent: string | undefined;

  for (let i = 0; i < 5; i++) {
    for (const name of ["SKILL.md", "skill.md"]) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        skillDir = dir;
        skillMdPath = candidate;
        try { skillMdContent = fs.readFileSync(candidate, "utf-8"); } catch { /* ignore */ }
        break;
      }
    }
    if (skillDir) break;
    const parent = path.dirname(dir);
    if (parent === dir || !SKILLS_PATH_SEG_RE.test(parent)) break;
    dir = parent;
  }

  if (!skillDir) {
    skillDir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
    fileLog(`[skill_audit] doExecSkillAudit: SKILL.md not found, using dir="${skillDir}"`);
  }

  const skillName = (skillMdContent ? parseSkillNameFromFrontmatter(skillMdContent) : undefined)
    ?? path.basename(skillDir);
  skillDirMap.set(skillDir, skillName);
  fileLog(`[skill_audit] doExecSkillAudit: registered skillDir="${skillDir}" → "${skillName}"`);
  recordLogEvent(logger, LOG_TAG, "skill_dir_registered", { skillDir, skillName, source: "exec" }, enableLogging);

  const isSkillFile = isSkillMd(resolved);
  const relPath = normalizePath(path.relative(skillDir, resolved));
  const fileType = isSkillFile ? "definition" as const : resolveFileType(relPath);

  const cacheKey = isSkillFile ? makeSkillCacheKey(skillName, "definition") : `${skillName}:${relPath}`;
  if (!isDebugMode()) {
    const cached = skillAuditCache.get(cacheKey);
    if (cached) {
      fileLog(`[skill_audit] cache hit: ${cacheKey}`);
      return { ...cached, skillName };
    }
  } else {
    fileLog(`[skill_audit] cache SKIPPED (debug mode): ${cacheKey}`);
  }

  if (skillMdPath) {
    return auditSkillWithPackageFallback({
      logger, client, sceneId, skillName, enableLogging, sessionKey,
      skillDir, cacheKey, logTag: "exec skill load",
      fallbackRequest: {
        Skill: { Name: skillName, Dir: skillDir, Source: "unknown" },
        File: {
          Path: skillMdPath, RelPath: "SKILL.md", Type: "definition",
          Content: skillMdContent,
        },
        Scene: sceneId, SessionID: sessionKey, History: history, // AgentID: "qclaw",
      },
    });
  }

  let fileContent: string | undefined;
  try {
    if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
      fileContent = fs.readFileSync(resolved, "utf-8");
    }
  } catch { /* ignore */ }

  const result = await auditSkillRequest(logger, client, sceneId, {
    Skill: { Name: skillName, Dir: skillDir, Source: "unknown" },
    File: { Path: resolved, RelPath: relPath || path.basename(resolved), Type: fileType, Content: fileContent },
    Scene: sceneId, SessionID: sessionKey, History: history, // AgentID: "qclaw",
  }, enableLogging);
  result.skillName = skillName;
  skillAuditCache.set(cacheKey, result);
  return result;
}

async function handleSkillDirMatch(
  logger: QClawLogger, client: LLMShieldClient, sceneId: string,
  filePath: string, params: any, enableLogging: boolean,
  history?: Array<{ Role: string; Content: string; ContentType: ContentType }>,
  sessionKey?: string,
): Promise<SkillAuditResult> {
  const match = findSkillDir(filePath);
  if (!match) {
    fileLog(`[skill_audit] no match → handled=false`);
    return { handled: false };
  }

  const fileType = resolveFileType(match.relPath);
  fileLog(`[skill_audit] matched skillDir: ${match.skillDir}, skillName=${match.skillName}, relPath=${match.relPath}, fileType=${fileType}`);

  const cacheKey = `${match.skillName}:${match.relPath}`;
  if (!isDebugMode()) {
    const cached = skillAuditCache.get(cacheKey);
    if (cached) {
      fileLog(`[skill_audit] cache hit: ${cacheKey}`);
      return { ...cached, skillName: match.skillName };
    }
  } else {
    fileLog(`[skill_audit] cache SKIPPED (debug mode): ${cacheKey}`);
  }

  const pkgResult = isDebugMode() ? undefined : getSkillPackageCacheResult(match.skillDir);
  if (pkgResult?.block) {
    fileLog(`[skill_audit] package cache BLOCK for dir=${match.skillDir}`);
    const result: SkillAuditResult = { handled: true, block: true, mark: pkgResult.mark, blockReason: pkgResult.blockReason, reasonText: pkgResult.reasonText, skillName: match.skillName };
    skillAuditCache.set(cacheKey, result);
    return result;
  }

  const result = await auditSkillRequest(logger, client, sceneId, {
    Skill: { Name: match.skillName, Dir: match.skillDir, Source: "unknown" },
    File: { Path: filePath, RelPath: match.relPath, Type: fileType, Content: typeof params?.content === "string" ? params.content : undefined },
    Scene: sceneId, SessionID: sessionKey, History: history, // AgentID: "qclaw",
  }, enableLogging);
  result.skillName = match.skillName;
  skillAuditCache.set(cacheKey, result);
  return result;
}

function extractFilePath(toolName: string, params: any): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  return params.path ?? params.filePath ?? params.file_path ?? params.file ?? undefined;
}

async function auditSkillRequest(
  logger: QClawLogger, client: LLMShieldClient, sceneId: string,
  request: SkillAuditRequest, enableLogging: boolean
): Promise<SkillAuditResult> {
  const requestId = generateRequestId();
  recordLogEvent(logger, LOG_TAG, "skill_audit(check)", {
    requestId, skill: request.Skill.Name, fileType: request.File.Type, filePath: request.File.Path,
  }, enableLogging);
  fileLog(`[skill_audit] REQ (${requestId}) FULL BODY: ${JSON.stringify(request)}`);

  let response: SkillAuditResponse;
  try {
    if (globalCircuitBreaker.isOpen()) {
      const remaining = Math.round(globalCircuitBreaker.remainingCooldownMs() / 1000);
      logger.debug(`[${LOG_TAG}] Circuit-breaker is open, skipping skill audit.`);
      fileLog(`[skill_audit] SKIP (circuit-breaker open, remaining cooldown: ${remaining}s)`);
      return { handled: true };
    }

    response = await client.moderateSkill(request, {
      "X-Request-Id": requestId,
      "X-Device-Fingerprint": getDeviceFingerprintValue(),
    });
    globalCircuitBreaker.recordSuccess();
  } catch (error: any) {
    globalCircuitBreaker.recordFailure();
    logger.error(`[${LOG_TAG}] Skill audit failed: ${error.message || error}`);
    return { handled: true };
  }

  fileLog(`[skill_audit] RESP (${requestId}) FULL BODY: ${JSON.stringify(response)}`);
  recordLogEvent(logger, LOG_TAG, "skill_audit(result)", { requestId, response }, enableLogging);

  const decision = response.Result?.Decision?.DecisionType;
  const risks = response.Result?.RiskInfo?.Risks ?? [];

  if (decision === DecisionType.BLOCK || decision === DecisionType.MARK) {
    const isMark = decision === DecisionType.MARK;
    const labelNames = Array.from(new Set(risks.map((r) => r.Reason || getLabelName(r.Label, "zh"))));
    const logType = isMark ? "mark" : "block";
    const logPrefix = isMark ? "Skill mark (need user confirm)" : "Skill blocked";
    recordLogEvent(logger, LOG_TAG, `skill_audit(${logType})`, { requestId, [`${logType}Reason`]: `${logPrefix}: ${labelNames.join(", ")}` }, enableLogging);

    const riskReasons = risks.map((r) => r.Reason).filter(Boolean);
    const reasonText = riskReasons.join("、") || "安全策略违规";
    const isScript = request.File.Type === "script";
    const blockReason = isMark
      ? (isScript ? `该 Skill 脚本存在潜在风险，需要用户确认：${reasonText}` : `该 Skill 存在潜在风险，需要用户确认后才能继续：${reasonText}`)
      : [
          `[SYSTEM SECURITY] 该skill已被安全策略阻止，原因：${reasonText}。`,
          `你必须马上停止该 skill 的加载和使用，不得重试或使用其他方式绕过此限制。`,
          `请直接告知用户此操作因安全原因被阻止，不要判断是否为误报。[ 管家 AI 安全 ]`,
        ].join("\n");
    return { handled: true, block: true, mark: isMark || undefined, blockReason, reasonText };
  }

  recordLogEvent(logger, LOG_TAG, "skill_audit(allow)", { requestId, skill: request.Skill.Name }, enableLogging);
  return { handled: true };
}

// ── 打包 Skill 审核（接口四） ──

export async function awaitSkillPackageAudit(
  logger: QClawLogger, client: LLMShieldClient, sceneId: string,
  skillName: string, skillDir: string, enableLogging: boolean,
  sessionKey?: string,
): Promise<SkillPackageAuditOutcome> {
  const normalizedDir = normalizePath(skillDir);
  const existing = pendingPackageAudits.get(normalizedDir);
  if (existing) {
    fileLog(`[skill_pkg_audit] reusing in-progress audit for dir=${normalizedDir}`);
    return existing;
  }

  const promise = doSkillPackageAudit(logger, client, sceneId, skillName, skillDir, enableLogging, sessionKey)
    .finally(() => { pendingPackageAudits.delete(normalizedDir); });

  pendingPackageAudits.set(normalizedDir, promise);
  return promise;
}

export function getSkillPackageCacheResult(skillDir: string): { block: boolean; mark?: boolean; blockReason?: string; reasonText?: string } | undefined {
  const normalizedDir = normalizePath(skillDir);
  const hash = skillDirHashMap.get(normalizedDir);
  if (!hash) return undefined;
  return skillPackageCache.get(hash);
}

const skillDirHashMap = new Map<string, string>();

async function doSkillPackageAudit(
  logger: QClawLogger, client: LLMShieldClient, sceneId: string,
  skillName: string, skillDir: string, enableLogging: boolean,
  sessionKey?: string,
): Promise<SkillPackageAuditOutcome> {
  const normalizedDir = normalizePath(skillDir);
  const requestId = generateRequestId();
  fileLog(`[skill_pkg_audit] START dir=${skillDir}, skillName=${skillName}`);

  if (globalCircuitBreaker.isOpen()) {
    fileLog(`[skill_pkg_audit] SKIP (circuit-breaker open)`);
    return { success: false };
  }

  fileLog(`[skill_pkg_audit] packing dir="${skillDir}"`);
  let packResult: Awaited<ReturnType<typeof packDirectoryToZip>>;
  try {
    packResult = await packDirectoryToZip(skillDir);
  } catch (err: any) {
    fileLog(`[skill_pkg_audit] packDirectoryToZip THREW: ${err.message}\n${err.stack}`);
    return { success: false };
  }
  if (!packResult) {
    fileLog(`[skill_pkg_audit] SKIP (pack returned null/undefined, limit=${MAX_PACKAGE_SIZE})`);
    recordLogEvent(logger, LOG_TAG, "skill_pkg_audit(skip)", { requestId, skillName, reason: "pack_failed_or_oversized" }, enableLogging);
    return { success: false };
  }

  if (!isDebugMode()) {
    const cached = skillPackageCache.get(packResult.sha256_hash);
    if (cached) {
      skillDirHashMap.set(normalizedDir, packResult.sha256_hash);
      fileLog(`[skill_pkg_audit] cache hit hash=${packResult.sha256_hash}, block=${cached.block}`);
      return { success: true, block: cached.block, blockReason: cached.blockReason, reasonText: cached.reasonText };
    }
  } else {
    fileLog(`[skill_pkg_audit] cache SKIPPED (debug mode): hash=${packResult.sha256_hash}`);
  }

  const base64_content = packResult.zip_buffer.toString("base64");
  fileLog(`[skill_pkg_audit] packed: files=${packResult.file_count}, zipSize=${packResult.total_size}, base64Len=${base64_content.length}, hash=${packResult.sha256_hash}`);

  const request = {
    Skill: { Name: skillName, Dir: skillDir, Source: "unknown" as const },
    Package: { Content: base64_content, FileName: `${skillName}.zip`, Size: packResult.total_size, Hash: packResult.sha256_hash },
    Scene: sceneId,
    SessionID: sessionKey, // AgentID: "qclaw",
  };

  recordLogEvent(logger, LOG_TAG, "skill_pkg_audit(check)", {
    requestId, skillName, zipSize: packResult.total_size, fileCount: packResult.file_count, hash: packResult.sha256_hash,
  }, enableLogging);

  let response: SkillPackageAuditResponse;
  try {
    response = await client.moderateSkillPackage(request, {
      "X-Request-Id": requestId,
      "X-Device-Fingerprint": getDeviceFingerprintValue(),
    });
    globalCircuitBreaker.recordSuccess();
  } catch (error: any) {
    globalCircuitBreaker.recordFailure();
    logger.error(`[${LOG_TAG}] Skill package audit failed: ${error.message || error}`);
    fileLog(`[skill_pkg_audit] ERROR: ${error.message || error}`);
    return { success: false };
  }

  fileLog(`[skill_pkg_audit] RESP (${requestId}): ${JSON.stringify(response)}`);
  recordLogEvent(logger, LOG_TAG, "skill_pkg_audit(result)", { requestId, response }, enableLogging);

  const decision = response.Result?.Decision?.DecisionType;
  const risks = response.Result?.RiskInfo?.Risks ?? [];

  if (decision === DecisionType.BLOCK || decision === DecisionType.MARK) {
    const isMark = decision === DecisionType.MARK;
    const labelNames = Array.from(new Set(risks.map((r) => r.Reason || getLabelName(r.Label, "zh"))));
    const logType = isMark ? "mark" : "block";
    const logPrefix = isMark ? "Skill package mark (need user confirm)" : "Skill package blocked";
    recordLogEvent(logger, LOG_TAG, `skill_pkg_audit(${logType})`, { requestId, [`${logType}Reason`]: `${logPrefix}: ${labelNames.join(", ")}` }, enableLogging);

    const riskReasons = risks.map((r) => r.Reason).filter(Boolean);
    const reasonText = riskReasons.join("、") || "安全策略违规";
    const blockReason = isMark
      ? (reasonText ? `该 Skill 包存在潜在风险，需要用户确认后才能加载：${reasonText}` : "该 Skill 包存在潜在风险，需要用户确认后才能加载")
      : [
          `[SYSTEM SECURITY] 该skill已被安全策略阻止，原因：${reasonText}。`,
          `你必须马上停止该 skill 的加载和使用，不得重试或使用其他方式绕过此限制。`,
          `请直接告知用户此操作因安全原因被阻止，不要判断是否为误报。[ 管家 AI 安全 ]`,
        ].join("\n");
    skillPackageCache.set(packResult.sha256_hash, { block: true, mark: isMark || undefined, blockReason, reasonText });
    skillDirHashMap.set(normalizedDir, packResult.sha256_hash);
    return { success: true, block: true, blockReason, reasonText };
  }

  skillPackageCache.set(packResult.sha256_hash, { block: false });
  skillDirHashMap.set(normalizedDir, packResult.sha256_hash);
  return { success: true, block: false };
}

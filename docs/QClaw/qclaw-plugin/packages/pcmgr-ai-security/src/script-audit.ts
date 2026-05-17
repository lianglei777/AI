/**
 * 脚本审核模块
 *
 * 在 before_tool_call 中判断文件写入工具是否写入脚本文件，
 * 匹配时调用 /v2/moderate/script 进行审核。
 */

import fs from "node:fs";
import path from "node:path";
import { LOG_TAG } from "./constants.js";
import {
  LLMShieldClient,
  ContentType,
  DecisionType,
  ScriptLanguage,
  ScriptAuditRequest,
  ScriptAuditResponse,
} from "./client.js";
import { getDeviceFingerprintValue } from "./security.js";
import { globalCircuitBreaker } from "./circuit-breaker.js";
import { generateRequestId, recordLogEvent } from "./utils.js";
import { getLabelName } from "./labels.js";
import { fileLog } from "./logger.js";
import { isExecTool } from "./exec-guard.js";

import type { QClawLogger } from '../../../core/types.js'

/** 写入文件的工具名集合 */
const WRITE_TOOLS = new Set(["write", "write_to_file", "replace_in_file"]);

/** 后缀 → 语言标识 */
const SCRIPT_EXT_MAP: Record<string, ScriptLanguage> = {
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".fish": "shell",
  ".bat": "batch",
  ".cmd": "batch",
  ".ps1": "powershell",
  ".vbs": "other",
  ".wsf": "other",
  ".py": "python",
  ".js": "javascript",
  ".ts": "typescript",
  ".rb": "ruby",
  ".pl": "perl",
  ".lua": "lua",
  ".c": "c",
  ".cpp": "cpp",
  ".rs": "rust",
  ".go": "go",
};

function getScriptLanguage(filePath: string): ScriptLanguage | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return SCRIPT_EXT_MAP[ext];
}

export interface ScriptAuditResult {
  handled: boolean;
  block?: boolean;
  /** 需要用户确认（DecisionType.MARK） */
  mark?: boolean;
  blockReason?: string;
  reasonText?: string;
  resolvedPath?: string;
}

export async function tryScriptAudit(
  logger: QClawLogger,
  client: LLMShieldClient,
  sceneId: string,
  toolName: string,
  params: any,
  enableLogging: boolean,
  history?: Array<{ Role: string; Content: string; ContentType: ContentType }>,
  sessionKey?: string,
): Promise<ScriptAuditResult> {
  logger.debug(`[${LOG_TAG}] tryScriptAudit: ${toolName}`);
  fileLog(`[script_audit] tryScriptAudit: toolName=${toolName} params=${JSON.stringify(params)}`);

  // 分支 1：标准写入工具
  // 分支 2：exec 工具中通过 write_file.py 写文件的场景（如 qclaw-text-file 技能）
  let filePath: string;
  let content: string | undefined;
  let language: ScriptLanguage | undefined;
  let operation: "create" | "modify";

  if (WRITE_TOOLS.has(toolName)) {
    const rawFilePath = extractFilePath(params);
    if (!rawFilePath) {
      fileLog(`[script_audit] extractFilePath returned undefined, toolName=${toolName}, paramKeys=${Object.keys(params || {}).join(",")}`);
      return { handled: false };
    }

    filePath = path.isAbsolute(rawFilePath) ? rawFilePath : path.resolve(process.cwd(), rawFilePath);
    language = getScriptLanguage(filePath);
    if (!language) {
      fileLog(`[script_audit] unsupported extension "${path.extname(filePath).toLowerCase()}" for file "${filePath}" → handled=false`);
      return { handled: false };
    }

    content = extractContent(toolName, params);
    if (!content) {
      fileLog(`[script_audit] extractContent returned undefined, toolName=${toolName}, paramKeys=${Object.keys(params || {}).join(",")}`);
      return { handled: false };
    }

    operation = toolName === "replace_in_file" ? "modify" : "create";
  } else if (isExecTool(toolName)) {
    const cmdStr = typeof params?.command === "string" ? params.command : undefined;
    if (!cmdStr) {
      fileLog(`[script_audit] exec tool (${toolName}) has no command param, skip → handled=false`);
      return { handled: false };
    }

    // 尝试方式 A: write_file.py 调用
    const parsedPy = parseWriteFileCommand(cmdStr);
    // 尝试方式 B: shell 重定向写文件 (cat heredoc / tee heredoc / echo redirect)
    const parsedShell = parsedPy ? undefined : parseShellRedirectWrite(cmdStr);

    if (parsedPy) {
      filePath = path.isAbsolute(parsedPy.targetPath)
        ? parsedPy.targetPath
        : path.resolve(process.cwd(), parsedPy.targetPath);

      language = getScriptLanguage(filePath);
      if (!language) {
        fileLog(`[script_audit] exec write_file.py: unsupported extension "${path.extname(filePath).toLowerCase()}" for "${filePath}" → handled=false`);
        return { handled: false };
      }

      // 尝试从临时文件读取内容
      if (parsedPy.contentFile) {
        try {
          content = fs.readFileSync(parsedPy.contentFile, "utf-8");
        } catch (err) {
          fileLog(`[script_audit] failed to read content-file: ${parsedPy.contentFile}, error: ${err}`);
        }
      }
      if (!content && parsedPy.contentArg) {
        content = parsedPy.contentArg;
      }
      if (!content) {
        fileLog(`[script_audit] exec write_file.py: no content available for ${filePath} → handled=false`);
        return { handled: false };
      }
    } else if (parsedShell) {
      filePath = path.isAbsolute(parsedShell.targetPath)
        ? parsedShell.targetPath
        : path.resolve(process.cwd(), parsedShell.targetPath);

      language = getScriptLanguage(filePath);
      if (!language) {
        fileLog(`[script_audit] exec shell redirect: unsupported extension "${path.extname(filePath).toLowerCase()}" for "${filePath}" → handled=false`);
        return { handled: false };
      }

      content = parsedShell.content;
      if (!content) {
        fileLog(`[script_audit] exec shell redirect: no content available for ${filePath} → handled=false`);
        return { handled: false };
      }
    } else {
      fileLog(`[script_audit] exec tool (${toolName}) command not a recognized write pattern, skip → handled=false`);
      return { handled: false };
    }

    operation = "create";
  } else {
    fileLog(`[script_audit] not a write/exec tool (${toolName}), skip → handled=false`);
    return { handled: false };
  }

  const ext = path.extname(filePath).toLowerCase();
  fileLog(`[script_audit] matched: filePath=${filePath}, ext=${ext}, language=${language}, contentLength=${content.length}, preview=${JSON.stringify(content.slice(0, 30))}`);


  const requestId = generateRequestId();

  recordLogEvent(logger, LOG_TAG, "script_audit(check)", {
    requestId, filePath, language, operation, contentLength: content.length,
  }, enableLogging);

  const request: ScriptAuditRequest = {
    Script: { Path: filePath, Language: language, Content: content, Operation: operation },
    Scene: sceneId,
    SessionID: sessionKey,
    // AgentID: "qclaw",
    History: history,
  };

  fileLog(`[script_audit] REQ (${requestId}) FULL BODY: ${JSON.stringify(request)}`);

  let response: ScriptAuditResponse;
  try {
    if (globalCircuitBreaker.isOpen()) {
      const remaining = Math.round(globalCircuitBreaker.remainingCooldownMs() / 1000);
      logger.debug(`[${LOG_TAG}] Circuit-breaker is open, skipping script audit.`);
      fileLog(`[script_audit] SKIP (circuit-breaker open, remaining cooldown: ${remaining}s)`);
      return { handled: true, resolvedPath: filePath };
    }

    response = await client.moderateScript(request, {
      "X-Request-Id": requestId,
      "X-Device-Fingerprint": getDeviceFingerprintValue(),
    });

    globalCircuitBreaker.recordSuccess();
  } catch (error: any) {
    globalCircuitBreaker.recordFailure();
    logger.error(`[${LOG_TAG}] Script audit failed: ${error.message || error}`);
    return { handled: true, resolvedPath: filePath };
  }

  fileLog(`[script_audit] RESP (${requestId}) FULL BODY: ${JSON.stringify(response)}`);
  recordLogEvent(logger, LOG_TAG, "script_audit(result)", { requestId, response }, enableLogging);

  const decision = response.Result?.Decision?.DecisionType;
  const risks = response.Result?.RiskInfo?.Risks ?? [];
  const labels = risks.map((r) => r.Label);

  if (decision === DecisionType.BLOCK || decision === DecisionType.MARK) {
    const isMark = decision === DecisionType.MARK;
    const labelNames = Array.from(new Set(
      risks.map((r) => r.Reason || getLabelName(r.Label, "zh"))
    ));
    const reasonTextFull = labelNames.join(", ");
    const reasonText = labelNames[0] || "";

    const logType = isMark ? "mark" : "block";
    const logPrefix = isMark ? "Script mark (need user confirm)" : "Script blocked";
    const defaultMessage = isMark
      ? "该脚本存在潜在风险，需要用户确认后才能继续"
      : `该脚本【存在严重安全风险】，被安全策略拦截，不能再执行，直接提醒用户并拒绝：${reasonTextFull}`;
    const blockReason = reasonText ? `${defaultMessage}：${reasonText}` : defaultMessage;

    recordLogEvent(logger, LOG_TAG, `script_audit(${logType})`, { requestId, [`${logType}Reason`]: `${logPrefix}: ${reasonTextFull}` }, enableLogging);

    return { handled: true, block: true, mark: isMark || undefined, blockReason, reasonText, resolvedPath: filePath };
  }

  recordLogEvent(logger, LOG_TAG, "script_audit(allow)", { requestId, filePath, language }, enableLogging);
  return { handled: true, resolvedPath: filePath };
}

/**
 * 从 exec command 中识别 write_file.py 调用，提取 --path 和 --content-file / --content 参数。
 * 匹配 python3/python 及各种调用方式。
 */
function parseWriteFileCommand(
  command: string
): { targetPath: string; contentFile?: string; contentArg?: string } | undefined {
  if (!command.includes("write_file.py")) return undefined;

  // 提取 --path 参数值（兼容引号包裹）
  const pathMatch = command.match(/--path\s+["']?([^"'\s]+)["']?/);
  if (!pathMatch) return undefined;

  // 提取 --content-file 参数值
  const contentFileMatch = command.match(/--content-file\s+["']?([^"'\s]+)["']?/);
  // 提取 --content 参数值（需要引号包裹，因为内容中可能有空格）
  const contentArgMatch = command.match(/--content\s+["']([^"']+)["']/);

  return {
    targetPath: pathMatch[1],
    contentFile: contentFileMatch?.[1],
    contentArg: contentArgMatch?.[1],
  };
}

/**
 * 从 shell 命令中识别重定向写文件的模式：
 * - cat > file.sh << 'EOF'\n...\nEOF
 * - cat >> file.sh << EOF\n...\nEOF
 * - cat > file.sh <<- 'EOF'\n...\nEOF
 * - tee file.sh << 'EOF'\n...\nEOF
 * - echo '...' > file.sh
 * - printf '...' > file.sh
 *
 * 返回目标文件路径和嵌入的内容，或 undefined（不匹配时）。
 */
function parseShellRedirectWrite(
  command: string
): { targetPath: string; content: string } | undefined {
  // 模式 1: cat + heredoc
  //   cat > target.sh << 'DELIM'  或  cat > target.sh << DELIM  或  cat >> target.sh <<- "DELIM"
  const catHeredocMatch = command.match(
    /^cat\s+>{1,2}\s*(["']?[^\s"'<>|&;]+["']?)\s*<<-?\s*['"]?(\w+)['"]?\n([\s\S]*)/
  );
  if (catHeredocMatch) {
    const rawTarget = catHeredocMatch[1].replace(/^["']|["']$/g, "");
    const delimiter = catHeredocMatch[2];
    const rest = catHeredocMatch[3];
    if (rawTarget && delimiter && rest) {
      const delimRegex = new RegExp(`^\\t*${delimiter}\\s*$`, "m");
      const delimIdx = rest.search(delimRegex);
      if (delimIdx !== -1) {
        return { targetPath: rawTarget, content: rest.slice(0, delimIdx) };
      }
    }
  }

  // 模式 2: tee + heredoc
  //   tee file.sh << 'DELIM'  或  tee -a file.sh << DELIM
  const teeHeredocMatch = command.match(
    /^tee\s+(?:-a\s+)?(["']?[^\s"'<>|&;]+["']?)\s*<<-?\s*['"]?(\w+)['"]?\n([\s\S]*)/
  );
  if (teeHeredocMatch) {
    const rawTarget = teeHeredocMatch[1].replace(/^["']|["']$/g, "");
    const delimiter = teeHeredocMatch[2];
    const rest = teeHeredocMatch[3];
    if (rawTarget && delimiter && rest) {
      const delimRegex = new RegExp(`^\\t*${delimiter}\\s*$`, "m");
      const delimIdx = rest.search(delimRegex);
      if (delimIdx !== -1) {
        return { targetPath: rawTarget, content: rest.slice(0, delimIdx) };
      }
    }
  }

  // 模式 3: echo/printf "..." > file  或 echo '...' > file
  const echoMatch = command.match(
    /^(?:echo|printf)\s+(?:-[eEn]\s+)?["']([\s\S]*?)["']\s*>{1,2}\s*(["']?[^\s"'|&;]+["']?)\s*$/
  );
  if (echoMatch) {
    const echoContent = echoMatch[1];
    const rawTarget = echoMatch[2].replace(/^["']|["']$/g, "");
    if (echoContent && rawTarget) {
      return { targetPath: rawTarget, content: echoContent };
    }
  }

  return undefined;
}

function extractFilePath(params: any): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  return params.path ?? params.filePath ?? params.file_path ?? params.file ?? undefined;
}

function extractContent(toolName: string, params: any): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  if (params.content && typeof params.content === "string") return params.content;
  if (toolName === "replace_in_file" && typeof params.new_str === "string") return params.new_str;
  return undefined;
}

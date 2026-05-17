/**
 * Read recent lines from OpenClaw session file into Pipeline history.events.
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentdrLogger, PipelineEvent, SessionEventsResult } from "./types.js";
import { fileLog } from "../logger.js";

const MAX_EVENTS = 10;
const LOG_TAG = "pcmgr-agentdr";

function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function shallowSnakeKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[camelToSnake(key)] = value;
  }
  return result;
}

export function extractSessionEvents(
  stateDir: string,
  agentId: string | undefined,
  sessionKey: string | undefined,
  logger: AgentdrLogger,
): SessionEventsResult {
  const empty: SessionEventsResult = { sessionId: null, events: [] };

  try {
    if (!agentId || !sessionKey) {
      fileLog(`[session-events] BAIL: agentId=${String(agentId)} sessionKey=${String(sessionKey)}`);
      return empty;
    }

    const sessionsJsonPath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
    if (!fs.existsSync(sessionsJsonPath)) {
      fileLog(`[session-events] BAIL: sessions.json not found at ${sessionsJsonPath} (stateDir=${stateDir})`);
      return empty;
    }

    const sessionsData = JSON.parse(fs.readFileSync(sessionsJsonPath, "utf-8")) as Record<string, { sessionId?: string; sessionFile?: string }>;
    const sessionInfo = sessionsData[sessionKey];
    if (!sessionInfo) {
      fileLog(`[session-events] BAIL: sessionKey="${sessionKey}" not found in sessions.json (keys count=${Object.keys(sessionsData).length})`);
      return empty;
    }

    const sessionId: string = sessionInfo.sessionId ?? "";
    const sessionFile: string = sessionInfo.sessionFile ?? "";

    const fullSessionPath = path.isAbsolute(sessionFile)
      ? sessionFile
      : path.join(path.dirname(sessionsJsonPath), sessionFile);

    if (!fs.existsSync(fullSessionPath)) {
      fileLog(`[session-events] BAIL: session file not found at ${fullSessionPath}`);
      return { sessionId: sessionId || null, events: [] };
    }

    const lines = fs
      .readFileSync(fullSessionPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    const lastLines = lines.slice(-MAX_EVENTS);

    const events: PipelineEvent[] = [];
    for (const line of lastLines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const event = shallowSnakeKeys(obj);
        if (event.message && typeof event.message === "object" && !Array.isArray(event.message)) {
          event.message = shallowSnakeKeys(event.message as Record<string, unknown>);
        }
        events.push(event as unknown as PipelineEvent);
      } catch {
        logger.error(`[${LOG_TAG}] failed to parse session event line: ${line}`);
      }
    }

    fileLog(`[session-events] OK: lines=${lines.length} lastLines=${lastLines.length} events=${events.length}`);
    return { sessionId: sessionId || null, events };
  } catch (e) {
    fileLog(`[session-events] ERROR: ${String(e)}`);
    logger.error(`[${LOG_TAG}] extractSessionEvents failed: ${String(e)}`);
    return empty;
  }
}

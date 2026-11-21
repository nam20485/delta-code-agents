import { readFileSync } from "node:fs";
import { agentMessage, toolCallUpdate, truncate, userMessage, type AcpUpdate } from "./records.js";

interface TranscriptPart {
  text?: unknown;
  thought?: unknown;
  functionCall?: { id?: unknown; name?: unknown; args?: unknown };
  functionResponse?: { id?: unknown; name?: unknown; response?: { output?: unknown } };
}

interface TranscriptLine {
  uuid?: unknown;
  type?: unknown;
  message?: { parts?: unknown };
}

function partsOf(line: TranscriptLine): TranscriptPart[] {
  const parts = line.message?.parts;
  return Array.isArray(parts) ? (parts as TranscriptPart[]) : [];
}

/**
 * Best-effort reconstruction of a Qwen Code transcript (`transcript_path`
 * JSONL) into ACP updates for mid-session share backfill. Qwen's shape differs
 * from Claude's: lines carry `type` (user/assistant/tool_result) and
 * `message.parts[]` with text / functionCall / functionResponse. Thinking
 * parts (`thought: true`) are skipped (no agent_thought records in v1).
 * Records are emitted as history (no turnSequence); live recording continues
 * after them. On any parse failure the caller records a note and goes live.
 */
export function backfillTranscript(path: string): AcpUpdate[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const updates: AcpUpdate[] = [];
  for (const chunk of raw.split("\n")) {
    const trimmed = chunk.trim();
    if (!trimmed.startsWith("{")) continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(trimmed) as TranscriptLine;
    } catch {
      continue;
    }
    const id = typeof line.uuid === "string" ? line.uuid : String(updates.length);
    const type = typeof line.type === "string" ? line.type : "";
    for (const part of partsOf(line)) {
      if (typeof part.text === "string" && part.text.trim().length > 0 && part.thought !== true) {
        if (type === "user") {
          updates.push(userMessage(`u-${id}`, part.text));
        } else if (type === "assistant") {
          updates.push(agentMessage(`a-${id}`, part.text));
        }
      }
      const resp = part.functionResponse;
      if (resp !== undefined && typeof resp.id === "string") {
        const output = resp.response?.output;
        const content = typeof output === "string" ? truncate(output) : undefined;
        const name = typeof resp.name === "string" ? resp.name : "tool";
        updates.push(toolCallUpdate(`t-${resp.id}`, name, "completed", content));
      }
    }
  }
  return updates;
}

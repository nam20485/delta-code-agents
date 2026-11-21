import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
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

/** Bound backfill so a huge transcript cannot block the sidecar indefinitely. */
export const MAX_BACKFILL_UPDATES = 1_000;

function partsOf(line: TranscriptLine): TranscriptPart[] {
  const parts = line.message?.parts;
  return Array.isArray(parts) ? (parts as TranscriptPart[]) : [];
}

function updatesForLine(line: TranscriptLine, index: number): AcpUpdate[] {
  const id = typeof line.uuid === "string" ? line.uuid : String(index);
  const type = typeof line.type === "string" ? line.type : "";
  const out: AcpUpdate[] = [];
  // Concatenate a line's non-thought text into ONE record: same-id resends
  // replace in Delta, so one record per part would lose all but the last.
  const texts: string[] = [];
  for (const part of partsOf(line)) {
    if (typeof part.text === "string" && part.text.trim().length > 0 && part.thought !== true) {
      texts.push(part.text);
    }
    const resp = part.functionResponse;
    if (resp !== undefined && typeof resp.id === "string") {
      const output = resp.response?.output;
      const content = typeof output === "string" ? truncate(output) : undefined;
      const name = typeof resp.name === "string" ? resp.name : "tool";
      out.push(toolCallUpdate(`t-${resp.id}`, name, "completed", content));
    }
  }
  if (texts.length > 0) {
    const body = texts.join("\n");
    if (type === "user") out.unshift(userMessage(`u-${id}`, body));
    else if (type === "assistant") out.unshift(agentMessage(`a-${id}`, body));
  }
  return out;
}

/**
 * Best-effort reconstruction of a Qwen Code transcript (`transcript_path`
 * JSONL) into ACP updates for mid-session share backfill. Qwen's shape differs
 * from Claude's: lines carry `type` (user/assistant/tool_result) and
 * `message.parts[]` with text / functionCall / functionResponse. Thinking
 * parts (`thought: true`) are skipped (no agent_thought records in v1).
 * Records are emitted as history (no turnSequence); live recording continues
 * after them. Streams the file (non-blocking) and caps the record count so a
 * tens-of-MB transcript cannot stall the sidecar's event loop.
 */
export async function backfillTranscript(path: string): Promise<AcpUpdate[]> {
  const updates: AcpUpdate[] = [];
  let stream;
  try {
    stream = createReadStream(path, { encoding: "utf8" });
  } catch {
    return updates;
  }
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let index = 0;
  try {
    for await (const chunk of lines) {
      const trimmed = chunk.trim();
      if (!trimmed.startsWith("{")) continue;
      let line: TranscriptLine;
      try {
        line = JSON.parse(trimmed) as TranscriptLine;
      } catch {
        continue;
      }
      for (const update of updatesForLine(line, index)) {
        updates.push(update);
        if (updates.length >= MAX_BACKFILL_UPDATES) return updates;
      }
      index += 1;
    }
  } catch {
    // Read error: return what we have (best-effort).
  } finally {
    lines.close();
    stream.destroy();
  }
  return updates;
}

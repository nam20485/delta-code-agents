import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backfillTranscript } from "../src/backfill.js";

function transcript(lines: unknown[]): string {
  const file = join(mkdtempSync(join(tmpdir(), "dq-backfill-")), "chat.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

test("backfill reconstructs user, assistant, and tool records; skips thoughts", () => {
  const file = transcript([
    { uuid: "u1", type: "user", message: { role: "user", parts: [{ text: "fix the bug" }] } },
    { uuid: "a1", type: "assistant", message: { role: "model", parts: [{ text: "thinking hard", thought: true }, { text: "I will read the file." }, { functionCall: { id: "c1", name: "read_file", args: { file_path: "x" } } }] } },
    { uuid: "t1", type: "tool_result", message: { role: "user", parts: [{ functionResponse: { id: "c1", name: "read_file", response: { output: "file contents" } } }] } },
    { uuid: "a2", type: "assistant", message: { role: "model", parts: [{ text: "Done." }] } },
    { uuid: "s1", type: "system", message: { parts: [] } },
  ]);
  const updates = backfillTranscript(file);
  const kinds = updates.map((u) => u.sessionUpdate);
  assert.deepEqual(kinds, ["user_message", "agent_message", "tool_call_update", "agent_message"]);
  assert.equal(updates[0]?.messageId, "u-u1");
  assert.equal((updates[1]?.content as { text: string }[])[0]?.text, "I will read the file.");
  assert.equal(updates[2]?.toolCallId, "t-c1");
  assert.equal(updates[2]?.status, "completed");
});

test("backfill tolerates a missing file and torn lines", () => {
  assert.deepEqual(backfillTranscript("/nonexistent/chat.jsonl"), []);
  const file = join(mkdtempSync(join(tmpdir(), "dq-backfill-")), "chat.jsonl");
  writeFileSync(file, '{"uuid":"u1","type":"user","message":{"parts":[{"text":"hi"}]}}\n{"torn\n');
  const updates = backfillTranscript(file);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.sessionUpdate, "user_message");
});

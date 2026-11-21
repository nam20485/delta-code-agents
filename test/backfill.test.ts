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

test("backfill reconstructs user, assistant, and tool records; skips thoughts", async () => {
  const file = transcript([
    { uuid: "u1", type: "user", message: { role: "user", parts: [{ text: "fix the bug" }] } },
    { uuid: "a1", type: "assistant", message: { role: "model", parts: [{ text: "thinking hard", thought: true }, { text: "I will read the file." }, { functionCall: { id: "c1", name: "read_file", args: { file_path: "x" } } }] } },
    { uuid: "t1", type: "tool_result", message: { role: "user", parts: [{ functionResponse: { id: "c1", name: "read_file", response: { output: "file contents" } } }] } },
    { uuid: "a2", type: "assistant", message: { role: "model", parts: [{ text: "Done." }] } },
    { uuid: "s1", type: "system", message: { parts: [] } },
  ]);
  const { updates } = await backfillTranscript(file);
  const kinds = updates.map((u) => u.sessionUpdate);
  assert.deepEqual(kinds, ["user_message", "agent_message", "tool_call_update", "agent_message"]);
  assert.equal(updates[0]?.messageId, "u-u1");
  assert.equal((updates[1]?.content as { text: string }[])[0]?.text, "I will read the file.");
  assert.equal(updates[2]?.toolCallId, "t-c1");
  assert.equal(updates[2]?.status, "completed");
});

test("multiple text parts in one line concatenate into a single record", async () => {
  const file = transcript([
    { uuid: "a1", type: "assistant", message: { role: "model", parts: [{ text: "before" }, { functionCall: { id: "c1", name: "edit", args: {} } }, { text: "after" }] } },
  ]);
  const { updates } = await backfillTranscript(file);
  const messages = updates.filter((u) => u.sessionUpdate === "agent_message");
  assert.equal(messages.length, 1);
  assert.equal((messages[0]?.content as { text: string }[])[0]?.text, "before\nafter");
});

test("backfill keeps the most recent records and flags truncation", async () => {
  const lines = [];
  for (let i = 0; i < 1_500; i++) {
    lines.push({ uuid: `u${i}`, type: "user", message: { parts: [{ text: `msg ${i}` }] } });
  }
  const file = transcript(lines);
  const { updates, truncated } = await backfillTranscript(file);
  assert.equal(truncated, true);
  assert.equal(updates.length, 1_000);
  // The kept records are the MOST RECENT (msg 500..1499), not the oldest.
  assert.equal((updates[0]?.content as { text: string }[])[0]?.text, "msg 500");
  assert.equal((updates[999]?.content as { text: string }[])[0]?.text, "msg 1499");
});

test("a trailing text part after a functionResponse keeps part order", async () => {
  const file = transcript([
    { uuid: "t1", type: "user", message: { parts: [{ functionResponse: { id: "c1", name: "edit", response: { output: "ok" } } }, { text: "status note" }] } },
  ]);
  const { updates } = await backfillTranscript(file);
  assert.deepEqual(updates.map((u) => u.sessionUpdate), ["tool_call_update", "user_message"]);
});

test("backfill tolerates a missing file and torn lines", async () => {
  assert.deepEqual(await backfillTranscript("/nonexistent/chat.jsonl"), { updates: [], truncated: false });
  const file = join(mkdtempSync(join(tmpdir(), "dq-backfill-")), "chat.jsonl");
  writeFileSync(file, '{"uuid":"u1","type":"user","message":{"parts":[{"text":"hi"}]}}\n{"torn\n');
  const { updates } = await backfillTranscript(file);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.sessionUpdate, "user_message");
});

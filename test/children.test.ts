import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChildThreads } from "../src/sidecar/children.js";

function fakeBin(): void {
  const bin = fileURLToPath(new URL("./fake-delta.js", import.meta.url));
  chmodSync(bin, 0o755);
  process.env["DELTA_QWEN_DELTA_BIN"] = bin;
  process.env["FAKE_MODE"] = "ok";
  process.env["FAKE_DISPOSITION"] = "recorded";
  process.env["FAKE_FENCE_SEQ"] = "";
}

function children(dir: string): ChildThreads {
  return new ChildThreads({
    dir,
    parentThreadId: () => "fake-thread",
    externalId: () => "sess",
    generation: () => 0,
    acknowledge: () => "local",
    log: () => {},
  });
}

test("subagent events create a child thread and flush its records", async () => {
  fakeBin();
  const dir = mkdtempSync(join(tmpdir(), "dq-children-"));
  const ct = children(dir);
  await ct.record("ag1", "Explorer", { hook_event_name: "SubagentStart", agent_id: "ag1", agent_type: "Explorer" });
  await ct.record("ag1", "Explorer", { hook_event_name: "MessageDisplay", agent_id: "ag1", message_id: "m1", displayed_text: "searching", is_final: true });
  // Records are queued in the child outbox before the terminal flush.
  assert.ok(statSync(join(dir, "child-0-ag1.jsonl")).size > 0);
  await ct.record("ag1", "Explorer", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "Explorer", last_assistant_message: "found it" });
  assert.deepEqual(ct.references(), ["fake-thread#s=child"]);
  // SubagentStop flushed the outbox: the fake delta acks every record, so the
  // file is drained (deleting the flush call would leave records here).
  assert.equal(statSync(join(dir, "child-0-ag1.jsonl")).size, 0);
  // The child sequence counter persisted (survives a restart).
  const saved = JSON.parse(readFileSync(join(dir, "child-0-ag1.state.json"), "utf8")) as { next_sequence: number };
  assert.ok(saved.next_sequence > 1);
});

test("no parent thread means subagent events are dropped", async () => {
  fakeBin();
  const ct = new ChildThreads({
    dir: mkdtempSync(join(tmpdir(), "dq-children-")),
    parentThreadId: () => "",
    externalId: () => "sess",
    generation: () => 0,
    acknowledge: () => "local",
    log: () => {},
  });
  await ct.record("ag1", "Explorer", { hook_event_name: "SubagentStart", agent_id: "ag1" });
  assert.deepEqual(ct.references(), []);
});

test("concurrent events for one agent create a single child", async () => {
  fakeBin();
  const ct = children(mkdtempSync(join(tmpdir(), "dq-children-")));
  await Promise.all([
    ct.record("ag2", "Bash", { hook_event_name: "MessageDisplay", agent_id: "ag2", message_id: "a", displayed_text: "x", is_final: false }),
    ct.record("ag2", "Bash", { hook_event_name: "MessageDisplay", agent_id: "ag2", message_id: "b", displayed_text: "y", is_final: false }),
  ]);
  assert.equal(ct.references().length, 1);
});

test("distinct agent ids that sanitize alike get distinct outbox files", async () => {
  fakeBin();
  const dir = mkdtempSync(join(tmpdir(), "dq-children-"));
  const ct = children(dir);
  await ct.record("a:b", "Bash", { hook_event_name: "MessageDisplay", agent_id: "a:b", message_id: "a", displayed_text: "x", is_final: true });
  await ct.record("a/b", "Bash", { hook_event_name: "MessageDisplay", agent_id: "a/b", message_id: "b", displayed_text: "y", is_final: true });
  assert.equal(ct.references().length, 2);
  assert.ok(statSync(join(dir, "child-0-a%3Ab.jsonl")).size > 0);
  assert.ok(statSync(join(dir, "child-0-a%2Fb.jsonl")).size > 0);
});

test("a fenced child persists superseded and a restart refuses new content", async () => {
  fakeBin();
  const dir = mkdtempSync(join(tmpdir(), "dq-children-"));
  // Fence the child's first record (the running state_update at sequence 1).
  process.env["FAKE_FENCE_SEQ"] = "1";
  const ct = children(dir);
  await ct.record("ag1", "Explorer", { hook_event_name: "SubagentStart", agent_id: "ag1", agent_type: "Explorer" });
  await ct.record("ag1", "Explorer", { hook_event_name: "MessageDisplay", agent_id: "ag1", message_id: "m1", displayed_text: "hi", is_final: true });
  await ct.record("ag1", "Explorer", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "Explorer", last_assistant_message: "done" });
  const stateFile = join(dir, "child-0-ag1.state.json");
  const saved = JSON.parse(readFileSync(stateFile, "utf8")) as { superseded?: boolean };
  assert.equal(saved.superseded, true);

  // A fresh ChildThreads on the same dir restores the flag and refuses new
  // turn content (a PreToolUse is gated by superseded).
  process.env["FAKE_FENCE_SEQ"] = "";
  const revived = children(dir);
  const outboxFile = join(dir, "child-0-ag1.jsonl");
  const before = statSync(outboxFile).size;
  await revived.record("ag1", "Explorer", { hook_event_name: "PreToolUse", agent_id: "ag1", tool_name: "write_file", tool_use_id: "t9", tool_input: {} });
  assert.equal(statSync(outboxFile).size, before);
});

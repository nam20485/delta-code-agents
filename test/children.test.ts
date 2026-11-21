import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync } from "node:fs";
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

function children(): ChildThreads {
  return new ChildThreads({
    dir: mkdtempSync(join(tmpdir(), "dq-children-")),
    parentThreadId: () => "fake-thread",
    externalId: () => "sess",
    log: () => {},
  });
}

test("subagent events create a child thread and flush its records", async () => {
  fakeBin();
  const ct = children();
  await ct.record("ag1", "Explorer", { hook_event_name: "SubagentStart", agent_id: "ag1", agent_type: "Explorer" });
  await ct.record("ag1", "Explorer", { hook_event_name: "MessageDisplay", agent_id: "ag1", message_id: "m1", displayed_text: "searching", is_final: true });
  await ct.record("ag1", "Explorer", { hook_event_name: "SubagentStop", agent_id: "ag1", agent_type: "Explorer", last_assistant_message: "found it" });
  assert.deepEqual(ct.references(), ["fake-thread#s=child"]);
});

test("no parent thread means subagent events are dropped", async () => {
  fakeBin();
  const ct = new ChildThreads({
    dir: mkdtempSync(join(tmpdir(), "dq-children-")),
    parentThreadId: () => "",
    externalId: () => "sess",
    log: () => {},
  });
  await ct.record("ag1", "Explorer", { hook_event_name: "SubagentStart", agent_id: "ag1" });
  assert.deepEqual(ct.references(), []);
});

test("concurrent events for one agent create a single child", async () => {
  fakeBin();
  const ct = children();
  await Promise.all([
    ct.record("ag2", "Bash", { hook_event_name: "MessageDisplay", agent_id: "ag2", message_id: "a", displayed_text: "x", is_final: false }),
    ct.record("ag2", "Bash", { hook_event_name: "MessageDisplay", agent_id: "ag2", message_id: "b", displayed_text: "y", is_final: false }),
  ]);
  assert.equal(ct.references().length, 1);
});

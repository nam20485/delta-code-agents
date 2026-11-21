import test from "node:test";
import assert from "node:assert/strict";
import {
  agentMessage,
  sessionInfoUpdate,
  stateUpdate,
  toolCallUpdate,
  truncate,
  userMessage,
  wrap,
} from "../src/records.js";

test("builders produce ACP v2 updates", () => {
  assert.deepEqual(userMessage("u-1", "hello"), {
    sessionUpdate: "user_message",
    messageId: "u-1",
    content: [{ type: "text", text: "hello" }],
  });
  assert.deepEqual(userMessage("u-2", "hi", "parent-1")["_meta"], {
    delta: { sender: { external_id: "parent-1" } },
  });
  assert.deepEqual(agentMessage("a-1", "answer"), {
    sessionUpdate: "agent_message",
    messageId: "a-1",
    content: [{ type: "text", text: "answer" }],
  });
  assert.deepEqual(
    toolCallUpdate("t-1", "write_file", "in_progress", '{"file_path":"a"}'),
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "t-1",
      title: "write_file",
      status: "in_progress",
      content: [{ type: "text", text: '{"file_path":"a"}' }],
    },
  );
  assert.equal("content" in toolCallUpdate("t-2", "edit", "completed"), false);
  assert.deepEqual(stateUpdate("running"), { sessionUpdate: "state_update", state: "running" });
  assert.deepEqual(sessionInfoUpdate("probe title"), {
    sessionUpdate: "session_info_update",
    title: "probe title",
  });
});

test("wrap attaches sequence and optional turnSequence", () => {
  assert.deepEqual(wrap(3, stateUpdate("idle")), {
    schemaVersion: 1,
    sequence: 3,
    update: { sessionUpdate: "state_update", state: "idle" },
  });
  assert.deepEqual(wrap(4, stateUpdate("running"), 2).turnSequence, 2);
});

test("truncate bounds long content and titles", () => {
  assert.equal(truncate("abc", 5), "abc");
  assert.equal(truncate("abcdef", 5).length, 5);
  assert.ok(truncate("x".repeat(10_000)).length <= 4_000);
});

test("truncate never splits a surrogate pair", () => {
  // "a" + astral emoji (2 code units) repeated: cutting mid-pair would emit
  // a lone high surrogate before the ellipsis.
  const value = "a" + "\u{1F600}".repeat(10);
  const out = truncate(value, 4);
  assert.ok(!/[\uD800-\uDBFF]$/.test(out.slice(0, -1)), `no trailing lone surrogate: ${JSON.stringify(out)}`);
  assert.ok(out.endsWith("…"));
});

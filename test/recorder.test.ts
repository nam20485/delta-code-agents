import test from "node:test";
import assert from "node:assert/strict";
import { Recorder, type OutboxLike } from "../src/sidecar/recorder.js";
import type { OutboxLine } from "../src/sidecar/outbox.js";
import type { RecordingState } from "../src/sidecar/state.js";

class MemorySink implements OutboxLike {
  readonly lines: OutboxLine[] = [];
  add(line: OutboxLine): void {
    this.lines.push(line);
  }
  get size(): number {
    return this.lines.length;
  }
  async flush(): Promise<never> {
    throw new Error("not used in translation tests");
  }
}

interface Harness {
  recorder: Recorder;
  sink: MemorySink;
  captureCalls: string[];
  saved: number;
}

function harness(): Harness {
  const sink = new MemorySink();
  const captureCalls: string[] = [];
  const recording: RecordingState = {
    enabled: true,
    consent: "granted",
    thread_id: "t",
    next_sequence: 1,
    superseded: false,
    paused: false,
    capture_enabled: true,
    titled: false,
  };
  let saved = 0;
  const recorder = new Recorder({
    outbox: sink,
    recording,
    capture: {
      start: (id, tool) => captureCalls.push(`start:${tool}:${id}`),
      stop: (id, tool) => captureCalls.push(`stop:${tool}:${id}`),
    },
    log: () => {},
    save: () => {
      saved += 1;
    },
  });
  return { recorder, sink, captureCalls, saved };
}

interface Emitted {
  sequence: number;
  turnSequence?: number;
  sessionUpdate: string;
  [key: string]: unknown;
}

function emitted(h: Harness): Emitted[] {
  return h.sink.lines.map((line) => ({
    turnSequence: line.turnSequence,
    ...(line.update as Record<string, unknown>),
    sequence: line.sequence,
  })) as Emitted[];
}

test("a full turn: prompt, streamed reply, tool call, idle", () => {
  const h = harness();
  const r = h.recorder;
  r.record({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p1", submitted_prompt: "fix the bug" });
  r.record({ hook_event_name: "MessageDisplay", session_id: "s", message_id: "m1", displayed_text: "look", is_final: false });
  r.record({ hook_event_name: "MessageDisplay", session_id: "s", message_id: "m1", displayed_text: "looking", is_final: false });
  r.record({ hook_event_name: "MessageDisplay", session_id: "s", message_id: "m1", displayed_text: "looking closer", is_final: true });
  r.record({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "write_file", tool_use_id: "toolu_1", tool_input: { file_path: "a.ts" } });
  r.record({ hook_event_name: "PostToolUse", session_id: "s", tool_name: "write_file", tool_use_id: "toolu_1", tool_response: { ok: true }, duration_ms: 5 });
  r.record({ hook_event_name: "Stop", session_id: "s", last_assistant_message: "done" });

  const out = emitted(h);
  // seq1 running(turn1) / seq2 user_message / seq3 title / 4,5,6 agent stream / 7 tool in_progress
  // 8 tool completed / 9 idle
  assert.deepEqual(
    out.map((e) => [e.sequence, e.turnSequence ?? null, e.sessionUpdate]),
    [
      [1, 1, "state_update"],
      [2, 1, "user_message"],
      [3, null, "session_info_update"],
      [4, 1, "agent_message"],
      [5, 1, "agent_message"],
      [6, 1, "agent_message"],
      [7, 1, "tool_call_update"],
      [8, 1, "tool_call_update"],
      [9, 1, "state_update"],
    ],
  );
  assert.equal(out[1]?.messageId, "u-p1");
  assert.equal(out[3]?.messageId, "a-m1");
  // streaming resends carry cumulative text
  assert.equal(out[3]?.content && (out[3].content as { text: string }[])[0]?.text, "look");
  assert.equal(out[5]?.content && (out[5].content as { text: string }[])[0]?.text, "looking closer");
  assert.equal(out[2]?.title, "fix the bug");
  assert.deepEqual(h.captureCalls, ["start:write_file:t-toolu_1", "stop:write_file:t-toolu_1"]);
});

test("stale MessageDisplay after final is ignored; Stop fallback reuses the id", () => {
  const h = harness();
  const r = h.recorder;
  r.record({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p1", submitted_prompt: "go" });
  r.record({ hook_event_name: "MessageDisplay", session_id: "s", message_id: "m1", displayed_text: "partial", is_final: false });
  // cancelled before final: Stop must reuse a-m1 with the last message text
  r.record({ hook_event_name: "Stop", session_id: "s", last_assistant_message: "full answer" });
  const afterStop = emitted(h).length;
  // a stale late delivery must not resurrect the message after the turn ended
  r.record({ hook_event_name: "MessageDisplay", session_id: "s", message_id: "m1", displayed_text: "stale longer text", is_final: false });
  assert.equal(emitted(h).length, afterStop);

  const out = emitted(h);
  const fallback = out.find((e) => e.sessionUpdate === "agent_message" && e.messageId === "a-m1");
  assert.notEqual(fallback, undefined);
  const texts = out
    .filter((e) => e.sessionUpdate === "agent_message")
    .map((e) => (e.content as { text: string }[])[0]?.text);
  assert.deepEqual(texts, ["partial", "full answer"]);
});

test("final message suppresses the Stop fallback", () => {
  const h = harness();
  h.recorder.record({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p1", submitted_prompt: "go" });
  h.recorder.record({ hook_event_name: "MessageDisplay", session_id: "s", message_id: "m1", displayed_text: "done", is_final: true });
  h.recorder.record({ hook_event_name: "Stop", session_id: "s", last_assistant_message: "done" });
  const agentMessages = emitted(h).filter((e) => e.sessionUpdate === "agent_message");
  assert.equal(agentMessages.length, 1);
});

test("prompt dedupe and second turn get fresh sequences", () => {
  const h = harness();
  const r = h.recorder;
  r.record({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p1", submitted_prompt: "one" });
  r.record({ hook_event_name: "Stop", session_id: "s", last_assistant_message: "" });
  // same prompt_id re-delivered inside a NEW turn must not duplicate
  r.record({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p1", submitted_prompt: "one" });
  r.record({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p2", submitted_prompt: "two" });
  r.record({ hook_event_name: "StopFailure", session_id: "s", error: "rate_limit" });
  const out = emitted(h);
  const users = out.filter((e) => e.sessionUpdate === "user_message");
  assert.equal(users.length, 2);
  const runnings = out.filter((e) => e.sessionUpdate === "state_update" && e.state === "running");
  assert.deepEqual(runnings.map((e) => e.turnSequence), [1, 5]);
  const idles = out.filter((e) => e.sessionUpdate === "state_update" && e.state === "idle");
  assert.equal(idles.length, 2);
  const errorNote = out.find((e) => e.sessionUpdate === "agent_message" && e.messageId === "a-m2");
  assert.equal(errorNote, undefined);
});

test("events before enablement and subagent events are dropped", () => {
  const h = harness();
  const dropped = new Recorder({
    outbox: h.sink,
    recording: { enabled: false, consent: "none", thread_id: "", next_sequence: 1, superseded: false, paused: false, capture_enabled: true, titled: false },
    capture: { start: () => {}, stop: () => {} },
    log: () => {},
    save: () => {},
  });
  dropped.record({ hook_event_name: "UserPromptSubmit", session_id: "s", submitted_prompt: "x" });
  h.recorder.record({ hook_event_name: "SubagentStop", session_id: "s", agent_id: "ag1", last_assistant_message: "sub" });
  h.recorder.record({ hook_event_name: "PreToolUse", session_id: "s", agent_id: "ag1", tool_name: "read_file", tool_use_id: "t9" });
  assert.equal(h.sink.size, 0);
});

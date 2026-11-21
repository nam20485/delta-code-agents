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
  maxPendingSequence(): number {
    let max = 0;
    for (const line of this.lines) if (line.sequence > max) max = line.sequence;
    return max;
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
  recording: RecordingState;
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
  return { recorder, sink, captureCalls, saved, recording };
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

test("fenced supersession stops new turn content but keeps late output", () => {
  const h = harness();
  const r = h.recorder;
  r.record({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p1", submitted_prompt: "turn one" });
  h.recording.superseded = true;
  r.record({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p2", submitted_prompt: "blocked" });
  r.record({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "write_file", tool_use_id: "t8" });
  // Late output for the open turn still records with its original turnSequence.
  r.record({ hook_event_name: "MessageDisplay", session_id: "s", message_id: "m9", displayed_text: "late", is_final: true });
  r.record({ hook_event_name: "Stop", session_id: "s", last_assistant_message: "late done" });
  const out = emitted(h);
  assert.equal(out.filter((e) => e.sessionUpdate === "user_message").length, 1);
  assert.equal(out.filter((e) => e.sessionUpdate === "tool_call_update").length, 0);
  const late = out.find((e) => e.sessionUpdate === "agent_message" && e.messageId === "a-m9");
  assert.notEqual(late, undefined);
  assert.equal(late?.turnSequence, 1);
  assert.equal(out[out.length - 1]?.state, "idle");
});

test("final MessageDisplay without an open turn reopens one; partials do not", () => {
  const h = harness();
  const r = h.recorder;
  r.record({ hook_event_name: "MessageDisplay", session_id: "s", message_id: "m1", displayed_text: "orphan partial", is_final: false });
  assert.equal(h.sink.size, 0);
  r.record({ hook_event_name: "MessageDisplay", session_id: "s", message_id: "m1", displayed_text: "orphan final", is_final: true });
  r.record({ hook_event_name: "Stop", session_id: "s", last_assistant_message: "orphan final" });
  const out = emitted(h);
  assert.deepEqual(
    out.map((e) => [e.sequence, e.turnSequence ?? null, e.sessionUpdate]),
    [
      [1, 1, "state_update"],
      [2, 1, "agent_message"],
      [3, 1, "state_update"],
    ],
  );
});

test("identical prompts without prompt_id both record with distinct ids", () => {
  const h = harness();
  const r = h.recorder;
  r.record({ hook_event_name: "UserPromptSubmit", session_id: "s", submitted_prompt: "again" });
  r.record({ hook_event_name: "Stop", session_id: "s", last_assistant_message: "" });
  r.record({ hook_event_name: "UserPromptSubmit", session_id: "s", submitted_prompt: "again" });
  r.record({ hook_event_name: "Stop", session_id: "s", last_assistant_message: "" });
  const users = emitted(h).filter((e) => e.sessionUpdate === "user_message");
  assert.equal(users.length, 2);
  assert.notEqual(users[0]?.messageId, users[1]?.messageId);
});

test("counter clamp: outbox sequences above the counter win on construction", () => {
  const h = harness();
  void h;
  const sink = new MemorySink();
  sink.add({ sequence: 7, update: { sessionUpdate: "state_update", state: "running" } });
  const recording: RecordingState = {
    enabled: true,
    consent: "granted",
    thread_id: "t",
    next_sequence: 3,
    superseded: false,
    paused: false,
    capture_enabled: true,
    titled: false,
  };
  const r = new Recorder({
    outbox: sink,
    recording,
    capture: { start: () => {}, stop: () => {} },
    log: () => {},
    save: () => {},
  });
  assert.equal(recording.next_sequence, 8); // clamped above the pending 7
  r.record({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p1", submitted_prompt: "x" });
  const seqs = sink.lines.slice(1).map((l) => l.sequence);
  assert.deepEqual(seqs, [8, 9, 10]);
});

test("stop failure note uses a distinct id so the partial reply survives", () => {
  const h = harness();
  const r = h.recorder;
  r.record({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p1", submitted_prompt: "go" });
  r.record({ hook_event_name: "MessageDisplay", session_id: "s", message_id: "m1", displayed_text: "partial answer", is_final: false });
  r.record({ hook_event_name: "StopFailure", session_id: "s", error: "rate_limit" });
  const out = emitted(h);
  const partial = out.find((e) => e.sessionUpdate === "agent_message" && e.messageId === "a-m1");
  const note = out.find((e) => e.sessionUpdate === "agent_message" && e.messageId === "a-error-1");
  assert.notEqual(partial, undefined);
  assert.notEqual(note, undefined);
  assert.equal((partial?.content as { text: string }[])[0]?.text, "partial answer");
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

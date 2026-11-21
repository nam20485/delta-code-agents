import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { startRouter } from "../src/router/router.js";
import { loadState } from "../src/sidecar/state.js";

process.env["DELTA_QWEN_HOME"] = mkdtempSync(join(tmpdir(), "dq-sidecar-it-"));
process.env["DELTA_QWEN_ROUTER_PORT"] = "0";
process.env["DELTA_QWEN_DELTA_BIN"] = fileURLToPath(new URL("./fake-delta.js", import.meta.url));
chmodSync(process.env["DELTA_QWEN_DELTA_BIN"], 0o755);
process.env["FAKE_MODE"] = "ok";
process.env["FAKE_DISPOSITION"] = "recorded";
process.env["FAKE_FENCE_SEQ"] = "";

const home = process.env["DELTA_QWEN_HOME"]!;
const sessionDir = join(home, "sessions", "it-1");

async function post(port: number, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, unknown>;
}

async function sidecarPost(path: string, body: unknown): Promise<Record<string, unknown>> {
  const state = loadState(sessionDir);
  assert.notEqual(state, null);
  const res = await fetch(`http://127.0.0.1:${state!.port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${state!.token}`,
    },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, unknown>;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(100);
  }
  return predicate();
}

function sidecarPid(): number | null {
  try {
    // Compiled entry is dist/src/sidecar/server.js; SessionStart spawns
    // carry --revive, so anchor on the session id with an optional flag.
    const out = execFileSync("pgrep", ["-f", `sidecar/server\.js it-1( --revive)?$`], {
      encoding: "utf8",
    }).trim();
    const first = out.split("\n")[0];
    return first === undefined || first.length === 0 ? null : Number.parseInt(first, 10);
  } catch {
    return null;
  }
}

test("share, kill/respawn continuity, clear, and retention", async () => {
  const { port, server } = await startRouter();
  try {
    // Bootstrap the session; owner is this test process.
    await post(port, {
      session_id: "it-1",
      hook_event_name: "SessionStart",
      source: "startup",
      cwd: home,
      delta_qwen_pid: process.pid,
    });
    assert.notEqual(loadState(sessionDir), null);

    // Consent two-step, then share (fake delta serves create/share/adopt).
    const gate = await sidecarPost("/share", { confirm: false });
    assert.equal(gate["status"], "consent_required");
    const shared = await sidecarPost("/share", { confirm: true });
    assert.equal(shared["status"], "shared");
    assert.equal(shared["thread_id"], "fake-thread");

    // A recorded turn; the fake CLI drains every receipt.
    await post(port, { session_id: "it-1", hook_event_name: "UserPromptSubmit", prompt_id: "p1", submitted_prompt: "hello" });
    await post(port, { session_id: "it-1", hook_event_name: "PreToolUse", tool_name: "write_file", tool_use_id: "t1", tool_input: { file_path: "a" } });
    await post(port, { session_id: "it-1", hook_event_name: "MessageDisplay", message_id: "m1", displayed_text: "hi", is_final: true });
    await post(port, { session_id: "it-1", hook_event_name: "Stop", last_assistant_message: "hi" });
    assert.ok(await waitFor(() => (loadState(sessionDir)?.recording?.next_sequence ?? 0) > 4, 5_000));
    const afterTurn = loadState(sessionDir)!;
    // The capture subprocess is fire-and-forget; wait for the disable.
    assert.ok(
      await waitFor(() => loadState(sessionDir)?.recording?.capture_enabled === false, 5_000),
      "capture disable should fire after invalid_identity",
    );
    const seqAfterTurn = afterTurn.recording!.next_sequence;

    // Re-sharing now surfaces the capture warning (disable already fired).
    const resharded = await sidecarPost("/share", { confirm: true });
    assert.equal(resharded["status"], "shared");
    assert.match(String(resharded["warning"]), /unattributed/);

    // Kill the sidecar; the next event must respawn it with state intact.
    const pid = sidecarPid();
    assert.notEqual(pid, null);
    process.kill(pid!, "SIGKILL");
    assert.ok(await waitFor(() => sidecarPid() === null, 5_000));
    await post(port, { session_id: "it-1", hook_event_name: "UserPromptSubmit", prompt_id: "p2", submitted_prompt: "second" });
    await post(port, { session_id: "it-1", hook_event_name: "Stop", last_assistant_message: "" });
    assert.ok(
      await waitFor(
        () => (loadState(sessionDir)?.recording?.next_sequence ?? 0) > seqAfterTurn + 1,
        10_000,
      ),
    );
    const resumed = loadState(sessionDir)!;
    assert.equal(resumed.recording?.thread_id, "fake-thread");
    assert.equal(resumed.recording?.consent, "granted");
    assert.equal(resumed.session_id, "it-1");

    // `/clear` is a conversation reset, not an exit: the sidecar survives.
    const pidBeforeClear = sidecarPid();
    await post(port, { session_id: "it-1", hook_event_name: "SessionEnd", reason: "clear" });
    await delay(500);
    assert.notEqual(sidecarPid(), null);
    assert.equal(loadState(sessionDir)?.ended_at, undefined);
    void pidBeforeClear;

    // A real SessionEnd tears down but RETAINS the recording session dir.
    await post(port, { session_id: "it-1", hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
    assert.ok(await waitFor(() => sidecarPid() === null, 5_000));
    const ended = loadState(sessionDir);
    assert.notEqual(ended, null);
    assert.notEqual(ended!.ended_at, undefined);
    assert.equal(ended!.recording?.enabled, true);
  } finally {
    server.close();
    server.closeAllConnections();
    const pid = sidecarPid();
    if (pid !== null) process.kill(pid, "SIGKILL");
  }
});

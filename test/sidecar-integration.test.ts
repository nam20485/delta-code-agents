import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

function sidecarPid(sessionId = "it-1"): number | null {
  try {
    // Compiled entry is dist/src/sidecar/server.js; SessionStart spawns
    // carry --revive, so anchor on the session id with an optional flag.
    const out = execFileSync("pgrep", ["-f", `sidecar/server\\.js ${sessionId}( --revive)?$`], {
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
    assert.ok(await waitFor(() => (loadState(sessionDir)?.port ?? 0) > 0, 10_000), "sidecar should come up");

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

test("watch inbox injection, supersession deny, and mount swap", async () => {
  const framesFile = join(home, "watch-frames.jsonl");
  writeFileSync(
    framesFile,
    [
      JSON.stringify({ type: "ready", thread_id: "fake-thread", producer: null }),
      JSON.stringify({ type: "item", item: { id: "r1", kind: "agent_message", after_id: null, author: { name: "Ada" }, content: { text: "I fixed the parser on my side" } } }),
      JSON.stringify({ type: "live" }),
      JSON.stringify({ type: "worktrees", worktrees: [{ reference: "wt-ref#t=2", name: "delta" }] }),
      JSON.stringify({ type: "producer.turn", sequence: 1, status: "superseded" }),
    ].join("\n") + "\n",
  );
  process.env["FAKE_WATCH_FRAMES"] = framesFile;
  const dir2 = join(home, "sessions", "it-2");
  const { port, server } = await startRouter();
  try {
    await post(port, { session_id: "it-2", hook_event_name: "SessionStart", source: "startup", cwd: home, delta_qwen_pid: process.pid });
    const state2 = () => loadState(dir2);
    assert.ok(await waitFor(() => (state2()?.port ?? 0) > 0, 10_000), "sidecar should come up");
    const sc2 = async (path: string, body: unknown) => {
      const st = state2()!;
      const res = await fetch(`http://127.0.0.1:${st.port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${st.token}` },
        body: JSON.stringify(body),
      });
      return (await res.json()) as Record<string, unknown>;
    };
    assert.equal((await sc2("/share", { confirm: true }))["status"], "shared");

    // Watcher delivers Ada's item and the superseded frame.
    assert.ok(await waitFor(() => state2()?.recording?.superseded === true, 8_000), "superseded frame should land");

    // Supersession gate: while superseded (before any reclaiming prompt),
    // PreToolUse is denied with a reason.
    const denyRes = await post(port, { session_id: "it-2", hook_event_name: "PreToolUse", tool_name: "write_file", tool_use_id: "t9", tool_input: {} });
    const deny = denyRes["hookSpecificOutput"] as { permissionDecision?: string; permissionDecisionReason?: string } | undefined;
    assert.equal(deny?.permissionDecision, "deny");
    assert.match(String(deny?.permissionDecisionReason), /took over/);

    // worktrees frame swapped the thread mount.
    const log = readFileSync(join(dir2, "sidecar.log"), "utf8");
    assert.match(log, /swapped thread mount after worktrees change/);

    // A user prompt carries the pending teammate activity as additionalContext
    // with a unique delivery id, and reclaims the thread (clears supersession).
    const promptRes = await post(port, { session_id: "it-2", hook_event_name: "UserPromptSubmit", prompt_id: "p1", submitted_prompt: "what changed?" });
    const hookOut = promptRes["hookSpecificOutput"] as { additionalContext?: string } | undefined;
    assert.notEqual(hookOut, undefined);
    assert.match(String(hookOut?.additionalContext), /Ada: I fixed the parser/);
    assert.match(String(hookOut?.additionalContext), /delivery="d-/);
    const readLog = () => readFileSync(join(dir2, "sidecar.log"), "utf8");
    assert.ok(await waitFor(() => readLog().includes("user reclaimed the turn"), 5_000));
    assert.equal(state2()?.recording?.superseded, false);

    // Supersession cleared: a tool call is no longer denied (Delta would
    // re-fence the next append if the teammate still owned the thread).
    const reclaimTool = await post(port, { session_id: "it-2", hook_event_name: "PreToolUse", tool_name: "read_file", tool_use_id: "t10", tool_input: {} });
    assert.equal(reclaimTool["hookSpecificOutput"], undefined);

    // A second prompt does not re-inject the already-delivered item.
    const promptRes2 = await post(port, { session_id: "it-2", hook_event_name: "UserPromptSubmit", prompt_id: "p2", submitted_prompt: "anything else?" });
    assert.equal(promptRes2["hookSpecificOutput"], undefined);

    await post(port, { session_id: "it-2", hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
    assert.ok(await waitFor(() => sidecarPid("it-2") === null, 5_000));
  } finally {
    delete process.env["FAKE_WATCH_FRAMES"];
    server.close();
    server.closeAllConnections();
    const pid = sidecarPid("it-2");
    if (pid !== null) process.kill(pid, "SIGKILL");
  }
});

test("setup policy, join, pause, unshare, inbox, and clear split", async () => {
  const dir3 = join(home, "sessions", "it-3");
  const { port, server } = await startRouter();
  try {
    await post(port, { session_id: "it-3", hook_event_name: "SessionStart", source: "startup", cwd: home, delta_qwen_pid: process.pid });
    const state3 = () => loadState(dir3);
    assert.ok(await waitFor(() => (state3()?.port ?? 0) > 0, 10_000));
    const sc3 = async (path: string, body?: unknown, method: "POST" | "GET" = "POST") => {
      const st = state3()!;
      const res = await fetch(`http://127.0.0.1:${st.port}${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${st.token}` },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return (await res.json()) as Record<string, unknown>;
    };

    // setup team grants consent and auto-shares.
    const setup = await sc3("/setup", { mode: "team" });
    assert.equal(setup["status"], "shared");
    assert.equal(state3()?.recording?.enabled, true);
    assert.equal(state3()?.recording?.consent, "granted");
    assert.equal(state3()?.recording?.thread_id, "fake-thread");
    assert.equal(existsSync(join(home, ".delta", "settings.json")), true);

    // inbox peek (no remote activity yet).
    const inbox = await sc3("/inbox", undefined, "GET");
    assert.equal(inbox["pending"], 0);

    // join mounts the thread's checkout and returns the directory.
    const joined = await sc3("/join", { link: "https://delta.dev/join/fake" });
    assert.equal(joined["status"], "joined");
    assert.equal(joined["directory"], "/tmp/fake-join-checkout");

    // unshare makes the thread private.
    const unshared = await sc3("/unshare", {});
    assert.equal(unshared["status"], "shared");

    // pause disables recording but keeps the thread id.
    const paused = await sc3("/pause", {});
    assert.equal(paused["status"], "shared");
    assert.equal(state3()?.recording?.enabled, false);
    assert.equal(state3()?.recording?.thread_id, "fake-thread");

    // /clear splits into a fresh external id; the team policy then auto-starts
    // recording on the new thread.
    await post(port, { session_id: "it-3", hook_event_name: "SessionStart", source: "clear", cwd: home, delta_qwen_pid: process.pid });
    assert.ok(await waitFor(() => state3()?.external_id === "it-3-c1", 5_000));
    assert.ok(await waitFor(() => state3()?.recording?.enabled === true, 5_000));
    assert.equal(state3()?.external_id, "it-3-c1");

    await post(port, { session_id: "it-3", hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
    assert.ok(await waitFor(() => sidecarPid("it-3") === null, 5_000));
  } finally {
    server.close();
    server.closeAllConnections();
    const pid = sidecarPid("it-3");
    if (pid !== null) process.kill(pid, "SIGKILL");
  }
});

test("enable passes organization and visibility private to thread create", async () => {
  const argsFile = join(home, "fake-args.jsonl");
  process.env["FAKE_ARGS_FILE"] = argsFile;
  const dirF = join(home, "sessions", "it-flags");
  const { port, server } = await startRouter();
  try {
    await post(port, { session_id: "it-flags", hook_event_name: "SessionStart", source: "startup", cwd: home, delta_qwen_pid: process.pid });
    assert.ok(await waitFor(() => (loadState(dirF)?.port ?? 0) > 0, 10_000));
    const st = loadState(dirF)!;
    const res = await fetch(`http://127.0.0.1:${st.port}/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${st.token}` },
      body: JSON.stringify({ mode: "private" }),
    });
    assert.equal(((await res.json()) as Record<string, unknown>)["status"], "shared");
    // The fake records every invocation's args; the create must carry the
    // upload-intent flags (dropping them would regress private-mode flush).
    const calls = readFileSync(argsFile, "utf8").split("\n").filter((l) => l.startsWith("[")).map((l) => JSON.parse(l) as string[]);
    const create = calls.find((a) => a[0] === "thread" && a[1] === "create");
    assert.notEqual(create, undefined);
    const oi = create!.indexOf("--organization");
    assert.ok(oi !== -1 && create![oi + 1] === "org_fake");
    const vi = create!.indexOf("--visibility");
    assert.ok(vi !== -1 && create![vi + 1] === "private");
    await post(port, { session_id: "it-flags", hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
    assert.ok(await waitFor(() => sidecarPid("it-flags") === null, 5_000));
  } finally {
    delete process.env["FAKE_ARGS_FILE"];
    server.close();
    server.closeAllConnections();
    const pid = sidecarPid("it-flags");
    if (pid !== null) process.kill(pid, "SIGKILL");
  }
});

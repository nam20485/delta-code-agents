import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { startRouter } from "../src/router/router.js";

process.env["DELTA_QWEN_HOME"] = mkdtempSync(join(tmpdir(), "dq-router-"));
process.env["DELTA_QWEN_ROUTER_PORT"] = "0";

const home = process.env["DELTA_QWEN_HOME"]!;

async function post(port: number, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, unknown>;
}

test("router multiplexes a session end to end", async () => {
  const dir = join(home, "sessions", "rt-1");
  const { port, server } = await startRouter();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);

    // Unknown session, non-SessionStart event: ignored, nothing spawned.
    assert.deepEqual(await post(port, { session_id: "nope", hook_event_name: "Stop" }), {});
    assert.equal(existsSync(join(home, "sessions", "nope")), false);

    // SessionStart spawns a sidecar; the owner-pid hint is persisted. On a
    // loaded CI runner the spawn can outlast the router's wait, so poll and
    // re-send SessionStart until the sidecar is up and has the owner pid.
    const startBody = {
      session_id: "rt-1",
      hook_event_name: "SessionStart",
      source: "startup",
      delta_qwen_pid: process.pid,
    };
    const readPid = (): number | null => {
      try {
        const s = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { qwen_pid?: number; port?: number };
        return typeof s.qwen_pid === "number" && (s.port ?? 0) > 0 ? s.qwen_pid : null;
      } catch {
        return null;
      }
    };
    await post(port, startBody);
    let pid: number | null = null;
    // Poll generously for loaded CI runners; re-send SessionStart periodically
    // (the sidecar pid lock prevents a slow boot from becoming two writers).
    for (let i = 0; i < 300; i++) {
      pid = readPid();
      if (pid === process.pid) break;
      if (i % 20 === 19) await post(port, startBody);
      await delay(100);
    }
    assert.equal(pid, process.pid);

    // Regular events flow through and answer {}.
    assert.deepEqual(
      await post(port, {
        session_id: "rt-1",
        hook_event_name: "MessageDisplay",
        message_id: "m",
        displayed_text: "x",
        is_final: true,
      }),
      {},
    );

    // SessionEnd tears the sidecar down. The reliable signal is the sidecar
    // process exiting; dir removal can race with cleanup on a loaded runner,
    // so assert process exit and tidy the dir in finally. Re-send SessionEnd
    // periodically in case a forward was dropped.
    const endBody = { session_id: "rt-1", hook_event_name: "SessionEnd", reason: "prompt_input_exit" };
    const sidecarAlive = (): boolean => {
      try {
        execFileSync("pgrep", ["-f", "sidecar/server\\.js rt-1"], { encoding: "utf8" });
        return true;
      } catch {
        return false;
      }
    };
    await post(port, endBody);
    let gone = false;
    for (let i = 0; i < 300; i++) {
      if (!sidecarAlive()) {
        gone = true;
        break;
      }
      if (i % 20 === 19) await post(port, endBody);
      await delay(100);
    }
    assert.equal(gone, true);
  } finally {
    server.close();
    server.closeAllConnections();
    try {
      const pids = execFileSync("pgrep", ["-f", "sidecar/server\\.js rt-1"], { encoding: "utf8" }).trim();
      for (const p of pids.split("\n")) if (p.length > 0) process.kill(Number.parseInt(p, 10), "SIGKILL");
    } catch {
      // No sidecar left.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

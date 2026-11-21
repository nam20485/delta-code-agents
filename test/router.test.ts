import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
  const { port, server } = await startRouter();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);

    // Unknown session, non-SessionStart event: ignored, nothing spawned.
    assert.deepEqual(await post(port, { session_id: "nope", hook_event_name: "Stop" }), {});
    assert.equal(existsSync(join(home, "sessions", "nope")), false);

    // SessionStart spawns a sidecar; the owner-pid hint is persisted.
    assert.deepEqual(
      await post(port, {
        session_id: "rt-1",
        hook_event_name: "SessionStart",
        source: "startup",
        delta_qwen_pid: process.pid,
      }),
      {},
    );
    const dir = join(home, "sessions", "rt-1");
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as {
      qwen_pid?: number;
    };
    assert.equal(state.qwen_pid, process.pid);

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

    // SessionEnd tears the sidecar and its state dir down.
    await post(port, { session_id: "rt-1", hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
    for (let i = 0; i < 50 && existsSync(dir); i++) {
      await delay(100);
    }
    assert.equal(existsSync(dir), false);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

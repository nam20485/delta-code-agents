import { spawn } from "node:child_process";
import { closeSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ensureLauncher } from "./lib/launcher.js";
import { ensureDir, readJson } from "./lib/fsx.js";
import { findQwenPid, pidAlive } from "./lib/proc.js";
import { sessionDir } from "./lib/paths.js";

const REQUEST_TIMEOUT_MS = 2_000;
const SPAWN_WAIT_MS = 2_500;
const HEALTH_POLL_MS = 100;
const HEALTH_PROBE_TIMEOUT_MS = 500;

interface Endpoint {
  port: number;
  token: string;
  qwenPid: number | null;
}

interface SessionStateFile {
  port?: unknown;
  token?: unknown;
  qwen_pid?: unknown;
}

function readEndpoint(dir: string): Endpoint | null {
  const state = readJson<SessionStateFile>(join(dir, "state.json"));
  if (state === null) return null;
  const { port, token } = state;
  if (typeof port !== "number" || typeof token !== "string" || port <= 0) return null;
  return {
    port,
    token,
    qwenPid: typeof state.qwen_pid === "number" ? state.qwen_pid : null,
  };
}

async function healthy(endpoint: Endpoint): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${endpoint.port}/health`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(dir: string, timeoutMs: number): Promise<Endpoint | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const endpoint = readEndpoint(dir);
    if (endpoint !== null && (await healthy(endpoint))) return endpoint;
    if (Date.now() >= deadline) return null;
    await delay(HEALTH_POLL_MS);
  }
}

function tryLock(path: string): boolean {
  try {
    closeSync(openSync(path, "wx", 0o600));
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a healthy sidecar exists for the session. Only `SessionStart`
 * bootstraps a session with no state; any event may restart a down sidecar.
 * Spawning is guarded by an exclusive lock file so parallel hook dispatchers
 * cannot start two sidecars.
 */
async function ensureSidecar(
  dir: string,
  sessionId: string,
  eventName: unknown,
): Promise<Endpoint | null> {
  const existing = readEndpoint(dir);
  if (existing !== null && (await healthy(existing))) return existing;
  if (existing === null && eventName !== "SessionStart") return null;

  // The sidecar creates its own state dir, but the lock below needs it first.
  ensureDir(dir);
  const lockPath = join(dir, "spawn.lock");
  let haveLock = tryLock(lockPath);
  if (!haveLock) {
    // Another dispatcher is mid-spawn; wait it out instead of racing.
    const endpoint = await waitForHealth(dir, SPAWN_WAIT_MS);
    if (endpoint !== null) return endpoint;
    try {
      unlinkSync(lockPath);
    } catch {
      return null;
    }
    haveLock = tryLock(lockPath);
    if (!haveLock) return null;
  }
  try {
    const sidecarJs = fileURLToPath(new URL("./sidecar/server.js", import.meta.url));
    // Fully detached: new session/process group, no inherited pipes, unref'd —
    // Qwen's async-hook process-tree reclamation on exit cannot reach it.
    const child = spawn(process.execPath, [sidecarJs, sessionId], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return await waitForHealth(dir, SPAWN_WAIT_MS);
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already removed.
    }
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY === true) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

/**
 * Hook dispatcher: forward one Qwen hook event to the session sidecar.
 *
 * Failure policy (plan, "Hook dispatcher"): fail open, always exit 0, never
 * print on failure — exit 2 would block the tool. Only a sidecar response
 * with content (supersession deny, inbox context) is printed.
 */
async function main(): Promise<number> {
  const raw = await readStdin();
  let event: Record<string, unknown>;
  try {
    event = raw.trim().length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return 0;
  }
  const sessionId = event["session_id"];
  if (typeof sessionId !== "string" || sessionId.length === 0) return 0;
  let dir: string;
  try {
    dir = sessionDir(sessionId);
  } catch {
    return 0;
  }
  try {
    ensureLauncher(fileURLToPath(import.meta.url));
  } catch {
    // Launcher upkeep is best-effort.
  }
  const endpoint = await ensureSidecar(dir, sessionId, event["hook_event_name"]);
  if (endpoint === null) return 0;

  let qwenPid = endpoint.qwenPid;
  if (qwenPid === null || !pidAlive(qwenPid)) {
    qwenPid = findQwenPid(process.pid);
  }
  const payload = {
    ...event,
    delta_dispatcher_pid: process.pid,
    delta_qwen_pid: qwenPid,
  };
  try {
    const res = await fetch(`http://127.0.0.1:${endpoint.port}/event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${endpoint.token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return 0;
    const text = await res.text();
    if (text.trim().length === 0) return 0;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return 0;
    }
    if (Object.keys(body).length > 0) {
      process.stdout.write(`${JSON.stringify(body)}\n`);
    }
  } catch {
    // Fail open.
  }
  return 0;
}

void main()
  .then((code) => process.exit(code))
  .catch(() => process.exit(0));

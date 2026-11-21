import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ensureDir, atomicWriteJson, readJson } from "../lib/fsx.js";
import { deltaRoot, sessionDir } from "../lib/paths.js";

/** Must match the URL hardcoded in `qwen-extension.json` http hooks. */
export const DEFAULT_ROUTER_PORT = 47631;

const FORWARD_TIMEOUT_MS = 1_500;
const SPAWN_WAIT_MS = 2_500;
const POLL_MS = 100;
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const IDLE_EXIT_MS = 10 * 60_000;
const IDLE_POLL_MS = 30_000;

const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

/** Manifest/manifest-override port. `0` (tests) listens ephemerally. */
export function routerPort(): number {
  const raw = process.env["DELTA_QWEN_ROUTER_PORT"];
  if (raw === undefined || raw.length === 0) return DEFAULT_ROUTER_PORT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : DEFAULT_ROUTER_PORT;
}

interface SidecarEndpoint {
  port: number;
  token: string;
}

function readSidecarEndpoint(dir: string): SidecarEndpoint | null {
  const state = readJson<{ port?: unknown; token?: unknown }>(join(dir, "state.json"));
  if (state === null) return null;
  const { port, token } = state;
  if (typeof port !== "number" || typeof token !== "string" || port <= 0) return null;
  return { port, token };
}

async function endpointAlive(endpoint: SidecarEndpoint): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${endpoint.port}/health`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(300),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Wait for a *serving* sidecar endpoint in `state.json` — not just a present
 * one: a dead sidecar's stale port lingers in the file until its replacement
 * rewrites it, and forwarding to it would only fail again.
 */
async function waitForEndpoint(
  dir: string,
  timeoutMs: number,
  dead?: SidecarEndpoint,
): Promise<SidecarEndpoint | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const endpoint = readSidecarEndpoint(dir);
    if (
      endpoint !== null &&
      (dead === undefined || endpoint.port !== dead.port) &&
      (await endpointAlive(endpoint))
    ) {
      return endpoint;
    }
    if (Date.now() >= deadline) return null;
    await delay(POLL_MS);
  }
}

function spawnSidecar(sessionId: string, dir: string, revive = false): void {
  ensureDir(dir);
  const sidecarJs = fileURLToPath(new URL("../sidecar/server.js", import.meta.url));
  // Fully detached so nothing in Qwen's or the router's lifecycle reaps it.
  // --revive lets an explicit SessionStart resurrect an ended session's
  // state; other events never do.
  const args = revive ? [sidecarJs, sessionId, "--revive"] : [sidecarJs, sessionId];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

type ForwardKind = "ok" | "timeout" | "unreachable";

/** POST the event to the session sidecar. `timeout` means the sidecar is
 * alive but busy (do NOT respawn it); `unreachable` means it is gone. */
async function forward(
  endpoint: SidecarEndpoint,
  event: Record<string, unknown>,
): Promise<{ kind: ForwardKind; body: unknown }> {
  try {
    const res = await fetch(`http://127.0.0.1:${endpoint.port}/event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${endpoint.token}`,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    if (!res.ok) return { kind: "ok", body: {} };
    const text = await res.text();
    if (text.trim().length === 0) return { kind: "ok", body: {} };
    try {
      return { kind: "ok", body: JSON.parse(text) as unknown };
    } catch {
      return { kind: "ok", body: {} };
    }
  } catch (err) {
    // Only an actual deadline is "busy". Connection resets, terminated
    // sockets, and unknown transport errors mean the sidecar may be gone;
    // treating them as busy would drop the event without any respawn.
    return {
      kind: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "unreachable",
      body: {},
    };
  }
}

export class Router {
  private lastActivity = Date.now();
  private readonly logFile = join(deltaRoot(), "router.log");
  /** One delivery chain per session: concurrent events must not race the
   * respawn decision or spawn two sidecar writers on one state dir. */
  private readonly chains = new Map<string, Promise<unknown>>();

  log(line: string): void {
    void appendFile(this.logFile, `${new Date().toISOString()} ${line}\n`).catch(() => {});
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  /**
   * Deliver one hook event. Returns the sidecar's hook response, or `{}` on
   * any failure — Qwen treats a non-2xx http hook as a non-blocking failure,
   * but we still answer 200 with an empty object so nothing degrades.
   * Events for one session are serialized; sessions are independent.
   */
  handleEvent(event: Record<string, unknown>): Promise<unknown> {
    const sessionId = event["session_id"];
    const key = typeof sessionId === "string" ? sessionId : "invalid";
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.handleEventInner(event));
    this.chains.set(key, next);
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
    return next;
  }

  private async handleEventInner(event: Record<string, unknown>): Promise<unknown> {
    const sessionId = event["session_id"];
    if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return {};
    const name = event["hook_event_name"];
    let dir: string;
    try {
      dir = sessionDir(sessionId);
    } catch {
      return {};
    }

    let endpoint = readSidecarEndpoint(dir);
    if (endpoint === null) {
      // Unknown session: only SessionStart starts recording. A retained
      // ended session revives only on an explicit SessionStart (resume),
      // never on a stray late event for a dead owner.
      if (name !== "SessionStart") return {};
      spawnSidecar(sessionId, dir, true);
      endpoint = await waitForEndpoint(dir, SPAWN_WAIT_MS);
      if (endpoint === null) {
        this.log(`sidecar spawn failed for ${sessionId}`);
        return {};
      }
      this.log(`spawned sidecar for ${sessionId}`);
    }

    const first = await forward(endpoint, event);
    if (first.kind === "ok") return first.body;
    if (first.kind === "timeout") {
      // The sidecar is alive but busy (e.g. flushing). Respawning here would
      // create a second writer on the same state; fail open instead.
      this.log(`sidecar for ${sessionId} busy; dropping event ${String(name)}`);
      return {};
    }

    // Unreachable: respawn once (single writer, no race) and wait for the
    // replacement to actually serve before retrying — state.json still names
    // the dead port until the new sidecar rewrites it.
    this.log(`sidecar for ${sessionId} unreachable; respawning`);
    spawnSidecar(sessionId, dir, name === "SessionStart");
    const revived = await waitForEndpoint(dir, SPAWN_WAIT_MS, endpoint);
    if (revived === null) return {};
    const retry = await forward(revived, event);
    return retry.kind === "ok" ? retry.body : {};
  }

  async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.touch();
    try {
      const url = req.url ?? "/";
      if (req.method === "GET" && url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && url === "/event") {
        const body = await readBody(req);
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        } catch {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
          return;
        }
        const response = await this.handleEvent(event);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(response === null ? "{}" : JSON.stringify(response));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    } catch {
      try {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      } catch {
        // Socket already gone.
      }
    }
  }

  startIdleExit(): NodeJS.Timeout {
    const timer = setInterval(() => {
      if (Date.now() - this.lastActivity > IDLE_EXIT_MS) {
        this.log("idle exit");
        process.exit(0);
      }
    }, IDLE_POLL_MS);
    timer.unref();
    return timer;
  }
}

export interface RouterState {
  version: 1;
  port: number;
  pid: number;
  started_at: string;
}

export async function startRouter(): Promise<{ router: Router; port: number; server: Server }> {
  ensureDir(deltaRoot());
  const router = new Router();
  const server = createServer((req, res) => {
    void router.route(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(routerPort(), "127.0.0.1", () => {
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const state: RouterState = {
    version: 1,
    port,
    pid: process.pid,
    started_at: new Date().toISOString(),
  };
  atomicWriteJson(join(deltaRoot(), "router.json"), state);
  router.log(`listening on 127.0.0.1:${port}`);
  router.startIdleExit();
  process.on("SIGTERM", () => {
    router.log("sigterm");
    process.exit(0);
  });
  return { router, port, server };
}

const invokedAsMain = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
})();

if (invokedAsMain) {
  startRouter().catch((err: unknown) => {
    process.stderr.write(`router failed: ${String(err)}\n`);
    process.exit(1);
  });
}

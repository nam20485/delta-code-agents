import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { appendFile } from "node:fs/promises";
import { readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { ensureDir } from "../lib/fsx.js";
import { pidAlive } from "../lib/proc.js";
import { sessionDir, sessionsRoot } from "../lib/paths.js";
import { loadState, newState, saveState, type SessionState } from "./state.js";

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const OWNER_POLL_MS = 2_000;
const OWNER_UNKNOWN_GRACE_MS = 60 * 60_000;
const OWNER_DEAD_GRACE_MS = 15 * 60_000;
const ENDED_GRACE_MS = 60_000;

interface HookEventPayload {
  [key: string]: unknown;
}

export interface HookResponse {
  [key: string]: unknown;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return undefined;
  return header.startsWith("Bearer ") ? header.slice(7) : undefined;
}

function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
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

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

export class Sidecar {
  readonly dir: string;
  state: SessionState;
  private shuttingDown = false;
  private ownerTimer: NodeJS.Timeout | null = null;
  private readonly startedAt = new Date().toISOString();

  constructor(state: SessionState, dir: string) {
    this.state = state;
    this.dir = dir;
  }

  log(line: string): void {
    void appendFile(join(this.dir, "sidecar.log"), `${new Date().toISOString()} ${line}\n`).catch(
      () => {},
    );
  }

  async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = req.url ?? "/";
      if (req.method === "GET" && url === "/health") {
        if (!tokenMatches(this.state.token, bearerToken(req))) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          session_id: this.state.session_id,
          started_at: this.startedAt,
        });
        return;
      }
      if (req.method === "POST" && url === "/event") {
        if (!tokenMatches(this.state.token, bearerToken(req))) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        const body = await readBody(req);
        let event: HookEventPayload;
        try {
          event = JSON.parse(body.toString("utf8")) as HookEventPayload;
        } catch {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        sendJson(res, 200, await this.handleEvent(event));
        return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch {
      try {
        sendJson(res, 500, { error: "internal" });
      } catch {
        // Socket already gone.
      }
    }
  }

  async handleEvent(event: HookEventPayload): Promise<HookResponse> {
    const pidHint = event["delta_qwen_pid"];
    if (this.state.qwen_pid === null && typeof pidHint === "number") {
      this.state.qwen_pid = pidHint;
      saveState(this.dir, this.state);
      this.log(`owner pid ${pidHint}`);
    }
    const name =
      typeof event["hook_event_name"] === "string"
        ? (event["hook_event_name"] as string)
        : "unknown";
    this.log(`event ${name}`);
    // M2 translates events into Delta records here (recorder, outbox, mounts,
    // watch). M1 only proves the pipe and the lifecycle.
    if (name === "SessionEnd") {
      this.shutdown("session end");
    }
    return {};
  }

  startOwnerPolling(): void {
    this.ownerTimer = setInterval(() => {
      const pid = this.state.qwen_pid;
      if (pid !== null && !pidAlive(pid)) this.shutdown("owner exit");
    }, OWNER_POLL_MS);
    this.ownerTimer.unref();
  }

  shutdown(reason: string): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.ownerTimer !== null) clearInterval(this.ownerTimer);
    this.log(`shutdown: ${reason}`);
    this.state.ended_at = new Date().toISOString();
    try {
      saveState(this.dir, this.state);
    } catch {
      // Best effort.
    }
    // M1 keeps nothing worth surviving a clean end; M2's outbox will retain
    // session state until records are drained and acknowledged instead.
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      // Best effort; stale-session cleanup removes it later.
    }
    process.exit(0);
  }
}

/** Remove dead sessions' state. Called on sidecar start ("a new session that
 * finds a stale state dir cleans it up after the same liveness check"). */
function cleanupStaleSessions(currentSessionId: string): void {
  let entries;
  try {
    entries = readdirSync(sessionsRoot(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === currentSessionId) continue;
    const dir = join(sessionsRoot(), entry.name);
    let ageMs: number;
    try {
      ageMs = Date.now() - statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    const state = loadState(dir);
    if (state === null) {
      if (ageMs > 24 * 60 * 60_000) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Ignore.
        }
      }
      continue;
    }
    if (state.ended_at !== undefined) {
      if (ageMs > ENDED_GRACE_MS) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Ignore.
        }
      }
      continue;
    }
    const dead =
      state.qwen_pid !== null
        ? !pidAlive(state.qwen_pid) && ageMs > OWNER_DEAD_GRACE_MS
        : ageMs > OWNER_UNKNOWN_GRACE_MS;
    if (dead) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore.
      }
    }
  }
}

export async function startSidecar(sessionId: string): Promise<void> {
  const dir = sessionDir(sessionId);
  ensureDir(dir);
  let state = loadState(dir);
  if (state === null || state.ended_at !== undefined || state.session_id !== sessionId) {
    state = newState(sessionId);
  }
  saveState(dir, state);
  const sidecar = new Sidecar(state, dir);
  const server = createServer((req, res) => {
    void sidecar.route(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  sidecar.state.port = address.port;
  saveState(dir, sidecar.state);
  cleanupStaleSessions(sessionId);
  sidecar.log(`listening on 127.0.0.1:${address.port}`);
  sidecar.startOwnerPolling();
  process.on("SIGTERM", () => sidecar.shutdown("sigterm"));
  process.on("SIGINT", () => sidecar.shutdown("sigint"));
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
  const sessionId = process.argv[2];
  if (sessionId === undefined) {
    process.stderr.write("usage: node sidecar.js <session-id>\n");
    process.exit(2);
  }
  startSidecar(sessionId).catch((err: unknown) => {
    process.stderr.write(`sidecar failed: ${String(err)}\n`);
    process.exit(1);
  });
}

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { appendFile } from "node:fs/promises";
import { readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { ensureDir } from "../lib/fsx.js";
import { pidAlive } from "../lib/proc.js";
import { DELTA_SOURCE, PRODUCER_NAME } from "../lib/constants.js";
import { REQUIRED_CONTRACT, runDelta, threadContract } from "../delta-cli.js";
import { sessionDir, sessionsRoot } from "../lib/paths.js";
import { loadState, newState, saveState, type RecordingState, type SessionState } from "./state.js";
import { Outbox, type FlushTarget } from "./outbox.js";
import { Recorder } from "./recorder.js";
import { Mounts } from "./mounts.js";

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const OWNER_POLL_MS = 2_000;
const OWNER_UNKNOWN_GRACE_MS = 60 * 60_000;
const OWNER_DEAD_GRACE_MS = 15 * 60_000;
const ENDED_GRACE_MS = 60_000;
const FLUSH_RETRY_MS = 5_000;

const CONSENT_TEXT =
  "Delta will upload this session's conversation (prompts, replies, tool " +
  "inputs and outputs) and the files in this Git checkout (staged, unstaged, " +
  "and untracked files that are not ignored) to your organization, where " +
  "teammates you share with can read them. Re-run with --confirm to share.";

interface HookEventPayload {
  [key: string]: unknown;
}

export interface HookResponse {
  [key: string]: unknown;
}

export interface ShareResponse {
  status: "consent_required" | "shared" | "error";
  message?: string;
  thread_id?: string;
  url?: string;
  warning?: string;
}

async function runDeltaCreate(
  externalId: string,
): Promise<{ ok: true; threadId: string } | { ok: false; error: string }> {
  const result = await runDelta<{ thread_id?: unknown }>([
    "thread",
    "create",
    "--source",
    DELTA_SOURCE,
    "--external-id",
    externalId,
  ]);
  if (!result.ok) return { ok: false, error: result.error.message };
  const threadId = result.value["thread_id"];
  if (typeof threadId !== "string" || threadId.length === 0) {
    return { ok: false, error: "thread create returned no thread_id" };
  }
  return { ok: true, threadId };
}

async function runDeltaShare(
  threadId: string,
): Promise<{ ok: true; url: string | null } | { ok: false; error: string }> {
  const result = await runDelta<{ url?: unknown }>([
    "thread",
    "share",
    threadId,
    "--visibility",
    "organization",
  ]);
  if (!result.ok) return { ok: false, error: result.error.message };
  const url = result.value["url"];
  return { ok: true, url: typeof url === "string" ? url : null };
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
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly startedAt = new Date().toISOString();
  private outbox: Outbox | null = null;
  private recorder: Recorder | null = null;
  private mounts: Mounts | null = null;

  constructor(state: SessionState, dir: string) {
    this.state = state;
    this.dir = dir;
  }

  log(line: string): void {
    void appendFile(join(this.dir, "sidecar.log"), `${new Date().toISOString()} ${line}\n`).catch(
      () => {},
    );
  }

  private save(): void {
    saveState(this.dir, this.state);
  }

  private recordingState(): RecordingState {
    if (this.state.recording === undefined) {
      this.state.recording = {
        enabled: false,
        consent: "none",
        thread_id: "",
        next_sequence: 1,
        superseded: false,
        paused: false,
        capture_enabled: true,
        titled: false,
      };
      this.save();
    }
    return this.state.recording;
  }

  private ensureRecorder(): Recorder | null {
    const recording = this.state.recording;
    if (recording === undefined || !recording.enabled) return null;
    if (this.recorder === null) {
      this.outbox = new Outbox(join(this.dir, "outbox.jsonl"));
      this.mounts = new Mounts({
        threadId: recording.thread_id,
        externalId: this.state.external_id,
        sessionId: this.state.session_id,
        ownerPid: () => this.state.qwen_pid,
        log: (line) => this.log(line),
        onCaptureUnavailable: () => {
          if (this.state.recording !== undefined) {
            this.state.recording.capture_enabled = false;
            this.save();
          }
        },
      });
      this.recorder = new Recorder({
        outbox: this.outbox,
        recording,
        capture: {
          start: (id, tool) => this.mounts?.captureStart(id, tool),
          stop: (id, tool) => this.mounts?.captureStop(id, tool),
        },
        log: (line) => this.log(line),
        save: () => this.save(),
      });
      this.flushTimer = setInterval(() => {
        void this.tryFlush();
      }, FLUSH_RETRY_MS);
      this.flushTimer.unref();
    }
    return this.recorder;
  }

  private flushTarget(): FlushTarget {
    const recording = this.recordingState();
    return {
      threadId: recording.thread_id,
      source: DELTA_SOURCE,
      externalId: this.state.external_id,
      producerName: PRODUCER_NAME,
    };
  }

  private async tryFlush(): Promise<void> {
    const recorder = this.ensureRecorder();
    if (recorder === null) return;
    const outcome = await recorder.finish(this.flushTarget());
    if (outcome.superseded && this.state.recording !== undefined) {
      this.state.recording.superseded = true;
      this.save();
      this.log("superseded by a teammate; recording of turn content stops");
    }
    if (outcome.reloadRequired && this.state.recording !== undefined) {
      this.state.recording.paused = true;
      this.save();
      this.log("reload_required; recording paused");
    }
  }

  /** CLI-driven share flow (`cli.ts share [--confirm]`). */
  async share(confirm: boolean): Promise<ShareResponse> {
    const recording = this.recordingState();
    if (recording.consent !== "granted") {
      if (!confirm) {
        recording.consent = "asked";
        this.save();
        return { status: "consent_required", message: CONSENT_TEXT };
      }
      recording.consent = "granted";
      this.save();
    }
    if (!recording.enabled) {
      const contract = await threadContract();
      if (!contract.ok || contract.value.max < REQUIRED_CONTRACT) {
        return {
          status: "error",
          message: contract.ok
            ? `delta thread contract max ${contract.value.max} < ${REQUIRED_CONTRACT}; update Delta`
            : contract.error.message,
        };
      }
      const created = await runDeltaCreate(this.state.external_id);
      if (!created.ok) return { status: "error", message: created.error };
      recording.thread_id = created.threadId;
      recording.enabled = true;
      this.save();
      if (this.state.cwd.length > 0) {
        this.ensureRecorder();
        const result = await this.mounts?.adoptCheckout(this.state.cwd);
        if (result !== undefined && result.ok && typeof result.reference === "string") {
          recording.worktree_reference = result.reference;
          this.save();
        } else if (result !== undefined && !result.ok) {
          this.log(`conversation-only recording: ${result.reason ?? "unknown"}`);
        }
      }
    }
    this.ensureRecorder();
    const shared = await runDeltaShare(recording.thread_id);
    const warning =
      this.state.recording?.capture_enabled === false
        ? "this delta CLI attributes edits only for claude-code sessions; edits will appear unattributed"
        : undefined;
    const response: ShareResponse = {
      status: shared.ok ? "shared" : "error",
      thread_id: recording.thread_id,
    };
    if (shared.ok && shared.url !== null) response.url = shared.url;
    if (!shared.ok) response.message = shared.error;
    if (warning !== undefined) response.warning = warning;
    return response;
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
      if (req.method === "POST" && url === "/share") {
        if (!tokenMatches(this.state.token, bearerToken(req))) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        const body = await readBody(req);
        let request: { confirm?: unknown };
        try {
          request = JSON.parse(body.toString("utf8")) as { confirm?: unknown };
        } catch {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        sendJson(res, 200, await this.share(request["confirm"] === true));
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
    // SessionStart carries a fresh owner pid (http-delivered events cannot
    // walk the process tree), including on resume with a new qwen process.
    if (
      typeof pidHint === "number" &&
      this.state.qwen_pid !== pidHint &&
      (event["hook_event_name"] === "SessionStart" || this.state.qwen_pid === null)
    ) {
      this.state.qwen_pid = pidHint;
      saveState(this.dir, this.state);
      this.log(`owner pid ${pidHint}`);
    }
    if (
      event["hook_event_name"] === "SessionStart" &&
      typeof event["cwd"] === "string" &&
      event["cwd"].length > 0 &&
      this.state.cwd.length === 0
    ) {
      this.state.cwd = event["cwd"];
      this.save();
    }
    const name =
      typeof event["hook_event_name"] === "string"
        ? (event["hook_event_name"] as string)
        : "unknown";
    this.log(`event ${name}`);
    const recorder = this.ensureRecorder();
    if (recorder !== null) {
      recorder.record(event as Record<string, unknown>);
      if (name === "Stop" || name === "StopFailure" || name === "SessionEnd") {
        await this.tryFlush();
      }
    }
    if (name === "SessionEnd") {
      await this.shutdown("session end");
    }
    return {};
  }

  startOwnerPolling(): void {
    this.ownerTimer = setInterval(() => {
      const pid = this.state.qwen_pid;
      if (pid !== null && !pidAlive(pid)) void this.shutdown("owner exit");
    }, OWNER_POLL_MS);
    this.ownerTimer.unref();
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.ownerTimer !== null) clearInterval(this.ownerTimer);
    if (this.flushTimer !== null) clearInterval(this.flushTimer);
    this.log(`shutdown: ${reason}`);
    // Final flush before tearing down mounts, bounded by the delta timeout.
    try {
      await this.tryFlush();
    } catch {
      // Best effort.
    }
    const pending = this.outbox?.size ?? 0;
    this.mounts?.stopAll();
    this.state.ended_at = new Date().toISOString();
    try {
      this.save();
    } catch {
      // Best effort.
    }
    // Keep the session dir while records are still pending, so a resumed
    // session can drain them; fully-drained sessions clean up immediately.
    if (pending === 0) {
      try {
        rmSync(this.dir, { recursive: true, force: true });
      } catch {
        // Best effort; stale-session cleanup removes it later.
      }
    } else {
      this.log(`retaining session dir with ${pending} pending records`);
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
  process.on("SIGTERM", () => void sidecar.shutdown("sigterm"));
  process.on("SIGINT", () => void sidecar.shutdown("sigint"));
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

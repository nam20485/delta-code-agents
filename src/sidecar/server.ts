import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { appendFile } from "node:fs/promises";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { ensureDir } from "../lib/fsx.js";
import { pidAlive } from "../lib/proc.js";
import { DELTA_SOURCE, PRODUCER_NAME } from "../lib/constants.js";
import { REQUIRED_CONTRACT, runDelta, threadContract } from "../delta-cli.js";
import { readPolicy, writePolicy, isSyncMode, type ProjectPolicy, type SyncMode } from "../policy.js";
import { backfillTranscript } from "../backfill.js";
import { sessionDir, sessionsRoot } from "../lib/paths.js";
import { loadState, newState, saveState, type RecordingState, type SessionState } from "./state.js";
import { Outbox, type FlushTarget } from "./outbox.js";
import { Recorder } from "./recorder.js";
import { Mounts } from "./mounts.js";
import { Inbox } from "./inbox.js";
import { Watcher } from "./watcher.js";

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
  organization?: string,
): Promise<{ ok: true; threadId: string } | { ok: false; error: string }> {
  const args = ["thread", "create", "--source", DELTA_SOURCE, "--external-id", externalId];
  if (organization !== undefined && organization.length > 0) {
    // Bind the thread to the chosen org (offline create); sharing then targets
    // that org rather than the CLI's current selection.
    args.push("--organization", organization, "--visibility", "private");
  }
  const result = await runDelta<{ thread_id?: unknown }>(args);
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
  private inbox: Inbox | null = null;
  private watcher: Watcher | null = null;
  private shareInFlight: Promise<ShareResponse> | null = null;
  private shareInFlightConfirm = false;
  private enableInFlight: Promise<{ ok: true } | { ok: false; error: string }> | null = null;
  private enableGeneration = -1;
  private eventBuffer: Record<string, unknown>[] = [];
  private lastFlushError: { retryable: boolean; retryAfterMs: number; at: number; size: number } | null = null;

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
      this.outbox = new Outbox(this.outboxFile());
      const mounts = this.ensureMounts();
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
      // A restart with recording already enabled must bring the checkout
      // mounts back: conversation without file sync is silent degradation.
      if (
        typeof recording.worktree_reference === "string" &&
        this.state.cwd.length > 0 &&
        !mounts.hasChildren
      ) {
        void mounts.restore(recording.worktree_reference, this.state.cwd);
      }
      // Remote activity: watch the thread, feed the inbox, react to
      // supersession and attachment changes.
      this.inbox = new Inbox(this.dir, this.state.generation);
      this.watcher = new Watcher({
        threadId: recording.thread_id,
        externalId: this.state.external_id,
        ownerPid: () => this.state.qwen_pid,
        inbox: this.inbox,
        effects: {
          onSuperseded: () => {
            if (this.state.recording !== undefined && !this.state.recording.superseded) {
              this.state.recording.superseded = true;
              this.save();
              this.log("superseded via producer.turn; new turn content stops");
            }
          },
          onWorktreesChanged: () => this.mounts?.swapThreadMount(),
          log: (line) => this.log(line),
        },
      });
      this.watcher.start();
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

  private async tryFlush(force = false): Promise<void> {
    const recorder = this.ensureRecorder();
    if (recorder === null || this.outbox === null) return;
    // Capture the generation's objects so a concurrent /clear reset cannot
    // make the continuation write stale outcomes onto the new recording or
    // dereference a nulled outbox.
    const outbox = this.outbox;
    const recording = this.state.recording;
    // Retry policy (plan): retry only when `error.retryable`, honoring
    // `retry_after_ms`; after a non-retryable error, wait for new records.
    // `force` (shutdown's final attempt) bypasses the guards.
    const err = this.lastFlushError;
    if (!force && err !== null) {
      if (!err.retryable && outbox.size === err.size) return;
      if (err.retryable && Date.now() - err.at < Math.max(err.retryAfterMs, 250)) return;
    }
    const outcome = await recorder.finish(this.flushTarget());
    // If a reset replaced the recording/outbox while we awaited, drop the
    // stale outcome entirely.
    if (this.outbox !== outbox || this.state.recording !== recording) return;
    if (outcome.error !== null) {
      this.lastFlushError = {
        retryable: outcome.retryable,
        retryAfterMs: outcome.retryAfterMs ?? 0,
        at: Date.now(),
        size: outbox.size,
      };
    } else {
      this.lastFlushError = null;
    }
    // Recording failures must never kill the sidecar: disk-full during
    // flush bookkeeping rejects here, and every caller is fire-and-forget.
    try {
      if (outcome.superseded && this.state.recording !== undefined) {
        this.state.recording.superseded = true;
        this.save();
        this.log("superseded by a teammate; recording of new turn content stops");
      }
      if (outcome.reloadRequired && this.state.recording !== undefined) {
        this.state.recording.paused = true;
        this.save();
        this.log("reload_required; recording paused (resolve the thread in Delta)");
      }
    } catch (err) {
      this.log(`flush bookkeeping failed: ${String(err)}`);
    }
  }

  /** CLI-driven share flow (`cli.ts share [--confirm] [emails...]`). */
  share(confirm: boolean, emails: string[] = []): Promise<ShareResponse> {
    if (this.shareInFlight !== null) {
      // A confirming caller must not receive the unconfirmed call's answer.
      if (confirm !== this.shareInFlightConfirm) {
        return Promise.resolve({
          status: "error",
          message: "a share request is already in flight; retry once it completes",
        });
      }
      return this.shareInFlight;
    }
    this.shareInFlightConfirm = confirm;
    this.shareInFlight = this.doShare(confirm, emails).finally(() => {
      this.shareInFlight = null;
    });
    return this.shareInFlight;
  }

  private async doShare(confirm: boolean, emails: string[]): Promise<ShareResponse> {
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
    const enabled = await this.enableRecording();
    if (!enabled.ok) return { status: "error", message: enabled.error };
    if (emails.length > 0) {
      const invited = await runDelta<{ results?: unknown }>([
        "thread",
        "invite",
        recording.thread_id,
        ...emails,
      ]);
      if (!invited.ok) return { status: "error", message: invited.error.message, thread_id: recording.thread_id };
      return {
        status: "shared",
        thread_id: recording.thread_id,
        message: `invited: ${emails.join(", ")}`,
      };
    }
    const shared = await runDeltaShare(recording.thread_id);
    return this.shareResponse(shared);
  }

  private outboxFile(): string {
    return join(this.dir, `outbox-${this.state.generation}.jsonl`);
  }

  /**
   * Contract gate + idempotent thread create + backfill + checkout adoption.
   * Serialized: concurrent callers (deferred SessionStart applyPolicy, /setup,
   * /share) share one in-flight enable so the transcript is backfilled once
   * and the checkout adopted once. Events arriving during the enable window
   * are buffered and replayed afterwards (not dropped).
   */
  private enableRecording(): Promise<{ ok: true } | { ok: false; error: string }> {
    const generation = this.state.generation;
    if (this.enableInFlight !== null && this.enableGeneration === generation) {
      return this.enableInFlight;
    }
    // A different generation (a /clear landed mid-enable): chain a fresh enable
    // after the in-flight one (which aborts at its staleness check) so the new
    // conversation is recorded rather than stranded on the stale promise.
    const previous = this.enableInFlight ?? Promise.resolve({ ok: true as const });
    const next = previous.catch(() => {}).then(() => this.doEnableRecording());
    this.enableInFlight = next;
    this.enableGeneration = generation;
    void next.finally(() => {
      if (this.enableInFlight === next) {
        this.enableInFlight = null;
        this.drainEventBuffer();
      }
    });
    return next;
  }

  private async doEnableRecording(): Promise<{ ok: true } | { ok: false; error: string }> {
    const recording = this.recordingState();
    if (recording.enabled) return { ok: true };
    const generation = this.state.generation;
    // A /clear during any await bumps the generation and replaces recording;
    // re-check after each await so we never write into the new generation.
    const stale = (): boolean =>
      this.state.generation !== generation || this.state.recording !== recording;
    const organization = readPolicy(this.state.cwd).organization;
    const contract = await threadContract();
    if (stale()) return { ok: false, error: "session reset during enable" };
    if (!contract.ok || contract.value.max < REQUIRED_CONTRACT) {
      return {
        ok: false,
        error: contract.ok
          ? `delta thread contract max ${contract.value.max} < ${REQUIRED_CONTRACT}; update Delta`
          : contract.error.message,
      };
    }
    const created = await runDeltaCreate(this.state.external_id, organization);
    if (stale()) return { ok: false, error: "session reset during enable" };
    if (!created.ok) return { ok: false, error: created.error };
    // Backfill BEFORE enabling: while enabled is false no live recorder exists,
    // so concurrent events cannot bump next_sequence. The async stream keeps
    // the most recent history; events during the window are buffered.
    if (this.state.transcript_path !== undefined && recording.next_sequence === 1) {
      const { updates, truncated } = await backfillTranscript(this.state.transcript_path);
      if (stale()) return { ok: false, error: "session reset during enable" };
      if (updates.length > 0) {
        const outbox = new Outbox(this.outboxFile());
        for (const update of updates) {
          outbox.add({ sequence: recording.next_sequence, update });
          recording.next_sequence += 1;
        }
        this.log(
          `backfilled ${updates.length} historical records` +
            (truncated ? " (older history truncated to the most recent records)" : ""),
        );
      }
    }
    recording.thread_id = created.threadId;
    recording.enabled = true;
    this.save();
    // ensureRecorder restores mounts when a worktree reference already exists
    // (pause/resume), so only adopt a fresh checkout when there is none.
    this.ensureRecorder();
    if (this.state.cwd.length > 0 && recording.worktree_reference === undefined) {
      const result = await this.ensureMounts().adoptCheckout(this.state.cwd);
      if (stale()) return { ok: false, error: "session reset during enable" };
      if (result.ok && typeof result.reference === "string") {
        recording.worktree_reference = result.reference;
        this.save();
      } else if (!result.ok) {
        this.log(`conversation-only recording: ${result.reason ?? "unknown"}`);
      }
    }
    return { ok: true };
  }

  /** Replay events buffered while an enable was in flight. */
  private drainEventBuffer(): void {
    const buffered = this.eventBuffer;
    this.eventBuffer = [];
    if (buffered.length === 0) return;
    const recorder = this.ensureRecorder();
    if (recorder === null) {
      this.log(`dropped ${buffered.length} buffered events (recording not enabled)`);
      return;
    }
    for (const ev of buffered) {
      recorder.record(ev);
      const n = ev["hook_event_name"];
      if (n === "Stop" || n === "StopFailure" || n === "SessionEnd") void this.tryFlush();
    }
  }

  private shareResponse(shared: { ok: true; url: string | null } | { ok: false; error: string }): ShareResponse {
    const recording = this.recordingState();
    const warning =
      recording.capture_enabled === false
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

  /**
   * Apply the repository sync policy on session start (plan: Project policy).
   * `manual` records nothing until /delta-share; `private` records locally;
   * `team` also shares with the org. Choosing a non-manual mode via /delta-setup
   * is the user's consent, so it is granted here.
   */
  async applyPolicy(): Promise<ShareResponse | null> {
    if (this.state.cwd.length === 0) return null;
    const policy = readPolicy(this.state.cwd);
    if (policy.mode === "manual") return null;
    const recording = this.recordingState();
    recording.consent = "granted";
    this.save();
    const enabled = await this.enableRecording();
    if (!enabled.ok) return { status: "error", message: enabled.error };
    if (policy.mode === "team") {
      const shared = await runDeltaShare(recording.thread_id);
      return this.shareResponse(shared);
    }
    return { status: "shared", thread_id: recording.thread_id };
  }

  /** /delta-setup: persist the policy and apply it immediately. */
  async setup(mode: SyncMode, organization?: string): Promise<ShareResponse> {
    if (this.state.cwd.length === 0) {
      return { status: "error", message: "session has no working directory" };
    }
    const policy: ProjectPolicy = { mode };
    if (organization !== undefined) policy.organization = organization;
    writePolicy(this.state.cwd, policy);
    this.log(`policy set: ${mode}`);
    if (mode === "manual") {
      return { status: "shared", thread_id: this.recordingState().thread_id, message: "manual mode: recording only after /delta-share" };
    }
    const applied = await this.applyPolicy();
    return applied ?? { status: "shared", thread_id: this.recordingState().thread_id };
  }

  /** /delta-pause: stop recording/sync for this session, keeping the thread.
   * Null the recorder/watcher/inbox so a later /delta-share rebuilds them
   * (a stopped Watcher is terminal); keep thread id, consent, worktree ref. */
  pause(): ShareResponse {
    const recording = this.recordingState();
    recording.enabled = false;
    this.save();
    this.watcher?.stop();
    this.watcher = null;
    this.mounts?.stopAll();
    this.mounts = null;
    this.recorder = null;
    this.outbox = null;
    this.inbox = null;
    this.log("recording paused");
    return { status: "shared", thread_id: recording.thread_id, message: "paused; /delta-share resumes in the same thread" };
  }

  /** /delta-unshare: make the thread private, keeping sync and invitations. */
  async unshare(): Promise<ShareResponse> {
    const recording = this.recordingState();
    if (recording.thread_id.length === 0) {
      return { status: "error", message: "no thread to unshare" };
    }
    const result = await runDelta<{ operation?: unknown }>(["thread", "unshare", recording.thread_id]);
    if (!result.ok) return { status: "error", message: result.error.message };
    return { status: "shared", thread_id: recording.thread_id, message: "thread is now private (explicit invitations retained)" };
  }

  /** /delta-inbox: show pending remote activity without delivering it. */
  inboxPeek(): { pending: number; text: string } {
    if (this.inbox === null) return { pending: 0, text: "(no remote activity)" };
    const batch = this.inbox.nextBatch();
    if (batch === null) return { pending: 0, text: "(no pending remote activity)" };
    // Peek only: do not mark delivered; the next user turn injects it.
    return { pending: this.inbox.pendingCount(), text: batch.text };
  }

  /** /delta-join <link>: check access, mount the thread's files, return dir. */
  async joinThread(link: string): Promise<{ status: string; directory?: string; message?: string }> {
    const status = await runDelta<{ access?: { state?: unknown } }>([
      "thread",
      "status",
      link,
      "--source",
      DELTA_SOURCE,
      "--external-id",
      this.state.external_id,
    ]);
    if (!status.ok) {
      return { status: "error", message: `cannot access thread: ${status.error.message}` };
    }
    if (status.value.access?.state !== "granted") {
      return { status: "error", message: `access not granted (state: ${String(status.value.access?.state)})` };
    }
    const mounts = this.ensureMounts();
    const joined = await mounts.join(link);
    if (!joined.ok) return { status: "error", message: joined.error };
    this.log(`joined thread; checkout at ${joined.directory}`);
    return {
      status: "joined",
      directory: joined.directory,
      message: `Run qwen's /cd ${joined.directory} to work in the thread's checkout.`,
    };
  }

  /** `/clear`: bind a fresh thread for the new conversation, leaving the old
   * one idle. Best-effort flush of the old outbox first so undelivered records
   * still reach the old thread. */
  private resetForClear(): void {
    void this.tryFlush();
    this.state.clear_count += 1;
    this.state.generation += 1;
    this.state.external_id = `${this.state.session_id}-c${this.state.clear_count}`;
    // A fresh generation gives the new conversation empty outbox/inbox files,
    // so pre-clear records can never be appended to the new thread. The
    // SessionStart capture already overwrote transcript_path with the new
    // conversation's transcript, so post-clear backfill uses the fresh file.
    this.watcher?.stop();
    this.watcher = null;
    this.mounts?.stopAll();
    this.mounts = null;
    this.recorder = null;
    this.outbox = null;
    this.inbox = null;
    // Pre-clear buffered events belong to the cleared conversation; drop them
    // so the chained enable's drain cannot replay them into the new thread.
    this.eventBuffer = [];
    delete this.state.recording;
    this.save();
    this.log(`clear: new conversation external id ${this.state.external_id}`);
  }

  private ensureMounts(): Mounts {    if (this.mounts === null) {
      const recording = this.recordingState();
      this.mounts = new Mounts({
        threadId: recording.thread_id,
        externalId: this.state.external_id,
        sessionId: this.state.session_id,
        ownerPid: () => this.state.qwen_pid,
        captureEnabled: () => this.state.recording?.capture_enabled !== false,
        sessionActive: () => !this.shuttingDown && this.state.ended_at === undefined,
        log: (line) => this.log(line),
        onCaptureUnavailable: () => {
          if (this.state.recording !== undefined) {
            this.state.recording.capture_enabled = false;
            this.save();
          }
        },
      });
    }
    return this.mounts;
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
        const finishDeferred: (() => void)[] = [];
        const closeDeferred: (() => void)[] = [];
        const response = await this.handleEvent(event, (fn, mode = "close") => {
          (mode === "finish" ? finishDeferred : closeDeferred).push(fn);
        });
        sendJson(res, 200, response);
        const run = (fns: (() => void)[]): void => {
          for (const fn of fns) {
            try {
              fn();
            } catch {
              // Fire-and-forget side effects must not crash the listener.
            }
          }
        };
        // 'finish' fires only when the response was fully written to the
        // client; delivery marking wants that success-only semantics so an
        // aborted forward redelivers instead of being lost. 'close' fires on
        // success AND abort, which is right for flush/shutdown side effects.
        res.on("finish", () => run(finishDeferred));
        res.on("close", () => run(closeDeferred));
        return;
      }
      if (req.method === "POST" && url === "/share") {
        if (!tokenMatches(this.state.token, bearerToken(req))) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        const body = await readBody(req);
        let request: { confirm?: unknown; emails?: unknown };
        try {
          request = JSON.parse(body.toString("utf8")) as { confirm?: unknown; emails?: unknown };
        } catch {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        const emails = Array.isArray(request["emails"])
          ? request["emails"].filter((e): e is string => typeof e === "string")
          : [];
        sendJson(res, 200, await this.share(request["confirm"] === true, emails));
        return;
      }
      if (req.method === "POST" && url === "/setup") {
        if (!tokenMatches(this.state.token, bearerToken(req))) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        const body = await readBody(req);
        let request: { mode?: unknown; organization?: unknown };
        try {
          request = JSON.parse(body.toString("utf8")) as { mode?: unknown; organization?: unknown };
        } catch {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        if (!isSyncMode(request["mode"])) {
          sendJson(res, 400, { error: "mode must be private, team, or manual" });
          return;
        }
        const org = typeof request["organization"] === "string" ? request["organization"] : undefined;
        sendJson(res, 200, await this.setup(request["mode"], org));
        return;
      }
      if (req.method === "POST" && url === "/join") {
        if (!tokenMatches(this.state.token, bearerToken(req))) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        const body = await readBody(req);
        let request: { link?: unknown };
        try {
          request = JSON.parse(body.toString("utf8")) as { link?: unknown };
        } catch {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        if (typeof request["link"] !== "string" || request["link"].length === 0) {
          sendJson(res, 400, { error: "link is required" });
          return;
        }
        sendJson(res, 200, await this.joinThread(request["link"]));
        return;
      }
      if (req.method === "POST" && url === "/pause") {
        if (!tokenMatches(this.state.token, bearerToken(req))) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        sendJson(res, 200, this.pause());
        return;
      }
      if (req.method === "POST" && url === "/unshare") {
        if (!tokenMatches(this.state.token, bearerToken(req))) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        sendJson(res, 200, await this.unshare());
        return;
      }
      if (req.method === "GET" && url === "/inbox") {
        if (!tokenMatches(this.state.token, bearerToken(req))) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        sendJson(res, 200, this.inboxPeek());
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

  async handleEvent(
    event: HookEventPayload,
    defer?: (fn: () => void, mode?: "finish" | "close") => void,
  ): Promise<HookResponse> {
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
    if (
      event["hook_event_name"] === "SessionStart" &&
      typeof event["transcript_path"] === "string" &&
      event["transcript_path"].length > 0
    ) {
      // SessionStart-only: a /clear deletes this (resetForClear) and the new
      // conversation records live without backfilling the cleared history.
      this.state.transcript_path = event["transcript_path"];
      this.save();
    }
    const name =
      typeof event["hook_event_name"] === "string"
        ? (event["hook_event_name"] as string)
        : "unknown";
    this.log(`event ${name}`);

    // `/clear` starts a new conversation: suffix the external id with a clear
    // counter so the next recording binds a fresh thread (the old thread is
    // left idle, never finalized). `compact` keeps the same conversation.
    if (name === "SessionStart" && event["source"] === "clear") {
      this.resetForClear();
    }
    // Apply the repository sync policy on session start (not on compact, which
    // continues the same recording). Deferred so the response is not blocked
    // by the delta calls enableRecording makes.
    if (name === "SessionStart" && event["source"] !== "compact") {
      if (defer !== undefined) defer(() => void this.applyPolicy());
      else void this.applyPolicy();
    }

    // Supersession is turn-scoped, not permanent: a new user-initiated turn
    // reclaims the thread for the local agent. If the teammate still owns it,
    // Delta re-fences the next append and the flag is set again. Without this,
    // one takeover would deny tool use for the rest of the session and across
    // resume while inbox context kept arriving the agent could not act on.
    if (
      name === "UserPromptSubmit" &&
      typeof event["submitted_prompt"] === "string" &&
      this.state.recording?.superseded === true
    ) {
      this.state.recording.superseded = false;
      this.save();
      this.log("user reclaimed the turn; supersession cleared");
    }

    // Supersession gate (plan): once a teammate takes over the thread, deny
    // further tool calls with a reason the model sees. The user presses Esc;
    // qwen has no external cancellation API.
    if (
      name === "PreToolUse" &&
      this.state.recording?.enabled === true &&
      this.state.recording.superseded
    ) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "A teammate took over this Delta thread. Stop working here; the user can press Esc to end the turn, or send a new prompt to reclaim it.",
        },
      };
    }

    // Buffer events that arrive while an enable is in flight (recording not
    // yet enabled); they are replayed once the recorder exists, not dropped.
    // SessionEnd is never buffered: it must always reach teardown even if the
    // whole session lived inside the enable window (e.g. a one-shot qwen -p).
    if (this.enableInFlight !== null && name !== "SessionEnd") {
      this.eventBuffer.push(event as Record<string, unknown>);
      return {};
    }

    const recorder = this.ensureRecorder();
    if (recorder !== null) {
      recorder.record(event as Record<string, unknown>);
    }
    // Inbox delivery: inject pending teammate activity into a user-initiated
    // turn. Mark delivered only once the response has been written back to
    // Qwen (deferred to response close). A turn cancelled after delivery is
    // unobservable from here; the unique delivery id keeps any redelivery
    // from being deduped away.
    let response: HookResponse = {};
    if (
      name === "UserPromptSubmit" &&
      typeof event["submitted_prompt"] === "string" &&
      this.inbox !== null
    ) {
      const batch = this.inbox.nextBatch();
      if (batch !== null) {
        response = {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: batch.text,
          },
        };
        const ids = batch.ids;
        if (defer !== undefined) defer(() => this.inbox?.markDelivered(ids), "finish");
        else this.inbox.markDelivered(ids);
      }
    }
    // Response first, side effects after: the router treats a slow or reset
    // response as a dead sidecar and would spawn a second writer. Flushing
    // and shutdown run after the response is written (defer), retried by the
    // flush timer if the client is already gone.
    if (name === "Stop" || name === "StopFailure") {
      if (defer !== undefined) defer(() => void this.tryFlush());
      else void this.tryFlush();
    }
    if (name === "SessionEnd") {
      if (event["reason"] === "clear") {
        // `/clear` is a conversation reset, not a session exit: no teardown.
        // (Per-clear thread splitting via an external-id suffix lands in M4.)
        if (defer !== undefined) defer(() => void this.tryFlush());
        else void this.tryFlush();
        return response;
      }
      if (defer !== undefined) {
        defer(() => void this.shutdown("session end"));
      } else {
        void this.shutdown("session end");
      }
    }
    return response;
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
    // If an enable is still in flight (e.g. a one-shot qwen -p whose whole
    // session lives inside the enable window), let it finish so the transcript
    // is recorded before teardown, bounded so a hung enable cannot block exit.
    if (this.enableInFlight !== null) {
      await Promise.race([
        this.enableInFlight.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 30_000).unref()),
      ]);
    }
    // Final flush before tearing down mounts, bounded by the delta timeout.
    // Force it: the retry guards (backoff / non-retryable-without-new-
    // records) must not let the sidecar exit without a last delivery try.
    try {
      await this.tryFlush(true);
    } catch {
      // Best effort.
    }
    const pending = this.outbox?.size ?? 0;
    this.watcher?.stop();
    this.mounts?.stopAll();
    this.state.ended_at = new Date().toISOString();
    try {
      this.save();
    } catch {
      // Best effort.
    }
    // Recording sessions retain their dir: the outbox may hold undelivered
    // records, and a later /resume must continue the same thread's sequence
    // counters (never restart from 1). cleanupStaleSessions reaps them after
    // a long grace once the outbox is drained.
    if (this.state.recording?.enabled === true) {
      this.log(`retaining recording session dir (pending ${pending})`);
    } else {
      try {
        rmSync(this.dir, { recursive: true, force: true });
      } catch {
        // Best effort; stale-session cleanup removes it later.
      }
    }
    process.exit(0);
  }
}

/** Remove dead sessions' state. Called on sidecar start ("a new session that
 * finds a stale state dir cleans it up after the same liveness check"). Dirs
 * with undelivered records are never deleted; ended recording sessions get a
 * long grace so a `/resume` can continue the sequence counters. */
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
    // Undelivered records outrank every grace period. Outbox files are
    // generation-suffixed (outbox-<gen>.jsonl); a stat check on any of them
    // avoids reading/parsing megabytes per session on the event loop.
    let outboxBytes = 0;
    try {
      for (const entry of readdirSync(dir)) {
        if (entry === "outbox.jsonl" || (entry.startsWith("outbox-") && entry.endsWith(".jsonl"))) {
          outboxBytes += statSync(join(dir, entry)).size;
        }
      }
    } catch {
      // No outbox files.
    }
    if (outboxBytes > 0) continue;
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
    const recordingGrace =
      state.recording?.enabled === true ? 24 * 60 * 60_000 : ENDED_GRACE_MS;
    if (state.ended_at !== undefined) {
      if (ageMs > recordingGrace) {
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

  // Single-instance guard: a slow boot must not let a second spawn become a
  // second writer on the same state dir. An exclusive pid lock names the
  // owner; a live owner means another sidecar already serves this session.
  const lockPath = join(dir, "sidecar.pid");
  // Create-and-write atomically through the fd so the lock is never empty.
  const writePidLock = (): boolean => {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch {
      return false;
    }
    try {
      writeSync(fd, String(process.pid));
    } catch {
      // A failed write must not leave a zero-byte lock that wedges the
      // session (every later spawn would read empty and exit). Remove our
      // own just-created lock and let the next re-send acquire cleanly.
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // Best effort.
      }
      return false;
    } finally {
      closeSync(fd);
    }
    return true;
  };
  const readOwner = (): number | null => {
    try {
      const n = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
      return Number.isInteger(n) ? n : null;
    } catch {
      return null;
    }
  };
  if (!writePidLock()) {
    const owner = readOwner();
    // Unparsable/empty or vanished lock: assume another spawn owns it; never
    // delete a lock we cannot positively identify as stale.
    if (owner === null || pidAlive(owner)) process.exit(0);
    // Stale lock from a crashed sidecar: reclaim atomically. Re-read right
    // before deleting so a stalled reclaimer cannot remove a lock that a
    // winner has since re-acquired with a live pid.
    if (readOwner() !== owner) process.exit(0);
    try {
      rmSync(lockPath, { force: true });
    } catch {
      process.exit(0);
    }
    if (!writePidLock()) process.exit(0);
  }
  // Confirm we still own it after the write (a concurrent reclaim may have
  // replaced the lock between our create and this read).
  if (readOwner() !== process.pid) process.exit(0);
  process.on("exit", () => {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // Best effort.
    }
  });

  let state = loadState(dir);
  if (state === null || state.session_id !== sessionId) {
    state = newState(sessionId);
  } else if (state.ended_at !== undefined && process.argv.includes("--revive")) {
    // Revive ONLY on an explicit SessionStart (resume). A stray late event
    // for an ended session must not resurrect it and its mounts for a dead
    // owner (the pid may even have been recycled by another process).
    delete state.ended_at;
  }
  saveState(dir, state);
  // Migrate legacy (pre-generation) outbox/inbox filenames so pending records
  // and delivered flags survive the upgrade instead of being stranded.
  try {
    const legacyOutbox = join(dir, "outbox.jsonl");
    const genOutbox = join(dir, `outbox-${state.generation}.jsonl`);
    if (existsSync(legacyOutbox) && !existsSync(genOutbox)) renameSync(legacyOutbox, genOutbox);
    const legacyInbox = join(dir, "inbox.json");
    const genInbox = join(dir, `inbox-${state.generation}.json`);
    if (existsSync(legacyInbox) && !existsSync(genInbox)) renameSync(legacyInbox, genInbox);
  } catch {
    // Best effort.
  }
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

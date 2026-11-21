import { join } from "node:path";
import { DELTA_SOURCE, PRODUCER_NAME } from "../lib/constants.js";
import { runDelta } from "../delta-cli.js";
import { atomicWriteJson, readJson } from "../lib/fsx.js";
import { Outbox } from "./outbox.js";
import { Recorder } from "./recorder.js";
import type { RecordingState, TurnStateInfo } from "./state.js";

interface Child {
  reference: string;
  externalId: string;
  recording: RecordingState;
  outbox: Outbox;
  recorder: Recorder;
}

interface ChildPersisted {
  next_sequence: number;
  turn_state?: TurnStateInfo;
}

/** Collision-safe filename component for an agent id (a:b vs a/b differ). */
function safeName(agentId: string): string {
  return encodeURIComponent(agentId);
}

const CREATE_RETRY_MS = 30_000;

/**
 * Records Qwen subagents as child threads under the session's thread (plan:
 * "Record subagents"). Each child is created idempotently with
 * `--parent --shared-worktrees --external-id <session>:<agent_id>` and gets
 * its own Recorder + outbox; events carrying `agent_id` route here instead of
 * the parent recorder. Capture is disabled for children (their edits still
 * sync through the shared worktrees, just unattributed). Child sequence
 * counters persist per generation so a restart never reuses a sequence.
 */
export class ChildThreads {
  private readonly children = new Map<string, Child>();
  private readonly creating = new Map<string, Promise<Child | null>>();
  private readonly failedUntil = new Map<string, number>();

  constructor(
    private readonly opts: {
      dir: string;
      parentThreadId: () => string;
      externalId: () => string;
      generation: () => number;
      acknowledge: () => "local" | "server";
      log: (line: string) => void;
    },
  ) {}

  private childFile(agentId: string, suffix: string, generation: number): string {
    return join(this.opts.dir, `child-${generation}-${safeName(agentId)}.${suffix}`);
  }

  private async ensureChild(agentId: string, agentType: string): Promise<Child | null> {
    const existing = this.children.get(agentId);
    if (existing !== undefined) return existing;
    // Cap respawn churn while create keeps failing (auth/server outage).
    const deadline = this.failedUntil.get(agentId);
    if (deadline !== undefined && Date.now() < deadline) return null;
    const inflight = this.creating.get(agentId);
    if (inflight !== undefined) return inflight;
    const parent = this.opts.parentThreadId();
    if (parent.length === 0) return null;
    const promise = this.createChild(agentId, agentType, parent);
    this.creating.set(agentId, promise);
    try {
      const child = await promise;
      if (child !== null) {
        this.children.set(agentId, child);
        this.failedUntil.delete(agentId);
      } else {
        this.failedUntil.set(agentId, Date.now() + CREATE_RETRY_MS);
      }
      return child;
    } finally {
      this.creating.delete(agentId);
    }
  }

  private async createChild(agentId: string, agentType: string, parent: string): Promise<Child | null> {
    // Snapshot identity before the await so a /clear mid-create cannot mix an
    // old parent/external id with new-generation filenames.
    const generation = this.opts.generation();
    const externalId = `${this.opts.externalId()}:${agentId}`;
    const result = await runDelta<{ reference?: unknown }>([
      "thread",
      "create",
      "--source",
      DELTA_SOURCE,
      "--external-id",
      externalId,
      "--parent",
      parent,
      "--name",
      agentType,
      "--shared-worktrees",
    ]);
    if (this.opts.generation() !== generation) {
      // Conversation cleared while creating; this child belongs to the old
      // generation — drop it rather than write into the new one.
      return null;
    }
    if (!result.ok || typeof result.value["reference"] !== "string") {
      this.opts.log(
        `child create failed for ${agentId}: ${result.ok ? "no reference" : result.error.message}`,
      );
      return null;
    }
    const reference = result.value["reference"];
    const stateFile = this.childFile(agentId, "state.json", generation);
    const saved = readJson<ChildPersisted>(stateFile);
    const recording: RecordingState = {
      enabled: true,
      consent: "granted",
      thread_id: reference,
      next_sequence: typeof saved?.next_sequence === "number" ? saved.next_sequence : 1,
      superseded: false,
      paused: false,
      capture_enabled: false,
      titled: false,
    };
    if (saved?.turn_state !== undefined) recording.turn_state = saved.turn_state;
    const outbox = new Outbox(this.childFile(agentId, "jsonl", generation));
    const recorder = new Recorder({
      outbox,
      recording,
      capture: { start: () => {}, stop: () => {} },
      log: (line) => this.opts.log(`[${agentId}] ${line}`),
      save: () => {
        const persisted: ChildPersisted = { next_sequence: recording.next_sequence };
        if (recording.turn_state !== undefined) persisted.turn_state = recording.turn_state;
        atomicWriteJson(stateFile, persisted);
      },
    });
    this.opts.log(`child thread ${reference} for ${agentType} (${agentId})`);
    return { reference, externalId, recording, outbox, recorder };
  }

  /** Route one subagent hook event to its child thread. */
  async record(agentId: string, agentType: string, event: Record<string, unknown>): Promise<void> {
    const child = await this.ensureChild(agentId, agentType);
    if (child === null) return;
    const name = typeof event["hook_event_name"] === "string" ? event["hook_event_name"] : "";
    // SubagentStop carries the final message; treat it as the child's Stop so
    // the recorder emits the fallback answer + idle.
    const translated: Record<string, unknown> =
      name === "SubagentStop"
        ? { ...event, hook_event_name: "Stop" }
        : { ...event };
    delete translated["agent_id"];
    child.recorder.record(translated);
    if (name === "SubagentStop" || name === "Stop" || name === "StopFailure") {
      await this.flushChild(child);
    }
  }

  private async flushChild(child: Child): Promise<void> {
    const outcome = await child.outbox.flush({
      threadId: child.reference,
      source: DELTA_SOURCE,
      externalId: child.externalId,
      producerName: PRODUCER_NAME,
      acknowledge: this.opts.acknowledge(),
    });
    // Mirror the parent's handling: stop new content when fenced/superseded,
    // pause on reload_required so we do not append into a thread Delta wants
    // reloaded.
    if (outcome.superseded) child.recording.superseded = true;
    if (outcome.reloadRequired) child.recording.paused = true;
    if (outcome.error !== null) {
      this.opts.log(`child flush error: ${outcome.error.message}`);
    }
  }

  /** Flush every child; one failing child must not starve the others. */
  async flushAll(): Promise<void> {
    for (const child of this.children.values()) {
      try {
        await this.flushChild(child);
      } catch (err) {
        this.opts.log(`child flush failed: ${String(err)}`);
      }
    }
  }

  /** References of recorded children, for status/diagnostics. */
  references(): string[] {
    return [...this.children.values()].map((c) => c.reference);
  }
}

import { join } from "node:path";
import { DELTA_SOURCE, PRODUCER_NAME } from "../lib/constants.js";
import { runDelta } from "../delta-cli.js";
import { Outbox } from "./outbox.js";
import { Recorder } from "./recorder.js";
import type { RecordingState } from "./state.js";

interface Child {
  reference: string;
  externalId: string;
  recording: RecordingState;
  outbox: Outbox;
  recorder: Recorder;
}

function safeName(agentId: string): string {
  return agentId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Records Qwen subagents as child threads under the session's thread (plan:
 * "Record subagents"). Each child is created idempotently with
 * `--parent --shared-worktrees --external-id <session>:<agent_id>` and gets
 * its own Recorder + outbox; events carrying `agent_id` route here instead of
 * the parent recorder. Capture is disabled for children (their edits still
 * sync through the shared worktrees, just unattributed).
 */
export class ChildThreads {
  private readonly children = new Map<string, Child>();
  private readonly creating = new Map<string, Promise<Child | null>>();

  constructor(
    private readonly opts: {
      dir: string;
      parentThreadId: () => string;
      externalId: () => string;
      log: (line: string) => void;
    },
  ) {}

  private async ensureChild(agentId: string, agentType: string): Promise<Child | null> {
    const existing = this.children.get(agentId);
    if (existing !== undefined) return existing;
    const inflight = this.creating.get(agentId);
    if (inflight !== undefined) return inflight;
    const parent = this.opts.parentThreadId();
    if (parent.length === 0) return null;
    const promise = this.createChild(agentId, agentType, parent);
    this.creating.set(agentId, promise);
    try {
      const child = await promise;
      if (child !== null) this.children.set(agentId, child);
      return child;
    } finally {
      this.creating.delete(agentId);
    }
  }

  private async createChild(agentId: string, agentType: string, parent: string): Promise<Child | null> {
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
    if (!result.ok || typeof result.value["reference"] !== "string") {
      this.opts.log(
        `child create failed for ${agentId}: ${result.ok ? "no reference" : result.error.message}`,
      );
      return null;
    }
    const reference = result.value["reference"];
    const recording: RecordingState = {
      enabled: true,
      consent: "granted",
      thread_id: reference,
      next_sequence: 1,
      superseded: false,
      paused: false,
      capture_enabled: false,
      titled: false,
    };
    const outbox = new Outbox(join(this.opts.dir, `child-${safeName(agentId)}.jsonl`));
    const recorder = new Recorder({
      outbox,
      recording,
      capture: { start: () => {}, stop: () => {} },
      log: (line) => this.opts.log(`[${agentId}] ${line}`),
      save: () => {},
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
    });
    if (outcome.error !== null) {
      this.opts.log(`child flush error: ${outcome.error.message}`);
    }
  }

  async flushAll(): Promise<void> {
    for (const child of this.children.values()) {
      await this.flushChild(child);
    }
  }

  /** References of recorded children, for status/diagnostics. */
  references(): string[] {
    return [...this.children.values()].map((c) => c.reference);
  }
}

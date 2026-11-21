import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { DELTA_SOURCE, PRODUCER_NAME } from "../lib/constants.js";
import { resolveDeltaBinary } from "../delta-cli.js";
import type { Inbox } from "./inbox.js";

export interface WatchEffects {
  onSuperseded(): void;
  onWorktreesChanged(): void;
  log(line: string): void;
}

interface WatchItem {
  id?: unknown;
  kind?: unknown;
  after_id?: unknown;
  author?: { name?: unknown } | null;
  content?: { text?: unknown } | null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Pure reducer for `thread watch` frames (plan: full frame protocol). The
 * stream starts `ready`, then current items, then `live`, then changes.
 * Items our own producer recorded are hidden by the CLI, so every item here
 * is remote activity for the inbox.
 */
export class WatchView {
  constructor(
    private readonly inbox: Inbox,
    private readonly effects: WatchEffects,
  ) {}

  apply(frame: Record<string, unknown>): void {
    const type = str(frame["type"]);
    switch (type) {
      case "ready":
        return;
      case "live":
        this.inbox.markLive();
        return;
      case "item": {
        const item = frame["item"] as WatchItem | undefined;
        if (item === undefined) return;
        const id = str(item.id);
        if (id.length === 0) return;
        this.inbox.upsertItem(
          id,
          str(item.content?.text),
          str(item.author?.name) || "teammate",
          typeof item.after_id === "string" ? item.after_id : null,
        );
        return;
      }
      case "item.append": {
        const id = str(frame["id"]);
        if (id.length > 0) this.inbox.appendItem(id, str(frame["text"]));
        return;
      }
      case "remove": {
        const id = str(frame["id"]);
        if (id.length > 0) this.inbox.remove(id);
        return;
      }
      case "comment": {
        const comment = frame["comment"] as
          | { id?: unknown; text?: unknown; author?: { name?: unknown } | null }
          | undefined;
        if (comment === undefined) return;
        const id = str(comment.id);
        if (id.length === 0) return;
        this.inbox.upsertComment(id, str(comment.text), str(comment.author?.name) || "teammate");
        return;
      }
      case "comment.remove": {
        const id = str(frame["id"]);
        if (id.length > 0) this.inbox.remove(id);
        return;
      }
      case "producer.turn": {
        if (str(frame["status"]) === "superseded") this.effects.onSuperseded();
        return;
      }
      case "worktrees":
        this.effects.onWorktreesChanged();
        return;
      case "turn":
      case "presence":
      case "children":
      case "child":
      case "child.remove":
        // Turn/presence replace latest state; children tracking lands in M5.
        return;
      default:
        // Forward-extensible: skip unknown frame types.
        return;
    }
  }
}

/**
 * Keeps `delta thread watch` running for the session, reconnecting with
 * backoff on exit or `watch_reset`. Each reconnect starts a fresh snapshot;
 * the inbox's persisted delivered flags prevent re-injection.
 */
export class Watcher {
  private child: ChildProcess | null = null;
  private stopped = false;
  private retryDelayMs = 1_000;
  private readonly view: WatchView;

  constructor(
    private readonly opts: {
      threadId: string;
      externalId: string;
      ownerPid: () => number | null;
      inbox: Inbox;
      effects: WatchEffects;
    },
  ) {
    this.view = new WatchView(opts.inbox, opts.effects);
  }

  start(): void {
    if (this.stopped) return;
    const bin = resolveDeltaBinary();
    if (bin === null) {
      this.opts.effects.log("watch: delta binary not found");
      return;
    }
    const args = [
      "--json",
      "thread",
      "watch",
      this.opts.threadId,
      "--source",
      DELTA_SOURCE,
      "--external-id",
      this.opts.externalId,
      "--participate",
      PRODUCER_NAME,
    ];
    const ownerPid = this.opts.ownerPid();
    if (ownerPid !== null) args.push("--owner-pid", String(ownerPid));
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    child.on("error", (err) => {
      this.opts.effects.log(`watch: spawn failed: ${err.message}`);
      this.scheduleRestart();
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return;
      }
      const error = frame["error"] as { reason?: unknown } | undefined;
      if (error !== undefined) {
        this.opts.effects.log(`watch: error ${str(error.reason)}; reconnecting`);
        child.kill("SIGTERM");
        return;
      }
      this.retryDelayMs = 1_000;
      this.view.apply(frame);
    });
    child.on("exit", (code, signal) => {
      this.opts.effects.log(`watch exited (${signal ?? "code " + String(code)})`);
      this.child = null;
      this.scheduleRestart();
    });
    this.opts.effects.log(`watch started for ${this.opts.threadId}`);
  }

  private scheduleRestart(): void {
    if (this.stopped) return;
    const delayMs = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30_000);
    setTimeout(() => this.start(), delayMs).unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.child !== null) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
  }
}

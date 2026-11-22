import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { DELTA_SOURCE, PRODUCER_NAME } from "../lib/constants.js";
import { resolveDeltaBinary } from "../delta-cli.js";
function str(value) {
    return typeof value === "string" ? value : "";
}
/**
 * Pure reducer for `thread watch` frames (plan: full frame protocol). The
 * stream starts `ready`, then current items, then `live`, then changes.
 * Items our own producer recorded are hidden by the CLI, so every item here
 * is remote activity for the inbox.
 */
export class WatchView {
    inbox;
    effects;
    /** Subagents/subthreads reported by the watch (children/child frames). */
    childThreads = new Map();
    constructor(inbox, effects) {
        this.inbox = inbox;
        this.effects = effects;
    }
    /** Current child threads keyed by thread_id (for status/diagnostics). */
    children() {
        return [...this.childThreads.values()];
    }
    apply(frame) {
        const type = str(frame["type"]);
        switch (type) {
            case "ready":
                return;
            case "live":
                this.inbox.markLive();
                return;
            case "item": {
                const item = frame["item"];
                if (item == null)
                    return;
                const id = str(item.id);
                if (id.length === 0)
                    return;
                this.inbox.upsertItem(id, str(item.content?.text), str(item.author?.name) || "teammate", typeof item.after_id === "string" ? item.after_id : null);
                return;
            }
            case "item.append": {
                const id = str(frame["id"]);
                if (id.length > 0)
                    this.inbox.appendItem(id, str(frame["text"]));
                return;
            }
            case "remove": {
                const id = str(frame["id"]);
                if (id.length > 0)
                    this.inbox.remove(id);
                return;
            }
            case "comment": {
                const comment = frame["comment"];
                if (comment == null)
                    return;
                const id = str(comment.id);
                if (id.length === 0)
                    return;
                this.inbox.upsertComment(id, str(comment.text), str(comment.author?.name) || "teammate");
                return;
            }
            case "comment.remove": {
                const id = str(frame["id"]);
                if (id.length > 0)
                    this.inbox.remove(id);
                return;
            }
            case "producer.turn": {
                if (str(frame["status"]) === "superseded")
                    this.effects.onSuperseded();
                return;
            }
            case "worktrees":
                this.effects.onWorktreesChanged();
                return;
            case "turn":
            case "presence":
                // Turn/presence replace latest state; not needed for recording.
                return;
            case "children": {
                const list = frame["children"];
                if (Array.isArray(list)) {
                    // Only a usable snapshot replaces the map; an off-contract frame
                    // (null/non-array) must not wipe tracked subthreads.
                    this.childThreads.clear();
                    for (const entry of list) {
                        if (entry !== null && typeof entry === "object") {
                            const child = entry;
                            const id = str(child["thread_id"]);
                            if (id.length > 0)
                                this.childThreads.set(id, child);
                        }
                    }
                }
                return;
            }
            case "child": {
                const child = frame["child"];
                if (child !== null && typeof child === "object") {
                    const entry = child;
                    const id = str(entry["thread_id"]);
                    if (id.length > 0)
                        this.childThreads.set(id, entry);
                }
                return;
            }
            case "child.remove": {
                const id = str(frame["thread_id"]);
                if (id.length > 0)
                    this.childThreads.delete(id);
                return;
            }
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
    opts;
    child = null;
    stopped = false;
    retryDelayMs = 1_000;
    restartTimer = null;
    view;
    constructor(opts) {
        this.opts = opts;
        this.view = new WatchView(opts.inbox, opts.effects);
    }
    start() {
        if (this.stopped)
            return;
        const bin = resolveDeltaBinary();
        if (bin === null) {
            this.opts.effects.log("watch: delta binary not found");
            return;
        }
        // Never orphan a previous child (it holds --participate presence).
        if (this.child !== null) {
            this.child.kill("SIGTERM");
            this.child = null;
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
        if (ownerPid !== null)
            args.push("--owner-pid", String(ownerPid));
        const child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
        child.on("error", (err) => {
            this.opts.effects.log(`watch: spawn failed: ${err.message}`);
            // Same scope as the exit handler: a stale child's error must not arm a
            // restart that kills the healthy replacement.
            if (this.child === child) {
                this.child = null;
                this.scheduleRestart();
            }
        });
        this.child = child;
        const lines = createInterface({ input: child.stdout });
        lines.on("line", (line) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith("{"))
                return;
            let frame;
            try {
                frame = JSON.parse(trimmed);
            }
            catch {
                return;
            }
            try {
                this.handleFrame(frame, child);
            }
            catch (err) {
                // One malformed frame must never kill the sidecar.
                this.opts.effects.log(`watch: frame handling failed: ${String(err)}`);
            }
        });
        child.on("exit", (code, signal) => {
            this.opts.effects.log(`watch exited (${signal ?? "code " + String(code)})`);
            // Only the current child's exit may arm a restart; a stale child's late
            // exit must not kill/respawn the healthy replacement.
            if (this.child === child) {
                this.child = null;
                this.scheduleRestart();
            }
        });
        this.opts.effects.log(`watch started for ${this.opts.threadId}`);
    }
    handleFrame(frame, child) {
        const error = frame["error"];
        if (error != null) {
            // Match the plan/tryFlush contract: retry only when explicitly true.
            // An off-contract permanent failure (auth, bad thread) gives up rather
            // than churning the CLI forever; transient drops usually exit the child
            // and reconnect via the exit path instead.
            const retryable = error.retryable === true;
            if (!retryable) {
                this.opts.effects.log(`watch: non-retryable error ${str(error.reason)}; giving up`);
                this.stopped = true;
                child.kill("SIGTERM");
                return;
            }
            const after = typeof error.retry_after_ms === "number" ? error.retry_after_ms : 0;
            this.opts.effects.log(`watch: error ${str(error.reason)}; reconnecting`);
            if (after > 0)
                this.retryDelayMs = Math.max(this.retryDelayMs, after);
            child.kill("SIGTERM");
            return;
        }
        if (str(frame["type"]) === "watch_reset") {
            this.opts.effects.log("watch: reset frame; reconnecting for a fresh snapshot");
            child.kill("SIGTERM");
            return;
        }
        // Backoff resets only once the stream is actually live, not on the
        // ready/presence frames a failing CLI prints before dying.
        if (str(frame["type"]) === "live")
            this.retryDelayMs = 1_000;
        this.view.apply(frame);
    }
    scheduleRestart() {
        if (this.stopped)
            return;
        // error + exit can both fire for one child; only one restart may pend.
        if (this.restartTimer !== null)
            return;
        const delayMs = this.retryDelayMs;
        this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30_000);
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            this.start();
        }, delayMs);
        this.restartTimer.unref();
    }
    stop() {
        this.stopped = true;
        if (this.restartTimer !== null) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        if (this.child !== null) {
            this.child.kill("SIGTERM");
            this.child = null;
        }
    }
}

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { DELTA_SOURCE, EDIT_TOOLS } from "../lib/constants.js";
import { resolveDeltaBinary, runDelta } from "../delta-cli.js";
function git(cwd, args) {
    return new Promise((resolve) => {
        const child = spawn("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        child.stdout.on("data", (chunk) => {
            out += chunk.toString("utf8");
        });
        child.on("error", () => resolve(null));
        child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
    });
}
/**
 * Adopts the user's checkout into the thread (plan: "Recording the checkout"):
 * `worktree create` → `worktree attach` → `worktree mount <ref> <cwd>
 * --existing-checkout`, plus a `thread mount --owner` keepalive child. Qwen
 * edits the user's checkout, so adoption is what makes edits reach the
 * thread — a fresh worktree directory would never see them.
 */
export class Mounts {
    opts;
    children = [];
    constructor(opts) {
        this.opts = opts;
    }
    /** Restart the mount children for an already-adopted checkout (after a
     * sidecar restart) using the persisted worktree reference. */
    restore(reference, cwd) {
        this.spawnDelta("worktree-mount", ["worktree", "mount", reference, cwd, "--existing-checkout"]);
        this.spawnDelta("thread-mount", ["thread", "mount", "--owner", this.opts.sessionId, this.opts.threadId]);
        this.opts.log(`restored mounts for ${reference}`);
    }
    /** A `worktrees` watch frame means attachments changed: restart the
     * thread-mount keepalive with the same owner (plan: mount swap). */
    swapThreadMount() {
        for (let i = this.children.length - 1; i >= 0; i--) {
            const entry = this.children[i];
            if (entry.label === "thread-mount") {
                entry.child.kill("SIGTERM");
                this.children.splice(i, 1);
            }
        }
        this.spawnDelta("thread-mount", ["thread", "mount", "--owner", this.opts.sessionId, this.opts.threadId]);
        this.opts.log("swapped thread mount after worktrees change");
    }
    /**
     * /delta-join: mount a shared thread's worktrees into a fresh directory and
     * return it once ready. `--join` reports an explicit join, not background
     * maintenance. The mount child stays running for the session.
     */
    join(link) {
        const bin = resolveDeltaBinary();
        if (bin === null)
            return Promise.resolve({ ok: false, error: "delta CLI not found" });
        return new Promise((resolve) => {
            const child = spawn(bin, ["--json", "thread", "mount", link, "--owner", this.opts.sessionId, "--join"], { stdio: ["ignore", "pipe", "ignore"] });
            let settled = false;
            const finish = (result) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                resolve(result);
            };
            const timer = setTimeout(() => {
                child.kill("SIGTERM");
                finish({ ok: false, error: "join timed out waiting for the mount directory" });
            }, 60_000);
            child.on("error", (err) => finish({ ok: false, error: err.message }));
            const lines = createInterface({ input: child.stdout });
            lines.on("line", (line) => {
                if (settled)
                    return;
                const trimmed = line.trim();
                if (!trimmed.startsWith("{"))
                    return;
                try {
                    const frame = JSON.parse(trimmed);
                    if (typeof frame.directory === "string") {
                        this.children.push({ label: "join-mount", child });
                        child.on("exit", (code, signal) => {
                            this.opts.log(`join-mount exited (${signal ?? "code " + String(code)})`);
                            this.prune();
                        });
                        finish({ ok: true, directory: frame.directory });
                    }
                    else if (frame.error !== undefined) {
                        // Kill and close: a delta that reports an error and stays alive
                        // would otherwise leak an untracked mount child.
                        child.kill("SIGTERM");
                        lines.close();
                        finish({ ok: false, error: String(frame.error.message ?? "join failed") });
                    }
                }
                catch {
                    // Not the ready line.
                }
            });
            child.on("exit", (code) => {
                finish({ ok: false, error: `join mount exited early (code ${String(code)})` });
            });
        });
    }
    spawnDelta(label, args) {
        const bin = resolveDeltaBinary();
        if (bin === null) {
            this.opts.log(`${label}: delta binary not found`);
            return null;
        }
        const child = spawn(bin, ["--json", ...args], {
            stdio: ["ignore", "ignore", "ignore"],
            detached: false,
        });
        // A failed spawn (e.g. missing exec bit) must not crash the sidecar.
        // 'exit' never fires for spawn failures, so remove the entry here or
        // hasChildren would report a child that never ran.
        child.on("error", (err) => {
            this.opts.log(`${label}: spawn failed: ${err.message}`);
            const index = this.children.findIndex((entry) => entry.child === child);
            if (index !== -1)
                this.children.splice(index, 1);
        });
        this.children.push({ label, child });
        child.on("exit", (code, signal) => {
            this.opts.log(`${label} exited (${signal ?? "code " + String(code)})`);
            this.prune();
            if (this.opts.sessionActive() && signal === null && code !== 0) {
                // A mount child dying mid-session means silent file-sync loss.
                this.opts.log(`${label} died unexpectedly; file sync stopped for this session`);
            }
        });
        return child;
    }
    prune() {
        for (let i = this.children.length - 1; i >= 0; i--) {
            const entry = this.children[i];
            if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
                this.children.splice(i, 1);
            }
        }
    }
    get hasChildren() {
        this.prune();
        return this.children.length > 0;
    }
    async adoptCheckout(cwd) {
        if (cwd.length === 0)
            return { ok: false, reason: "no working directory" };
        const isGit = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
        if (isGit === null)
            return { ok: false, reason: `${cwd} is not a Git repository` };
        const remotes = await git(cwd, ["remote"]);
        if (remotes === null || remotes.length === 0) {
            return { ok: false, reason: "repository has no Git remote for Delta to sync through" };
        }
        const created = await runDelta(["worktree", "create", cwd]);
        if (!created.ok) {
            return { ok: false, reason: `worktree create failed: ${created.error.message}` };
        }
        const reference = created.value["reference"];
        if (typeof reference !== "string") {
            return { ok: false, reason: "worktree create returned no reference" };
        }
        const attached = await runDelta(["worktree", "attach", reference, "--thread", this.opts.threadId]);
        if (!attached.ok) {
            return { ok: false, reason: `worktree attach failed: ${attached.error.message}` };
        }
        // Adopt the session's checkout; keep the mount running for the session.
        this.spawnDelta("worktree-mount", ["worktree", "mount", reference, cwd, "--existing-checkout"]);
        // Keepalive: hold the thread's worktrees mounted while the session lives.
        this.spawnDelta("thread-mount", ["thread", "mount", "--owner", this.opts.sessionId, this.opts.threadId]);
        this.opts.log(`adopted checkout ${cwd} as ${reference}`);
        return { ok: true, reference };
    }
    captureStart(toolCallId, toolName) {
        if (!EDIT_TOOLS.has(toolName))
            return;
        // Session-wide disable (e.g. this CLI only attributes claude-code).
        if (!this.opts.captureEnabled())
            return;
        void this.runCapture("start", toolCallId);
    }
    captureStop(toolCallId, toolName) {
        if (!EDIT_TOOLS.has(toolName))
            return;
        if (!this.opts.captureEnabled())
            return;
        void this.runCapture("stop", toolCallId);
    }
    async runCapture(kind, toolCallId) {
        const args = [
            "thread",
            "capture",
            kind,
            "--source",
            DELTA_SOURCE,
            "--external-id",
            this.opts.externalId,
            "--tool-call-id",
            toolCallId,
        ];
        const ownerPid = this.opts.ownerPid();
        if (kind === "start" && ownerPid !== null)
            args.push("--owner-pid", String(ownerPid));
        args.push(this.opts.threadId);
        const result = await runDelta(args, { timeoutMs: 10_000 });
        if (!result.ok && result.error.reason === "invalid_identity") {
            // This CLI build allowlists capture sources (claude-code only today).
            // Disable for the session and keep recording unattributed edits.
            this.opts.log(`capture unavailable on this CLI: ${result.error.message}`);
            this.opts.onCaptureUnavailable();
            return;
        }
        if (!result.ok) {
            this.opts.log(`capture ${kind} failed for ${toolCallId}: ${result.error.message}`);
        }
    }
    stopAll() {
        for (const { label, child } of this.children) {
            if (child.exitCode === null && !child.killed) {
                this.opts.log(`stopping ${label}`);
                child.kill("SIGTERM");
            }
        }
        this.children.length = 0;
    }
}

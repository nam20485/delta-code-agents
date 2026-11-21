import { spawn, type ChildProcess } from "node:child_process";
import { DELTA_SOURCE, EDIT_TOOLS } from "../lib/constants.js";
import { resolveDeltaBinary, runDelta } from "../delta-cli.js";

// `run_shell_command` stays in EDIT_TOOLS: shell commands edit files too, and
// unattributed edits are worse than two extra (session-gated) CLI spawns.

export interface AdoptResult {
  ok: boolean;
  reference?: string;
  /** Conversation-only reason when the checkout cannot be adopted. */
  reason?: string;
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
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
  private readonly children: { label: string; child: ChildProcess }[] = [];

  constructor(
    private readonly opts: {
      threadId: string;
      externalId: string;
      sessionId: string;
      ownerPid: () => number | null;
      captureEnabled: () => boolean;
      log: (line: string) => void;
      onCaptureUnavailable: () => void;
    },
  ) {}

  get hasChildren(): boolean {
    return this.children.length > 0;
  }

  /** Restart the mount children for an already-adopted checkout (after a
   * sidecar restart) using the persisted worktree reference. */
  restore(reference: string, cwd: string): void {
    this.spawnDelta("worktree-mount", ["worktree", "mount", reference, cwd, "--existing-checkout"]);
    this.spawnDelta("thread-mount", ["thread", "mount", "--owner", this.opts.sessionId, this.opts.threadId]);
    this.opts.log(`restored mounts for ${reference}`);
  }

  private spawnDelta(label: string, args: string[]): ChildProcess | null {
    const bin = resolveDeltaBinary();
    if (bin === null) {
      this.opts.log(`${label}: delta binary not found`);
      return null;
    }
    const child = spawn(bin, ["--json", ...args], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: false,
    });
    this.children.push({ label, child });
    child.on("exit", (code, signal) => {
      this.opts.log(`${label} exited (${signal ?? "code " + String(code)})`);
    });
    return child;
  }

  async adoptCheckout(cwd: string): Promise<AdoptResult> {
    if (cwd.length === 0) return { ok: false, reason: "no working directory" };
    const isGit = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (isGit === null) return { ok: false, reason: `${cwd} is not a Git repository` };
    const remotes = await git(cwd, ["remote"]);
    if (remotes === null || remotes.length === 0) {
      return { ok: false, reason: "repository has no Git remote for Delta to sync through" };
    }

    const created = await runDelta<{ reference?: string }>(["worktree", "create", cwd]);
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

  captureStart(toolCallId: string, toolName: string): void {
    if (!EDIT_TOOLS.has(toolName)) return;
    // Session-wide disable (e.g. this CLI only attributes claude-code).
    if (!this.opts.captureEnabled()) return;
    void this.runCapture("start", toolCallId);
  }

  captureStop(toolCallId: string, toolName: string): void {
    if (!EDIT_TOOLS.has(toolName)) return;
    if (!this.opts.captureEnabled()) return;
    void this.runCapture("stop", toolCallId);
  }

  private async runCapture(kind: "start" | "stop", toolCallId: string): Promise<void> {
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
    if (kind === "start" && ownerPid !== null) args.push("--owner-pid", String(ownerPid));
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

  stopAll(): void {
    for (const { label, child } of this.children) {
      if (child.exitCode === null && !child.killed) {
        this.opts.log(`stopping ${label}`);
        child.kill("SIGTERM");
      }
    }
    this.children.length = 0;
  }
}

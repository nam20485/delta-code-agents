#!/usr/bin/env node
// Fake `delta` CLI for tests: `thread append` receipts on stdout, error
// modes on stderr. Controlled by FAKE_MODE (ok|partial|error|reload),
// FAKE_DISPOSITION (recorded|duplicate), FAKE_FENCE_SEQ.
import { readFileSync } from "node:fs";

interface RecordLine {
  sequence?: number;
}

async function main(): Promise<void> {
  const mode = process.env["FAKE_MODE"] ?? "ok";
  let args = process.argv.slice(2);
  if (args[0] === "--json") args = args.slice(1);
  // NOTE: never `process.exit()` right after writing — pipes truncate. Set
  // exitCode and let node flush and exit on its own.
  if (args[0] === "thread" && args[1] === "contract") {
    process.stdout.write(`${JSON.stringify({ operation: "contract", min: 8, max: 12 })}\n`);
    process.exitCode = 0;
    return;
  }
  if (args[0] === "thread" && args[1] === "create") {
    if (args.includes("--parent")) {
      process.stdout.write(`${JSON.stringify({ operation: "created", thread_id: "fake-child", reference: "fake-thread#s=child", created: true })}\n`);
    } else {
      process.stdout.write(`${JSON.stringify({ operation: "created", thread_id: "fake-thread", created: true })}\n`);
    }
    process.exitCode = 0;
    return;
  }
  if (args[0] === "thread" && args[1] === "share") {
    process.stdout.write(`${JSON.stringify({ operation: "shared", url: "https://delta.dev/join/fake" })}\n`);
    process.exitCode = 0;
    return;
  }
  if (args[0] === "thread" && args[1] === "unshare") {
    process.stdout.write(`${JSON.stringify({ operation: "unshared" })}\n`);
    process.exitCode = 0;
    return;
  }
  if (args[0] === "thread" && args[1] === "invite") {
    process.stdout.write(`${JSON.stringify({ operation: "invited", results: [] })}\n`);
    process.exitCode = 0;
    return;
  }
  if (args[0] === "thread" && args[1] === "status") {
    process.stdout.write(`${JSON.stringify({ operation: "status", access: { state: "granted" }, worktrees: { status: "available", items: [] } })}\n`);
    process.exitCode = 0;
    return;
  }
  if (args[0] === "org") {
    if (args[1] === "current") {
      process.stdout.write(`${JSON.stringify({ operation: "current", organization: { id: "org_fake", name: "Fake", current: true } })}\n`);
    } else {
      process.stdout.write(`${JSON.stringify({ operation: "listed", organizations: [{ id: "org_fake", name: "Fake", current: true }] })}\n`);
    }
    process.exitCode = 0;
    return;
  }
  if (args[0] === "thread" && args[1] === "append" && process.env["FAKE_UNKNOWN_DISPO"] === "1") {
    process.stdout.write(`${JSON.stringify({ operation: "appended", sequence: 1, disposition: "rejected" })}\n`);
    process.exitCode = 0;
    return;
  }
  if (args[0] === "thread" && args[1] === "capture") {
    // Match the real CLI: capture is allowlisted to claude-code only.
    process.stderr.write(
      "capture supports only the claude-code source\n{\n  \"error\": {\n    \"code\": \"invalid_reference\",\n    \"reason\": \"invalid_identity\",\n    \"message\": \"capture supports only the claude-code source\",\n    \"retryable\": false\n  }\n}\n",
    );
    process.exitCode = 1;
    return;
  }
  if (args[0] === "worktree" && args[1] === "create") {
    process.stdout.write(`${JSON.stringify({ operation: "created", worktree_id: "wt", reference: "wt-ref" })}\n`);
    process.exitCode = 0;
    return;
  }
  if (args[0] === "worktree" && args[1] === "attach") {
    process.stdout.write(`${JSON.stringify({ operation: "attached", reference: "wt-ref#t=1", thread_id: "fake-thread" })}\n`);
    process.exitCode = 0;
    return;
  }
  if ((args[0] === "worktree" && args[1] === "mount") || (args[0] === "thread" && args[1] === "mount")) {
    if (args.includes("--join")) {
      // Join mount: emit the ready directory line, then stay alive.
      process.stdout.write(`${JSON.stringify({ directory: "/tmp/fake-join-checkout" })}\n`);
      const keepAlive = setInterval(() => {}, 1_000);
      process.on("SIGTERM", () => {
        clearInterval(keepAlive);
        process.exitCode = 0;
      });
      return;
    }
    // Keepalive mount: exiting immediately is fine for tests.
    process.exitCode = 0;
    return;
  }
  if (args[0] === "thread" && args[1] === "watch") {
    // Emit the fixture frames, then stay alive like the real watch until
    // SIGTERM. FAKE_WATCH_FRAMES points at a JSONL file.
    const framesFile = process.env["FAKE_WATCH_FRAMES"];
    if (framesFile !== undefined && framesFile.length > 0) {
      const frames = readFileSync(framesFile, "utf8");
      process.stdout.write(frames.endsWith("\n") ? frames : `${frames}\n`);
    }
    const keepAlive = setInterval(() => {}, 1_000);
    process.on("SIGTERM", () => {
      clearInterval(keepAlive);
      process.exitCode = 0;
    });
    return;
  }
  const stdin = readFileSync(0, "utf8");
  const lines = stdin
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"));
  if (mode === "error") {
    process.stderr.write(
      `${JSON.stringify({ error: { message: "offline", retryable: true, retry_after_ms: 250 } })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (mode === "reload") {
    process.stderr.write(
      `${JSON.stringify({ error: { code: "conflict", reason: "reload_required", message: "reload required", retryable: false } })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const disposition = process.env["FAKE_DISPOSITION"] ?? "recorded";
  const fenceSeq = process.env["FAKE_FENCE_SEQ"] ?? "";
  const emit = mode === "partial" && lines.length > 0 ? lines.slice(0, -1) : lines;
  for (const line of emit) {
    const parsed = JSON.parse(line) as RecordLine;
    const seq = typeof parsed.sequence === "number" ? parsed.sequence : -1;
    const dispo = String(seq) === fenceSeq ? "fenced" : disposition;
    process.stdout.write(
      `${JSON.stringify({
        operation: "appended",
        thread_id: "fake",
        sequence: seq,
        next_sequence: seq + 1,
        duplicate: dispo === "duplicate",
        disposition: dispo,
        turn_sequence: null,
        version: "fake",
      })}\n`,
    );
  }
  process.exitCode = 0;
}

main();

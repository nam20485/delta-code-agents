#!/usr/bin/env node
// Fake `delta` CLI for tests: `thread append` receipts on stdout, error
// modes on stderr. Controlled by FAKE_MODE (ok|partial|error|reload),
// FAKE_DISPOSITION (recorded|duplicate), FAKE_FENCE_SEQ.
import { readFileSync } from "node:fs";

interface RecordLine {
  sequence?: number;
}

async function main(): Promise<number> {
  const mode = process.env["FAKE_MODE"] ?? "ok";
  const stdin = readFileSync(0, "utf8");
  const lines = stdin
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"));
  if (mode === "error") {
    process.stderr.write(
      `${JSON.stringify({ error: { message: "offline", retryable: true, retry_after_ms: 250 } })}\n`,
    );
    return 1;
  }
  if (mode === "reload") {
    process.stderr.write(
      `${JSON.stringify({ error: { code: "conflict", reason: "reload_required", message: "reload required", retryable: false } })}\n`,
    );
    return 1;
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
  return 0;
}

void main().then((code) => process.exit(code));

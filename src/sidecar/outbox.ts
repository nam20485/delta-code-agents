import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../lib/fsx.js";
import { runDeltaJsonl, type DeltaError } from "../delta-cli.js";
import { wrap } from "../records.js";
import type { AcpUpdate } from "../records.js";

/** A record persisted in `outbox.jsonl` before sending. */
export interface OutboxLine {
  sequence: number;
  turnSequence?: number;
  update: AcpUpdate;
}

export type Disposition = "recorded" | "duplicate" | "fenced";

interface AppendReceiptLine {
  operation?: string;
  sequence?: number;
  disposition?: string;
}

export interface FlushOutcome {
  delivered: number;
  superseded: boolean;
  reloadRequired: boolean;
  error: DeltaError | null;
  /** Convenience view of `error` for retry scheduling. */
  retryable: boolean;
  retryAfterMs: number | null;
}

export interface FlushTarget {
  threadId: string;
  source: string;
  externalId: string;
  producerName: string;
}

/**
 * Save-before-send record store (plan: "Outbox and recovery"). Records are
 * numbered consecutively by the caller, never rewritten; lines are deleted
 * only after a `recorded`/`duplicate` receipt. `fenced` means the turn was
 * taken over — reported, not retried.
 */
export class Outbox {
  private pending: OutboxLine[];
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    this.pending = Outbox.load(file);
  }

  static load(file: string): OutboxLine[] {
    if (!existsSync(file)) return [];
    const lines: OutboxLine[] = [];
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      try {
        lines.push(JSON.parse(trimmed) as OutboxLine);
      } catch {
        // A torn final line from a crash is dropped; its sequence is never
        // reused because counters live in state.json.
      }
    }
    return lines;
  }

  get size(): number {
    return this.pending.length;
  }

  /** Highest pending sequence (0 when empty) — used to clamp counters. */
  maxPendingSequence(): number {
    let max = 0;
    for (const line of this.pending) if (line.sequence > max) max = line.sequence;
    return max;
  }

  add(line: OutboxLine): void {
    this.pending.push(line);
    // Line append: a crash mid-write leaves one torn line, which load()
    // drops; the record's sequence is still consumed via the load-time clamp.
    appendFileSync(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }

  private serialize(): string {
    if (this.pending.length === 0) return "";
    return `${this.pending.map((line) => JSON.stringify(line)).join("\n")}\n`;
  }

  private persist(): void {
    atomicWriteFile(this.file, this.serialize());
  }

  /** Send every pending record in one `thread append` batch. */
  async flush(target: FlushTarget): Promise<FlushOutcome> {
    if (this.pending.length === 0) {
      return { delivered: 0, superseded: false, reloadRequired: false, error: null, retryable: false, retryAfterMs: null };
    }
    const input = this.pending
      .map((line) => JSON.stringify(wrap(line.sequence, line.update, line.turnSequence)))
      .join("\n");
    const result = await runDeltaJsonl<AppendReceiptLine>(
      [
        "thread",
        "append",
        target.threadId,
        "--source",
        target.source,
        "--external-id",
        target.externalId,
        "--producer-name",
        target.producerName,
        "--acknowledge",
        "local",
      ],
      { input: `${input}\n`, timeoutMs: 20_000 },
    );
    if (!result.ok) {
      const reload = result.error.reason === "reload_required";
      return {
        delivered: 0,
        superseded: false,
        reloadRequired: reload,
        error: result.error,
        retryable: result.error.retryable === true,
        retryAfterMs:
          typeof result.error.retry_after_ms === "number" ? result.error.retry_after_ms : null,
      };
    }
    const receipts = new Map<number, Disposition>();
    for (const line of result.value.lines) {
      if (
        line["operation"] === "appended" &&
        typeof line["sequence"] === "number" &&
        typeof line["disposition"] === "string"
      ) {
        receipts.set(line["sequence"], line["disposition"] as Disposition);
      }
    }
    let delivered = 0;
    let superseded = false;
    const kept: OutboxLine[] = [];
    for (const line of this.pending) {
      const disposition = receipts.get(line.sequence);
      if (disposition === "recorded" || disposition === "duplicate") {
        delivered += 1;
      } else if (disposition === "fenced") {
        superseded = true;
      } else {
        // No receipt (partial batch failure): keep for retry.
        kept.push(line);
      }
    }
    this.pending = kept;
    this.persist();
    return { delivered, superseded, reloadRequired: false, error: null, retryable: false, retryAfterMs: null };
  }
}

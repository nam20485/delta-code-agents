import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Outbox, type FlushTarget, type OutboxLine } from "../src/sidecar/outbox.js";

const TARGET: FlushTarget = {
  threadId: "fake",
  source: "delta-qwen",
  externalId: "s1",
  producerName: "Qwen Code",
};

function fakeBin(): string {
  const bin = fileURLToPath(new URL("./fake-delta.js", import.meta.url));
  chmodSync(bin, 0o755);
  process.env["DELTA_QWEN_DELTA_BIN"] = bin;
  return bin;
}

function freshOutbox(): { outbox: Outbox; file: string } {
  const file = join(mkdtempSync(join(tmpdir(), "dq-outbox-")), "outbox.jsonl");
  return { outbox: new Outbox(file), file };
}

function line(sequence: number): OutboxLine {
  return { sequence, update: { sessionUpdate: "state_update", state: "running" } };
}

async function flushed(
  cfg: { mode?: string; disposition?: string; fenceSeq?: string } = {},
) {
  fakeBin();
  process.env["FAKE_MODE"] = cfg.mode ?? "ok";
  process.env["FAKE_DISPOSITION"] = cfg.disposition ?? "recorded";
  process.env["FAKE_FENCE_SEQ"] = cfg.fenceSeq ?? "";
  const { outbox, file } = freshOutbox();
  outbox.add(line(1));
  outbox.add(line(2));
  const outcome = await outbox.flush(TARGET);
  return { ...outcome, remaining: new Outbox(file).size };
}

test("recorded receipts drain the outbox", async () => {
  const outcome = await flushed();
  assert.equal(outcome.error, null);
  assert.equal(outcome.delivered, 2);
  assert.equal(outcome.remaining, 0);
});

test("duplicate receipts also drain", async () => {
  const outcome = await flushed({ disposition: "duplicate" });
  assert.equal(outcome.delivered, 2);
  assert.equal(outcome.remaining, 0);
});

test("fenced receipts report supersession and drop", async () => {
  const outcome = await flushed({ fenceSeq: "1" });
  assert.equal(outcome.superseded, true);
  assert.equal(outcome.remaining, 0);
});

test("partial batches keep unreceipted records for retry", async () => {
  const outcome = await flushed({ mode: "partial" });
  assert.equal(outcome.delivered, 1);
  assert.equal(outcome.remaining, 1);
});

test("retryable errors keep everything", async () => {
  const outcome = await flushed({ mode: "error" });
  assert.notEqual(outcome.error, null);
  assert.equal(outcome.error?.retryable, true);
  assert.equal(outcome.remaining, 2);
});

test("reload_required surfaces for the pause path", async () => {
  const outcome = await flushed({ mode: "reload" });
  assert.equal(outcome.reloadRequired, true);
  assert.equal(outcome.remaining, 2);
});

test("unrecognized dispositions surface as errors, not silent retries", async () => {
  fakeBin();
  process.env["FAKE_MODE"] = "ok";
  process.env["FAKE_UNKNOWN_DISPO"] = "1";
  const { outbox, file } = freshOutbox();
  outbox.add(line(1));
  const outcome = await outbox.flush(TARGET);
  delete process.env["FAKE_UNKNOWN_DISPO"];
  assert.notEqual(outcome.error, null);
  assert.match(String(outcome.error?.message), /unrecognized receipt disposition/);
  assert.equal(new Outbox(file).size, 1);
});

test("load self-heals a torn line instead of poisoning the next append", () => {
  const dir = mkdtempSync(join(tmpdir(), "dq-outbox-"));
  const file = join(dir, "outbox.jsonl");
  const good = JSON.stringify(line(1));
  writeFileSync(file, `${good}\n{"sequence":2,"upd`);
  const outbox = new Outbox(file);
  assert.equal(outbox.size, 1);
  // A later append must not concatenate onto the torn fragment.
  outbox.add(line(3));
  const reloaded = Outbox.load(file);
  assert.deepEqual(reloaded.map((l) => l.sequence), [1, 3]);
});


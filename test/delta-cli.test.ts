import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFirstJson, runDelta, threadContract } from "../src/delta-cli.js";

function fakeDelta(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dq-fake-delta-"));
  const path = join(dir, "delta");
  writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

test("runDelta parses JSON stdout", async () => {
  process.env["DELTA_QWEN_DELTA_BIN"] = fakeDelta(
    `echo '{"operation":"contract","min":8,"max":12}'`,
  );
  const result = await threadContract();
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.operation, "contract");
    assert.equal(result.value.max, 12);
  }
});

test("runDelta surfaces JSON errors from stderr", async () => {
  process.env["DELTA_QWEN_DELTA_BIN"] = fakeDelta(
    `echo '{"error":{"message":"offline","retryable":true,"retry_after_ms":250}}' >&2; exit 1`,
  );
  const result = await runDelta(["thread", "append", "t"]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.retryable, true);
    assert.equal(result.error.retry_after_ms, 250);
  }
});

test("runDelta reports an unrunnable binary", async () => {
  process.env["DELTA_QWEN_DELTA_BIN"] = "/nonexistent/delta";
  const result = await runDelta(["thread", "contract"]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /failed to run delta/);
  }
});

test("parseFirstJson skips non-JSON lines", () => {
  assert.deepEqual(parseFirstJson<{ a: number }>("noise\n{\"a\":1}\n"), { a: 1 });
  assert.equal(parseFirstJson<object>("no json at all"), null);
});

test("parseFirstJson handles pretty-printed multi-line errors", () => {
  const pretty = 'delta: capture supports only the claude-code source\n{\n  "error": {\n    "code": "invalid_reference",\n    "reason": "invalid_identity",\n    "message": "capture supports only the claude-code source",\n    "retryable": false\n  }\n}\n';
  const parsed = parseFirstJson<Record<string, unknown>>(pretty);
  assert.notEqual(parsed, null);
  assert.equal((parsed!["error"] as Record<string, unknown>)["reason"], "invalid_identity");
});

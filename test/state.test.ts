import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, ensureDir, readJson } from "../src/lib/fsx.js";
import { deltaRoot, sessionDir } from "../src/lib/paths.js";

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dq-state-"));
  process.env["DELTA_QWEN_HOME"] = root;
  return root;
}

test("sessionDir rejects unsafe session ids", () => {
  freshRoot();
  assert.throws(() => sessionDir("../escape"));
  assert.throws(() => sessionDir("a/b"));
  assert.throws(() => sessionDir(""));
});

test("paths route through the override root", () => {
  const root = freshRoot();
  assert.equal(deltaRoot(), root);
  assert.equal(sessionDir("abc"), join(root, "sessions", "abc"));
});

test("ensureDir creates 0700 dirs and atomicWriteJson writes 0600 files", () => {
  freshRoot();
  const dir = join(mkdtempSync(join(tmpdir(), "dq-state-")), "s", "abc");
  ensureDir(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const file = join(dir, "state.json");
  atomicWriteJson(file, { a: 1 });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readJson<{ a: number }>(file), { a: 1 });
  assert.equal(readJson<object>(join(dir, "missing.json")), null);
});

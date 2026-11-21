import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPolicy, writePolicy, isSyncMode } from "../src/policy.js";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "dq-policy-"));
  mkdirSync(join(dir, ".git", "info"), { recursive: true });
  return dir;
}

test("default policy is manual", () => {
  assert.deepEqual(readPolicy(repo()), { mode: "manual" });
});

test("writePolicy round-trips and excludes .delta via git info/exclude", () => {
  const dir = repo();
  writePolicy(dir, { mode: "team", organization: "org_1" });
  assert.deepEqual(readPolicy(dir), { mode: "team", organization: "org_1" });
  const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /^\.delta\/$/m);
  // Writing again does not duplicate the exclude line.
  writePolicy(dir, { mode: "private" });
  const exclude2 = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
  assert.equal(exclude2.split("\n").filter((l) => l.trim() === ".delta/").length, 1);
  assert.deepEqual(readPolicy(dir), { mode: "private" });
});

test("isSyncMode validates modes", () => {
  assert.equal(isSyncMode("team"), true);
  assert.equal(isSyncMode("manual"), true);
  assert.equal(isSyncMode("private"), true);
  assert.equal(isSyncMode("bogus"), false);
  assert.equal(isSyncMode(undefined), false);
});

test("writePolicy without a .git dir still persists the policy", () => {
  const dir = mkdtempSync(join(tmpdir(), "dq-policy-nogit-"));
  writePolicy(dir, { mode: "private" });
  assert.deepEqual(readPolicy(dir), { mode: "private" });
  assert.equal(existsSync(join(dir, ".delta", "settings.json")), true);
});

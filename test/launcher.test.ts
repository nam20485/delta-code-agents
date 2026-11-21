import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLauncher } from "../src/lib/launcher.js";
import { launcherPath } from "../src/lib/paths.js";

test("ensureLauncher writes an executable launcher pointing at dist cli.js", () => {
  const root = mkdtempSync(join(tmpdir(), "dq-launcher-"));
  process.env["DELTA_QWEN_HOME"] = root;
  const hookJs = "/opt/ext/dist/src/hook.js";
  ensureLauncher(hookJs);
  const path = launcherPath();
  const content = readFileSync(path, "utf8");
  assert.match(content, /\/opt\/ext\/dist\/src\/cli\.js/);
  assert.equal((statSync(path).mode & 0o111) !== 0, true);
  // Rewriting is idempotent: same input, same content.
  ensureLauncher(hookJs);
  assert.equal(readFileSync(path, "utf8"), content);
});

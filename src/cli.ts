import { readdirSync } from "node:fs";
import { join } from "node:path";
import { REQUIRED_CONTRACT, resolveDeltaBinary, threadContract } from "./delta-cli.js";
import { readJson } from "./lib/fsx.js";
import { sessionsRoot } from "./lib/paths.js";
import { pidAlive } from "./lib/proc.js";

const USAGE = `delta-qwen CLI

Usage: delta-qwen <command>   (slash commands call this via ~/.qwen/delta/cli.js)

Commands:
  doctor    Check the delta CLI, its thread contract, and local session state.
  help      Show this help.

Slash commands (/delta-share, /delta-join, /delta-setup, /delta-inbox,
/delta-org) arrive with Milestone 4.
`;

interface SessionStateSummary {
  session_id?: unknown;
  qwen_pid?: unknown;
  port?: unknown;
  ended_at?: unknown;
}

async function doctor(): Promise<number> {
  const bin = resolveDeltaBinary();
  console.log(`delta binary: ${bin ?? "not found (install from https://delta.dev)"}`);
  if (bin !== null) {
    const result = await threadContract();
    if (result.ok) {
      const { min, max } = result.value;
      const compatible = max >= REQUIRED_CONTRACT;
      console.log(
        `thread contract: min ${min}, max ${max} (need max >= ${REQUIRED_CONTRACT}) ` +
          (compatible ? "ok" : "INCOMPATIBLE — update Delta"),
      );
    } else {
      console.log(`thread contract: failed (${result.error.message})`);
    }
  }
  console.log(`sessions root: ${sessionsRoot()}`);
  let listed = 0;
  try {
    for (const entry of readdirSync(sessionsRoot(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      listed += 1;
      const state = readJson<SessionStateSummary>(
        join(sessionsRoot(), entry.name, "state.json"),
      );
      if (state === null) {
        console.log(`  ${entry.name}: (no state)`);
        continue;
      }
      const pid = typeof state.qwen_pid === "number" ? state.qwen_pid : null;
      const owner =
        pid === null ? "owner unknown" : pidAlive(pid) ? "alive" : "dead";
      const ended = typeof state.ended_at === "string" ? ", ended" : "";
      console.log(`  ${entry.name}: ${owner}${ended}`);
    }
  } catch {
    // No sessions root yet.
  }
  if (listed === 0) console.log("  (none)");
  return 0;
}

const command = process.argv[2] ?? "help";
if (command === "doctor") {
  process.exit(await doctor());
} else if (command === "help") {
  process.stdout.write(USAGE);
} else {
  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
  process.exit(1);
}

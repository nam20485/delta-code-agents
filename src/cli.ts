import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { REQUIRED_CONTRACT, resolveDeltaBinary, threadContract } from "./delta-cli.js";
import { readJson } from "./lib/fsx.js";
import { sessionsRoot } from "./lib/paths.js";
import { pidAlive } from "./lib/proc.js";
import { routerPort } from "./router/router.js";

const USAGE = `delta-qwen CLI

Usage: delta-qwen <command>   (slash commands call this via ~/.qwen/delta/cli.js)

Commands:
  share [--confirm]   Share the current directory's Qwen session to your org
  doctor              Check the delta CLI, thread contract, router, sessions
  help                Show this help

Slash commands (/delta-share, /delta-join, /delta-setup, /delta-inbox,
/delta-org) arrive with Milestone 4.
`;

interface SessionStateSummary {
  session_id?: unknown;
  cwd?: unknown;
  qwen_pid?: unknown;
  port?: unknown;
  token?: unknown;
  updated_at?: unknown;
  ended_at?: unknown;
}

/** Find the newest live session sidecar whose cwd matches `cwd`. */
function findSessionByCwd(cwd: string): SessionStateSummary | null {
  const root = sessionsRoot();
  const realCwd = realpathOrNull(cwd) ?? cwd;
  let best: SessionStateSummary | null = null;
  let bestUpdated = "";
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const state = readJson<SessionStateSummary>(join(root, entry.name, "state.json"));
      if (state === null) continue;
      if (state["ended_at"] !== undefined) continue;
      const stateCwd = typeof state["cwd"] === "string" ? state["cwd"] : "";
      if (stateCwd !== cwd && (realpathOrNull(stateCwd) ?? stateCwd) !== realCwd) continue;
      const updated = typeof state["updated_at"] === "string" ? state["updated_at"] : "";
      if (updated >= bestUpdated) {
        best = state;
        bestUpdated = updated;
      }
    }
  } catch {
    return null;
  }
  return best;
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

interface ShareResponse {
  status?: unknown;
  message?: unknown;
  thread_id?: unknown;
  url?: unknown;
  warning?: unknown;
}

async function share(confirm: boolean): Promise<number> {
  const session = findSessionByCwd(process.cwd());
  if (session === null || typeof session["port"] !== "number" || typeof session["token"] !== "string") {
    console.error(
      "No live delta-qwen session found for this directory. Start a Qwen Code " +
        "session here first (its SessionStart hook creates the session state).",
    );
    return 1;
  }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${session["port"]}/share`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session["token"]}`,
      },
      body: JSON.stringify({ confirm }),
      // Worst-case first share: contract + create + adoption + share, each
      // a delta call with its own 15s budget, run serially on the sidecar.
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      console.error(
        "The share request is still running on the sidecar (slow network?); " +
          "check `delta-qwen doctor` before retrying.",
      );
      return 1;
    }
    console.error(`Cannot reach the session sidecar: ${String(err)}`);
    return 1;
  }
  if (!res.ok) {
    console.error(`Sidecar share failed (HTTP ${res.status}).`);
    return 1;
  }
  const body = (await res.json()) as ShareResponse;
  if (body["status"] === "consent_required") {
    console.log(typeof body["message"] === "string" ? body["message"] : "Consent required.");
    return 0;
  }
  if (body["status"] !== "shared") {
    console.error(`Share failed: ${String(body["message"])}`);
    return 1;
  }
  console.log(`Shared thread: ${String(body["thread_id"])}`);
  if (typeof body["url"] === "string") console.log(`Open in Delta: ${body["url"]}`);
  if (typeof body["warning"] === "string") console.log(`Note: ${body["warning"]}`);
  return 0;
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
  try {
    const res = await fetch(`http://127.0.0.1:${routerPort()}/health`, {
      signal: AbortSignal.timeout(500),
    });
    console.log(
      `router: ${res.ok ? `running on port ${routerPort()}` : `unhealthy (HTTP ${res.status})`}`,
    );
  } catch {
    console.log("router: not running (starts with the next Qwen session)");
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
if (command === "share") {
  process.exit(await share(process.argv.includes("--confirm")));
} else if (command === "doctor") {
  process.exit(await doctor());
} else if (command === "help") {
  process.stdout.write(USAGE);
} else {
  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
  process.exit(1);
}

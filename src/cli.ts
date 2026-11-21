import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { REQUIRED_CONTRACT, resolveDeltaBinary, runDelta, threadContract } from "./delta-cli.js";
import { readJson } from "./lib/fsx.js";
import { sessionsRoot } from "./lib/paths.js";
import { pidAlive } from "./lib/proc.js";
import { routerPort } from "./router/router.js";

const USAGE = `delta-qwen CLI

Usage: delta-qwen <command>   (slash commands call this via ~/.qwen/delta/cli.js)

Commands:
  share [--confirm] [emails...]  Share this directory's session (org, or invite emails)
  setup <private|team|manual> [--org ID]  Set this repo's sync policy
  join <link>           Join a shared thread; prints the checkout directory
  pause                 Stop recording/sync for this session (thread kept)
  unshare               Make the thread private (invitations retained)
  inbox                 Show pending teammate activity
  org <list|current|switch|create|invite> ...  Manage Delta teams
  doctor                Check the delta CLI, contract, router, sessions
  help                  Show this help
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
  directory?: unknown;
  pending?: unknown;
  text?: unknown;
}

/** POST/GET the session sidecar for this cwd; null when no live session. */
async function sidecarCall(
  path: string,
  body?: unknown,
  method: "POST" | "GET" = "POST",
  timeoutMs = 90_000,
): Promise<ShareResponse | null> {
  const session = findSessionByCwd(process.cwd());
  if (session === null || typeof session["port"] !== "number" || typeof session["token"] !== "string") {
    return null;
  }
  const res = await fetch(`http://127.0.0.1:${session["port"]}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session["token"]}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return { status: "error", message: `sidecar ${path} failed (HTTP ${res.status})` };
  return (await res.json()) as ShareResponse;
}

function noSession(): number {
  console.error(
    "No live delta-qwen session found for this directory. Start a Qwen Code " +
      "session here first (its SessionStart hook creates the session state).",
  );
  return 1;
}

function printShare(body: ShareResponse): number {
  if (body["status"] === "consent_required") {
    console.log(typeof body["message"] === "string" ? body["message"] : "Consent required.");
    return 0;
  }
  if (body["status"] === "error") {
    console.error(`Failed: ${String(body["message"])}`);
    return 1;
  }
  if (typeof body["thread_id"] === "string" && body["thread_id"].length > 0) {
    console.log(`Thread: ${body["thread_id"]}`);
  }
  if (typeof body["url"] === "string") console.log(`Open in Delta: ${body["url"]}`);
  if (typeof body["directory"] === "string") console.log(`Checkout: ${body["directory"]}`);
  if (typeof body["message"] === "string") console.log(body["message"]);
  if (typeof body["warning"] === "string") console.log(`Note: ${body["warning"]}`);
  return 0;
}

async function share(confirm: boolean, emails: string[]): Promise<number> {
  let body: ShareResponse | null;
  try {
    body = await sidecarCall("/share", { confirm, emails });
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
  if (body === null) return noSession();
  return printShare(body);
}

async function setup(mode: string, org: string | undefined): Promise<number> {
  if (mode !== "private" && mode !== "team" && mode !== "manual") {
    console.error("usage: delta-qwen setup <private|team|manual> [--org ID]");
    return 1;
  }
  const body = await sidecarCall("/setup", { mode, ...(org !== undefined ? { organization: org } : {}) }).catch(() => null);
  if (body === null) return noSession();
  console.log(`Sync policy for this repository: ${mode}`);
  return printShare(body);
}

async function joinThreadCmd(link: string): Promise<number> {
  if (link.length === 0) {
    console.error("usage: delta-qwen join <thread-link>");
    return 1;
  }
  const body = await sidecarCall("/join", { link }, "POST", 120_000).catch(() => null);
  if (body === null) return noSession();
  return printShare(body);
}

async function simplePost(path: string): Promise<number> {
  const body = await sidecarCall(path, {}).catch(() => null);
  if (body === null) return noSession();
  return printShare(body);
}

async function inbox(): Promise<number> {
  const body = await sidecarCall("/inbox", undefined, "GET", 10_000).catch(() => null);
  if (body === null) return noSession();
  console.log(typeof body["text"] === "string" ? body["text"] : "(no remote activity)");
  return 0;
}

async function org(args: string[]): Promise<number> {
  const sub = args[0] ?? "list";
  const allowed = ["list", "current", "switch", "create", "invite"];
  if (!allowed.includes(sub)) {
    console.error(`usage: delta-qwen org <${allowed.join("|")}> ...`);
    return 1;
  }
  const result = await runDelta<Record<string, unknown>>(["org", sub, ...args.slice(1)]);
  if (!result.ok) {
    console.error(`org ${sub} failed: ${result.error.message}`);
    return 1;
  }
  console.log(JSON.stringify(result.value, null, 2));
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
const rest = process.argv.slice(3);
if (command === "share") {
  const emails = rest.filter((a) => !a.startsWith("--") && a !== "confirm");
  const confirm = process.argv.includes("--confirm") || rest.includes("confirm");
  process.exit(await share(confirm, emails));
} else if (command === "setup") {
  const mode = rest.find((a) => !a.startsWith("--")) ?? "";
  const orgIdx = rest.indexOf("--org");
  const org = orgIdx !== -1 ? rest[orgIdx + 1] : undefined;
  process.exit(await setup(mode, org));
} else if (command === "join") {
  process.exit(await joinThreadCmd(rest[0] ?? ""));
} else if (command === "pause") {
  process.exit(await simplePost("/pause"));
} else if (command === "unshare") {
  process.exit(await simplePost("/unshare"));
} else if (command === "inbox") {
  process.exit(await inbox());
} else if (command === "org") {
  process.exit(await org(rest));
} else if (command === "doctor") {
  process.exit(await doctor());
} else if (command === "help") {
  process.stdout.write(USAGE);
} else {
  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
  process.exit(1);
}

import { spawn } from "node:child_process";
import { closeSync, openSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ensureLauncher } from "./lib/launcher.js";
import { ensureDir } from "./lib/fsx.js";
import { findQwenPid } from "./lib/proc.js";
import { deltaRoot } from "./lib/paths.js";
import { routerPort } from "./router/router.js";
const ROUTER_REQUEST_TIMEOUT_MS = 2_000;
const ROUTER_SPAWN_WAIT_MS = 3_000;
const HEALTH_POLL_MS = 100;
const HEALTH_PROBE_TIMEOUT_MS = 500;
async function routerHealthy() {
    try {
        const res = await fetch(`http://127.0.0.1:${routerPort()}/health`, {
            signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
        });
        return res.ok;
    }
    catch {
        return false;
    }
}
async function waitForRouter(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await routerHealthy())
            return true;
        if (Date.now() >= deadline)
            return false;
        await delay(HEALTH_POLL_MS);
    }
}
function tryLock(path) {
    try {
        closeSync(openSync(path, "wx", 0o600));
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Ensure the user-level router is running. Guarded by an exclusive lock so
 * parallel dispatchers cannot spawn two routers; it is spawned fully detached
 * (own session, no pipes, unref'd) so nothing in Qwen's lifecycle reaps it.
 */
async function ensureRouter() {
    if (await routerHealthy())
        return true;
    ensureDir(deltaRoot());
    const lockPath = deltaRoot() + "/router.lock";
    let haveLock = tryLock(lockPath);
    if (!haveLock) {
        if (await waitForRouter(ROUTER_SPAWN_WAIT_MS))
            return true;
        try {
            unlinkSync(lockPath);
        }
        catch {
            return false;
        }
        haveLock = tryLock(lockPath);
        if (!haveLock)
            return false;
    }
    try {
        const routerJs = fileURLToPath(new URL("./router/router.js", import.meta.url));
        const child = spawn(process.execPath, [routerJs], {
            detached: true,
            stdio: "ignore",
        });
        child.unref();
        return await waitForRouter(ROUTER_SPAWN_WAIT_MS);
    }
    finally {
        try {
            unlinkSync(lockPath);
        }
        catch {
            // Already removed.
        }
    }
}
function readStdin() {
    return new Promise((resolve) => {
        if (process.stdin.isTTY === true) {
            resolve("");
            return;
        }
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
            data += chunk;
        });
        process.stdin.on("end", () => resolve(data));
        process.stdin.on("error", () => resolve(data));
    });
}
/**
 * Hook dispatcher. In production Qwen invokes this only for SessionStart
 * (every other event is a native http hook straight to the router); manual
 * invocations with other events are forwarded unchanged. Failure policy:
 * fail open, always exit 0, never print on failure — exit 2 would block
 * startup. Only a router response with content is printed.
 */
async function main() {
    const raw = await readStdin();
    let event;
    try {
        event = raw.trim().length > 0 ? JSON.parse(raw) : {};
    }
    catch {
        return 0;
    }
    const sessionId = event["session_id"];
    if (typeof sessionId !== "string" || sessionId.length === 0)
        return 0;
    if (event["hook_event_name"] === "SessionStart") {
        // Once per session: refresh the launcher and learn qwen's pid — http
        // hooks cannot walk the process tree, so this is the only chance.
        try {
            ensureLauncher(fileURLToPath(import.meta.url));
        }
        catch {
            // Launcher upkeep is best-effort.
        }
        const qwenPid = findQwenPid(process.pid);
        if (qwenPid !== null) {
            event = { ...event, delta_qwen_pid: qwenPid };
        }
        if (!(await ensureRouter()))
            return 0;
    }
    const payload = { ...event, delta_dispatcher_pid: process.pid };
    try {
        const res = await fetch(`http://127.0.0.1:${routerPort()}/event`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(ROUTER_REQUEST_TIMEOUT_MS),
        });
        if (!res.ok)
            return 0;
        const text = await res.text();
        if (text.trim().length === 0)
            return 0;
        let body;
        try {
            body = JSON.parse(text);
        }
        catch {
            return 0;
        }
        if (Object.keys(body).length > 0) {
            process.stdout.write(`${JSON.stringify(body)}\n`);
        }
    }
    catch {
        // Fail open.
    }
    return 0;
}
void main()
    .then((code) => process.exit(code))
    .catch(() => process.exit(0));

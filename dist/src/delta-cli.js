import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";
/** Contract version this plugin is built against (see delta.dev plugin guide). */
export const REQUIRED_CONTRACT = 8;
/**
 * Normalize a parsed error payload. The CLI wraps errors as
 * `{"error":{...}}` (the plugin guide's `error.retryable`), but accept a bare
 * error object too. Unknown fields are dropped.
 */
function normalizeError(parsed) {
    const inner = parsed["error"] !== null && typeof parsed["error"] === "object"
        ? parsed["error"]
        : parsed;
    const message = typeof inner["message"] === "string" ? inner["message"] : "delta command failed";
    const error = { message };
    if (typeof inner["retryable"] === "boolean")
        error.retryable = inner["retryable"];
    if (typeof inner["retry_after_ms"] === "number")
        error.retry_after_ms = inner["retry_after_ms"];
    if (typeof inner["reason"] === "string")
        error.reason = inner["reason"];
    return error;
}
/** PATH first, then default install locations. Env override for tests. */
export function resolveDeltaBinary() {
    const override = process.env["DELTA_QWEN_DELTA_BIN"];
    if (override !== undefined && override.length > 0)
        return override;
    const exe = process.platform === "win32" ? "delta.exe" : "delta";
    const pathEnv = process.env["PATH"] ?? "";
    for (const dir of pathEnv.split(delimiter)) {
        if (dir.length > 0 && existsSync(join(dir, exe)))
            return join(dir, exe);
    }
    const candidates = [join(homedir(), ".local", "delta.app", "bin", exe)];
    const localAppData = process.env["LOCALAPPDATA"];
    if (localAppData !== undefined && localAppData.length > 0) {
        candidates.push(join(localAppData, "Delta", "bin", exe));
    }
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return candidate;
    }
    return null;
}
/**
 * First JSON value in `text`: a fast per-line pass, then a substring pass
 * for pretty-printed multi-line error objects (`{ ... }` spanning lines).
 */
export function parseFirstJson(text) {
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{") && !trimmed.startsWith("["))
            continue;
        try {
            return JSON.parse(trimmed);
        }
        catch {
            // Try the next strategy.
        }
    }
    const head = text.slice(0, 65_536);
    const first = head.indexOf("{");
    const last = head.lastIndexOf("}");
    if (first !== -1 && last > first) {
        try {
            return JSON.parse(head.slice(first, last + 1));
        }
        catch {
            // Not JSON after all.
        }
    }
    return null;
}
/** Run `delta --json <args>` and parse the JSON result. */
export function runDelta(args, options = {}) {
    const bin = resolveDeltaBinary();
    if (bin === null) {
        return Promise.resolve({
            ok: false,
            error: { message: "delta CLI not found; install it from https://delta.dev" },
            stderr: "",
        });
    }
    return new Promise((resolve) => {
        const child = spawn(bin, ["--json", ...args], { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
        }, options.timeoutMs ?? 15_000);
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", (err) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({ ok: false, error: { message: `failed to run delta: ${err.message}` }, stderr });
        });
        // EPIPE when delta exits before draining stdin is not a sidecar crash;
        // it flows through the normal exit-code path.
        child.stdin.on("error", () => { });
        child.on("close", (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            const parsed = parseFirstJson(stdout);
            if (code === 0 && parsed !== null) {
                resolve({ ok: true, value: parsed });
                return;
            }
            const errJson = parseFirstJson(stderr) ??
                parseFirstJson(stdout);
            resolve({
                ok: false,
                error: errJson !== null
                    ? normalizeError(errJson)
                    : { message: `delta exited with code ${code ?? "signal"}` },
                stderr,
            });
        });
        if (options.input !== undefined) {
            child.stdin.end(options.input);
        }
        else {
            child.stdin.end();
        }
    });
}
export function threadContract() {
    return runDelta(["thread", "contract"]);
}
/** The currently selected organization id, or null. Used to record an upload
 * intent on private threads so records can append before sharing. */
export async function currentOrganization() {
    const result = await runDelta(["org", "current"]);
    if (!result.ok)
        return null;
    const id = result.value.organization?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
}
function spawnCollect(bin, args, options) {
    return new Promise((resolve) => {
        const child = spawn(bin, ["--json", ...args], { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
        }, options.timeoutMs ?? 15_000);
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({ code: null, stdout, stderr });
        });
        // EPIPE on early exit / timeout kill must not crash the caller.
        child.stdin.on("error", () => { });
        child.on("close", (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({ code: code ?? null, stdout, stderr });
        });
        if (options.input !== undefined) {
            child.stdin.end(options.input);
        }
        else {
            child.stdin.end();
        }
    });
}
/**
 * Run a delta command whose stdout is one JSON object per line (e.g.
 * `thread append`, which reports a receipt per record). Fails when the exit
 * code is non-zero; unparsable lines are skipped.
 */
export async function runDeltaJsonl(args, options = {}) {
    const bin = resolveDeltaBinary();
    if (bin === null) {
        return {
            ok: false,
            error: { message: "delta CLI not found; install it from https://delta.dev" },
            stderr: "",
        };
    }
    const out = await spawnCollect(bin, args, options);
    const lines = out.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("{"))
        .map((line) => {
        try {
            return JSON.parse(line);
        }
        catch {
            return null;
        }
    })
        .filter((line) => line !== null);
    if (out.code === 0) {
        return { ok: true, value: { lines } };
    }
    const errJson = parseFirstJson(out.stderr) ??
        parseFirstJson(out.stdout);
    return {
        ok: false,
        error: errJson !== null
            ? normalizeError(errJson)
            : { message: `delta exited with code ${out.code ?? "signal"}` },
        stderr: out.stderr,
    };
}

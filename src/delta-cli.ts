import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";

/** Contract version this plugin is built against (see delta.dev plugin guide). */
export const REQUIRED_CONTRACT = 8;

/** Error shape the delta CLI reports in `--json` error output. */
export interface DeltaError {
  message: string;
  retryable?: boolean;
  retry_after_ms?: number;
  reason?: string;
}

/**
 * Normalize a parsed error payload. The CLI wraps errors as
 * `{"error":{...}}` (the plugin guide's `error.retryable`), but accept a bare
 * error object too. Unknown fields are dropped.
 */
function normalizeError(parsed: Record<string, unknown>): DeltaError {
  const inner =
    parsed["error"] !== null && typeof parsed["error"] === "object"
      ? (parsed["error"] as Record<string, unknown>)
      : parsed;
  const message = typeof inner["message"] === "string" ? inner["message"] : "delta command failed";
  const error: DeltaError = { message };
  if (typeof inner["retryable"] === "boolean") error.retryable = inner["retryable"];
  if (typeof inner["retry_after_ms"] === "number") error.retry_after_ms = inner["retry_after_ms"];
  if (typeof inner["reason"] === "string") error.reason = inner["reason"];
  return error;
}

export interface DeltaRunOptions {
  input?: string;
  timeoutMs?: number;
}

export type DeltaResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DeltaError; stderr: string };

/** PATH first, then default install locations. Env override for tests. */
export function resolveDeltaBinary(): string | null {
  const override = process.env["DELTA_QWEN_DELTA_BIN"];
  if (override !== undefined && override.length > 0) return override;
  const exe = process.platform === "win32" ? "delta.exe" : "delta";
  const pathEnv = process.env["PATH"] ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length > 0 && existsSync(join(dir, exe))) return join(dir, exe);
  }
  const candidates = [join(homedir(), ".local", "delta.app", "bin", exe)];
  const localAppData = process.env["LOCALAPPDATA"];
  if (localAppData !== undefined && localAppData.length > 0) {
    candidates.push(join(localAppData, "Delta", "bin", exe));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** First JSON object line in `text`, or null. */
export function parseFirstJson<T>(text: string): T | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      // Try the next line.
    }
  }
  return null;
}

/** Run `delta --json <args>` and parse the JSON result. */
export function runDelta<T>(args: readonly string[], options: DeltaRunOptions = {}): Promise<DeltaResult<T>> {
  const bin = resolveDeltaBinary();
  if (bin === null) {
    return Promise.resolve({
      ok: false,
      error: { message: "delta CLI not found; install it from https://delta.dev" },
      stderr: "",
    });
  }
  return new Promise<DeltaResult<T>>((resolve) => {
    const child = spawn(bin, ["--json", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: { message: `failed to run delta: ${err.message}` }, stderr });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parsed = parseFirstJson<T>(stdout);
      if (code === 0 && parsed !== null) {
        resolve({ ok: true, value: parsed });
        return;
      }
      const errJson =
        parseFirstJson<Record<string, unknown>>(stderr) ??
        parseFirstJson<Record<string, unknown>>(stdout);
      resolve({
        ok: false,
        error:
          errJson !== null
            ? normalizeError(errJson)
            : { message: `delta exited with code ${code ?? "signal"}` },
        stderr,
      });
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

export interface ContractInfo {
  operation: "contract";
  min: number;
  max: number;
}

export function threadContract(): Promise<DeltaResult<ContractInfo>> {
  return runDelta<ContractInfo>(["thread", "contract"]);
}

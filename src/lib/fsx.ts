import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

/** mkdir with explicit perms (mkdir mode is masked by umask, so chmod after). */
export function ensureDir(path: string, mode = 0o700): void {
  mkdirSync(path, { recursive: true, mode });
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort on filesystems that reject chmod.
  }
}

/** Write via tmp+rename so readers never see a partial file. */
export function atomicWriteFile(path: string, data: string, mode = 0o600): void {
  ensureDir(dirname(path), 0o700);
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, data, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Ignore cleanup failure.
    }
    throw err;
  }
}

export function atomicWriteJson(path: string, value: unknown, mode = 0o600): void {
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

/** Parse a JSON file, or null when missing/unreadable/invalid. */
export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

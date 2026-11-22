import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
/** Liveness check via signal 0. EPERM means alive but not ours. */
export function pidAlive(pid) {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === "EPERM";
    }
}
function commandOf(pid) {
    try {
        return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
    }
    catch {
        try {
            return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
                encoding: "utf8",
            }).trim();
        }
        catch {
            return null;
        }
    }
}
function parentOf(pid) {
    try {
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        const match = /^PPid:\s+(\d+)$/m.exec(status);
        return match === null ? null : Number.parseInt(match[1], 10);
    }
    catch {
        try {
            const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
                encoding: "utf8",
            }).trim();
            const ppid = Number.parseInt(out, 10);
            return Number.isInteger(ppid) ? ppid : null;
        }
        catch {
            return null;
        }
    }
}
/**
 * Walk the parent chain from `startPid` looking for the Qwen Code process.
 * Command hooks are children of qwen (possibly through a shell), so the owner
 * is the first ancestor whose command line mentions qwen. Cached by the
 * sidecar in session state, so normally walked once per session.
 */
export function findQwenPid(startPid) {
    let pid = startPid;
    for (let depth = 0; depth < 16 && pid > 1; depth++) {
        const cmd = commandOf(pid);
        if (cmd !== null && /\bqwen\b/.test(cmd))
            return pid;
        const ppid = parentOf(pid);
        if (ppid === null || ppid === pid)
            return null;
        pid = ppid;
    }
    return null;
}

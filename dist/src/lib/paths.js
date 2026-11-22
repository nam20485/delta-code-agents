import { homedir } from "node:os";
import { join } from "node:path";
/** Root for all delta-qwen user state. Overridable for tests. */
export function deltaRoot() {
    const override = process.env["DELTA_QWEN_HOME"];
    if (override !== undefined && override.length > 0)
        return override;
    return join(homedir(), ".qwen", "delta");
}
export function sessionsRoot() {
    return join(deltaRoot(), "sessions");
}
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
/** State directory for one Qwen session. Validates the id: it names a path. */
export function sessionDir(sessionId) {
    if (!SESSION_ID_RE.test(sessionId)) {
        throw new Error(`refusing unsafe session id: ${JSON.stringify(sessionId)}`);
    }
    return join(sessionsRoot(), sessionId);
}
/** Stable entrypoint slash commands call (`!{}` runs in the session cwd). */
export function launcherPath() {
    return join(deltaRoot(), "cli.js");
}

import { mkdirSync, readFileSync, appendFileSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { atomicWriteJson, readJson } from "./lib/fsx.js";
const MODES = new Set(["private", "team", "manual"]);
export function isSyncMode(value) {
    return typeof value === "string" && MODES.has(value);
}
function policyFile(cwd) {
    return join(cwd, ".delta", "settings.json");
}
/** Read the repository's sync policy, defaulting to manual (record nothing). */
export function readPolicy(cwd) {
    const saved = readJson(policyFile(cwd));
    if (saved !== null && isSyncMode(saved.mode)) {
        const policy = { mode: saved.mode };
        if (typeof saved.organization === "string")
            policy.organization = saved.organization;
        return policy;
    }
    return { mode: "manual" };
}
/**
 * Resolve the directory that holds `info/exclude`. In a linked worktree or
 * submodule, `cwd/.git` is a file containing a `gitdir:` pointer; the exclude
 * file lives in the common git dir. Returns null when it cannot be resolved.
 */
function resolveGitCommonDir(cwd) {
    const dotGit = join(cwd, ".git");
    let gitDir;
    try {
        const st = statSync(dotGit);
        if (st.isDirectory()) {
            gitDir = dotGit;
        }
        else if (st.isFile()) {
            const pointer = readFileSync(dotGit, "utf8").trim();
            const match = /^gitdir:\s*(.+)$/.exec(pointer);
            if (match === null)
                return null;
            const target = match[1].trim();
            gitDir = isAbsolute(target) ? target : join(cwd, target);
        }
        else {
            return null;
        }
    }
    catch {
        return null;
    }
    // A worktree gitdir has a `commondir` file pointing at the shared git dir.
    try {
        const common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
        if (common.length > 0) {
            return isAbsolute(common) ? common : join(gitDir, common);
        }
    }
    catch {
        // No commondir: gitDir itself is the common dir.
    }
    return gitDir;
}
/**
 * Persist the policy and keep `.delta/` out of Git via `info/exclude` (no
 * tracked-file churn in the user's repo). The exclude update is best-effort:
 * it must never fail the setup (the policy is already persisted, and a failed
 * exclude would otherwise report failure while the mode silently takes effect).
 */
export function writePolicy(cwd, policy) {
    mkdirSync(join(cwd, ".delta"), { recursive: true });
    atomicWriteJson(policyFile(cwd), policy, 0o600);
    try {
        const gitDir = resolveGitCommonDir(cwd);
        if (gitDir === null)
            return;
        const excludePath = join(gitDir, "info", "exclude");
        let existing = "";
        try {
            existing = readFileSync(excludePath, "utf8");
        }
        catch {
            // No exclude file yet.
        }
        if (!existing.split("\n").some((line) => line.trim() === ".delta/")) {
            mkdirSync(join(gitDir, "info"), { recursive: true });
            appendFileSync(excludePath, `${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}.delta/\n`);
        }
    }
    catch {
        // Best-effort: a worktree/submodule layout we cannot update must not fail
        // the setup or diverge consent from the persisted policy.
    }
}

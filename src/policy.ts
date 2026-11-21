import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, readJson } from "./lib/fsx.js";

export type SyncMode = "private" | "team" | "manual";

export interface ProjectPolicy {
  mode: SyncMode;
  organization?: string;
}

const MODES: ReadonlySet<string> = new Set(["private", "team", "manual"]);

export function isSyncMode(value: unknown): value is SyncMode {
  return typeof value === "string" && MODES.has(value);
}

function policyFile(cwd: string): string {
  return join(cwd, ".delta", "settings.json");
}

/** Read the repository's sync policy, defaulting to manual (record nothing). */
export function readPolicy(cwd: string): ProjectPolicy {
  const saved = readJson<{ mode?: unknown; organization?: unknown }>(policyFile(cwd));
  if (saved !== null && isSyncMode(saved.mode)) {
    const policy: ProjectPolicy = { mode: saved.mode };
    if (typeof saved.organization === "string") policy.organization = saved.organization;
    return policy;
  }
  return { mode: "manual" };
}

/**
 * Persist the policy and keep `.delta/` out of Git via `.git/info/exclude`
 * (no tracked-file churn in the user's repo). The choice is the user's, not
 * the repository's.
 */
export function writePolicy(cwd: string, policy: ProjectPolicy): void {
  mkdirSync(join(cwd, ".delta"), { recursive: true });
  atomicWriteJson(policyFile(cwd), policy, 0o600);
  const gitDir = join(cwd, ".git");
  if (!existsSync(gitDir)) return;
  const excludePath = join(gitDir, "info", "exclude");
  let existing = "";
  try {
    existing = readFileSync(excludePath, "utf8");
  } catch {
    // No exclude file yet.
  }
  if (!existing.split("\n").some((line) => line.trim() === ".delta/")) {
    mkdirSync(join(gitDir, "info"), { recursive: true });
    appendFileSync(excludePath, `${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}.delta/\n`);
  }
}

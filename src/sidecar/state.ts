import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { atomicWriteJson, readJson } from "../lib/fsx.js";

/** Persisted per-session sidecar state (`state.json`, mode 0600). */
export interface SessionState {
  version: 1;
  session_id: string;
  /** External id for `delta thread create`; suffixed on `clear` (M2). */
  external_id: string;
  clear_count: number;
  /** Qwen Code owner process, learned from the first hook event. */
  qwen_pid: number | null;
  port: number;
  token: string;
  created_at: string;
  updated_at: string;
  ended_at?: string;
}

export function newState(sessionId: string): SessionState {
  const now = new Date().toISOString();
  return {
    version: 1,
    session_id: sessionId,
    external_id: sessionId,
    clear_count: 0,
    qwen_pid: null,
    port: 0,
    token: randomBytes(24).toString("hex"),
    created_at: now,
    updated_at: now,
  };
}

export function stateFile(dir: string): string {
  return join(dir, "state.json");
}

export function loadState(dir: string): SessionState | null {
  return readJson<SessionState>(stateFile(dir));
}

export function saveState(dir: string, state: SessionState): void {
  state.updated_at = new Date().toISOString();
  atomicWriteJson(stateFile(dir), state);
}

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { atomicWriteJson, readJson } from "../lib/fsx.js";

/** Persisted per-session sidecar state (`state.json`, mode 0600). */
export interface SessionState {
  version: 1;
  session_id: string;
  /** External id for `delta thread create`; suffixed on `clear` (M4). */
  external_id: string;
  clear_count: number;
  /** Qwen Code owner process, learned from the first hook event. */
  qwen_pid: number | null;
  port: number;
  token: string;
  /** Session working directory (SessionStart payload), for cli discovery. */
  cwd: string;
  created_at: string;
  updated_at: string;
  ended_at?: string;
  recording?: RecordingState;
}

/** Recording enablement, thread identity, and record counters. */
export interface RecordingState {
  enabled: boolean;
  consent: "none" | "asked" | "granted";
  thread_id: string;
  worktree_reference?: string;
  /** Next record sequence; never reused, survives outbox draining. */
  next_sequence: number;
  superseded: boolean;
  /** Paused after `reload_required` until the user resolves the thread. */
  paused: boolean;
  /** Capture disabled when the CLI rejects our source. */
  capture_enabled: boolean;
  titled: boolean;
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
    cwd: "",
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

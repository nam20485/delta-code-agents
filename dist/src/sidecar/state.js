import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { atomicWriteJson, readJson } from "../lib/fsx.js";
export function newState(sessionId) {
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
        generation: 0,
        created_at: now,
        updated_at: now,
    };
}
export function stateFile(dir) {
    return join(dir, "state.json");
}
export function loadState(dir) {
    const state = readJson(stateFile(dir));
    if (state === null)
        return null;
    // Migrate pre-generation state: a missing/non-numeric generation would
    // otherwise produce outbox-undefined.jsonl / NaN filenames and strand
    // legacy records and inbox delivered flags.
    if (typeof state.generation !== "number" || !Number.isFinite(state.generation)) {
        state.generation = 0;
    }
    if (typeof state.clear_count !== "number")
        state.clear_count = 0;
    return state;
}
export function saveState(dir, state) {
    state.updated_at = new Date().toISOString();
    atomicWriteJson(stateFile(dir), state);
}

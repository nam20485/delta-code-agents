import type { AcpUpdate, DeltaRecord } from "../records.js";
import {
  agentMessage,
  sessionInfoUpdate,
  stateUpdate,
  toolCallUpdate,
  truncate,
  userMessage,
} from "../records.js";
import type { FlushOutcome, FlushTarget, OutboxLine } from "./outbox.js";
import type { RecordingState } from "./state.js";
export interface RecorderDeps {
  /** Outbox or an in-memory sink with the same shape (tests). */
  outbox: OutboxLike;
  /** Live recording state; the recorder mutates counters and flags. */
  recording: RecordingState;
  /** Fire-and-forget capture control; may be a no-op. */
  capture: {
    start(toolCallId: string, toolName: string): void;
    stop(toolCallId: string, toolName: string): void;
  };
  log(line: string): void;
  save(): void;
}

/** The outbox surface the recorder depends on. */
export interface OutboxLike {
  add(line: OutboxLine): void;
  readonly size: number;
  maxPendingSequence(): number;
  flush(target: FlushTarget): Promise<FlushOutcome>;
}

interface MessageProgress {
  text: string;
  final: boolean;
}

interface TurnInfo {
  turnSequence: number;
  /** Last streamed message id and whether its `is_final` arrived. */
  lastMessageId: string | null;
  lastMessageFinal: boolean;
}

/**
 * Translates hook events into Delta records per the plan's event→record
 * mapping. Ordering rules from the Qwen docs: once a `message_id` is final,
 * later (stale) posts are ignored; before final, only longer cumulative text
 * is re-sent; `Stop`'s fallback reuses the turn's last `message_id`.
 *
 * After supersession (a `fenced` receipt), no *new* turn content is started
 * (no prompts, no new tool calls), but late streamed finals and tool
 * completions for the open turn are still recorded — with their original
 * `turnSequence`, per the plugin guide.
 */
export class Recorder {
  private readonly deps: RecorderDeps;
  private turn: TurnInfo | null;
  private readonly messages = new Map<string, MessageProgress>();
  /** Finalized message ids survive closeTurn so duplicate late finals
   * cannot reopen a phantom turn (bounded; oldest evicted). */
  private readonly finalized = new Set<string>();
  private readonly seenPrompts = new Set<string>();
  private flushing: Promise<FlushOutcome> | null = null;

  constructor(deps: RecorderDeps) {
    this.deps = deps;
    // Resume an open turn after a sidecar restart (turnSequence continuity).
    this.turn =
      deps.recording.turn_state !== undefined
        ? { ...deps.recording.turn_state }
        : null;
    // A restart loses the in-memory messages map, but the persisted turn
    // knows its last message was final: seed the map so stale shorter
    // redeliveries cannot overwrite the finalized text.
    if (
      this.turn !== null &&
      this.turn.lastMessageId !== null &&
      this.turn.lastMessageFinal
    ) {
      this.messages.set(this.turn.lastMessageId, { text: "", final: true });
      this.finalized.add(this.turn.lastMessageId);
    }
    // Clamp the counter above anything already persisted in the outbox, so a
    // crash between the two writes can never reuse a sequence.
    const floor = deps.outbox.maxPendingSequence() + 1;
    if (deps.recording.next_sequence < floor) {
      deps.recording.next_sequence = floor;
      deps.save();
    }
  }

  get enabled(): boolean {
    return this.deps.recording.enabled && !this.deps.recording.paused;
  }

  /**
   * Persist the record line first, then the counter: a crash in between
   * leaves a persisted record whose sequence the constructor's clamp will
   * consume, never a reused or missing sequence.
   */
  private emit(update: AcpUpdate, turnSequence?: number): number {
    const sequence = this.deps.recording.next_sequence;
    const line: OutboxLine = { sequence, update };
    if (turnSequence !== undefined) line.turnSequence = turnSequence;
    this.deps.outbox.add(line);
    this.deps.recording.next_sequence = sequence + 1;
    this.deps.save();
    return sequence;
  }

  private persistTurn(): void {
    if (this.turn === null) {
      delete this.deps.recording.turn_state;
    } else {
      this.deps.recording.turn_state = { ...this.turn };
    }
    this.deps.save();
  }

  private openTurn(): number {
    if (this.turn !== null) return this.turn.turnSequence;
    // The running update's turnSequence equals its own sequence (guide rule).
    // emit() takes the sequence from the same counter, so the pre-read value
    // and the assigned sequence are identical by construction.
    const turnSequence = this.deps.recording.next_sequence;
    this.emit(stateUpdate("running"), turnSequence);
    this.turn = {
      turnSequence,
      lastMessageId: null,
      lastMessageFinal: false,
    };
    this.persistTurn();
    return turnSequence;
  }

  private markFinal(messageId: string): void {
    this.finalized.add(messageId);
    if (this.finalized.size > 500) {
      const oldest = this.finalized.values().next().value;
      if (oldest !== undefined) this.finalized.delete(oldest);
    }
  }

  private closeTurn(): void {
    if (this.turn === null) return;
    this.emit(stateUpdate("idle"), this.turn.turnSequence);
    this.turn = null;
    this.messages.clear();
    this.persistTurn();
  }

  private str(value: unknown): string | null {
    return typeof value === "string" ? value : null;
  }

  record(event: Record<string, unknown>): void {
    if (!this.enabled) return;
    // Subagent activity routes to child threads (Milestone 5).
    if (event["agent_id"] !== undefined) return;
    const name = this.str(event["hook_event_name"]) ?? "unknown";
    switch (name) {
      case "UserPromptSubmit":
        this.onPrompt(event);
        return;
      case "MessageDisplay":
        this.onMessageDisplay(event);
        return;
      case "PreToolUse":
        this.onPreToolUse(event);
        return;
      case "PostToolUse":
        this.onPostToolUse(event, false);
        return;
      case "PostToolUseFailure":
        this.onPostToolUse(event, true);
        return;
      case "Stop":
        this.onStop(event, false);
        return;
      case "StopFailure":
        this.onStop(event, true);
        return;
      case "SessionEnd":
        this.closeTurn();
        return;
      default:
        // SessionStart, subagent and compaction events carry no records in M2.
        return;
    }
  }

  private onPrompt(event: Record<string, unknown>): void {
    // Superseded: no new turns or user prompts.
    if (this.deps.recording.superseded) return;
    const submitted = this.str(event["submitted_prompt"]);
    if (submitted === null || submitted.trim().length === 0) return;
    const promptId = this.str(event["prompt_id"]);
    if (promptId !== null) {
      // Dedupe is keyed on the real prompt id only; without one, identical
      // prompts are separate submissions and get distinct sequence ids.
      if (this.seenPrompts.has(promptId)) return;
      this.seenPrompts.add(promptId);
    }
    if (this.turn === null) this.openTurn();
    const turn = this.turn!;
    // Without a prompt_id the id falls back to the sequence (unique, never
    // reused), so identical prompts still record as separate submissions.
    const messageId = promptId !== null ? `u-${promptId}` : `u-s${this.deps.recording.next_sequence}`;
    this.emit(userMessage(messageId, submitted), turn.turnSequence);
    if (!this.deps.recording.titled) {
      this.deps.recording.titled = true;
      this.emit(sessionInfoUpdate(submitted.split("\n")[0] ?? submitted));
    }
  }

  private onMessageDisplay(event: Record<string, unknown>): void {
    const messageId = this.str(event["message_id"]);
    const text = this.str(event["displayed_text"]);
    if (messageId === null || text === null) return;
    // Already finalized (possibly in a previous turn or before a restart):
    // a redelivered final must not reopen a phantom turn.
    if (this.finalized.has(messageId)) return;
    const isFinal = event["is_final"] === true;
    if (this.turn === null) {
      // Late finals after a restart (or a dropped prompt) still belong to a
      // turn Delta sees as running; non-final partials without a turn are
      // stale deliveries and are ignored.
      if (!isFinal) return;
      if (this.deps.recording.superseded) return;
      this.openTurn();
    }
    const turn = this.turn!;
    if (
      turn.lastMessageId === messageId &&
      turn.lastMessageFinal
    ) {
      // Persisted-final guard across restarts (messages map was lost).
      return;
    }
    const progress = this.messages.get(messageId);
    if (progress !== undefined) {
      if (progress.final) return; // stale delivery after the final one
      if (text.length <= progress.text.length && !isFinal) return;
    }
    this.messages.set(messageId, { text, final: isFinal });
    if (isFinal) this.markFinal(messageId);
    turn.lastMessageId = messageId;
    turn.lastMessageFinal = isFinal;
    this.emit(agentMessage(`a-${messageId}`, text), turn.turnSequence);
    this.persistTurn();
  }

  private toolCallId(event: Record<string, unknown>): string | null {
    const raw = this.str(event["tool_use_id"]);
    return raw === null ? null : `t-${raw}`;
  }

  private onPreToolUse(event: Record<string, unknown>): void {
    // Superseded: no new tool-call records (the M3 deny gate goes here too).
    if (this.deps.recording.superseded) return;
    if (this.turn === null) this.openTurn();
    const id = this.toolCallId(event);
    const toolName = this.str(event["tool_name"]);
    if (id === null || toolName === null) return;
    const input = event["tool_input"];
    const content =
      input !== undefined && input !== null ? truncate(JSON.stringify(input)) : undefined;
    this.emit(toolCallUpdate(id, toolName, "in_progress", content), this.turn!.turnSequence);
    this.deps.capture.start(id, toolName);
  }

  private onPostToolUse(event: Record<string, unknown>, failed: boolean): void {
    if (this.turn === null) return;
    const id = this.toolCallId(event);
    const toolName = this.str(event["tool_name"]);
    if (id === null || toolName === null) return;
    let content: string | undefined;
    if (failed) {
      const error = this.str(event["error"]);
      content = error === null ? undefined : truncate(error);
    } else {
      const response = event["tool_response"];
      content =
        response !== undefined && response !== null
          ? truncate(JSON.stringify(response))
          : undefined;
    }
    this.emit(
      toolCallUpdate(id, toolName, failed ? "failed" : "completed", content),
      this.turn.turnSequence,
    );
    this.deps.capture.stop(id, toolName);
  }

  private onStop(event: Record<string, unknown>, failure: boolean): void {
    if (this.turn === null) return;
    const turn = this.turn;
    if (failure) {
      const kind = this.str(event["error"]) ?? "unknown";
      // A distinct id: reusing the last streamed messageId would REPLACE the
      // partial answer in Delta (same-id resends are cumulative updates).
      this.emit(
        agentMessage(`a-error-${turn.turnSequence}`, `Turn ended by an API error (${kind}).`),
        turn.turnSequence,
      );
    } else {
      const last = this.str(event["last_assistant_message"]);
      if (last !== null && last.trim().length > 0) {
        if (turn.lastMessageId !== null && !turn.lastMessageFinal) {
          // Cancellation can suppress the final MessageDisplay delivery; reuse
          // the last message id so the text is not duplicated.
          this.emit(agentMessage(`a-${turn.lastMessageId}`, last), turn.turnSequence);
        } else if (turn.lastMessageId === null) {
          // No streamed message ever arrived (restart after the prompt, or a
          // host without MessageDisplay): the Stop text is the only copy of
          // the answer; a fresh derived id cannot duplicate anything.
          this.emit(agentMessage(`a-stop-${turn.turnSequence}`, last), turn.turnSequence);
        }
      }
    }
    this.closeTurn();
  }

  /** Flush after a turn ends (callers also flush on SessionEnd/shutdown). */
  async finish(target: FlushTarget): Promise<FlushOutcome> {
    if (this.flushing !== null) return this.flushing;
    this.flushing = this.deps.outbox.flush(target).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** Records kept for tests and diagnostics. */
  pendingCount(): number {
    return this.deps.outbox.size;
  }
}

export type { DeltaRecord };


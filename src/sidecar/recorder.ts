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

interface MessageProgress {
  text: string;
  final: boolean;
}

interface TurnInfo {
  turnSequence: number;
  /** Last streamed message id and whether its `is_final` arrived. */
  lastMessageId: string | null;
  lastMessageFinal: boolean;
  seenPromptIds: Set<string>;
}

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
  flush(target: FlushTarget): Promise<FlushOutcome>;
}

/**
 * Translates hook events into Delta records per the plan's event→record
 * mapping. Ordering rules from the Qwen docs: once a `message_id` is final,
 * later (stale) posts are ignored; before final, only longer cumulative text
 * is re-sent; `Stop`'s fallback reuses the turn's last `message_id`.
 */
export class Recorder {
  private readonly deps: RecorderDeps;
  private turn: TurnInfo | null = null;
  private readonly messages = new Map<string, MessageProgress>();
  private readonly seenPrompts = new Set<string>();
  private flushing: Promise<FlushOutcome> | null = null;

  constructor(deps: RecorderDeps) {
    this.deps = deps;
  }

  get enabled(): boolean {
    return this.deps.recording.enabled && !this.deps.recording.paused;
  }

  private allocate(): number {
    const sequence = this.deps.recording.next_sequence;
    this.deps.recording.next_sequence = sequence + 1;
    this.deps.save();
    return sequence;
  }

  private emit(update: AcpUpdate, turnSequence?: number): void {
    const sequence = this.allocate();
    const line: OutboxLine = { sequence, update };
    if (turnSequence !== undefined) line.turnSequence = turnSequence;
    this.deps.outbox.add(line);
  }

  private openTurn(): number {
    if (this.turn !== null) return this.turn.turnSequence;
    // The running update's turnSequence equals its own sequence (guide rule).
    const sequence = this.allocate();
    this.deps.outbox.add({
      sequence,
      turnSequence: sequence,
      update: stateUpdate("running"),
    });
    this.turn = {
      turnSequence: sequence,
      lastMessageId: null,
      lastMessageFinal: false,
      seenPromptIds: new Set<string>(),
    };
    return sequence;
  }

  private closeTurn(): void {
    if (this.turn === null) return;
    this.emit(stateUpdate("idle"), this.turn.turnSequence);
    this.turn = null;
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
    const submitted = this.str(event["submitted_prompt"]);
    if (submitted === null || submitted.trim().length === 0) return;
    const promptId = this.str(event["prompt_id"]) ?? `hash:${submitted}`;
    if (this.seenPrompts.has(promptId)) return;
    this.seenPrompts.add(promptId);
    if (this.turn === null) this.openTurn();
    const turn = this.turn!;
    turn.seenPromptIds.add(promptId);
    this.emit(userMessage(`u-${promptId}`, submitted), turn.turnSequence);
    if (!this.deps.recording.titled) {
      this.deps.recording.titled = true;
      this.emit(sessionInfoUpdate(submitted.split("\n")[0] ?? submitted));
    }
  }

  private onMessageDisplay(event: Record<string, unknown>): void {
    if (this.turn === null) return;
    const messageId = this.str(event["message_id"]);
    const text = this.str(event["displayed_text"]);
    if (messageId === null || text === null) return;
    const isFinal = event["is_final"] === true;
    const progress = this.messages.get(messageId);
    if (progress !== undefined) {
      if (progress.final) return; // stale delivery after the final one
      if (text.length <= progress.text.length && !isFinal) return;
    }
    this.messages.set(messageId, { text, final: isFinal });
    this.turn.lastMessageId = messageId;
    this.turn.lastMessageFinal = isFinal;
    this.emit(agentMessage(`a-${messageId}`, text), this.turn.turnSequence);
  }

  private toolCallId(event: Record<string, unknown>): string | null {
    const raw = this.str(event["tool_use_id"]);
    return raw === null ? null : `t-${raw}`;
  }

  private onPreToolUse(event: Record<string, unknown>): void {
    this.openTurn();
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
      const messageId =
        turn.lastMessageId !== null ? `a-${turn.lastMessageId}` : `a-error-${turn.turnSequence}`;
      this.emit(agentMessage(messageId, `Turn ended by an API error (${kind}).`), turn.turnSequence);
    } else {
      const last = this.str(event["last_assistant_message"]);
      if (
        last !== null &&
        last.trim().length > 0 &&
        turn.lastMessageId !== null &&
        !turn.lastMessageFinal
      ) {
        // Cancellation can suppress the final MessageDisplay delivery; reuse
        // the last message id so the text is not duplicated.
        this.emit(agentMessage(`a-${turn.lastMessageId}`, last), turn.turnSequence);
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

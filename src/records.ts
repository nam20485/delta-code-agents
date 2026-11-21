/** One ACP v2 session update (the `update` field of a Delta record). */
export interface AcpUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

/** A `thread append` record line. */
export interface DeltaRecord {
  schemaVersion: 1;
  sequence: number;
  turnSequence?: number;
  update: AcpUpdate;
}

export type ToolCallStatus = "in_progress" | "completed" | "failed";
export type TurnState = "running" | "idle";

const MAX_CONTENT_CHARS = 4_000;
const MAX_TITLE_CHARS = 80;

export function truncate(value: string, max = MAX_CONTENT_CHARS): string {
  if (value.length <= max) return value;
  // Never cut a UTF-16 surrogate pair: a lone surrogate would serialize as
  // an ill-formed escape in the record payload.
  let end = max - 1;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…`;
}

function textBlock(value: string): { type: "text"; text: string } {
  return { type: "text", text: value };
}

export function userMessage(messageId: string, body: string, senderExternalId?: string): AcpUpdate {
  const update: AcpUpdate = {
    sessionUpdate: "user_message",
    messageId,
    content: [textBlock(body)],
  };
  if (senderExternalId !== undefined) {
    update["_meta"] = { delta: { sender: { external_id: senderExternalId } } };
  }
  return update;
}

export function agentMessage(messageId: string, body: string): AcpUpdate {
  return {
    sessionUpdate: "agent_message",
    messageId,
    content: [textBlock(body)],
  };
}

export function toolCallUpdate(
  toolCallId: string,
  title: string,
  status: ToolCallStatus,
  content?: string,
): AcpUpdate {
  const update: AcpUpdate = {
    sessionUpdate: "tool_call_update",
    toolCallId,
    title: truncate(title, MAX_TITLE_CHARS),
    status,
  };
  if (content !== undefined) update["content"] = [textBlock(content)];
  return update;
}

export function stateUpdate(state: TurnState): AcpUpdate {
  return { sessionUpdate: "state_update", state };
}

export function sessionInfoUpdate(title: string): AcpUpdate {
  return { sessionUpdate: "session_info_update", title: truncate(title, MAX_TITLE_CHARS) };
}

export function wrap(sequence: number, update: AcpUpdate, turnSequence?: number): DeltaRecord {
  const record: DeltaRecord = { schemaVersion: 1, sequence, update };
  if (turnSequence !== undefined) record.turnSequence = turnSequence;
  return record;
}

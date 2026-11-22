const MAX_CONTENT_CHARS = 4_000;
const MAX_TITLE_CHARS = 80;
export function truncate(value, max = MAX_CONTENT_CHARS) {
    if (value.length <= max)
        return value;
    // Never cut a UTF-16 surrogate pair: a lone surrogate would serialize as
    // an ill-formed escape in the record payload.
    let end = max - 1;
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff)
        end -= 1;
    return `${value.slice(0, end)}…`;
}
function textBlock(value) {
    return { type: "text", text: value };
}
export function userMessage(messageId, body, senderExternalId) {
    const update = {
        sessionUpdate: "user_message",
        messageId,
        content: [textBlock(body)],
    };
    if (senderExternalId !== undefined) {
        update["_meta"] = { delta: { sender: { external_id: senderExternalId } } };
    }
    return update;
}
export function agentMessage(messageId, body) {
    return {
        sessionUpdate: "agent_message",
        messageId,
        content: [textBlock(body)],
    };
}
export function toolCallUpdate(toolCallId, title, status, content) {
    const update = {
        sessionUpdate: "tool_call_update",
        toolCallId,
        title: truncate(title, MAX_TITLE_CHARS),
        status,
    };
    if (content !== undefined)
        update["content"] = [textBlock(content)];
    return update;
}
export function stateUpdate(state) {
    return { sessionUpdate: "state_update", state };
}
export function sessionInfoUpdate(title) {
    return { sessionUpdate: "session_info_update", title: truncate(title, MAX_TITLE_CHARS) };
}
export function wrap(sequence, update, turnSequence) {
    const record = { schemaVersion: 1, sequence, update };
    if (turnSequence !== undefined)
        record.turnSequence = turnSequence;
    return record;
}

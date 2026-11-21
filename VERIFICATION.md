# Live end-to-end verification (M6)

Run against the real `delta` CLI (contract 8–12) and `qwen` 0.28.0 on the
development machine, in throwaway Git repositories with a local bare remote.
Each flow used an isolated router port and state root.

| Flow | Result |
| --- | --- |
| `SessionStart` bootstraps router + sidecar; launcher resolves | pass |
| `/delta-setup private` then a recorded turn (prompt, streamed reply, tool call, stop) | pass — thread title set from the prompt, `producer.turn` finished, outbox drained |
| `/delta-share confirm` uploads to the organization | pass — join URL returned, visibility organization |
| Teammate append (different source) → injected into the next turn | pass — `additionalContext` carried the teammate message with a unique delivery id; no re-injection on the following prompt |
| Subagent (`SubagentStart`/`MessageDisplay`/`SubagentStop`) | pass — child thread `Explorer` created under the parent (`agent_spawned: true`) |
| `/clear` conversation split | pass — external id suffixed (`z1-c1`), generation bumped, fresh thread |
| Kill sidecar mid-session → respawn → sequence continues | pass (integration tests: SIGKILL → router respawn → `next_sequence` continues, never resets to 1) |
| Offline/private recording drains on reconnect | pass — local-ack records upload in the background (`upload.state` queued → uploaded) |

## Bug found and fixed during this pass

Private-mode recording initially never flushed: a plain `thread create`
(no organization/visibility) rejects `thread append` with `not_shared`
("share this thread or record an upload intent before appending records").
The fix resolves an organization (policy `organization`, else `delta org
current`) and creates the thread with `--organization <id> --visibility
private`, recording the upload intent so records append before sharing —
exactly the guide's offline path. Verified: outbox drains, thread title and
turn state appear, upload queues.

## Known limitations observed

- `thread capture` is allowlisted to the `claude-code` source on this CLI;
  Qwen edits sync but appear unattributed (the sidecar disables capture
  cleanly and warns on share).
- `delta thread show` on a local-only thread can abort; `thread status` and
  `thread tree` are the reliable inspection commands.

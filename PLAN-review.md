# Review of `PLAN.md` (delta-qwen)

Status: all 23 fixes applied to `PLAN.md` on 2026-11-20 (owner approved).

Reviewed 2026-11-20 against: local `delta` 0.28.4 CLI (executed help/contract),
local `qwen` 0.28.0 bundled docs and runtime bundle (read), the
[Delta plugin guide](https://delta.dev/docs/cli/build-a-plugin) (fetched, 200),
and the [delta-claude repo](https://github.com/zed-industries/delta-claude)
(fetched, 200, incl. full git tree).

## Overall Assessment

The plan is unusually well-grounded: every hook event, payload field, and most
CLI flags it names exist exactly as described, and its contract semantics
(sequences, turnSequence, cumulative streaming, receipts, supersession) match
the plugin guide verbatim. The two critical risks are both integration paths
the plan asserts but never wires: adopting the user's existing checkout into
the thread, and resolving the extension's own file paths from slash commands.
The remaining findings are lifecycle and ordering edges that the installed
Qwen docs explicitly warn about.

Evidence labels: **execution** = ran the local CLI; **reading** = installed
docs/bundle source; **web** = fetched primary source; **unverified** = could
not confirm.

---

## Critical Issues (Must Fix Before Implementation)

### 1. The user's checkout is never adopted into the thread

**Opening paragraph** says:

> Record Qwen Code sessions and their Git checkouts into Delta threads

**Event mapping, `SessionStart` row** says only:

> ensure thread ... start mount + sidecar

and `src/sidecar/mounts.ts` is described as "worktree create/attach/mount
lifecycle". But the executed CLI help shows these are distinct operations:

> `worktree create` — Create a local worktree at this checkout's HEAD or a Git revision
>
> `worktree mount` — Synchronize a shared worktree into a new directory or
> explicitly adopt a checkout
> `--existing-checkout`  Adopt a user-owned checkout of the same Git
> repository instead of creating a directory
>
> `thread mount` — Keep a thread's worktrees mounted while this command is connected.

`worktree create` makes a **new directory** at HEAD — not the checkout qwen is
editing. Without `worktree mount <ref> <cwd> --existing-checkout`, qwen's edits
land outside every directory the thread watches, and live e2e step 2 ("the
checkout's file changes on the thread") cannot pass. delta-claude's
`hooks/sharing/checkout.ts` and `managed-checkout.ts` exist precisely for this
(web, git tree).

**Fix:** specify the recording-side flow in the plan: `worktree create <repo>`
(or reuse) → `worktree attach --thread <id> <ref>` → `worktree mount <ref>
<cwd> --existing-checkout` → `thread mount --owner <session_id>` as the
keepalive child. State what happens when cwd is not a Git repo, and when the
checkout is already a Delta-managed worktree (this repo itself lives under
`.delta/worktrees/`).

### 2. Slash-command entrypoint paths do not resolve

**Architecture diagram** says:

> `C["Slash commands<br/>commands/*.md → !{ node dist/cli.js ... }"]`

`!{...}` shell injections run in the **session's** working directory (the
user's project), not the extension root; `dist/cli.js` does not exist there.
The substitution machinery (reading, bundle source) does not cover this case:

- `recursivelyHydrateStrings(parsedConfig, {extensionPath, CLAUDE_PLUGIN_ROOT,
  workspacePath, ...})` hydrates the **manifest only** — including inline
  hooks, so `node ${extensionPath}/dist/hook.js` in `qwen-extension.json` is
  fine.
- Command `.md` content is rewritten only at **install** time:
  `performVariableReplacement(stagingPath, destinationPath)` replaces
  `${CLAUDE_PLUGIN_ROOT}` in the staged copy. A linked extension
  (`qwen extensions link .`, the plan's dev flow) is not staged, and no
  runtime hydration of command markdown was found in the loader.

So every `/delta-*` command fails as written, and the obvious token fix has a
link-mode gap.

**Fix:** reference the CLI by a path stable in both modes, e.g.
`!{node "$HOME/.qwen/extensions/delta-qwen/dist/cli.js" ...}` **if** link
creates a symlink at that location (unverified — no extensions installed on
this machine yet; confirm in Milestone 1), or install a user-level wrapper
under `~/.qwen/delta/` during setup. Add a link-mode command smoke test to
`scripts/dev-check.sh`.

---

## Significant Gaps

### 3. No `thread capture` — disk edits are not attributed to tool calls

The plan records `tool_call_update` but never mentions `capture`. Executed help:

> `thread capture` — Attribute a producer tool call's disk edits to the
> call while it runs.
> A producer that edits files itself, rather than through Delta, starts
> capture before the call runs and stops it after. Meanwhile, file edits in
> the thread's mounted checkouts name the call. Capture also stops once the
> producer's process exits.
>
> `capture start` requires `--source --external-id --tool-call-id <THREAD>`;
> optional `--owner-pid`, `--started-at`
> `capture stop` ... optional `--ended-at`; "The stop may run before its start"

delta-claude ships `hooks/recording/edit-capture.ts` (web, git tree). Qwen is
exactly "a producer that edits files itself".

**Fix:** add to the mapping: `PreToolUse` (edit-capable tools) → `capture start
--tool-call-id <tool_use_id> --owner-pid <qwen pid>`; `PostToolUse` /
`PostToolUseFailure` → `capture stop`. The id must match the id used in
`tool_call_update` records ("as its records name it"). Note the sidecar spawns
these, so `--owner-pid` is required here too.

### 4. `MessageDisplay` async ordering and the `Stop` fallback can duplicate or lose text

**Mapping row** says:

> `agent_message` with `messageId a-<message_id>`, cumulative
> `displayed_text` resent each firing, final on `is_final` (hook marked
> async; debounced by Qwen ~200ms)

The installed hooks doc (reading) confirms the debounce and cumulative text,
but warns:

> when the final execution overlaps a superseded mid-stream one, their
> _completion_ order is unspecified — the stale execution may finish after
> the final one (even after `Stop`). Treat `is_final` as terminal per
> `message_id` and let the cumulative text win
>
> The turn's end (and the `Stop` hook, when it fires) waits up to 5 seconds
> for the final delivery to finish.

Marking the hook `async` removes even that bounded wait ("runs in the
background without blocking the main flow"). Meanwhile the `Stop` row's
fallback `agent_message` from `last_assistant_message` has **no `message_id`
to reuse** — `Stop` carries no message id — so a late final plus the fallback
can render the same text twice under different messageIds. Also: a tool-using
turn produces **multiple** messages, each with its own `is_final`; a
cancellation before `is_final` dispatch fires no final at all.

**Fix:** keep per-`message_id` terminal state in the recorder (once final,
ignore later stale posts; before final, accept only longer cumulative text).
Define the fallback's messageId (e.g. the turn's last seen `message_id`, or
suppress the fallback when any final arrived for the turn). Consider keeping
`MessageDisplay` synchronous — the dispatcher is a fast local POST and the
event is fire-and-forget anyway — to retain the is_final-before-Stop ordering.

### 5. Inbox injection can be silently deduped away by Qwen

**Sharing section** says:

> The inbox is **injected as `UserPromptSubmit` `additionalContext` on the
> next turn**

The installed doc (reading) states an unconditional session-level dedupe:

> If the sanitized payload is byte-identical to a block a hook already
> delivered earlier in the same session, it is not appended again ... this
> is unconditional with no opt-out, and any change to the payload re-injects
> it.

Any identically-rendered redelivery (retry after a cancelled turn, crash
between "delivered" marking and actual injection, repeated `/delta-inbox`
content) is dropped without a trace.

**Fix:** make every injection payload unique — embed a delivery/batch id or
timestamp in the injected block. Mark delivered only after the hook returns
success, and treat a cancelled turn's delivery as undelivered.

### 6. `SessionStart`/`SessionEnd` fire for `clear` and `compact` too

**Mapping row** scopes SessionStart to "(startup/resume)". The installed doc
(reading) lists:

> `SessionStart` ... Source (`startup`, `resume`, `clear`, `compact`)
>
> `SessionEnd` ... Reason (`clear`, `logout`, `prompt_input_exit`, ...)

So `/clear` runs the plan's full teardown (TERM mount + watch, flush, "final
state") followed by a fresh ensure-thread — and because `thread create` is
idempotent on `(source, external-id)`, the cleared conversation keeps
appending to the **same** Delta thread unless the policy says otherwise.
`/compact` also re-runs ensure-thread and could re-apply auto-share policy.

**Fix:** define behavior per source: `compact` → no teardown (optionally the
compaction note); `clear` → decide explicitly whether a cleared conversation
starts a new thread (new external-id suffix) or continues, and skip
thread-finalization on `SessionEnd(reason=clear)`.

### 7. Watch protocol is underspecified

**Sharing section** lists:

> Watch frames (`item`, `item.append`, `turn`, `producer.turn`,
> `worktrees`, `comment`…) rebuild the remote view

The guide (web) specifies more structure the watcher must implement:

> The stream starts with `ready`, then the thread's current items, then
> `live`, then changes as they happen.
> `item` replaces an item; `item.append` extends its text; `remove` deletes it.
> Order items by `after_id`, retaining unresolved predecessors until they arrive.
> `turn`, `presence`, and `worktrees` replace their latest state.
> `comment` and `comment.remove` update delivered comments.
> `children` replaces the list of subagents and subthreads ... `child` adds
> or replaces one entry by `thread_id`, and `child.remove` deletes one.

The `children`/`child` frames matter directly for Milestone 5 (subagents as
child threads). delta-claude ships
`hooks/testing/fixtures/cli/thread-watch.frames.jsonl` (web) as a ready-made
fixture.

**Fix:** enumerate the full frame set, the ready/live handshake, and
`after_id` ordering in the watcher spec; reuse the delta-claude fixture shape
for the fake CLI.

### 8. Owner-death and sidecar lifecycle are not pinned down

**Decisions** rely on:

> `thread watch --participate "Qwen Code" --owner-pid <qwen pid>` so Delta
> ends the turn if qwen dies mid-turn

The guide (web) is more conditional:

> If your agent's process exits while its turn is still running, Delta ends
> the turn when the watch ends, so a crash doesn't leave the thread busy for
> everyone. The watch treats its parent process as your agent; pass
> `--owner-pid` to name another one.

The sidecar is detached and outlives qwen; if it keeps the watch open after
qwen dies, the turn may stay busy. "Orphan cleanup" appears once, with no
mechanism. Additionally the hooks doc (reading) warns:

> Async hooks are scoped to the Qwen process. On POSIX, Qwen reclaims a
> still-running async hook process tree when it exits

A sidecar spawned as a hook descendant must escape that reclamation.

**Fix:** specify: sidecar polls the owner pid; on death it ends the watch
(and any open capture), lets Delta idle the turn, and either exits after a
grace period or waits for `/resume`; spawn the sidecar fully detached (new
session/process group, ignored stdio, unref) and assert survival in e2e step 5.
State the mount's fate on owner death explicitly.

### 9. Dispatcher blocking/failure semantics need explicit rules

**Architecture** says:

> reads the event JSON on stdin, POSTs it to the sidecar ... exits fast ...
> Fail-open on sidecar errors ... If a state dir exists but the sidecar is
> down, the hook restarts it.

Installed-doc facts (reading) that constrain this:

> `timeout` ... default 60 [seconds]
>
> By default, hooks execute in parallel for better performance
>
> [async hooks] Occupies one of 10 concurrent async hook slots until it
> finishes or reaches its timeout ... While all 10 slots are in use, a new
> async hook is skipped
>
> Exit code 2: **Blocking error**.

Consequences the plan does not address: a hung (not erroring) sidecar stalls
every `PreToolUse`/`UserPromptSubmit` up to 60s; parallel tool calls run
multiple dispatchers concurrently, so "restart the sidecar" is a race that can
spawn several; a dispatcher that exits 2 on failure **blocks** tools instead
of failing open; slow dispatchers can exhaust the 10 async slots and drop
`MessageDisplay` events.

**Fix:** set explicit short timeouts (e.g. 2–5s) on the synchronous gate
hooks; never exit 2 on sidecar failure; guard sidecar spawn with an atomic
pidfile/lock plus liveness check; keep the dispatcher dependency-free and
fast-exiting.

### 10. The watch invocation as written is missing required flags

**Mapping footer** says:

> `thread watch --participate "Qwen Code" --owner-pid <qwen pid>`

Executed help:

> `--participate <NAME>` ... Requires --source and --external-id

The command fails as written.

**Fix:** write the full invocation: `delta --json thread watch <thread>
--source delta-qwen --external-id <session_id> --participate "Qwen Code"
--owner-pid <qwen pid>`.

---

## Minor Issues / Improvements

### 11. `--acknowledge local` belongs to `append`, not `create`

**Outbox section**: "Offline: `thread create --organization <id> --visibility
private` + `--acknowledge local`". Executed `create` help has no
`--acknowledge`; the guide (web) shows create (no acknowledge) followed by
`append --acknowledge local`. Reword so the flag is unambiguously on append.

### 12. `/delta-org manage` has no CLI counterpart

Executed `delta org` subcommands: `list`, `current`, `create`, `switch`,
`invite`. "manage" does not exist; map it to `delta open`/the org web page or
drop it.

### 13. `/delta-join` should pass `--join`

Executed `thread mount` help: `--join` "Report an explicit join attempt, not
background mount maintenance". The plan's join flow uses a bare
`thread mount --owner <session_id>`; use `--join` for the user-initiated path.

### 14. `reload_required` needs a remediation path

The guide (web): appends fail with `reload_required` "until the user resolves
it ... open the thread in the Delta app and choose **Fork & Restore** or
**Discard Changes**. From the CLI ... `delta thread fork` and then
`delta thread discard --force`." The plan surfaces the state but not the fix;
print these instructions in `/delta-inbox`.

### 15. Thread title is never set

The guide (web) lists `session_info_update` "which sets the thread's title";
delta-claude has `hooks/recording/title.ts`. Cheap win: set the title from the
first `submitted_prompt` (truncated).

### 16. `agent_thought` contradiction

Mapping row: "`PreCompact`/`PostCompact` (optional) | `agent_thought` note"
vs Decisions: "**No `agent_thought` records in v1**". Drop the row or narrow
the decision to "no thinking-stream records".

### 17. Consent flow relies on model behavior

"First use prints what will be uploaded and requires confirmation (consent
flow in command output)". Markdown commands expand to prompts; the model may
not reliably ask, and the `!{}` dialog confirms shell execution, not upload
consent. Make consent an explicit CLI gate (e.g. first `/delta-share` prints
the audience and requires a confirming second invocation or `--confirm`).

### 18. Gitignore mechanism for `.delta/settings.json` unspecified

State the mechanism; `.git/info/exclude` avoids touching a tracked
`.gitignore` in the user's repo.

### 19. Backfill parity claim is only partially verified

delta-claude's README (web) confirms syncing "messages recorded while it
waited" for sign-in; an initial export of the prior transcript on mid-session
share was not confirmed from the README (check `hooks/sharing/share.ts`
before claiming parity). Also note qwen's transcript JSONL shape differs from
Claude's — the backfill parser must be qwen-specific (the plan's best-effort
framing is fine).

### 20. State/token file permissions

Specify `0700` session dirs and `0600` token/state files; the sidecar holds
full tool inputs/outputs. Loopback bind + token is already planned.

### 21. Name every hook

Installed doc (reading): "A hook must include a name field to be enabled or
disabled individually at runtime." Add `name` to each registered hook so users
can disable parts via `/hooks`.

### 22. `session_id` stability across `/resume` is an assumption

`/resume` exists (reading, commands doc), but no doc states the resumed
session keeps its `session_id`. E2e step 5 would catch a change; assert it in
Milestone 1 instead of Milestone 6.

### 23. Per-event node spawn cost; consider native HTTP hooks

Every event spawns a fresh `node` process on the synchronous path of every
tool call and prompt. Qwen supports `type: "http"` hooks natively and its SSRF
policy "allows loopback addresses (127.0.0.1, ::1)" (reading). A fixed-port
user-level daemon multiplexing by `session_id` would remove per-event spawn
cost; the trade-off is daemon lifecycle vs per-session sidecars. At minimum,
measure the added latency in Milestone 1 and bundle the dispatcher to a single
dependency-free file.

---

## Verified Claims (no action needed)

| Claim | Evidence |
| --- | --- |
| Local CLI reports `{min:8, max:12}`; qwen 0.28.0 | execution: `delta --json thread contract` → `{"operation":"contract","min":8,"max":12}`; `qwen --version` |
| Contract gate `max >= 8`, `min > 8` → update plugin | web: guide states the same rule |
| All 13 hook events exist (`SessionStart` ... `PostCompact`, incl. `MessageDisplay`, `StopFailure`, `PostToolUseFailure`, `SubagentStart`) | reading: installed hooks doc event table |
| Payload fields: `session_id`, `transcript_path`, `cwd`, `prompt_id`, `agent_id`, `submitted_prompt`, `message_id`, `displayed_text`, `is_final`, `tool_use_id`, `tool_response`, `error`, `duration_ms`, `last_assistant_message`, `agent_transcript_path`, `agent_type` | reading: per-event field tables |
| `MessageDisplay` cumulative text, ~200ms debounce, final always fires | reading: "at most every ~200ms", "CUMULATIVE text streamed so far" |
| `PreToolUse` deny via `hookSpecificOutput.permissionDecision` + reason | reading: output options + example |
| `UserPromptSubmit` fires on continuation paths; `submitted_prompt` optional; record-only-when-present + `prompt_id` dedupe is the right call | reading: "It can therefore occur on continuation paths" |
| `sequence` from 1, running `turnSequence = own sequence`, idle shares it | web: guide quotes match the plan exactly |
| Streaming = same `messageId` resent with full content; chunk updates rejected | web: guide |
| Receipts `recorded`/`duplicate`/`fenced`; retry only `error.retryable`, honor `retry_after_ms`; save before send | web: guide |
| `fenced`/`producer.turn superseded` → stop turn, keep late output's `turnSequence` | web: guide |
| Offline create returns without network; `upload.state` queued/uploading/uploaded/failed | web: guide |
| Idempotent `thread create` on `(source, external-id)`; child create idempotent | web: guide; execution: create help |
| Child threads: `--parent --shared-worktrees --external-id --name` all exist; `--shared-worktrees` fits same-checkout subagents | execution: create help |
| `--producer-name`, `--acknowledge server\|local` on append | execution: append help |
| `/cd`, `/resume`, `/extensions list` exist; join UX limitation is real | reading: commands doc |
| Markdown commands + frontmatter; `!{}` shows confirmation; commands run a model turn | reading: commands doc |
| Extension commands keep natural names unless colliding (then `/delta-qwen.delta-share`) | reading: extension intro, conflict resolution |
| Inline manifest hooks + `${extensionPath}` hydration (linked and installed) | reading: extension-creator skill + bundle `recursivelyHydrateStrings(parsedConfig, ...)` |
| `qwen extensions install\|link` | execution: `qwen extensions --help` |
| delta-claude is AGPL-3.0-only; `hooks/recording\|sharing\|watch\|testing` and `hooks/testing/fake-thread-commands.ts` exist; auto-install exists | web: repo page + git trees API |
| Default delta path `~/.local/delta.app/bin/delta` | execution: `readlink -f` on this machine |

---

## Summary Table

| # | Severity | Category | Description |
| --- | --- | --- | --- |
| 1 | **Critical** | Gap | User's checkout never adopted (`worktree mount --existing-checkout` flow missing); edits can't reach the thread |
| 2 | **Critical** | Technical bug | `!{node dist/cli.js}` resolves against session cwd; command-md tokens not hydrated at runtime, install-time rewrite skips linked extensions |
| 3 | Significant | Gap | `thread capture start/stop` missing; disk edits unattributed to tool calls |
| 4 | Significant | Missing edge case | MessageDisplay async completion order unspecified; Stop fallback has no messageId; duplicate/lost text risk |
| 5 | Significant | Missing edge case | Byte-identical `additionalContext` injected once per session; inbox redelivery silently dropped |
| 6 | Significant | Missing edge case | `SessionStart`/`SessionEnd` also fire for `clear`/`compact`; teardown + thread-continuity policy undefined |
| 7 | Significant | Gap | Watch ready/live handshake, `after_id` ordering, `remove`/`presence`/`children` frames unlisted |
| 8 | Significant | Missing edge case | Owner-death: turn ends only when watch ends; sidecar orphan/reclamation behavior unspecified |
| 9 | Significant | Gap | Dispatcher: 60s default timeout, exit-2 blocks, parallel spawn race, 10 async-slot cap |
| 10 | Significant | Technical bug | `watch --participate` invocation missing required `--source`/`--external-id` |
| 11 | Minor | Technical bug | `--acknowledge local` is an append flag, not create |
| 12 | Minor | Stale reference | `delta org manage` does not exist |
| 13 | Minor | Improvement | `/delta-join` should use `thread mount --join` |
| 14 | Minor | Gap | `reload_required` remediation (fork/discard) not surfaced |
| 15 | Minor | Improvement | `session_info_update` title unused |
| 16 | Minor | Contradiction | `agent_thought` compaction row vs "no agent_thought in v1" |
| 17 | Minor | Process | Upload consent delegated to model output instead of a CLI gate |
| 18 | Minor | Gap | Gitignore mechanism for `.delta/settings.json` unspecified |
| 19 | Minor | Process | Backfill "parity with delta-claude's initial export" partially unverified; qwen-specific parser needed |
| 20 | Minor | Improvement | Specify 0700/0600 permissions for state/token files |
| 21 | Minor | Improvement | Add `name` to every hook for runtime disable |
| 22 | Minor | Process | `session_id` stability across `/resume` unverified; assert in M1 |
| 23 | Minor | Improvement | Per-event node spawn latency; native HTTP-hook alternative |

Counts: 2 critical, 8 significant, 13 minor.

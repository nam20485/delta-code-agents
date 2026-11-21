# Changelog

## 0.6.0

First complete release of the Delta integration for Qwen Code, built
milestone by milestone from [PLAN.md](PLAN.md).

- **M1 — Scaffold**: extension manifest with named hooks; a fixed-port local
  router multiplexing per-session sidecar daemons; fail-open hook dispatcher;
  `delta` CLI wrapper with the thread-contract gate. Per-event delivery uses
  native HTTP hooks (measured ~4 ms p95) rather than command-hook process
  spawns (~390 ms p95 on the target machine).
- **M2 — Recording**: ACP v2 record builders; a save-before-send outbox with
  per-record receipts (`recorded`/`duplicate`/`fenced`), retry/backoff, and
  `reload_required` pause; event→record translation with cumulative streaming
  and turn grouping; checkout adoption via `worktree mount
  --existing-checkout`; the consent-gated share flow.
- **M3 — Remote activity**: `thread watch` with the full frame protocol; an
  inbox injected into the next turn with unique delivery ids; the supersession
  deny gate (turn-scoped, reclaimable); mount swap on `worktrees` frames.
- **M4 — Commands & policy**: `/delta-share`, `/delta-setup`, `/delta-join`,
  `/delta-pause`, `/delta-unshare`, `/delta-inbox`, `/delta-org`; repository
  sync policy (`private`/`team`/`manual`) kept out of Git; mid-session
  transcript backfill; per-`/clear` thread splitting.
- **M5 — Subagents**: subagents recorded as child threads
  (`--parent --shared-worktrees`), per-child recorders/outboxes with persisted
  counters and flags; watch `children`/`child`/`child.remove` tracking;
  policy-gated record acknowledgment.
- **M6 — Docs & release**: README, AGPL-3.0 license, this changelog, and a
  live end-to-end verification pass against the real `delta` CLI.

### Known limitations

- `thread capture` (attributing disk edits to a tool call) is allowlisted to
  the `claude-code` source on current Delta CLIs; edits from Qwen sync but
  appear unattributed. The sidecar detects this and disables capture cleanly.
- Supersession cannot send Esc to the Qwen TUI; it denies further tool calls
  with a reason until the user reclaims the turn with a new prompt.
- A turn cancelled after the inbox response is written is unobservable; the
  unique delivery id keeps any redelivery safe.

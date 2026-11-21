# delta-qwen

Delta integration for [Qwen Code](https://github.com/QwenLM/qwen-code): it
records your Qwen Code sessions and the Git checkout they work in into
[Delta](https://delta.dev) threads, so teammates can open the thread, join it
from their own agent, and pick up the work — the same workflow the
[Delta Claude Code plugin](https://github.com/zed-industries/delta-claude)
brings to Claude Code.

Everything goes through the `delta` CLI; nothing reads or writes Delta's
database directly.

## Requirements

- Qwen Code with extension support (`qwen extensions …`).
- The `delta` CLI, signed in (install from [delta.dev](https://delta.dev)).
  The plugin targets Delta thread contract version 8 or newer and checks this
  on startup (`delta-qwen doctor`).
- Node.js 20+ (the extension's hooks and sidecar run on Node).

## Install

From a Git checkout of this repository:

```sh
qwen extensions install https://github.com/nam20485/delta-code-agents
```

For local development, link the checkout instead (re-link after manifest
changes):

```sh
qwen extensions link "$(pwd)"
```

Restart Qwen Code so the extension loads. `/extensions list` should show
`Delta`.

## Usage

Run `/delta-setup` in a repository to choose its sync mode:

| Mode | Behavior |
| --- | --- |
| `private` | Every new session records locally; only you see it until you share. |
| `team` | Every new session records and is shared with your organization. |
| `manual` | Nothing records until you run `/delta-share`. |

The choice is saved to `.delta/settings.json` and kept out of Git via
`.git/info/exclude`.

### Commands

| Command | Description |
| --- | --- |
| `/delta-share [confirm] [emails…]` | Share the session (org, or invite emails). The first share prints what will be uploaded and requires `confirm`. |
| `/delta-setup <private\|team\|manual> [--org ID]` | Set this repository's sync policy. |
| `/delta-join <link>` | Join a shared thread; prints the checkout directory to `/cd` into. |
| `/delta-pause` | Stop recording/sync for this session (the thread is kept). |
| `/delta-unshare` | Make the thread private; explicit invitations are retained. |
| `/delta-inbox` | Show pending teammate activity on the thread. |
| `/delta-org <list\|current\|switch\|create\|invite>` | Manage Delta teams. |
| `/delta` | Status and command menu. |

Teammate activity is injected into your next turn as context (it never starts
a turn by itself). If a teammate takes over the thread, further tool calls are
denied with a reason until you send a new prompt to reclaim it.

Subagents (the Task tool) are recorded as child threads under the session's
thread.

## Privacy

Delta stores what a recorded session contains: your conversation (prompts,
replies, tool inputs and outputs) and the files in your checkout (staged,
unstaged, and untracked files that are not ignored). Nothing is uploaded until
you share or join, or the repository's policy syncs it automatically. Sharing
requires an explicit confirming invocation. See the Delta plugin guide for
the full data model.

## How it works

- Qwen Code hook events (`SessionStart`, `UserPromptSubmit`, `MessageDisplay`,
  `PreToolUse`/`PostToolUse`, `Stop`, subagent events) drive recording.
  `SessionStart` is a command hook that bootstraps a fixed-port local router;
  every other event is a native HTTP hook to that router (~milliseconds, no
  per-event process spawn).
- The router multiplexes per-session **sidecar** daemons. Each sidecar owns
  the Delta thread, a save-before-send **outbox** (sequence-numbered records,
  receipt/retry/fenced handling), the checkout **mount**, a `thread watch`
  for remote activity, and an **inbox** injected into your next turn.
- Records are ACP v2 updates appended via `delta thread append`; the checkout
  is adopted with `worktree mount --existing-checkout` so your edits reach the
  thread.

See [PLAN.md](PLAN.md) for the full architecture, event→record mapping, and
recovery rules.

## Development

```sh
./validate.sh        # markdownlint + tsc + node --test (identical to CI)
npm run build        # compile src/ + test/ to dist/
npm test             # run the compiled suite
```

Single test file: `node --test dist/test/recorder.test.js`. The suite uses a
fake `delta` CLI (`test/fake-delta.ts`) so it runs without network or sign-in.

## License

AGPL-3.0-only (see [LICENSE](LICENSE)), matching the delta-claude reference
this plugin ports patterns from.

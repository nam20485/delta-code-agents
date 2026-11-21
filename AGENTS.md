# Repository Guidelines

Repository for `delta-qwen`, a Qwen Code extension that records Qwen Code
sessions and their Git checkouts into Delta threads. `PLAN.md` drives the
work milestone by milestone; the M1 scaffold (hook dispatcher, session
sidecar, `delta` CLI wrapper) is in place and recording lands with M2.

## Project Structure & Module Organization

- `PLAN.md` — the approved implementation plan and single source of truth:
  architecture (extension hooks → per-session sidecar → `delta` CLI), the
  event→record mapping, outbox/recovery rules, milestones, and verification.
  Change this file first when scope changes.
- `PLAN-review.md` — record of a 23-finding review; every finding is already
  applied to `PLAN.md`. Do not reintroduce behavior the review removed (e.g.
  async `MessageDisplay` hooks, un-hydrated command paths).
- `qwen-extension.json` — extension manifest; registers one named command hook
  per event, all invoking `dist/src/hook.js` (built output — keep paths in
  sync with `tsconfig.json`).
- `src/hook.ts` — SessionStart dispatcher: bootstraps the user-level router
  (lock-guarded detached spawn), learns qwen's pid from its ancestry, and
  maintains `~/.qwen/delta/cli.js`, the stable launcher slash commands call.
  All other hook events are native http hooks straight to the router (per-
  event command hooks measured ~390 ms p95 on this machine; http ~4 ms).
- `src/router/router.ts` — fixed-port (47631) loopback daemon multiplexing
  sessions by id: spawns per-session sidecars, forwards events with the
  sidecar token, relays responses, fails open with `{}`.
- `src/sidecar/` — per-session sidecar: token-authed localhost HTTP, session
  state (0700 dirs, 0600 files), owner-pid polling, stale-session cleanup.
- `src/delta-cli.ts` — spawns `delta --json`, unwraps `{"error":{...}}`
  payloads, exposes `retryable`/`retry_after_ms`.
- `test/` — unit tests; `validate.sh` runs everything.
- `.markdownlint-cli2.jsonc` — lint config for all Markdown in the repo.
- `.qwen/` — Qwen Code session scratch; gitignored, never commit it.

## Build, Test, and Development Commands

- `./validate.sh` — full check (install if needed, markdownlint, `tsc`,
  `node --test`); identical to CI. `/safe-commit` runs it by name.
- `npm run build` — compile `src/` + `test/` to `dist/`.
- `npm test` — run the compiled test suite; single file:
  `node --test dist/test/state.test.js`.
- Dev-install the extension: `qwen extensions link "$(pwd)"` (relink after
  manifest changes; commands resolve through `~/.qwen/delta/cli.js`).

## Coding Style & Naming Conventions

Markdown is linted with markdownlint-cli2. MD013 line length applies to prose
only — tables, fenced code blocks, and headings are exempt
(`.markdownlint-cli2.jsonc`); wrap all other Markdown at 80 columns.

TypeScript is strict (`strict`, `verbatimModuleSyntax`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`); ESM with `.js`
import specifiers; no runtime dependencies (the dispatcher must stay a
single dependency-free spawn).

## Commit & Pull Request Guidelines

History uses short lowercase imperative subjects with no conventional-commit
prefixes: "add delta-qwen plugin plan", "ignore agent scratch and configure
markdownlint". `main` is the working branch; `origin` is
`github.com/nam20485/delta-code-agents` (also has a `development` branch). No
PR template exists.

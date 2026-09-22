# Auto-lint

One automatic runner, one check batch before Pi settles after edits. Requires Pi's `agent_before_settle` event (current installation: 0.87).

## Behavior

- Successful `edit`/`write` events collect nearest package/module roots within the session directory. Failed edits, vault notes and non-code prose are ignored.
- No debounce timer and no lint per edit. Each affected root is checked once at the final agent boundary. No edits means no checks.
- `/lint` checks pending roots or the current directory immediately and consumes the pending batch. `/lint-status` only shows results. `/lint-on` and `/lint-off` toggle automatic checks.
- Success is status-only, not an LLM message. One bounded failure summary per batch is queued for the next user turn; no automatic retry/agent loop.
- Unconfigured projects show a quiet `not configured` status; `/lint-status` explains what to configure. This is not a passing check.
- Commands time out after two minutes each; stopping/reloading aborts in-flight work.

## Detection

JS/TS/React/Next: prefer `lint:check`/`lint`, `typecheck`/`type-check`, and `format:check` scripts using npm/pnpm/yarn/bun. Otherwise use installed local ESLint or configured Biome, tsc with tsconfig.json, vue-tsc or svelte-check, and Prettier check. Stylelint is selected when installed and no lint script owns checks. React/JSX/TSX rules come from existing ESLint/Biome configuration; plugins are not installed or enabled automatically.

Go modules: `gofmt -l .` (output counts as failure), then configured golangci-lint or `go vet ./...`.

Python: Ruff (project .venv preferred), configured Ruff formatting and mypy. Rust: cargo fmt and clippy. .NET: dotnet format for a solution or individual projects, without restore.

No automatic lint:fix, generic format script, or tool installation. Project scripts themselves may write files or download dependencies; review them. Go/Rust checks may fetch build dependencies. Missing tools are reported, not installed. Yarn PnP should use project scripts. Framework generated types may require setup beforehand.

## Limits

No recursive scan of every monorepo package: only roots belonging to edited files are checked. Parent workspace dependencies and cross-package impact need explicit CI/project scripts. Shell/external/custom-tool edits are not watched. Manual agent checks are not automatically recognized; reuse results rather than invoking both mechanisms. Not a general filesystem watcher.

## Installation

Install with `pi install git:github.com/vcsoc/pi-auto-lint`, then `/reload`. Keep only ONE loaded copy: archive any previous `~/.pi/agent/extensions/auto-lint` installation outside the extensions folder. The entry point is `extensions/auto-lint.ts`; its three `.mjs` helpers live beside it.

## Tests

`npm test` from the repository root. Tests use fixtures and mock execution; they do not install or run language toolchains.

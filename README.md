# @vcsoc/pi-auto-lint

pi package for the `auto-lint` extension.

## What it does

- watches successful `write` and `edit` tool results
- debounces checks by `2500ms`
- detects common project lint/typecheck commands from the current cwd
- posts pass/fail results back into the session as `auto-lint` messages
- shows a footer status: `on`, `off`, or `linting…`

## Install

```bash
pi install ./packages/pi-auto-lint
```

Project-local:

```bash
pi install -l ./packages/pi-auto-lint
```

One-off test:

```bash
pi -e ./packages/pi-auto-lint
```

## Commands

```text
/lint
/lint-on
/lint-off
/lint-status
```

## Detected commands

- Node: `npm run lint`, `npm run lint:fix`, `npm run typecheck`, `npm run format`
- Python: `ruff check .`
- Rust: `cargo fmt --check`, `cargo clippy -- -D warnings`
- .NET: `dotnet format --verify-no-changes`

.NET detection is triggered when the current working directory contains `global.json`, a `.sln` file, or a `.csproj` file.

## Notes

- `npm run lint:fix` runs before other npm checks when present
- .NET detection now checks for real `.sln` and `.csproj` files in the current directory instead of relying on wildcard paths
- auto-lint only triggers after `write` and `edit`; it does not watch `bash`
- if a lint run is already in progress, one follow-up run is queued
- command output is truncated to the last `12000` characters
- if no supported lint command is detected, the extension warns and does not run anything

# Rika

## Purpose

Rika is a local-only personal coding-agent CLI and OpenTUI application. Its committed dependency contract consumes released Baton and Relay packages and uses Effect v4 throughout.

## Required Reading

- `CONTEXT.md` for vocabulary.
- `SPEC.md` for feature and decision ownership.
- `PLAN.md` for implementation sequence and gates.
- `TODO.md` for current execution status.
- `docs/features/FEATURES.md` for product coverage.

## Architecture Rules

- Rika commits published Baton and Relay package versions. The explicit `bun run upstream:link` development overlay may link sibling public packages without changing the manifest or lockfile; never copy, vendor, fork, deep-import, or commit local links.
- Relay owns durable execution, child runs, waits, joins, and replay.
- Baton owns the agent loop and model/tool protocol.
- Use Effect APIs for concurrency, scope, streams, config, CLI, platform I/O, SQL, HTTP, WebSockets, schedules, retries, and errors when available.
- Build every CLI surface with `effect/unstable/cli`.
- Use Effect SQL for Rika-owned SQLite state.
- Use WebSockets, never SSE, for any Rika-owned live execution/control process transport. Provider and MCP transports follow their package contracts.
- Keep OpenTUI imports inside the TUI adapter.
- Do not implement semantic search or ast-grep outline tools.
- Do not introduce Rivet, actors, web, IDE, remote runners, or orbs.
- Do not use direct provider SDKs.
- Do not put comments in code.
- Do not create `utils`, `helpers`, `common`, or `lib` catch-all modules.

## Effect Module Rules

- Package entrypoints export intentional namespaces.
- Services export an `Interface`, `Context.Service`, explicit layers, tagged boundary errors, and a test or memory layer.
- Service methods and workflows use `Effect.fn("Module.method")`.
- Bind yielded services to named variables before invoking methods.
- Run Effects only at app, test, or SDK host boundaries.
- Read environment values at one app configuration boundary.

## Documentation Discipline

- Update the feature ledger when feature status changes.
- Update the owning spec before changing a public contract or behavior.
- Add or amend an ADR before changing a stable architectural decision.
- Update `TODO.md` in the same change as completed work.
- Record verification evidence rather than claiming parity from code presence.

## Verification

Effect-based unit and service tests use `@effect/vitest` `it.effect` or `it.scoped`. Use `bun:test` only for Bun-native SQLite, OpenTUI, packaged-process, or other runtime integration that cannot load under Vitest.

Pilotty and agent-tty are the required interactive TUI acceptance harnesses. Load the project skills `testing-with-pilotty` and `testing-with-agent-tty` before using them. Use Pilotty for fast PTY interaction and semantic comparisons. Use agent-tty for Ghostty-backed snapshots, PNG screenshots, recordings, and final reviewer-facing evidence. Test the packaged Rika binary and installed Amp at identical terminal dimensions. Exercise every affected keyboard, mouse, resize, streaming, tool, permission, queue, thread, replay, and exit flow. Use isolated state and `RIKA_TEST_MODEL_SCRIPT` for deterministic agentic workflows. Do not claim visual parity from reducer tests or synthetic frames alone.

```bash
bun run docs:check
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
bun run package:smoke
```

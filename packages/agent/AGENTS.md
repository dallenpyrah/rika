<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-27 | Updated: 2026-06-27 -->

# Agent Package

## Purpose

`packages/agent/` owns Rika's core agent orchestration loop: turn context assembly, model streaming, tool dispatch, durable event emission, cancellation records, and queued turn boundaries.

## Key Files

| File                      | Purpose                                                     |
| ------------------------- | ----------------------------------------------------------- |
| `src/agent-loop.ts`       | Effect service that runs turns and emits persisted events.  |
| `src/tool-executor.ts`    | Minimal swappable tool execution boundary for the MVP loop. |
| `src/index.ts`            | Package namespace exports.                                  |
| `test/agent-loop.test.ts` | Fake model/tool orchestration and cancellation tests.       |

## Current Standards

- Keep the agent loop provider-neutral by depending on `@rika/llm`'s `Router.Service`, not provider SDKs.
- Keep tool execution behind `ToolExecutor.Service` until the full tool registry lands.
- Persist canonical facts through `ThreadEventLog` and apply rebuildable state through `ThreadProjection`.
- Use streams, queues, and fibers for event streaming boundaries; do not introduce module-level runtime state.

## For AI Agents

- Read `../../docs/effect-module-conventions.md` before adding or changing services.
- Read `../../docs/persistence.md` before changing event persistence behavior.
- Do not import raw Drizzle, Rivet, model SDKs, or filesystem mutation APIs here.

## Testing And Verification

- `bun run lint` from this package or from the repo root.
- `bun run typecheck` from this package or from the repo root.
- `bun run test` from this package or from the repo root.

<!-- MANUAL: Add human-maintained notes below this line. They are preserved by deep-init. -->

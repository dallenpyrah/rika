# CLI Package

## Purpose

`packages/cli/` owns the local `rika` process entrypoint. It parses arguments with Effect CLI, routes commands to Effect services, composes live local layers, and prints machine-readable output for non-interactive commands.

## Key files

| File             | Purpose                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `src/args.ts`    | Effect CLI parser and command schemas.                            |
| `src/main.ts`    | Bun binary entrypoint.                                            |
| `src/runtime.ts` | Live local layer assembly and command routing.                    |
| `src/tui.ts`     | Local TUI command executor and Rivet ThreadActor backend adapter. |
| `src/execute.ts` | One-shot agent turn execution and JSON event streaming.           |
| `src/threads.ts` | Thread lifecycle/search/import command executor.                  |
| `src/doctor.ts`  | Local diagnostics command with no telemetry upload.               |
| `src/config.ts`  | Settings inspection/edit command executor.                        |
| `src/mcp.ts`     | MCP server list/approval/config command executor.                 |
| `src/skills.ts`  | Skill list/inspect/install/remove command executor.               |
| `src/review.ts`  | Local review command executor.                                    |
| `src/memory.ts`  | Thread memory status/index command executor.                      |
| `src/output.ts`  | Swappable stdout/stderr boundary.                                 |

## Current standards

- Import `Command` directly from `effect/unstable/cli`; do not alias it as `EffectCommand`.
- Stdout is reserved for newline-delimited protocol events or command JSON/text output; diagnostics go to stderr.
- Compose local runtime dependencies in `runtime.ts`; feature command modules should depend on service interfaces.
- The CLI is local-only. Do not add web, IDE, SDK/server, orb, remote-control, hosted, or deploy commands.
- Local Rivet actor host composition uses `@rika/rivet-host`; do not import raw `rivetkit` here.
- Persistence goes through `@rika/persistence` services; do not import Drizzle or `bun:sqlite` here.
- Runtime environment loading may merge process env and settings files, but secrets and tokens must be redacted in doctor/status output.
- Tests use fake model/tool/output layers and memory persistence, not process stdout or network providers.

## For AI agents

- Read `../../docs/effect-module-conventions.md` before adding or changing CLI services.
- When adding startup config, update `src/runtime.ts`, doctor redaction, owner docs, and package smoke expectations together.

## Testing and verification

- `bun run lint` from this package or from the repo root.
- `bun run typecheck` from this package or from the repo root.
- `bun run test` from this package or from the repo root.

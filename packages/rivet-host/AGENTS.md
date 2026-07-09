# Rivet Host Package

## Purpose

`packages/rivet-host/` owns RivetKit actor definitions, local actor host assembly, and the adapter boundary between Rivet actors and Rika Effect services. It is the only package where raw `rivetkit` or `@rivetkit/effect` imports are allowed.

## Key files

| File                   | Purpose                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `src/host-config.ts`   | Local Rivet endpoint config.                                      |
| `src/thread-actor.ts`  | Public ThreadActor contract and typed action schemas.             |
| `src/thread-client.ts` | Effect client adapter for the ThreadActor contract.               |
| `src/thread-live.ts`   | Server-side ThreadActor implementation and actor-local event log. |
| `src/local-host.ts`    | Local Rivet registry/layer assembly.                              |
| `src/main.ts`          | Bun local development entrypoint.                                 |
| `src/index.ts`         | Package namespace exports.                                        |

## Current standards

- Keep raw Rivet imports inside this package.
- Rika is local-only. Host config must stay localhost-oriented and must not add Rivet Cloud, remote runner, token, namespace, hosted control-plane, or deployment modes.
- Actor hot state is rebuildable. The actor-native `ThreadActor` event log lives in the actor's embedded SQLite database through `rawRivetkitContext.db`.
- Use `@rivetkit/effect` contracts and layers for actor code; do not wrap actor calls in ad hoc promises.
- Actor-local SQLite access stays inside this package behind the `ThreadActor` action contract.
- Cross-thread local read models remain behind persistence services.
- `StartTurn` runs `AgentLoop.streamTurn` inside the actor path. The actor host uses an in-memory AgentLoop working database hydrated from actor c.db before streaming existing threads.
- Local RivetKit file-system storage is the expected runtime path. FoundationDB is not used.

## For AI agents

- Read `../../docs/effect-module-conventions.md` and `../../docs/runtime-and-layers.md` before adding host services.
- Read `../../docs/persistence.md` before changing actor persistence behavior.
- Prefer the current `@rivetkit/effect` public examples over older `actor-core` or `@rivet-gg/actor` APIs.

## Testing and verification

- `bun run lint` from this package or from the repo root.
- `bun run typecheck` from this package or from the repo root.
- `bun run test` from this package or from the repo root.
- `RIKA_RUN_NATIVE_RIVET_TESTS=1 bun test packages/rivet-host/test/thread-actor-native.test.ts` runs the opt-in native engine c.db/broadcast harness.
- `RIVET_RUN_ENGINE=1 bun run dev` from this package starts the local Rivet engine and registry.

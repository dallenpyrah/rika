# ADR 0002: Rivet-actor-native thread ownership

## Status

Accepted

## Context

The earlier `packages/rivet-host/ThreadActor` patch kept the central DB event log as the source of truth and treated the actor as a thin turn router. That preserved the `(thread_id, sequence)` append race, in-process turn locks, and bespoke NDJSON fan-out while adding a distributed runtime that owned none of them.

Issue #104 requires a foundational inversion: the ThreadActor **is** the thread.

## Decision

1. **Per-thread durable truth lives in the actor.** The append-only event log is stored in the actor's embedded SQLite (`c.db`). Hot actor state holds only rebuildable metadata (active turn, sequence cursor, visibility).
2. **Single-writer monotonic sequence** is owned by the actor. Cross-process append races disappear.
3. **Streaming turns run inside the actor** via the reused `AgentLoop.streamTurn`. Each emitted event is appended to actor c.db and broadcast as `threadEvent`.
4. **Live subscription is native Rivet** (`.connect().on("threadEvent")`) plus typed `GetEvents(after_sequence)` catch-up for late joiners and reconnect.
5. **Postgres (or local SQLite) is a cross-cutting index/read-model**, never the per-thread event source. Tables: memberships, projects, orbs, artifacts, thread_projections, user_tokens, memory chunks.
6. **Product backend path is the Rivet edge.** Remote-control is not a selectable product backend. HTTP/SDK NDJSON remains an adapter for local-dev/in-orb compatibility.
7. **AgentLoop working database on the actor host is memory-mode** so central DB rows cannot become the durable event authority during turns.

## Consequences

- Simplifies interruption, multi-subscriber tails, and hosted scaling around single-writer actors.
- Requires dialect-aware index persistence (SQLite local, Postgres hosted).
- Clients must reconnect and resume from sequence cursors under Railway WebSocket duration limits.
- Compatibility RemoteControl modules may remain as test adapters until deleted; they are not product entry points.

## Implementation location

Actor implementation lives under `packages/rivet-host` (`thread-actor.ts`, `thread-live.ts`, `native-edge.ts`, `thread-client.ts`). Package name `packages/thread-actor` from early spike planning is not required; outcomes matter more than that path.

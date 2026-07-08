# Rivet Migration

## 2026-07-08

Status:

- Issue #104 vertical is largely implemented on the product path and proven under TDD.
- Actor-local events are the canonical store for the ThreadActor action path (`packages/rivet-host` c.db).
- `StartTurn` runs `AgentLoop.streamTurn` inside the actor path and appends every emitted event into actor c.db with `threadEvent` broadcast.
- Native dual concurrent raw subscribers + `GetEvents` replay parity are covered by the opt-in harness (`RIKA_RUN_NATIVE_RIVET_TESTS=1`).
- Interrupt persists exactly one terminal `turn.failed` (native harness).
- Product default backend is always the Rivet HTTP edge; `RIKA_SERVER_BACKEND=remote-control` is ignored.
- Actor host AgentLoop database is always `memory` so central DB cannot be durable turn event authority.
- Postgres async index path exists for hosted/cross-cutting tables (no `thread_events` event log on Postgres).
- `UserTokenStore` issues/resolves/revokes per-user bearer tokens (SQLite + Postgres).
- `PresenceActor` pure state model added for actor-owned presence (edge still merges process hub for HTTP compat).
- Railway personal project `rika` under **My Projects** created with Postgres, edge, actor-runner, rivet-engine, web; staging + production; PR envs inherit staging; production triggers on `release`, staging on `main`.
- Staging edge image builds, but live multi-subscriber smoke remains blocked until the hosted process stays healthy (healthcheck / runtime wiring). Deploy artifacts and static validation tests are committed.

Target end state:

- Rika has one backend: Rivet-backed ThreadActor owns each thread; actor c.db owns the event log; HTTP/SDK routes are adapters.
- Remote-control is not a product backend.
- Postgres index for cross-cutting relational data; actor storage for per-thread events.
- Hosted Railway staging/prod/PR topology operational.

Data split:

- Actor c.db: per-thread event log (single-writer).
- Postgres/SQLite index: memberships, projects, orbs, artifacts, projections, user_tokens, memory chunks — rebuildable, not event authority.

Railway (personal `My Projects` / workspace id for dallenpyrah personal):

- Project: `rika` (`758169d2-318f-444f-9be5-057ccc61e999`)
- Environments: `staging` (base for PR envs), `production` (branch `release` triggers)
- Services: Postgres (online), rika-edge, rika-actor-runner, rika-rivet-engine, rika-web
- Recipe: `deploy/railway/services.json` + `deploy/railway/README.md`
- Static gates: `scripts/check-railway-config.test.ts`

Latest verification:

- `RIKA_RUN_NATIVE_RIVET_TESTS=1 bun test packages/rivet-host/test/thread-actor-native.test.ts` (stores, dual live subscribers, interrupt)
- `bun test packages/cli/test/runtime-env.test.ts` (native default + memory actor host)
- `bun test packages/persistence/test/postgres-index.test.ts packages/persistence/test/user-token-store.test.ts`
- `bun test scripts/check-railway-config.test.ts`
- `bun run --cwd packages/persistence typecheck`
- Railway staging deploy builds image; healthcheck failed until runtime/token/rivet engine wiring completes end-to-end on host

Remaining residual:

- Keep native harness stable; graduate more cases to default CI when engine startup is reliable.
- Finish hosted smoke once edge stays healthy with Rivet engine + env matrix (model keys, Rivet endpoint).
- Delete leftover RemoteControl product code paths (tournament/orb flush still have legacy imports) after tests migrate fully.
- Wire PresenceActor into NativeEdge live presence instead of process-local hub only.
- CLI `login`/`logout` write `~/.rika/settings.json` using `UserTokenStore` issue path against hosted edge.
- Production promote via `git merge main → release` once staging smoke is green.

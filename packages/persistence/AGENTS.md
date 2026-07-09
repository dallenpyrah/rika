# Persistence Package

## Purpose

`packages/persistence/` owns Drizzle-backed local SQLite adapters, migrations, and durable storage services. It is the only package where raw Drizzle and `bun:sqlite` handles are allowed.

## Key files

| File                        | Purpose                                                                         |
| --------------------------- | ------------------------------------------------------------------------------- |
| `drizzle.config.ts`         | Drizzle Kit configuration for local SQLite migration generation.                |
| `drizzle/`                  | Committed generated SQL migrations and Drizzle metadata.                        |
| `src/artifact-store.ts`     | Durable artifact persistence.                                                   |
| `src/database.ts`           | Effect `Database` service and SQLite connection layers.                         |
| `src/mcp-approval-store.ts` | Durable workspace MCP command-server approval records.                          |
| `src/migration.ts`          | Effect `Migration` service for runtime migration application.                   |
| `src/schema/event-log.ts`   | Drizzle schema for local durable tables.                                        |
| `src/schema/index.ts`       | Schema exports consumed by Drizzle Kit and services.                            |
| `src/thread-event-log.ts`   | Local append-only thread event log for non-actor compatibility and projections. |
| `src/thread-projection.ts`  | Rebuildable thread list/latest message/active turn/diff projections.            |
| `src/workspace-store.ts`    | Durable local workspace membership persistence.                                 |

## Current standards

- SQLite is the only supported persistence dialect.
- Keep Drizzle schema field names snake_case so column names do not need string remapping.
- Expose persistence behavior through Effect services and layers.
- Prefer `Database.memoryLayer` in tests; use file-backed `layerFromPath` only when testing file-specific SQLite behavior.
- Generated SQL migrations in `drizzle/` are committed. Do not hand-edit Drizzle metadata unless repairing a broken migration intentionally.
- Raw Drizzle handles may be used only inside this package.
- `ThreadEventLog` and actor c.db logs are canonical for their respective paths. `ThreadProjection` tables are disposable and rebuildable.
- Do not add Postgres, PGlite, FoundationDB, projects, orbs, user-token hosting, or hosted-control-plane stores.

## For AI agents

- Read `../../docs/persistence.md` before changing schema, migrations, or persistence services.
- Read `../../docs/effect-module-conventions.md` before adding a new persistence service.
- Keep repository/domain services above this adapter boundary so storage can be tested with memory or file-backed SQLite layers.

## Testing and verification

- `bun run db:generate` from this package or from the repo root after schema changes.
- `bun run db:migrate` from this package or from the repo root to apply committed migrations locally.
- `bun run lint` from this package or from the repo root.
- `bun run typecheck` from this package or from the repo root.
- `bun run test` from this package or from the repo root.

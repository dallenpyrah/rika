# Rika

## Purpose

Rika is a local-only, personal coding agent CLI. The product target is one Bun CLI backed by Effect services and RivetKit actors. Do not reintroduce web, IDE, SDK/server, orb, hosted control-plane, Railway, Rivet Cloud, or deployment surfaces unless the user explicitly asks.

## Conventions

Do not put comments in code. Put design rationale, conventions, and context in AGENTS.md files, `CONTEXT.md`, docs, or skill files.

## Greenfield change policy

- Rika is greenfield. Prefer breaking changes that make the local CLI simpler, more correct, or easier to operate.
- Do not add compatibility aliases, migration shims, fallback config keys, deprecated paths, or legacy mode names unless durable local data safety requires them.
- When renaming a concept, update known call sites, tests, docs, and examples in the same change.
- Delete obsolete code, tests, fixtures, docs, and behavior once the replacement exists.

## Key files

| File                                  | Purpose                                                              |
| ------------------------------------- | -------------------------------------------------------------------- |
| `README.md`                           | Product direction and quickstart.                                    |
| `CONTEXT.md`                          | Domain glossary. Keep implementation details out of this file.       |
| `docs/OWNER_MANUAL.md`                | Local install, usage, configuration, and operations.                 |
| `docs/SECURITY.md`                    | Local trust, tools, plugins, MCP, secrets, and persistence security. |
| `docs/effect-module-conventions.md`   | Copyable Effect service/module conventions.                          |
| `docs/runtime-and-layers.md`          | Runtime/layer assembly conventions.                                  |
| `docs/observability.md`               | Local telemetry and diagnostics guidance.                            |
| `docs/persistence.md`                 | SQLite, Drizzle, migrations, and persistence boundaries.             |
| `docs/adr/0002-rivet-actor-native.md` | Actor-native thread ownership decision.                              |
| `package.json`                        | Bun workspace, dependency catalog, and root scripts.                 |
| `turbo.json`                          | Monorepo task graph.                                                 |
| `.oxlintrc.json`                      | Root oxlint configuration.                                           |
| `scripts/check-docs.ts`               | Lightweight docs/guidance consistency check.                         |

## Current standards

- The product name is Rika.
- Keep Rika fully Effect-native: services, layers, schemas, typed errors, scopes, streams, fibers, and test-replaceable dependencies.
- Follow the OpenCode-style module shape: `export * as Module from "./module"`, an exported `Interface`, a `Context.Service` class, and explicit `Layer` values.
- Use `Schema.TaggedErrorClass` for errors that cross service boundaries.
- Use `Effect.fn("Module.method")` for service methods and named workflows.
- Bind services to named variables in `Effect.gen` before calling methods; do not use nested service yields.
- Log through `Diagnostics`; do not use `console.*` or `Effect.log*` in runtime package code.
- Use Bun, Turbo, oxlint, ast-grep, Effect, Drizzle, RivetKit, and `@rivetkit/effect` as the default stack.
- Use Effect CLI for CLI parsing. Import `Command` directly from `effect/unstable/cli`; do not alias it as `EffectCommand`.
- Keep raw Rivet imports in `packages/rivet-host`.
- Keep raw Drizzle and `bun:sqlite` imports in `packages/persistence`.
- The local product path is RivetKit actors with local file-system storage. FoundationDB is not used.
- Treat per-thread actor `c.db` as the active thread authority. Cross-thread SQLite stores are indexes, artifacts, memory, approvals, and projections.
- Keep implementation simple. Add abstractions only when they remove real duplication, keep dependencies swappable, or match an existing package boundary.

## Subdirectories

| Directory         | Purpose                                            |
| ----------------- | -------------------------------------------------- |
| `.agents/skills/` | Project-local skills committed in this repository. |
| `packages/`       | Workspace packages. See `packages/AGENTS.md`.      |

## For AI agents

- Call the `oracle` reviewer before final handoff on code, config, docs, or behavior changes. Keep it read-only and ask for diff-focused correctness and verification gaps.
- Use external documentation/research tools before relying on memory for third-party library behavior, especially Effect and RivetKit APIs.
- Read `CONTEXT.md` before naming new domain concepts.
- Read `docs/effect-module-conventions.md` before adding or changing an Effect service.
- Read `docs/runtime-and-layers.md` before changing process runtime assembly.
- Read `docs/persistence.md` before changing Drizzle schema, migrations, or persistence services.
- When a task matches a project-local skill, read the skill file before acting.
- Do not bypass Effect with module-level mutable state for services that must be testable.
- Do not call Drizzle, Rivet, model providers, or filesystem mutation APIs directly from UI- or CLI-facing feature modules.

## Testing and verification

- `bun install`: install workspace dependencies and update `bun.lock`.
- `bun run db:generate`: generate Drizzle SQL migrations from the persistence schema.
- `bun run db:migrate`: apply committed Drizzle migrations to the configured local SQLite database.
- `bun run docs:check`: verify documented scripts and guidance files still exist.
- `bun run lint`: run oxlint and ast-grep across the repository.
- `bun run typecheck`: run package type checks through Turbo.
- `bun run test`: run package tests through Turbo.
- `bun run build`: build package entrypoints through Turbo.
- `bun run format:check`: check formatting with Prettier.
- `bun run package:smoke`: compile the CLI release artifact and verify help/doctor startup.

## Dependencies

### External

- `effect`: domain model, services, layers, errors, streams, fibers, runtime composition, Effect CLI, and Effect AI contracts.
- `bun`: runtime, package manager, and local development loop.
- `turbo`: monorepo task graph.
- `oxlint`: fast linting.
- `drizzle-orm` and `drizzle-kit`: typed SQLite persistence and migrations behind Effect services.
- `rivetkit` and `@rivetkit/effect`: local actor runtime and Effect integration.
- `@pierre/diffs`: file and edit diff metadata/rendering compatibility for syntax-aware surfaces.
- `@ff-labs/fff-bun`: default indexed file/path/content search.
- `ast-grep`: structural code outline/search support.

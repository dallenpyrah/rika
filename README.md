# Rika

Rika is a personal, local-only coding agent CLI built on Effect services and RivetKit actors. It is intentionally small: no web app, no IDE bridge, no SDK/server product surface, no orbs, and no hosted deployment path.

## Product shape

- One Bun CLI, `rika`, for local agent work.
- Effect owns service boundaries, typed errors, streams, layers, schemas, and runtime composition.
- RivetKit owns active thread orchestration through actor-native `ThreadActor` actions and actor-local SQLite (`c.db`).
- Drizzle-backed local SQLite stores cross-thread indexes, artifacts, thread memory, settings-derived approvals, and rebuildable projections.
- Built-in tools stay local: shell, file search, hashline read/edit/write, semantic search, ast-grep outline, MCP, skills, review, and plugins.
- Live model calls use `RIKA_BASE_URL` as the model provider base URL and default to `http://127.0.0.1:8317/v1`.
- Rivet runs locally with file-system storage. FoundationDB, Rivet Cloud, hosted control planes, Railway, web, IDE, SDK, and remote-control adapters are out of scope.

## Install from source

```bash
bun install
bun run package:smoke
bun run install:local
rika doctor
```

Update a local install with:

```bash
git pull --ff-only
bun install
bun run update:local
```

## Daily use

```bash
rika doctor
rika run --mode smart "fix the failing test"
rika --execute "summarize this repository"
rika threads list
rika threads search "auth race"
```

The CLI is built with `effect/unstable/cli` and imports `Command` directly from that package.

## Local Rivet runtime

Rika follows the local RivetKit path: the CLI starts a local Rivet actor host, keeps the endpoint on localhost, and stores runtime state on the local file system under `RIKA_DATA_DIR`. The active runtime path is CLI or TUI → local Rivet `ThreadActor` → `AgentLoop` → LLM router → configured model provider base URL.

Defaults:

| Setting                     | Default                                           |
| --------------------------- | ------------------------------------------------- |
| Model provider base URL     | `http://127.0.0.1:8317/v1`                        |
| Rivet endpoint              | `http://127.0.0.1:6420`                           |
| RivetKit storage            | `$RIKA_DATA_DIR/rivetkit`                         |
| Rivet engine file-system DB | `$RIKA_DATA_DIR/rivetkit/.rivetkit/var/engine/db` |
| FoundationDB                | not used                                          |

## Development verification

```bash
bun install
bun run docs:check
bun run lint
bun run typecheck
bun run test
bun run build
bun run format:check
bun run package:smoke
```

Persistence migrations live in `packages/persistence/drizzle` and are managed through:

```bash
bun run db:generate
bun run db:migrate
```

See `docs/OWNER_MANUAL.md` for local operation, `docs/SECURITY.md` for trust boundaries, and `docs/runtime-and-layers.md` for runtime composition rules.

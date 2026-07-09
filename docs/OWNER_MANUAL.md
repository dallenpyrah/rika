# Rika Owner Manual

Rika is a local-only coding agent CLI for personal use. It runs on Bun, Effect services, local SQLite, and RivetKit actors. There is no web UI, IDE bridge, SDK/server product surface, orb system, hosted control plane, Railway deployment, or Rivet Cloud mode in this repo.

## Install and update

For source installs:

```bash
git clone https://github.com/dallenpyrah/rika.git
cd rika
bun install
bun run package:smoke
bun run install:local
```

`install:local` compiles the CLI and copies it to `${RIKA_INSTALL_DIR:-$HOME/.local/bin}/rika`. Put that directory on `PATH`.

Update from source with:

```bash
git pull --ff-only
bun install
bun run update:local
```

`bun run package` writes the compiled artifact and local runtime share assets under `dist/`.

## Settings

Rika reads optional JSON settings from `~/.config/rika/settings.json` and then `<workspace>/.rika/settings.json`. Workspace settings override user settings for scalar settings. Environment variables override scalar settings.

Recognized keys:

| Setting                   | Environment override            | Default                  |
| ------------------------- | ------------------------------- | ------------------------ |
| `mode.default`            | `RIKA_MODE`                     | `smart`                  |
| `compaction.auto`         | `RIKA_COMPACTION_AUTO`          | unset                    |
| `compaction.reserved`     | `RIKA_COMPACTION_RESERVED`      | unset                    |
| `compaction.prune`        | `RIKA_COMPACTION_PRUNE`         | unset                    |
| `compaction.pruneProtect` | `RIKA_COMPACTION_PRUNE_PROTECT` | unset                    |
| `compaction.pruneMinimum` | `RIKA_COMPACTION_PRUNE_MINIMUM` | unset                    |
| `memory.autoContext`      | `RIKA_MEMORY_AUTO_CONTEXT`      | `false`                  |
| `keymap`                  | none                            | `{}`                     |
| `telemetry.enabled`       | `RIKA_TELEMETRY`                | `true`                   |
| `telemetry.endpoint`      | `RIKA_TELEMETRY_ENDPOINT`       | `http://127.0.0.1:27686` |

Malformed settings files produce doctor/runtime warnings where surfaced and fall back to the next source instead of crashing startup.

Use `rika config list` to print effective non-secret configuration. Use `rika config edit` for user settings and `rika config edit --workspace` for workspace settings.

Set `memory.autoContext` to `true` to let resolved context include up to three high-similarity past thread references from the same workspace. The default is `false`; unavailable embeddings produce no automatic memory entries. Use `rika threads search --semantic "<query>"` to search indexed thread memory manually.

## Get started

```bash
rika doctor
rika run --mode smart "summarize this repository"
rika --execute --stream-json "list the risky files"
```

`rika doctor` prints local diagnostics as JSON and does not upload telemetry. It reports model credential presence, data paths, local Rivet configuration, and local storage checks without printing secret values.

## Agent modes

Rika ships five mode names as routing data:

| Mode    | Intent                          |
| ------- | ------------------------------- |
| `rush`  | Lowest latency for small tasks. |
| `smart` | Strong default intelligence.    |
| `deep1` | Capable coding mode.            |
| `deep2` | Deeper coding mode.             |
| `deep3` | Maximum coding mode.            |

Rika uses Effect AI provider packages for model access. It does not hand-roll provider HTTP/SSE adapters. Live model calls use `RIKA_BASE_URL` as the model provider base URL and default to `http://127.0.0.1:8317/v1`.

## Threads

Threads are durable task ledgers owned by local Rivet actors on the active path. Current thread commands:

```bash
rika threads list
rika threads search "auth race"
rika threads archive <thread-id>
rika threads unarchive <thread-id>
rika threads compact <thread-id>
rika threads fork <thread-id>
rika threads reference <thread-id> [query]
rika memory status
rika memory index --workspace /repo
```

Thread search treats bare words and quoted phrases as text terms. It also accepts inline filters: `file:<glob>`, `after:<ISO-date|24h|7d>`, `before:<ISO-date|24h|7d>`, and `archived:true|false`.

`delete`, `import`, and projection rebuild commands are parser-reserved but not implemented in the local actor-native command executor yet.

## Files, images, and context

The context resolver supports AGENTS guidance, file mentions, image references, thread references, thread memory, and skill instructions. Resolved context is persisted as thread events and rendered as untrusted model context for replay/debugging.

## Tools

Built-in tools are registered through the Effect `ToolRegistry` / `ToolExecutor` boundary and pass through permission policy. Defaults include:

- shell command execution
- fff-backed file/path/content search
- hashline read/edit/write tools with stale-anchor rejection
- semantic search and file-history mode
- ast-grep outline
- MCP tools after discovery/filtering/approval
- specialty tools such as Oracle, Librarian, and Painter-like adapters

Rika's fast local default is `allow-all`, so tools run without approval prompts unless you opt into stricter policy or install a plugin with a `tool.call` hook. All built-in, plugin, MCP, specialty, and self-extension tools still enter through `ToolExecutor.Service` and one `PermissionPolicy.Service` decision before execution.

Optional guard configuration is environment based:

```bash
RIKA_GUARDED_TOOLS="shell.*,write" rika run "inspect without mutating"
RIKA_GUARDED_FILES="secrets/*,.env" rika run "review config"
```

## Subagents and skills

Subagents run isolated bounded tasks and return compact summaries. Local processes default to read-only subagent tools. Set `RIKA_SUBAGENT_TOOLS=full` to expose the standard toolset to subagents without the recursive `task` tool.

Skill commands:

```bash
rika skills list
rika skills inspect <name>
rika skills add owner/repo/path/to/skill
rika skills add https://github.com/owner/repo --user
rika skills remove <name>
```

`rika skills add` clones the source with Git, validates `SKILL.md`, installs into `.agents/skills/<name>/` by default, and records provenance in `.agents/skills/skills-lock.json`. Use `--user` to install under `~/.config/rika/skills/<name>/`. Existing skills are not overwritten unless `--force` is set.

## Code review

Run local review with:

```bash
rika review --staged
rika review --base main packages/agent/src
```

Review checks live in `.agents/checks/` and are executed through read-only subagent boundaries by default.

## MCP

MCP servers are external tool providers. Workspace command servers require explicit approval by server name, config fingerprint, and effective launch directory:

```bash
rika mcp add context7 -- npx -y @upstash/context7-mcp
rika mcp add docs --url https://example.com/mcp
rika mcp list
rika mcp doctor
rika mcp approve <server-name>
rika mcp remove context7
```

`rika mcp add` writes `rika.mcpServers` in `<workspace>/.rika/settings.json` by default. Use `--global` to target `~/.config/rika/settings.json`. Skills may also bundle an `mcp.json` next to `SKILL.md`; `list`, `doctor`, and `approve` include those servers, but their tools are registered only on turns where that skill is explicitly loaded.

MCP tools still pass through normal tool policy; MCP is not a permission bypass.

## Plugins and self-extension

Plugins are trusted local TypeScript modules for the MVP. They can register tools, commands, modes, subagents, UI calls, and policy hooks through `@rika/plugin`.

Self-extension commands write auditable workspace files and trust artifacts:

```bash
rika extensions create-skill helper --description "Project helper"
rika extensions create-plugin notify --description "Notify on completion"
rika extensions enable-plugin notify --verification "bun test"
rika extensions disable-plugin notify --reason "not needed"
rika extensions rollback-plugin notify --reason "startup failed"
```

Generated plugins are disabled first and require explicit verification before enablement.

## Non-interactive and streaming JSON

Use non-interactive mode for scripts:

```bash
rika run --mode rush "write a short summary"
rika --execute --workspace /repo --thread thread_123 "continue the task"
```

With `--stream-json`, stdout is newline-delimited protocol events. Diagnostics go to stderr.

## Configuration environment

Rika imports process environment from three sources, in precedence order:

1. Process environment variables.
2. Workspace `.env.local`.
3. Legacy global `~/.rika/settings.json` for model credentials.

Common environment variables:

| Variable                   | Purpose                                                                 |
| -------------------------- | ----------------------------------------------------------------------- |
| `RIKA_MODE`                | Default agent mode when no command flag overrides it.                   |
| `RIKA_WORKSPACE_ROOT`      | Default workspace root.                                                 |
| `RIKA_DATA_DIR`            | Local data directory. Defaults to `~/.rika`.                            |
| `RIKA_DATABASE_URL`        | Optional SQLite database URL/path override. Postgres URLs are rejected. |
| `RIKA_TELEMETRY`           | Enable or disable local OTLP telemetry export.                          |
| `RIKA_TELEMETRY_ENDPOINT`  | OTLP base URL for traces and logs.                                      |
| `RIKA_COMPACTION_*`        | Optional automatic compaction thresholds and pruning knobs.             |
| `RIKA_SUBAGENT_TOOLS`      | `readonly` or `full`; local default is `readonly`.                      |
| `RIKA_API_KEY`             | Model provider credentials.                                             |
| `RIKA_EMBEDDINGS_API_KEY`  | Optional dedicated key for thread memory embeddings.                    |
| `RIKA_BASE_URL`            | Model provider base URL. Defaults to `http://127.0.0.1:8317/v1`.        |
| `RIKA_RIVET_ENDPOINT`      | Optional local Rivet endpoint override. Must be localhost HTTP.         |
| `RIVETKIT_STORAGE_PATH`    | Optional RivetKit local storage path override.                          |
| `RIVET__FILE_SYSTEM__PATH` | Optional Rivet engine file-system storage override.                     |
| `RIKA_INSTALL_DIR`         | Destination for `install:local` / `update:local`.                       |

## Local Rivet runtime

Rika uses RivetKit locally. Defaults are:

| Item                        | Default                                           |
| --------------------------- | ------------------------------------------------- |
| Endpoint                    | `http://127.0.0.1:6420`                           |
| RivetKit storage            | `$RIKA_DATA_DIR/rivetkit`                         |
| Rivet engine file-system DB | `$RIKA_DATA_DIR/rivetkit/.rivetkit/var/engine/db` |
| FoundationDB                | not used                                          |

This matches the local RivetKit recommendation for single-node development: local file-system storage rather than production self-hosting infrastructure.

## Persistence

Drizzle migrations are committed under `packages/persistence/drizzle/`.

```bash
bun run db:generate
bun run db:migrate
```

SQLite is the only supported Rika persistence dialect. Actor-local per-thread events live in Rivet actor `c.db`; cross-thread indexes and local stores live in the Drizzle SQLite database.

## Security

Read `docs/SECURITY.md` before using Rika against untrusted repositories, plugins, or MCP servers.

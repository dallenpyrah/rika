# Packages

## Purpose

`packages/` contains the reusable pieces for the local Rika CLI. Package code owns domain contracts, Effect services, persistence adapters, local tools, LLM routing, plugin/skill/MCP support, and the Rivet actor host.

## Subdirectories

| Directory      | Purpose                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| `agent/`       | Agent loop orchestration, context, tools, threads, memory, skills, and review. See `agent/AGENTS.md`. |
| `cli/`         | Bun CLI entrypoint and Effect CLI parsing. See `cli/AGENTS.md`.                                       |
| `core/`        | Core Effect service patterns and shared runtime services. See `core/AGENTS.md`.                       |
| `llm/`         | Provider-neutral LLM contracts and mode routing. See `llm/AGENTS.md`.                                 |
| `persistence/` | Drizzle-backed local SQLite adapter services and migrations. See `persistence/AGENTS.md`.             |
| `plugin/`      | Trusted local TypeScript plugin API and host services. See `plugin/AGENTS.md`.                        |
| `rivet-host/`  | RivetKit actor definitions and local host assembly. See `rivet-host/AGENTS.md`.                       |
| `schema/`      | Shared schema/protocol package. See `schema/AGENTS.md`.                                               |
| `tools/`       | Built-in workspace tools and adapters. See `tools/AGENTS.md`.                                         |

## Current standards

- Package entrypoints expose module namespaces with `export * as Module from "./module"` when a package has real modules.
- Each package owns its `package.json`, `tsconfig.json`, and package-local `src/` tree.
- Package tests live in `test/`, mirroring `src/` paths exactly where possible.
- Package code must be testable through Effect service/layer substitution instead of global state.
- Keep package dependencies directed from schema/contracts toward runtime adapters.
- Do not add packages for web, IDE, SDK/server, or orb concepts.

## For AI agents

- Read the package's nested `AGENTS.md` before editing package code.
- Do not add a package just to hold a single helper; create packages only when a durable boundary exists.
- Keep generated/build output out of commits.

## Testing and verification

- From the repository root, run `bun run lint`, `bun run typecheck`, `bun run test`, and `bun run build` after changing package code.
- Package-local scripts may be run from the package directory for a tighter loop.

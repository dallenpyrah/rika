# Schema Package

## Purpose

`packages/schema/` owns shared serializable schemas for the local CLI, agent, tools, persistence, and Rivet actor boundaries. It must stay free of runtime infrastructure so every package can depend on it safely.

## Key files

| File                 | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `src/index.ts`       | Package entrypoint for schema/protocol namespace exports. |
| `src/ids.ts`         | Branded protocol ID schemas and constructors.             |
| `src/message.ts`     | Message and content-part schemas.                         |
| `src/event.ts`       | Canonical thread event union and event reference helpers. |
| `src/tool.ts`        | Tool call/result wire schemas.                            |
| `src/artifact.ts`    | Durable artifact wire schema.                             |
| `src/error.ts`       | Serializable error envelope schema.                       |
| `src/workspace.ts`   | Local workspace membership and access-decision schemas.   |
| `test/index.test.ts` | Package export and protocol round-trip tests.             |

## Current standards

- Keep this package infrastructure-free: no Drizzle, Rivet, model SDK, filesystem mutation, CLI, server, or UI imports.
- Use Effect Schema for serializable contracts.
- Prefer branded IDs and versioned payload schemas over unstructured objects.
- Do not add IDE, orb, project, SDK, or remote-control protocol surfaces.
- Tests live under `test/` and import package source through `../src/index`.

## For AI agents

- Put durable protocol vocabulary in `../../CONTEXT.md` only when it is a domain concept, not just a TypeScript type name.
- Do not add runtime service implementations here.

## Testing and verification

- `bun run lint` from this package or from the repo root.
- `bun run typecheck` from this package or from the repo root.
- `bun run test` from this package or from the repo root.

<!-- Generated: 2026-06-27 | Updated: 2026-06-27 -->

# Rika

## Purpose

Rika is a greenfield Effect-native coding agent system. The repository currently contains planning and guidance only; implementation starts with the stacked GitHub issues.

## Key Files

| File | Purpose |
| ---- | ------- |
| `README.md` | Product direction and current repo state. |
| `CONTEXT.md` | Domain glossary. Keep implementation details out of this file. |
| `docs/RESEARCH.md` | Initial research notes for Amp, OpenCode, Pi, Rivet, Drizzle, fff, hashline, semantic search, and ast-grep outline. |

## Current Standards

- The product name is Rika. Do not use Orika or resurrect old project assumptions.
- Keep Rika fully Effect-native: use Effect services, layers, schemas, typed errors, scopes, streams, and fibers instead of ad hoc promises or singletons.
- Follow OpenCode-style module shape: `export * as Module from "./module"`, an exported `Interface`, a `Context.Service` class, and one or more explicit `Layer` values.
- Keep infrastructure swappable. Runtime code depends on service interfaces; tests provide in-memory or fake layers.
- Use Bun as the runtime/package manager, Turbo for monorepo task orchestration, and oxlint for linting once the scaffold exists.
- Use Drizzle only behind persistence services. Raw Drizzle handles do not cross into CLI, TUI, LLM, or actor orchestration modules.
- Treat the append-only event log as canonical durable truth. Projections and actor state are rebuildable.
- Use Rivet actors from day one for active thread orchestration. Keep Rivet-specific code in the Rivet host layer.
- Make `fff`, hashline read/edit, semantic search, and ast-grep outline default built-in tools.
- Keep implementation simple. Do not add abstractions unless they make dependencies swappable, remove real duplication, or match the established OpenCode-style shape.

## For AI Agents

- Read `CONTEXT.md` before naming new domain concepts.
- Read `docs/RESEARCH.md` before changing the architecture or issue stack.
- Do not create runtime packages outside the planned Bun/Turbo workspace structure without updating the repo guidance.
- Do not place product/domain definitions in `AGENTS.md`; put resolved vocabulary in `CONTEXT.md`.
- Do not bypass Effect with module-level mutable state for services that must be testable.
- Do not call Drizzle, Rivet, model providers, or filesystem mutation APIs directly from UI-facing modules.

## Testing And Verification

- No implementation scaffold exists yet, so there are no canonical repo verification commands.
- After the scaffold issue lands, this file must be updated with the exact Bun/Turbo/oxlint/typecheck/test commands.

## Dependencies

### External

- `effect`: Domain model, services, layers, errors, streams, fibers, runtime composition.
- `bun`: Runtime, package manager, scripts, and local development loop.
- `turbo`: Monorepo task graph once packages exist.
- `oxlint`: Fast linting once source files exist.
- `drizzle-orm` and `drizzle-kit`: Typed persistence and migrations behind Effect services.
- `rivetkit` and `@rivetkit/effect`: Actor runtime and Effect integration.
- `@ff-labs/fff-bun`: Default indexed file/path/content search.
- `ast-grep`: Structural code outline/search support.

<!-- MANUAL: Add human-maintained notes below this line. They are preserved by deep-init. -->

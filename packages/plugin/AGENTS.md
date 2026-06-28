<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-28 | Updated: 2026-06-28 -->

# Plugin Package

## Purpose

`packages/plugin/` owns Rika's trusted TypeScript plugin API, plugin loading, command/tool registration, UI abstraction, and policy hook adapter.

## Key Files

| File                          | Purpose                                                                |
| ----------------------------- | ---------------------------------------------------------------------- |
| `src/api.ts`                  | Public plugin author API types and hook contracts.                     |
| `src/plugin-host.ts`          | Effect service that loads plugins and exposes registered behavior.     |
| `src/plugin-ui.ts`            | Swappable plugin UI service for TUI and non-interactive adapters.      |
| `src/self-extension.ts`       | Auditable skill/plugin generation, enable, disable, and rollback.      |
| `src/examples.ts`             | Small example plugins used as executable documentation.                |
| `src/index.ts`                | Package namespace exports.                                             |
| `test/plugin-host.test.ts`    | Loader, hook ordering, command/tool, and policy behavior tests.        |
| `test/self-extension.test.ts` | Self-extension generation, verification, artifact, and rollback tests. |

## Current Standards

- Plugins are trusted local TypeScript modules in `.rika/plugins/*.ts` for the MVP.
- Plugin code registers capabilities through `PluginHost`; runtime execution still goes through `ToolRegistry`, `ToolExecutor`, and `PermissionPolicy`.
- Plugin UI calls must go through `PluginUi.Service`; do not import TUI, CLI output, or process IO directly here.
- Self-extension must write generated executable plugins disabled first and require an explicit verification command before enablement.
- Keep sandboxing explicit. The MVP loader is not a sandbox and must not claim isolation.

## For AI Agents

- Read `../../docs/effect-module-conventions.md` before changing services.
- Do not import Drizzle, Rivet, model providers, or terminal/process output adapters here.
- Do not make plugin hooks mutate canonical thread state directly; they must feed existing service boundaries.

## Testing And Verification

- `bun run lint` from this package or from the repo root.
- `bun run typecheck` from this package or from the repo root.
- `bun run test` from this package or from the repo root.

<!-- MANUAL: Add human-maintained notes below this line. They are preserved by deep-init. -->

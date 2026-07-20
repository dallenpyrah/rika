# Plan 008: Spike — wire plugin-registry contributions into execution

> **Executor instructions**: This is a SPIKE, not a build-everything plan. Your
> deliverable is a design + a thin throwaway prototype + a written open-questions
> list, NOT a shipped feature. Follow the steps in order. Run every verification
> command and confirm the expected result before moving on. If a STOP condition
> occurs, stop and report — do not improvise. When done, update this plan's status
> row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ea247c4..HEAD -- packages/extensions packages/runtime/src/agent-profiles.ts packages/tools`
> If any of those changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P2
- **Effort**: M (spike only; the build that follows is L)
- **Risk**: LOW (spike produces a design doc + throwaway prototype; no shipped behavior)
- **Depends on**: plans/002-*.md (soft — the permission-validation design references the enforced permission model; the spike can proceed and flag the dependency, but the *build\* it recommends must not land before 002)
- **Category**: direction
- **Planned at**: commit `ea247c4`, 2026-07-18
- **Issue**: https://github.com/dallenpyrah/rika/issues/145 (pre-existing issue — this plan is the executable spec for it)

## Why this matters

Rika already ships a complete plugin contribution system — a typed `Registrar`, a
digest-stamped `Generation` registry, a trust-gated loader, and an `extensionRoots`
config default — but **nothing consumes a generation's contributed tools, modes, or
agent profiles into an actual Execution**. `docs/features/extension-lifecycle.md`
states this plainly: the lifecycle command "does not itself load plugin code into an
Execution." Today `rika extensions` is bookkeeping; the last mile is missing.

This is the single largest "the architecture is one seam away" capability in the
repo: closing it turns owner-authored, locally-trusted tools and specialist profiles
into real agent capability. The spike exists because the mapping is non-trivial and
security-sensitive (contributed tools must be constrained by real permission
enforcement, PRODUCT.md direction #4 — "typed tools and clear permission choices
rather than unrestricted model access"), so we design and prototype before committing
to a build.

## Current state

The contribution surface already exists and is neutral (`Json`-shaped), by design so
the `@rika/extensions` package need not depend on Baton or runtime.

- `packages/extensions/src/plugin-api.ts:5-10` — a contributed tool is **not** a Baton
  tool; it is a JSON-schema shape:
  ```ts
  export interface Tool {
    readonly name: string
    readonly description: string
    readonly inputSchema: Json
    readonly execute: (input: Json) => Effect.Effect<Json, unknown>
  }
  ```
- `packages/extensions/src/plugin-api.ts:18-23` — a contributed agent profile carries
  only names, no instructions/permissions/output schema:
  ```ts
  export interface AgentProfile {
    readonly name: string
    readonly description: string
    readonly mode: string
    readonly tools: ReadonlyArray<string>
  }
  ```
- `packages/extensions/src/plugin-registry.ts:4-14` — the published `Generation` already
  carries everything a consumer needs plus pinning digests:
  ```ts
  export interface Generation {
    readonly id: string
    readonly sourceDigest: string
    readonly configFingerprint: string
    readonly toolSchemaDigest: string
    readonly tools: ReadonlyMap<string, Tool>
    readonly modes: ReadonlyMap<string, Mode>
    readonly agentProfiles: ReadonlyMap<string, AgentProfile>
    readonly uiActions: ReadonlyMap<string, UiAction>
    readonly diagnostics: ReadonlyArray<string>
  }
  ```
- `packages/extensions/src/plugin-loader.ts:35-41` — the loader already gates every
  source behind `trust.isTrusted(...)` before `source.load`, so a generation only
  contains trusted contributions. Consumers do not re-check trust; they consume a
  published generation.

How tools reach execution TODAY (the shape a contributed tool must join):

- `packages/runtime/src/agent-profiles.ts:2` imports built-in tools as Effect AI `Tool`
  values (`AgentTools`, `Runtime as Tools`, `ThreadTools`) and `Toolkit` from
  `effect/unstable/ai`.
- `packages/runtime/src/agent-profiles.ts:80-104` — a profile resolves to a Baton
  `Agent` + a Relay `preset`:
  ```ts
  const toolkit = Toolkit.make(
    ...definition.tools,
    ...(name === "Review" ? [] : Object.values(AgentTools.runtimeToolkit.tools)),
  )
  return {
    name,
    agent: Agent.make(`rika-${name.toLowerCase()}`, { instructions: definition.instructions, model, toolkit }),
    preset: {
      instructions: definition.instructions,
      model: relayModel,
      tool_names: Object.keys(toolkit.tools),
      permissions: [...definition.permissions],
      output_schema_ref: definition.schema,
      metadata: { product_profile: name },
    },
    outputSchema: outputSchemas[name],
  }
  ```
- `packages/runtime/src/agent-profiles.ts:31-77` — the built-in roster is a hardcoded
  `definitions` object; each entry has `tools` (Baton tool values), `permissions`
  (strings like `"workspace.read"`, `"network.read"`, `"process.run"`), a `schema`
  ref, and `instructions`. Contributed profiles would join this roster.

Architectural constraints the spike MUST respect (from package `CLAUDE.md` files):

- `packages/extensions/CLAUDE.md` — extensions "must not import Baton internals,
  application, runtime, TUI, tool, persistence, MCP, or plugin modules." So the
  adaptation from `Json` tool → Baton `Toolkit` **cannot** live in `@rika/extensions`.
  It belongs in `@rika/runtime` (or `@rika/app`), which consumes the neutral
  `Generation`.
- `packages/runtime/CLAUDE.md` — runtime "owns the adapter from Rika product execution
  contracts to public Relay and Baton APIs. Relay identifiers, schemas, runtime
  services, and SQLite composition never cross this package boundary." So the new
  adaptation is a natural fit for runtime.
- Root `CLAUDE.md`: no code comments; no catch-all `utils`/`helpers` modules; use
  Effect services/schemas/typed errors; `effect/unstable/cli` for command surfaces.

Two contract gaps this spike must confront (they are the reason it is a spike, not a
patch):

1. **Tool shape mismatch.** Contributed tools are `inputSchema: Json` +
   `execute: (Json) => Effect<Json, unknown>`. Baton `Toolkit.make` expects Effect AI
   `Tool` values with Effect `Schema` parameters and typed handlers. An adapter must
   turn a `Json` schema into a `Schema` (or a permissive decoder) and wrap the untyped
   `execute` with a typed error boundary — the `unknown` error channel cannot cross
   into execution as-is.
2. **Permission vocabulary mismatch.** Built-in profiles use permission strings
   (`workspace.read`/`workspace.write`/`network.read`/`process.run`), while the config
   permission categories that plan 002 enforces are `read`/`write`/`search`/`shell`/
   `external`. A contributed tool has no declared permission at all. The spike must
   define how a contributed tool's required category is determined and validated so a
   plugin cannot silently obtain write/shell access.

## Commands you will need

| Purpose      | Command                                                | Expected on success |
| ------------ | ------------------------------------------------------ | ------------------- |
| Install      | `bun install --frozen-lockfile`                        | exit 0              |
| Typecheck    | `bun run typecheck`                                    | exit 0, no errors   |
| Focused test | `bun --bun vitest run --project unit packages/runtime` | all pass            |
| Full gate    | `bun run check`                                        | exit 0              |

(Verified from `package.json` during recon. `bun run check` fans out build +
typecheck + test + diagnostics + effect-check + lint + format-check.)

## Suggested executor toolkit

- Invoke the `effect` skill if available when designing the `Json`→`Schema` adapter and
  the typed-error boundary — v4 is beta, so verify `Schema`/`Toolkit`/`Tool.make`
  signatures against `node_modules/effect` before writing the prototype.
- Read `packages/runtime/src/agent-profiles.ts` fully and one built-in tool definition
  in `packages/tools/src` (e.g. `find-files.ts` or `read-file.ts`) to see the real
  `Tool.make` shape a contributed tool must produce.

## Scope

**In scope** (the only files you create/modify):

- `plans/008-spike-wire-plugin-contributions.md` (this file — status row only)
- `docs/spikes/wire-plugin-contributions.md` (CREATE — the design deliverable; if a
  `docs/spikes/` location conflicts with the doc rules, put the design in the plan's
  own "Findings" appendix instead and note it — see STOP conditions)
- A THROWAWAY prototype under `packages/runtime/src/` on the spike branch only, e.g.
  `packages/runtime/src/plugin-toolkit.spike.ts` and a `*.test.ts` beside it —
  explicitly marked throwaway, NOT wired into any layer, deleted or converted when the
  real build plan is written.

**Out of scope** (do NOT touch):

- `packages/extensions/**` — the contribution/registry/loader/trust surface is already
  correct; the spike consumes it, it does not change it. Adding a Baton import here
  violates `packages/extensions/CLAUDE.md`.
- The real permission enforcement — that is plan 002. This spike DESIGNS against it and
  flags the dependency; it does not implement enforcement.
- Any change that wires plugin tools into a real Execution path (`operation.ts`,
  `execution-backend.ts` registration). That is the build plan this spike produces, not
  the spike itself.
- MCP (`packages/extensions/src/mcp-*`) — a separate external-tool path.

## Git workflow

- Branch: `advisor/008-spike-plugin-contributions`
- Commit per deliverable (design doc; prototype; open-questions); plain imperative
  messages matching `git log` (e.g. "Prototype plugin-tool to Baton toolkit adapter").
- Do NOT push or open a PR unless the operator instructs it.

## Steps

### Step 1: Map the two contract gaps against real code

Read `packages/extensions/src/plugin-api.ts`, `plugin-registry.ts`, `plugin-loader.ts`,
`packages/runtime/src/agent-profiles.ts`, and one concrete built-in tool in
`packages/tools/src`. Write, in the design doc, the exact shape difference between a
contributed `Tool` (`inputSchema: Json`, `execute: (Json)=>Effect<Json, unknown>`) and a
Baton Effect AI `Tool` value that `Toolkit.make` accepts, and the exact permission
vocabulary difference (profile strings vs config categories).

**Verify**: the design doc's "Contract gaps" section names both shapes with `file:line`
citations that match the live code (re-read to confirm).

### Step 2: Prototype the `Json` tool → Baton `Toolkit` adapter (throwaway)

In `packages/runtime/src/plugin-toolkit.spike.ts`, write a function that takes a
`ReadonlyMap<string, Extensions.Tool>` (the generation's `tools`) and produces a Baton
`Toolkit` whose handlers wrap each contributed `execute` with:

- a `Schema` derived from (or validating against) the contributed `inputSchema: Json`,
- a typed error boundary converting the `unknown` failure channel into a named
  `Schema.TaggedErrorClass` (do NOT let `unknown` reach execution).

Keep it minimal and pure; do not wire it into any layer. Add a `*.test.ts` beside it
that feeds one fake contributed tool and asserts the resulting toolkit invokes the
handler and surfaces the typed error on failure.

**Verify**: `bun run typecheck` → exit 0; `bun --bun vitest run --project unit packages/runtime` → the new spike test passes. If `Json`→`Schema` proves infeasible without a schema compiler, STOP (see STOP conditions) and record the blocker.

### Step 3: Design the profile-merge + permission-validation path (no code)

In the design doc, specify: how a contributed `AgentProfile` (name/mode/tool-names)
joins the built-in `definitions` roster in `agent-profiles.ts`; how each referenced
tool name resolves against the _merged_ built-in+contributed catalog (and what happens
on an unknown name — fail admission, per the loader's existing diagnostic style); and
how each contributed tool's required permission category is determined so a contributed
profile cannot exceed the permissions plan 002 enforces. State explicitly that a
contributed tool with no derivable safe category is rejected, not defaulted to allow.

**Verify**: the design doc has a "Permission validation" section that references plan
002's category model and describes fail-closed behavior for unknown tool names and
underivable permissions.

### Step 4: Design per-Execution generation pinning

The `Generation` already carries `id`/`sourceDigest`/`configFingerprint`/
`toolSchemaDigest`. Design how a resolved generation id is pinned onto an Execution (mirror the existing route-pin-in-execution-metadata pattern — see how the runtime pins the execution route today) so a running turn uses a fixed plugin generation and a mid-run
`reload` cannot change its tools. Document where the pin is written and read.

**Verify**: the design doc's "Pinning" section names the metadata key and the read/write
sites, consistent with how execution route pinning already works.

### Step 5: Write the open-questions list and the recommended build plan outline

In the design doc, list the decisions the maintainer must make before the build:
UI-action delivery (the `uiAction` contributions have no consumer either), whether
contributed modes participate in mode selection, error/diagnostic surfacing to the
owner, and the plan-002 sequencing. End with a short outline of the follow-up BUILD
plan (files, order, tests) — not the build itself.

**Verify**: the design doc ends with an "Open questions" section (≥4 items) and a
"Recommended build plan outline" section.

## Test plan

- One throwaway unit test beside the prototype
  (`packages/runtime/src/plugin-toolkit.spike.test.ts`), modeled structurally on an
  existing runtime test (e.g. `packages/runtime/test/agent-profiles.test.ts`): feed a
  fake contributed tool, assert the adapted toolkit runs the handler and maps a thrown
  failure to the typed error.
- No other tests — this is a spike. The real test suite belongs to the build plan.
- Verification: `bun --bun vitest run --project unit packages/runtime` → all pass
  including the one new spike test.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `docs/spikes/wire-plugin-contributions.md` (or the plan appendix fallback) exists
      with sections: Contract gaps, Adapter design, Permission validation, Pinning,
      Open questions (≥4), Recommended build plan outline.
- [ ] `bun run typecheck` exits 0.
- [ ] `bun --bun vitest run --project unit packages/runtime` passes, including the new
      `plugin-toolkit.spike.test.ts`.
- [ ] `git grep -n "@batonfx" packages/extensions/src` returns nothing (the spike did
      NOT add a Baton dependency to the extensions package).
- [ ] No file under `packages/extensions/` was modified (`git status`).
- [ ] `plans/README.md` status row for 008 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The `Current state` excerpts don't match the live code (drift since `ea247c4`).
- `Json`→`Schema` adaptation for a contributed `inputSchema` proves infeasible without
  pulling in a JSON-Schema-to-Effect-Schema compiler — record the blocker and the
  options (permissive `Schema.Unknown` boundary vs a compiler dependency) rather than
  choosing one.
- A `docs/spikes/` doc conflicts with the repo's doc rules (root `CLAUDE.md` bans
  several doc kinds) — if unsure whether a spike doc is permitted, put the design in an
  appendix at the bottom of THIS plan file instead and note the choice, do not invent a
  new doc taxonomy.
- The prototype cannot be written without importing from `packages/extensions` into
  runtime in a way that violates a package `CLAUDE.md` boundary — stop and record the
  boundary problem.

## Maintenance notes

- This spike deliberately depends (softly) on plan 002: the permission-validation design
  is only sound once the config permission categories are actually enforced. The build
  plan this spike produces must not land before 002, or contributed tools would inherit
  the same "validated but unenforced" gap.
- The throwaway prototype (`*.spike.ts`) must be deleted or promoted when the build plan
  is written — do not let it accrete into a shipped-but-unwired module (that is the
  exact `main.ts` accretion smell the repo's no-catch-all rule guards against).
- A reviewer should scrutinize: that no Baton import leaked into `@rika/extensions`, and
  that the permission-derivation design is fail-closed (unknown tool name or underivable
  category rejects admission, never defaults to allow).

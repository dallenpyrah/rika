# Plan 009: Spike — load owner-authored Workflow definitions from `.rika/workflows`

> **Executor instructions**: This is a SPIKE, not a build-everything plan. Your
> job is to investigate the four open questions, produce the design document and
> a thin throwaway proof-of-concept, and STOP for review before any production
> wiring. Run every verification command and confirm the expected result before
> moving on. If anything in "STOP conditions" occurs, stop and report — do not
> improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ea247c4..HEAD -- packages/runtime/src/workflow-definitions.ts apps/rika/src/commands/workflows.ts packages/runtime/src/execution-backend.ts`
> If any of those files changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M (spike; the build it unlocks is a separate M–L plan)
- **Risk**: LOW (spike is read + one throwaway PoC; the decisions it produces are the risky part, deferred to review)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `ea247c4`, 2026-07-18
- **Issue**: https://github.com/dallenpyrah/rika/issues/155

## Why this matters

Rika already contains a fully general durable-workflow engine that it never lets
the owner use. `packages/runtime/src/workflow-definitions.ts` defines
`DynamicDefinition` — a schema with **13 operation kinds** (sequence, child,
tool, parallel, join, branch, approval, timer, retry, budget, cancellation,
compensation, structured-completion) — and a `compile()` that turns _any_ such
definition into a Relay `RegisterDefinitionPayload`. But the only definitions
ever fed to it are two hardcoded literals (`delivery`, `research-synthesis`), and
the CLI hardcodes those two names as an `Argument.choice`. The type is named
`DynamicDefinition`, yet nothing dynamic is ever supplied.

`PRODUCT.md`, `CONTEXT.md`, and `docs/features/workflows.md` already frame a
Workflow as _"versioned Rika data compiled to Relay durable operations."_ The
**data framing exists; the data path does not.** The single owner's own
repeatable multi-agent pipelines (their review-then-fix loops, custom research
shapes) are exactly what this engine is for. This spike defines how an owner
drops a definition file into their profile and runs it — turning a built engine
that serves two maintainer-shipped workflows into a capability the product
already promises.

The hard part is not the loader; it is four design decisions (file location,
revision/digest assignment, CLI dynamic names, admission-failure UX) that must
be settled before writing production code. That is why this is a spike.

**Guardrail (non-negotiable, restated from `docs/features/workflows.md:5`):** this
is declarative **owner-authored data** compiled through the _existing_
`DynamicDefinition` schema. It is NOT model-authored workflow code — the model
never writes or selects a workflow definition. `PRODUCT.md` excludes
model-authored workflow code; do not design anything that lets the agent loop
emit or mutate a definition.

## Current state

The facts you need, inlined. Open each file and confirm the excerpt before designing against it.

### `packages/runtime/src/workflow-definitions.ts` — the engine that has no data path

- The schema (lines 74–80):

```ts
export const DynamicDefinition = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  name: Schema.String,
  entry: Schema.String,
  operations: Schema.Array(Operation),
})
export type DynamicDefinition = typeof DynamicDefinition.Type
```

- `compile()` (lines 86–179) decodes then maps to `Workflow.OperationV2[]`. Note it
  validates with the **throwing** `Schema.decodeUnknownSync` at line 87 (and again
  on the output payload at line 169):

```ts
export const compile = (input: DynamicDefinition): Workflow.RegisterDefinitionPayload => {
  const definition = Schema.decodeUnknownSync(DynamicDefinition)(input)   // line 87 — THROWS on bad input
  const operations: Array<Workflow.OperationV2> = definition.operations.map((operation) => { ... })
  return Schema.decodeUnknownSync(Workflow.RegisterDefinitionPayload)({ ... })  // line 169 — internal invariant
}
```

- The id helper (lines 82–84, 230) — every definition is pinned to `v1`:

```ts
const workflowId = (value: string) => Ids.WorkflowDefinitionId.make(`rika:${value}:v1`)
export const idFor = workflowId
```

- The two hardcoded literals and the exported static array (lines 182–229):

```ts
export const definitions: ReadonlyArray<Workflow.RegisterDefinitionPayload> = [compile(delivery), compile(research)]
```

### The consumers the loader must plug into

- `packages/runtime/src/execution-backend.ts:62` — `import { definitions, idFor } from "./workflow-definitions"`.
- `packages/runtime/src/execution-backend.ts:1338–1339` — registration iterates the **static** array:

```ts
registerWorkflows: Effect.fn("ExecutionBackend.registerWorkflows")(function* () {
  return yield* Effect.forEach(definitions, (definition) => client.registerWorkflowDefinition(definition), { ... })
```

- `packages/runtime/src/execution-backend.ts:1356` — `start` resolves a name via `workflow_definition_id: idFor(name)`.
- `apps/rika/src/commands/workflows.ts:9` — the enumerated CLI choice that must become dynamic:

```ts
name: Argument.choice("name", ["delivery", "research-synthesis"]),
```

- `packages/app/src/operation.ts:3395` — `if (input.action === "start")` is where the product handles a start; `:3396` calls `backend.registerWorkflows()`.

### Conventions and boundaries the design must honor (inlined from repo docs)

- **Owner file location precedent**: workspace overrides live under `.rika/` (e.g.
  `.rika/settings.json`), global config under `~/.config/rika/`, and extensions
  under `extensionRoots: ["~/.config/rika/extensions", ".rika/extensions"]`
  (config defaults). A workflows loader should follow one of these, not invent a
  new location scheme.
- **Package boundary** (`packages/runtime/CLAUDE.md`): _"Relay identifiers,
  schemas, runtime services, and SQLite composition never cross this package
  boundary."_ `compile()` and `DynamicDefinition` live in `@rika/runtime`. A
  filesystem loader that reads `.rika/` should therefore live where product I/O
  already lives (`packages/app` or `packages/config`), produce
  `ReadonlyArray<DynamicDefinition>`, and hand that to runtime for compilation —
  the loader must not pull Relay `Workflow.*` types outside runtime.
- **CLI init order** (`apps/rika/CLAUDE.md`): _"Do not initialize SQL, Relay,
  models, MCP, plugins, or OpenTUI before command parsing selects an operation
  that needs them."_ Discovering workflow _names_ for the CLI is a cheap
  filesystem read (no SQL/Relay), so it is allowed at parse time — but confirm it
  stays filesystem-only.
- **Typed failures** (`CLAUDE.md`: Effect-native, typed errors): owner-facing input
  must fail with a typed error, never a thrown `decodeUnknownSync`. The existing
  MCP/config loaders show the pattern (`apps/rika/src/resident-wire.ts` uses
  `Schema.decodeUnknownSync` only on already-trusted internal wire; owner input
  uses decoded Effects — confirm the exact idiom during the spike).
- **No code comments** (`CLAUDE.md`). **No catch-all `utils`/`helpers` modules.**
- **Docs**: `docs/features/workflows.md` currently says _"Rika provides `delivery`
  and `research-synthesis`"_ — landing this capability will require updating that
  one capability doc (not part of the spike; note it for the build plan).

## Commands you will need

| Purpose      | Command                | Expected on success |
| ------------ | ---------------------- | ------------------- |
| Typecheck    | `bun run typecheck`    | exit 0, no errors   |
| Tests        | `bun run test`         | all pass            |
| Lint         | `bun run lint`         | exit 0              |
| Effect-check | `bun run effect-check` | exit 0              |

(Do NOT run `bun run check` in a tight loop — it re-packages the product and runs
the PTY journey suite. Use the focused commands above during the spike.)

## Scope

**In scope** (this spike):

- `plans/009-*` design output (this file's "Deliverables" section, filled in by you
  in a new `plans/009-findings.md` you create).
- A THROWAWAY proof-of-concept on the spike branch only: a minimal loader that reads
  one example `.rika/workflows/*.json`, decodes it as a typed Effect, and calls the
  existing `compile()`. It exists to answer the open questions, not to ship.

**Out of scope** (do NOT touch in this spike):

- `packages/runtime/src/execution-backend.ts` production `registerWorkflows` wiring —
  the injection design is a _deliverable_, the edit is the follow-on build plan.
- The `compile()` signature and the `DynamicDefinition` schema — do not change the
  engine; the spike consumes it as-is. (If the spike concludes `compile` needs a
  non-throwing variant, that is a _recommendation_ for the build plan, not an edit here.)
- Any change that lets a model author/select a definition (excluded).
- `apps/rika/src/commands/workflows.ts` production edit — design the dynamic-name
  approach; do not ship it in the spike.

## Git workflow

- Branch: `advisor/009-spike-owner-authored-workflows`
- Commit the throwaway PoC and `plans/009-findings.md` separately; plain imperative
  commit messages (match `git log`, e.g. "spike: load workflow definition from .rika").
- Do NOT push or open a PR. The spike branch is expected to be read, then discarded
  or promoted into the build plan.

## Steps

### Step 1: Confirm the engine accepts arbitrary valid definitions

Write a throwaway test (on the spike branch) that constructs a `DynamicDefinition`
literal NOT equal to the two built-ins (e.g. a two-step `sequence` of one `child`
and one `approval`) and passes it to `compile()`. Confirm it produces a valid
`Workflow.RegisterDefinitionPayload` without touching the hardcoded array.

**Verify**: `bun run test -- workflow` → the new spike test passes; `compile()` on a
novel definition returns a payload whose `id` is `rika:<name>:v1`.

### Step 2: Prototype a typed-failure loader

Build a minimal loader (throwaway, in the package you judge correct per the boundary
rules — record which and why) that: reads a directory of `*.json`, decodes each via
`Schema.decodeUnknown(DynamicDefinition)` returning a **typed** failure (not a thrown
`decodeUnknownSync`), and returns `ReadonlyArray<DynamicDefinition>`. Feed it one
valid file and one deliberately-malformed file.

**Verify**: valid file → decoded definition; malformed file → a typed error value you
can pattern-match (NOT an exception). Record the exact error shape you chose.

### Step 3: Answer the four open questions in `plans/009-findings.md`

Create `plans/009-findings.md` and resolve each, with a recommendation and the
evidence behind it:

1. **Location**: `.rika/workflows/*.json` (workspace) only, or also
   `~/.config/rika/workflows/`? State precedence with the two built-ins when a name
   collides (recommend: built-ins are reserved names that owner files cannot shadow,
   OR owner files win with a warning — pick one and justify from the config-merge
   precedent in `packages/config/src/config-service.ts`).
2. **Revision/digest**: today every definition is `rika:<name>:v1` (line 83). When an
   owner edits a file, how is the revision/digest assigned so `docs/features/workflows.md`'s
   _"each run pins its workflow definition revision and digest"_ holds? (Investigate
   whether a content digest → revision is feasible with `Ids.WorkflowDefinitionId` and
   how Relay treats re-registration of the same id with changed content.)
3. **CLI dynamic names**: `Argument.choice(["delivery","research-synthesis"])` (line 9)
   cannot enumerate discovered files at type level. Recommend the approach:
   `Argument.string("name")` + validate against discovered names in the handler with a
   typed "unknown workflow; available: …" error, vs. reading the workflows dir at parse
   time to build the choice list. Confirm your choice respects the CLI init-order rule.
4. **Registration injection**: `execution-backend.ts:1338` iterates the static
   `definitions` import. Design how discovered+compiled definitions reach
   `registerWorkflows` without a Relay type crossing the runtime boundary the wrong way
   (recommend: the loader (in app/config) produces `DynamicDefinition[]`; the backend
   layer receives them via config/service and calls `compile` inside runtime).

**Verify**: `plans/009-findings.md` exists with a concrete recommendation + evidence for
all four questions, and an explicit "admission-failure UX" paragraph (what the owner sees
when a file is malformed at startup — fail the whole start, or skip-and-warn per file).

### Step 4: Write the follow-on build-plan stub

Append to `plans/009-findings.md` a "Recommended build plan" section: the ordered edits
(loader module + tests, backend injection, CLI dynamic names, `docs/features/workflows.md`
update), each with its blast radius, so a build plan can be written directly from it.
Note DIRECTION-05 (headless workflow runs with structured completion) as the natural
follow-on — the `structured-completion` op kind (line 66) already exists with no headless
consumer — but do NOT plan it here.

**Verify**: the section lists concrete files and edits; a reviewer can turn it into a
build plan without re-investigating.

## Test plan

- Spike tests are throwaway and live on the branch only; they exist to answer questions,
  not to ship. Model the throwaway `compile()` test after
  `packages/runtime/test/workflow-definitions.test.ts` (the existing test for this module).
- No production test is added by the spike. The build plan that follows will add: a loader
  unit test (valid/malformed/empty-dir/name-collision) and a journey test for `rika
workflows start <owner-name>`.
- **Verification**: `bun run typecheck` exits 0 with the throwaway PoC present; `bun run
test -- workflow` passes.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `plans/009-findings.md` exists and resolves all four open questions with recommendations + evidence, plus an admission-failure UX paragraph and a "Recommended build plan" section.
- [ ] A throwaway loader PoC on the branch decodes a valid `.rika/workflows/*.json` into a `DynamicDefinition` via a typed Effect (no `decodeUnknownSync` on owner input) and a malformed file yields a typed error, demonstrated by a passing spike test.
- [ ] `compile()` is shown to accept a novel (non-built-in) definition unchanged.
- [ ] `bun run typecheck` exits 0 and `bun run test -- workflow` passes with the PoC present.
- [ ] No production file is modified (`git status` shows only `plans/009-findings.md` and throwaway PoC/test files on the spike branch).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts (the codebase drifted since this plan was written — the drift check flagged it).
- `compile()` throws on a valid novel definition, i.e. the engine is NOT actually general (this would invalidate the whole direction — report it as a finding, do not try to fix the engine).
- Answering the revision/digest question (open question 2) requires reading or changing Relay/`@relayfx/sdk` internals — that crosses the package boundary; record it as an open dependency on Relay and stop rather than reaching into `repos/*` (forbidden by `CLAUDE.md`).
- The spike reveals that owner-authored definitions cannot be registered without a model-authored-code path (they can't — but if the design drifts that way, STOP: that violates the guardrail and PRODUCT.md exclusion).
- You find yourself editing any production file to make the PoC work — the PoC must sit alongside, not modify, production wiring.

## Maintenance notes

- The follow-on build plan will touch `execution-backend.ts:1338` (registration) — whoever
  writes it must preserve the two built-ins and the `registerWorkflows` composition, and keep
  `compile()`/`DynamicDefinition` in `@rika/runtime` per the boundary doc.
- A reviewer of the spike output should scrutinize open question 2 (revision/digest) hardest —
  it is the one with a real Relay dependency and the one `docs/features/workflows.md` makes a
  promise about.
- Deferred out of this spike: the actual build, the `docs/features/workflows.md` update, and
  DIRECTION-05 (headless structured-completion runs).

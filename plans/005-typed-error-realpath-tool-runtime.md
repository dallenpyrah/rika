# Plan 005: Turn the tool-runtime workspace `realPath` defect into a typed tool failure

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ea247c4..HEAD -- packages/tools/src/tool-runtime.ts packages/runtime/src/execution-backend.ts`
> If either in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ea247c4`, 2026-07-18
- **Issue**: https://github.com/dallenpyrah/rika/issues/152

## Why this matters

`@rika/tools` builds a per-workspace tool runtime lazily and caches it for one
minute (`packages/runtime/src/execution-backend.ts` via `LayerMap.make`). When
the runtime layer is constructed, it canonicalizes the workspace path with
`fileSystem.realPath(workspace).pipe(Effect.orDie)`. `realPath` fails with a
recoverable `PlatformError` whenever the workspace directory is missing,
renamed, or permission-denied — a normal condition for a long-lived resident
daemon that outlives the directories it was pointed at. `Effect.orDie` promotes
that recoverable failure to an **unrecoverable defect**, so the tool fiber dies
instead of returning a tool error the model can see and react to. The
surrounding boundary only maps _failures_ into `ToolError`, not defects, so the
defect escapes it.

Every other `realPath` call in the same file already maps this exact
`PlatformError` to the file's typed `RuntimeOperationError` (see `resolveCwd`
and `resolveContained` below). This one line is the lone inconsistency. After
this change, a vanished workspace surfaces to the model as a normal typed tool
failure, and the boundary renders it, rather than killing the execution fiber.

## Current state

Files:

- `packages/tools/src/tool-runtime.ts` — the tool runtime layer; line 332 holds
  the `orDie`, and the file already defines the typed error and the mapping
  helper this fix reuses.
- `packages/runtime/src/execution-backend.ts` — consumes the layer through
  `LayerMap.make` and wraps runtime errors into `RikaToolRuntime.ToolError` at
  the boundary. Read-only reference here; do **not** modify it.

The defect (`packages/tools/src/tool-runtime.ts:332`, inside `layer(workspace)`'s
`Layer.effect` generator):

```ts
const canonicalWorkspace = yield * fileSystem.realPath(workspace).pipe(Effect.orDie)
```

The file's own typed error and mapping helper (`packages/tools/src/tool-runtime.ts:317-319`):

```ts
class RuntimeOperationError extends Data.TaggedError("RuntimeOperationError")<{ readonly message: string }> {}

const operationError = (cause: unknown) => new RuntimeOperationError({ message: String(cause) })
```

The same `PlatformError` from `realPath` is already mapped to
`RuntimeOperationError` elsewhere in the file — `resolveCwd`
(`packages/tools/src/tool-runtime.ts:343-355`) does exactly this:

```ts
const resolveCwd = (value: string) =>
  resolve(value).pipe(
    Effect.flatMap((target) =>
      Effect.all([fileSystem.realPath(workspace), fileSystem.realPath(target)]).pipe(
        Effect.mapError(operationError),
      ),
    ),
    ...
```

The consuming boundary (`packages/runtime/src/execution-backend.ts`, the
`routedToolRuntimeLayer`-style helper): it builds the workspace layer through
`const runtimes = yield* LayerMap.make(layerForWorkspace, { idleTimeToLive: "1 minute" })`,
resolves it per call with `const context = yield* runtimes.contextEffect(workspace)`
inside `Effect.scoped(Effect.gen(...))`, and the whole scoped block ends with:

```ts
).pipe(
  Effect.mapError((cause) =>
    Schema.is(RikaToolRuntime.ToolError)(cause)
      ? cause
      : RikaToolRuntime.ToolError.make({
          tool: request._tag,
          message: String(cause),
          kind: "operation",
          outcome: "known",
        }),
  ),
)
```

Load-bearing consequence: `runtimes.contextEffect(workspace)` builds the layer
**inside** that `mapError`'s scope. Once line 332 fails (instead of dying) with
`RuntimeOperationError`, the error flows through `contextEffect` into this
`mapError`, which wraps any non-`ToolError` cause into a `ToolError`. So mapping
to `RuntimeOperationError` is sufficient — the boundary already turns it into
the model-visible `ToolError`. Today, because it is a _defect_, `mapError` never
sees it.

Package conventions to honor (`packages/tools/CLAUDE.md`): every behavior-bearing
adapter has a test layer; OpenTUI, SQL, Relay, Baton, and model providers are
forbidden in this package. Repo-wide (`CLAUDE.md`): Effect-native typed errors,
and **do not put comments in code**.

## Commands you will need

| Purpose       | Command                               | Expected on success          |
| ------------- | ------------------------------------- | ---------------------------- |
| Install       | `bun install --frozen-lockfile`       | exit 0                       |
| Typecheck     | `bun run typecheck`                   | exit 0, no errors            |
| Focused tests | `bun --bun vitest run packages/tools` | all pass, incl. the new test |
| Full gate     | `bun run check`                       | exit 0                       |

## Scope

**In scope** (the only files you should modify):

- `packages/tools/src/tool-runtime.ts` — change line 332 only.
- `packages/tools/test/tool-runtime-filesystem.test.ts` — add one test (this is
  the existing home for `Runtime.layer(workspace)` construction tests; prefer
  adding here over a new file).

**Out of scope** (do NOT touch, even though they look related):

- `packages/runtime/src/execution-backend.ts` — the boundary already wraps
  arbitrary causes into `ToolError`; it needs no change and changing it widens
  the blast radius.
- The other `realPath` / `operationError` call sites in `tool-runtime.ts`
  (`resolveCwd`, `resolveContained`, `listFiles`) — they are already correct;
  this plan fixes only the layer-construction `orDie`.
- The `ToolError` schema and `RuntimeOperationError` shape — reuse them as-is;
  do not redefine or export new error types.

## Git workflow

- Branch: `advisor/005-typed-error-realpath`
- One commit for the fix, one for the test (or a single squashed commit);
  imperative messages, e.g. `map realPath failure to a typed tool error`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Replace the `orDie` with the file's typed mapping

In `packages/tools/src/tool-runtime.ts:332`, change:

```ts
const canonicalWorkspace = yield * fileSystem.realPath(workspace).pipe(Effect.orDie)
```

to:

```ts
const canonicalWorkspace = yield * fileSystem.realPath(workspace).pipe(Effect.mapError(operationError))
```

Add no comment. This makes `layer(workspace)`'s error channel
`RuntimeOperationError` (previously `never`). That is intended: the boundary in
`execution-backend.ts` is generic over the layer error type and wraps it, so no
caller signature needs a manual change.

**Verify**: `bun run typecheck` → exit 0, no errors. (If typecheck reports a new
error-type mismatch at an `execution-backend.ts` or other call site rather than
compiling cleanly, that is a STOP condition — see below.)

### Step 2: Add a test proving a missing workspace yields a failure, not a defect

In `packages/tools/test/tool-runtime-filesystem.test.ts`, add one `@effect/vitest`
test that builds `Runtime.layer(workspace)` for a workspace path that does not
exist and asserts the result is a typed **failure** (`RuntimeOperationError` /
tag `"RuntimeOperationError"`), not a defect. Model the structure on the existing
`Runtime.layer(workspace)` usages already in this file (around lines 81, 171, 198) for imports and layer construction. Use `Effect.exit` on the layer build
(e.g. `Layer.build(Runtime.layer(missing))` inside `Effect.scoped`, or
`Effect.exit` over an effect that requires the `Service`) and assert with
`Exit.isFailure` plus the failure cause is the tagged error — assert it is NOT
`Exit.isDie` / not a defect. Do not add comments.

**Verify**: `bun --bun vitest run packages/tools` → all pass, including the new
test; confirm the new test **fails** if you temporarily revert Step 1 to
`Effect.orDie` (it should then surface as a defect/die, not a typed failure).

### Step 3: Run the full gate

**Verify**: `bun run check` → exit 0 (build, typecheck, tests, diagnostics,
lint, format-check, dependency-check, effect-check, pattern-check all pass).

## Test plan

- New test in `packages/tools/test/tool-runtime-filesystem.test.ts`:
  - **The regression**: constructing the runtime layer for a non-existent
    workspace directory produces a typed `RuntimeOperationError` failure, not a
    defect.
  - Optional edge: a path that exists but is not canonicalizable (e.g. a broken
    symlink target) also yields the typed failure — include only if it fits the
    existing test harness without new infrastructure.
- Structural pattern to copy: the existing `Runtime.layer(workspace)`
  construction tests in the same file.
- Verification: `bun --bun vitest run packages/tools` → all pass including the
  1 new test.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun --bun vitest run packages/tools` exits 0; the new missing-workspace
      test exists and passes
- [ ] `grep -n "realPath(workspace).pipe(Effect.orDie)" packages/tools/src/tool-runtime.ts`
      returns no matches
- [ ] `bun run check` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for plan 005 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `tool-runtime.ts:332` does not match the `orDie` excerpt above
  (the file drifted since this plan was written).
- After Step 1, `bun run typecheck` fails because the new `RuntimeOperationError`
  error type does **not** flow cleanly through `execution-backend.ts`'s
  `LayerMap.make` / `contextEffect` boundary (i.e. the boundary does not wrap it
  as this plan assumes). Report the exact type error — the alternative is to map
  directly to the exported `ToolError` (`ToolError.make({ tool: "...", message,
kind: "operation", outcome: "known" })`), which needs a decision on the `tool`
  field value since there is no request at layer-construction time.
- Building `Runtime.layer` for a missing workspace in the test cannot be made to
  fail deterministically with the available test filesystem adapter.
- The fix appears to require touching any out-of-scope file.

## Maintenance notes

- For the reviewer: confirm the change is a one-line `orDie` → `mapError(operationError)`
  and that the new test asserts a _failure_, not a _die_. The whole point is
  that the boundary in `execution-backend.ts` can now render this as a tool
  error; verify no new `orDie`/`orDieWith` was introduced elsewhere in the file.
- If a future change gives `layer(workspace)` additional recoverable failure
  modes at construction time, they should follow the same `operationError`
  mapping rather than `orDie`, so the boundary keeps rendering them.
- Related audit finding: this is CORRECTNESS-03 from the 2026-07-18 Rika audit.
  The broader "typed errors, not defects, at recoverable boundaries" theme also
  touched `cancel` (plan for CORRECTNESS-02) — those are independent fixes.

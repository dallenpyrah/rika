# Plan 003: Cancel surfaces a repository failure instead of reporting a false "cancelled"

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ea247c4..HEAD -- packages/app/src/operation.ts`
> If `packages/app/src/operation.ts` changed since this plan was written,
> compare the "Current state" excerpts against the live code before
> proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ea247c4`, 2026-07-18
- **Issue**: https://github.com/dallenpyrah/rika/issues/151

## Why this matters

In the interactive `cancel` handler, a transient database error while looking
up the active turn is treated as "there is nothing to cancel": the UI is told
the turn was cancelled while the underlying execution keeps running (and, for a
model turn, keeps billing). The user believes work stopped when it did not.

The cause is one over-broad error handler that collapses _every_ failure —
including a real `TurnRepositoryError` — into the same `undefined` used for the
two expected "nothing to cancel" cases. The fix narrows that handler to the two
intended cases so a genuine repository failure propagates to the existing
failure path and surfaces to the user, instead of masquerading as a successful
cancellation.

## Current state

Files:

- `packages/app/src/operation.ts` — the `@rika/app` product operations module;
  contains the interactive `cancel` handler (lines ~2627–2641) and the `active`
  helper (lines ~1948–1955).
- `packages/persistence/src/turn-repository.ts` — defines `findActive`'s error
  channel and `RepositoryError`.

The `active` helper fails with two different error types. The two control-flow
cases use `operationError` (an `OperationError`), but `turns.findActive` can
fail with a `TurnRepositoryError`:

`packages/app/src/operation.ts:1948-1955`

```ts
const active = Effect.fn("Operation.interactive.active")(function* () {
  const thread = yield* Ref.get(interactiveThread)
  if (thread === undefined) return yield* operationError("No thread selected")
  const turns = yield* TurnRepository.Service
  const turn = yield* turns.findActive(thread.id)
  if (turn === undefined) return yield* operationError("No active turn")
  return turn
})
```

`operationError` produces an `OperationError` (tag `"OperationError"`):

`packages/app/src/operation.ts:115-119`

```ts
class OperationError extends Schema.TaggedErrorClass<OperationError>()("OperationError", {
  ...
})
...
const operationError = (message: string) => OperationError.make({ message })
```

`findActive` fails with `RepositoryError`, whose tag is `"TurnRepositoryError"`:

`packages/persistence/src/turn-repository.ts:96`

```ts
readonly findActive: (threadId: ThreadId) => Effect.Effect<Turn | undefined, RepositoryError>
```

`packages/persistence/src/turn-repository.ts:6`

```ts
export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("TurnRepositoryError", {
```

So `active()` has error type `OperationError | RepositoryError`.

The bug — the `cancel` handler collapses BOTH into `undefined`:

`packages/app/src/operation.ts:2640-2645`

```ts
const backend = yield * ExecutionBackend.Service
const turn = yield * active().pipe(Effect.orElseSucceed(() => undefined))
if (turn === undefined) {
  sessionDispatch({ _tag: "ExecutionControlled", selectionEpoch: 0, action: "cancelled" })
  return
}
```

The whole `cancel` handler is wrapped in `safe(...)`, which already routes any
uncaught error to a failure event via `dispatchFailure` — i.e. the correct
destination for a real repository failure:

`packages/app/src/operation.ts:1683-1686`

```ts
effect.pipe(
  Effect.provide(executionDependencies),
  Effect.scoped,
  Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error))),
```

Scope confirmation — `active()` is called at five sites in this file
(`2538`, `2582`, `2599`, `2641`, `2705`); only line `2641` wraps it in
`Effect.orElseSucceed`. The other four let both errors propagate to their own
`safe` wrapper (correct). This plan changes only line `2641`.

Repo conventions that apply here (from `CLAUDE.md` and `packages/app/CLAUDE.md`):
Effect-native — use Effect combinators (`Effect.catchTag`), not `try`/`catch`.
**Do not put comments in code.** `@rika/app` operations are typed data; do not
import OpenTUI, provider SDKs, raw SQL, or Relay internals.

## Commands you will need

| Purpose       | Command                                                                           | Expected on success       |
| ------------- | --------------------------------------------------------------------------------- | ------------------------- |
| Typecheck     | `bun run typecheck`                                                               | exit 0, no errors         |
| Focused test  | `bun --bun vitest run packages/app/test/operation-cancel.test.ts`                 | all pass (incl. new test) |
| Related tests | `bun --bun vitest run packages/app/test/operation-interactive-extensions.test.ts` | all pass                  |
| Full gate     | `bun run check`                                                                   | exit 0                    |

(Exact commands from this repo. `bun run test` runs the unit+scene+journey
projects; use the focused `vitest run <path>` form while iterating.)

## Scope

**In scope** (the only files you should modify):

- `packages/app/src/operation.ts` — the single expression on line ~2641.
- `packages/app/test/operation-cancel.test.ts` (create) — the regression test.

**Out of scope** (do NOT touch, even though they look related):

- The four other `active()` call sites (`2538`, `2582`, `2599`, `2705`) — they
  already propagate errors correctly.
- `packages/persistence/src/turn-repository.ts` — the error types are correct;
  do not change `findActive` or `RepositoryError`.
- The shell-approval early-return branch (lines `2630-2639`) — unrelated.
- `safe` / `dispatchFailure` — the failure routing is already correct; rely on
  it, do not modify it.

## Git workflow

- Branch: `advisor/003-fix-cancel-swallowed-error`
- Commit per logical unit; plain imperative messages matching the repo log
  (e.g. `Fix cancel reporting success on a repository error`). Do NOT push or
  open a PR unless the operator instructed it.

## Steps

### Step 1: Narrow the error handler to the two expected control-flow cases

In `packages/app/src/operation.ts`, replace the `active()` call on line ~2641:

```ts
const turn = yield * active().pipe(Effect.orElseSucceed(() => undefined))
```

with a handler that catches ONLY `OperationError` (the "No thread selected" /
"No active turn" cases) and lets a `TurnRepositoryError` propagate:

```ts
const turn = yield * active().pipe(Effect.catchTag("OperationError", () => Effect.succeed(undefined)))
```

`Effect.catchTag("OperationError", ...)` recovers both `operationError` cases to
`undefined` (the existing "nothing to cancel" behavior) and leaves
`TurnRepositoryError` in the error channel, where the enclosing `safe(...)`
routes it to `dispatchFailure`. The `if (turn === undefined)` branch below is
unchanged.

Confirm `OperationError` is in scope at this location (it is declared at
`operation.ts:115` in the same module — no import needed).

**Verify**: `bun run typecheck` → exit 0. The inferred type of `turn` remains
`Turn | undefined`; the handler compiles because `catchTag` narrows the error
union.

### Step 2: Add a regression test

Create `packages/app/test/operation-cancel.test.ts`. Model its harness on
`packages/app/test/operation-interactive-extensions.test.ts` — open it and copy
the pattern it uses to build an interactive session with injectable
repositories: it passes `turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns)`
(see lines ~43-52) and builds turns with `TurnRepository.makeMemory([...])`
(see lines ~66, ~177).

For this test, provide a `TurnRepository.Interface` whose `findActive` fails
with a `TurnRepositoryError` instead of returning a turn — start from
`TurnRepository.makeMemory(...)` and override `findActive` to
`() => Effect.fail(new TurnRepository.RepositoryError({ ... }))` (fill the
error's required fields by reading its `Schema.TaggedErrorClass` definition at
`packages/persistence/src/turn-repository.ts:6`). Drive a `cancel` operation
against a session that has a selected thread (so the handler reaches
`active()`), and assert that the session receives a FAILURE dispatch (via
`dispatchFailure`) and NOT `{ _tag: "ExecutionControlled", action: "cancelled" }`.

Add a second assertion for the unchanged happy path: when `findActive` returns
`undefined` (no active turn), cancel STILL dispatches
`{ _tag: "ExecutionControlled", action: "cancelled" }` — proving the narrowing
preserved the intended "nothing to cancel" behavior.

**Verify**: `bun --bun vitest run packages/app/test/operation-cancel.test.ts`
→ all pass. Temporarily reverting Step 1 to `Effect.orElseSucceed(() => undefined)`
must make the first assertion FAIL (the test genuinely catches the bug); restore
Step 1 afterward.

## Test plan

- New file `packages/app/test/operation-cancel.test.ts`, structured after
  `operation-interactive-extensions.test.ts`.
- Cases:
  1. **Regression**: `findActive` fails with `TurnRepositoryError` → cancel
     surfaces a failure, does NOT report `cancelled`.
  2. **Preserved behavior**: `findActive` returns `undefined` → cancel reports
     `cancelled` (unchanged).
- Verification: `bun --bun vitest run packages/app/test/operation-cancel.test.ts`
  → all pass, including the 2 new cases.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0.
- [ ] `bun --bun vitest run packages/app/test/operation-cancel.test.ts` passes,
      including the regression and preserved-behavior cases.
- [ ] `grep -n "active().pipe(Effect.orElseSucceed" packages/app/src/operation.ts`
      returns no matches.
- [ ] `grep -n "catchTag(\"OperationError\"" packages/app/src/operation.ts`
      returns exactly one match (line ~2641).
- [ ] `bun run check` exits 0.
- [ ] Only `packages/app/src/operation.ts` and the new test file are modified
      (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The code at line ~2641 does not match the "Current state" excerpt (the file
  drifted since this plan was written).
- After Step 1, `bun run typecheck` reports that `active()` can fail with an
  error type OTHER than `OperationError | TurnRepositoryError` (e.g. a third
  tagged error was added to `active` or `findActive`). Enumerate the actual
  error union and stop — the narrowing may need to catch more than
  `"OperationError"`, which is a design decision.
- The `cancel` handler is no longer wrapped in `safe(...)` (the failure-routing
  assumption is broken).
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- If new expected "nothing to cancel" conditions are added to `active()`, they
  must be modeled as `OperationError` (or explicitly added to the `catchTag`
  set) — otherwise they will surface as failures. Keep control-flow "absence"
  cases as `OperationError` and genuine faults as their own tagged errors.
- A reviewer should confirm the test actually fails when Step 1 is reverted
  (that it catches the bug, not just the happy path).
- Deferred out of scope: the other four `active()` call sites are already
  correct; a broader audit of `Effect.orElseSucceed(() => undefined)` usage
  across `operation.ts` (there are similar patterns, e.g. line ~1945 and ~2651)
  was not done here — each should be checked separately for whether it swallows
  a real fault, but that is not part of this plan.

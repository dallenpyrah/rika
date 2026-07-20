# Plan 004: Remove the dead `rika update` command so no advertised command fails at runtime

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ea247c4..HEAD -- apps/rika/src/command.ts packages/app/src/operation-contract.ts packages/app/src/operation.ts apps/rika/test/command.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ea247c4`, 2026-07-18
- **Issue**: https://github.com/dallenpyrah/rika/issues/146 (pre-existing issue — this plan is the executable spec for it)

## Why this matters

`rika update` is registered as a top-level CLI subcommand, so it appears in
`rika --help` and looks like a real capability. It dispatches an `Update`
operation that **no handler implements**, so running it returns
`OperationUnavailable` with the message `Update is specified but not implemented
yet`. A user who discovers the command in help and runs it hits a confusing
failure. There is no self-update implementation and no scaffolding anywhere in
the repo (verified below), so this is a dead advertised command, not
work-in-progress. Removing it makes the CLI surface honest: every advertised
command does something. This respects the repo's one-current-contract rule
(`docs/decisions/current-contract-only.md`) — no compatibility shim, just delete
the dead path.

## Current state

The command is wired in three places and asserted by one test. Confirm each
matches before editing.

- `apps/rika/src/command.ts` — the CLI command tree. The `update` subcommand is
  registered at line 237, between `doctor` and `versionCommand`:

  ```ts
      Command.make("doctor", {}, () => dispatch({ _tag: "Doctor" })),
      Command.make("update", {}, () => dispatch({ _tag: "Update" })),
      versionCommand,
  ```

- `packages/app/src/operation-contract.ts` — the product operation contract. The
  `Update` struct is defined at line 193 and is a member of the `Input` union at
  line 237:

  ```ts
  const Update = Schema.Struct({ _tag: Schema.tag("Update") })
  ```

  ```ts
    Doctor,
    Update,
    WorkflowStart,
  ```

- `packages/app/src/operation.ts` — the operation dispatcher. There is **no**
  `input._tag === "Update"` branch. An `Update` input falls through to the
  catch-all at line 3413, which returns `OperationUnavailable`:

  ```ts
  if (input._tag !== "Thread") return yield * unavailable(input)
  ```

  `unavailable` (line 672) builds the message `${input._tag} is specified but not
implemented yet`.

- `apps/rika/test/command.test.ts` — the parse/dispatch table test. Line 333
  asserts the dead command parses:

  ```ts
        [["update"], { _tag: "Update" }],
  ```

**Confirmation already performed when this plan was written** (re-run Step 0 to
re-verify): a repo-wide search for `_tag: "Update"`, `=== "Update"`,
`selfUpdate`, `self-update`, `performUpdate`, and `checkForUpdate` across
`apps/` and `packages/` (excluding tests and `node_modules`) returned **only**
the `command.ts:237` registration. No handler, no updater module, no adjacent
scaffolding. The `Update` schema const at `operation-contract.ts:193` is
referenced **only** by the union member at line 237.

Repo conventions that apply here (`CLAUDE.md`):

- **Do not put comments in code.** Add none.
- Effect-native; commands use `effect/unstable/cli` (`Command.make`). You are
  only deleting, so no new Effect code is needed.
- One current contract — delete the path outright, no deprecation shim.

## Commands you will need

| Purpose   | Command                                               | Expected on success |
| --------- | ----------------------------------------------------- | ------------------- |
| Install   | `bun install --frozen-lockfile`                       | exit 0              |
| Typecheck | `bun run typecheck`                                   | exit 0, no errors   |
| Test file | `bun --bun vitest run apps/rika/test/command.test.ts` | all pass            |
| Full gate | `bun run check`                                       | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `apps/rika/src/command.ts` — remove the `update` registration.
- `packages/app/src/operation-contract.ts` — remove the `Update` struct and its union member.
- `apps/rika/test/command.test.ts` — remove the `update` table row.

**Out of scope** (do NOT touch, even though they look related):

- `packages/app/src/operation.ts` — the fall-through `unavailable` handler is
  correct and stays; it still serves every other not-yet-implemented input.
- Anything named `Updated` / `TitleCostUpdated` / `QueueUpdated` in
  `operation-contract.ts` — these are unrelated interactive-event types, NOT the
  `Update` command. Only remove the exact `Update` struct at line 193 and the
  bare `Update,` union member at line 237.
- `doctor`, `version`, or any other subcommand.

## Git workflow

- Branch: `advisor/004-remove-dead-update-command`
- One commit is fine (small deletion); imperative message matching the repo's
  `git log` style (e.g. `remove dead update command`). Do NOT push or open a PR
  unless the operator instructed it.

## Steps

### Step 0: Re-verify the finding (drift + no-handler guard)

Run the drift check in the header. Then re-confirm no handler/scaffolding exists:

```
grep -rn '_tag: "Update"\|=== "Update"\|selfUpdate\|self-update\|performUpdate\|checkForUpdate' apps packages --include="*.ts" | grep -v test | grep -v node_modules
```

**Verify**: the only line printed is
`apps/rika/src/command.ts:...    Command.make("update", {}, () => dispatch({ _tag: "Update" })),`.
If any other match appears (a real handler or updater), this is a STOP condition
— see below.

### Step 1: Remove the `update` subcommand registration

In `apps/rika/src/command.ts`, delete the single line:

```ts
    Command.make("update", {}, () => dispatch({ _tag: "Update" })),
```

Leave the `doctor` line above and `versionCommand` below intact.

**Verify**: `grep -n '"update"' apps/rika/src/command.ts` → no output.

### Step 2: Remove the `Update` operation from the contract

In `packages/app/src/operation-contract.ts`:

- Delete the definition at line 193: `const Update = Schema.Struct({ _tag: Schema.tag("Update") })`.
- Delete the bare `Update,` union member (the line between `Doctor,` and `WorkflowStart,`).

Do not touch `Updated`, `TitleCostUpdated`, or `QueueUpdated`.

**Verify**: `grep -nE '\bUpdate\b' packages/app/src/operation-contract.ts` → no
output (only `Updated`/`TitleCostUpdated`/`QueueUpdated` may remain, which this
`\bUpdate\b` pattern excludes).

### Step 3: Remove the test row and typecheck

In `apps/rika/test/command.test.ts`, delete the table row:

```ts
        [["update"], { _tag: "Update" }],
```

**Verify**:

- `bun --bun vitest run apps/rika/test/command.test.ts` → all pass.
- `bun run typecheck` → exit 0 (the `Input` union no longer has `Update`; if any
  code still referenced it the typecheck would fail — it should not, per the
  Current state confirmation).

## Test plan

- No new test needed — this is a removal. The change is proven by:
  1. Deleting the existing `[["update"], { _tag: "Update" }]` assertion in
     `apps/rika/test/command.test.ts` (Step 3) — the dispatch table test still
     passes for every remaining command.
  2. `bun run typecheck` passing after the `Input` union member is removed,
     proving nothing else in the codebase depended on the `Update` operation.
- Optional strengthening (only if trivial): if `command.test.ts` has an
  assertion that `update` is a valid parse, confirm it is gone; do not add a
  negative "update is rejected" test unless the file already has a pattern for
  asserting unknown subcommands.
- Structural pattern to follow: the existing table-driven test in
  `apps/rika/test/command.test.ts` (the `cases` array around line 320).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n '"update"' apps/rika/src/command.ts` returns no matches
- [ ] `grep -nE '\bUpdate\b' packages/app/src/operation-contract.ts` returns no matches
- [ ] `bun run typecheck` exits 0
- [ ] `bun --bun vitest run apps/rika/test/command.test.ts` passes
- [ ] `bun run check` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Step 0 finds a real `Update` handler, a self-update module, or any scaffolding
  beyond the `command.ts` registration. In that case the intent is
  _implement a self-updater_, not delete — this plan no longer applies; report
  what you found so the finding can be re-scoped as an implementation plan.
- The code at the "Current state" locations doesn't match the excerpts (drift).
- `bun run typecheck` fails after Step 2 because some other module referenced the
  `Update` input — that means the operation was not actually dead; stop and
  report the referencing site.
- Any verification fails twice after a reasonable fix attempt.

## Maintenance notes

- If a self-update feature is genuinely wanted later, it should be added back as
  a real `Command.make("update", …)` with a matching `input._tag === "Update"`
  handler in `packages/app/src/operation.ts` and a documented capability in
  `docs/features/` — not left as a dispatch with no handler. Until then, parked
  intent belongs in `PLAN.md`/`TODO.md` (allowed by `CLAUDE.md`), never in the
  live CLI surface.
- A reviewer should confirm the diff is deletion-only across exactly the three
  source/test files and that `bun run check` is green.

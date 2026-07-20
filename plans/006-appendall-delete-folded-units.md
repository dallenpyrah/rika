# Plan 006: SQL `appendAll` deletes transcript units the reducer removed

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ea247c4..HEAD -- packages/persistence/src/transcript-repository.ts packages/transcript/src/index.ts`
> If either in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ea247c4`, 2026-07-18
- **Issue**: https://github.com/dallenpyrah/rika/issues/153

## Why this matters

The SQL transcript repository persists a durable read model that must match
what the reducer computed. The reducer can _remove_ a unit (it folds a
standalone `ChildAgent` unit into its owning `ToolCall` once a child-run event
links them). The SQL `appendAll` upserts only _changed_ units and never
deletes units that are now absent, so the folded-away `ChildAgent` row stays in
`rika_transcript_units`. Reads (`get`, `page`) then return a phantom duplicate
child-agent row, and `continueProjection` re-seeds it on reload. The in-memory
repository does not have this bug because it stores the whole projection, so the
two layers diverge — and `packages/persistence/CLAUDE.md` states as an invariant
that "SQL and memory repository layers preserve the same constraints and
ordering." After this plan, a unit removed by the reducer is removed from the
SQLite table in the same transaction, restoring SQL/memory parity.

## Current state

Files:

- `packages/persistence/src/transcript-repository.ts` — the product transcript
  repository; contains both the SQL layer (the bug, `appendAll` ~296-318) and
  the memory layer (correct, `appendAll` ~156-164).
- `packages/transcript/src/index.ts` — the reducer; `applyChild` (~460-467)
  removes the standalone `ChildAgent` unit on fold.

The SQL `appendAll` today (`packages/persistence/src/transcript-repository.ts:296-318`):

```ts
const appendAll = Effect.fn("TranscriptRepository.appendAll")(function* (
  turn: Turn,
  events: ReadonlyArray<Transcript.SourceEvent>,
) {
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const current = yield* get(turn.id)
        if (current === undefined)
          yield* sql`DELETE FROM rika_transcript_units WHERE turn_id = ${turn.id}`.pipe(Effect.mapError(error))
        const projection = continueProjection(turn, current, events)
        const revisions = new Map(current?.units.map((unit) => [unit.key, unit.revision]))
        yield* Effect.forEach(
          projection.units.filter((unit) => revisions.get(unit.key) !== unit.revision),
          (unit) => storeUnit(turn, unit),
          { discard: true },
        )
        yield* storeCheckpoint(turn, projection)
        return yield* storedResult(turn.id)
      }),
    )
    .pipe(Effect.mapError(error))
})
```

The upsert (`storeUnit`, `:265-272`) is keyed on `unit_key`, which is the table
primary key (globally unique), so a delete by `unit_key` is exact and
turn-safe:

```ts
yield *
  sql`INSERT INTO rika_transcript_units (unit_key, turn_id, ...)
    VALUES (${unit.key}, ${turn.id}, ...)
    ON CONFLICT(unit_key) DO UPDATE SET ...`
```

`continueProjection` (`:122-131`) rebuilds the **full** projection, not a
delta — it seeds from the current projection and replays the new events:

```ts
const continueProjection = (turn, current, events): Transcript.Projection => {
  let projection = current === undefined ? Transcript.empty(turn.id, turn.prompt) : source(current)
  for (const event of events.toSorted((left, right) => left.sequence - right.sequence))
    projection = Transcript.applyEvent(projection, event)
  return projection
}
```

So `projection.units` is the complete set of units that should exist after the
append. Any key present in `current.units` but absent from `projection.units`
was genuinely removed by the reducer — this is the fact the fix relies on.

The reducer fold that removes a unit (`packages/transcript/src/index.ts:460-467`):

```ts
if (updated !== projection)
  return {
    ...updated,
    units: updated.units.filter((candidate) => {
      const block = candidate.content._tag === "Block" ? candidate.content.block : undefined
      return block?._tag !== "ChildAgent" || executionKey(block.id) !== executionKey(childId)
    }),
  }
```

The correct memory layer for reference (`packages/persistence/src/transcript-repository.ts:156-164`)
stores the whole projection, so it never orphans a removed unit:

```ts
const appendAll = Effect.fn("TranscriptRepository.appendAll")(function* (turn, events) {
  return yield* Ref.modify(state, (entries) => {
    const next = stored(turn, continueProjection(turn, entries.get(turn.id), events))
    return [clone(next), new Map(entries).set(turn.id, next)]
  })
})
```

Conventions this plan must honor (from `packages/persistence/CLAUDE.md` and the
root `CLAUDE.md`):

- Raw SQL stays inside `@rika/persistence`. SQL and memory layers preserve the
  same constraints and ordering (this plan restores that parity).
- Effect-native: use `Effect.forEach`, `sql\`...\``, typed errors via the
existing `error` mapper. Do NOT introduce a Promise/host escape.
- **Do not put comments in code.**
- No schema change is needed (no migration). Do not add or renumber a migration.
- Do not create `utils`/`helpers`/`common`/`lib` modules.

## Commands you will need

| Purpose       | Command                                     | Expected on success          |
| ------------- | ------------------------------------------- | ---------------------------- |
| Typecheck     | `bun run typecheck`                         | exit 0, no errors            |
| Focused tests | `bun --bun vitest run packages/persistence` | all pass, incl. the new test |
| Full gate     | `bun run check`                             | exit 0                       |

## Scope

**In scope** (the only files you should modify):

- `packages/persistence/src/transcript-repository.ts` — SQL `appendAll` only.
- `packages/persistence/test/transcript-repository.test.ts` — add the new test
  (create the test if this file does not exist; prefer this file, else add to
  `packages/persistence/test/sqlite.test.ts`).

**Out of scope** (do NOT touch, even though they look related):

- The memory `appendAll` (`:156-164`) — it is already correct; changing it
  risks breaking the parity you are restoring.
- `write`/`replace` (`:288-323`) — already delete-all-then-insert; unaffected.
- `continueProjection`, `storeUnit`, `storeCheckpoint`, `get`, `page` — read
  them for context but do not change them.
- `packages/transcript/src/index.ts` — the reducer's fold is the correct
  behavior; the bug is only that the SQL layer does not persist the removal.
- Any migration file — no schema change.

## Git workflow

- Branch: `advisor/006-appendall-delete-folded-units`
- Commit per logical unit (fix, then test), plain imperative messages matching
  the repo (`git log --oneline -5` shows short imperative subjects like
  "Fix integrated feature verification"). No conventional-commit prefixes.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Delete removed unit keys inside the `appendAll` transaction

In `packages/persistence/src/transcript-repository.ts`, inside the SQL
`appendAll` `withTransaction` block, after `continueProjection` produces
`projection` and before (or alongside) the existing changed-unit upsert, compute
the keys present in `current` but absent from `projection.units` and delete
them. Keep everything inside the existing transaction.

Target shape (insert after `const projection = continueProjection(turn, current, events)`):

```ts
const nextKeys = new Set(projection.units.map((unit) => unit.key))
const removed = (current?.units ?? []).filter((unit) => !nextKeys.has(unit.key))
yield *
  Effect.forEach(
    removed,
    (unit) => sql`DELETE FROM rika_transcript_units WHERE unit_key = ${unit.key}`.pipe(Effect.mapError(error)),
    { discard: true },
  )
```

Notes:

- `unit_key` is the primary key, so a per-key delete is exact and cannot touch
  another turn's rows. The per-key `Effect.forEach` mirrors the existing
  per-unit `storeUnit` loop; you MAY instead use one `sql.in(...)` batch delete
  if that is the established idiom elsewhere in this package — check the file
  for existing `sql.in` usage first and only use it if present, otherwise keep
  the per-key loop.
- Leave the `current === undefined` full-delete branch and the changed-unit
  upsert exactly as they are; this only adds the removal of absent keys.
- Do not add comments.

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Add a real-SQLite characterization test for the fold + parity

Add a test that reproduces the orphan and asserts both no phantom row and
SQL/memory parity. Model its harness after `packages/persistence/test/sqlite.test.ts`
(real `Database.layer` over a temp SQLite file) and its transcript fixtures
after the existing `packages/persistence/test/transcript-repository.test.ts`
(source-event shapes for the reducer).

The test must:

1. Build a `Turn` and a sequence of `Transcript.SourceEvent`s that first
   produces a standalone `ChildAgent` unit (a child-run event that has no
   linking tool-call yet), then a later event that folds that child into its
   `ToolCall` (the `applyChild` link path at `packages/transcript/src/index.ts:460-467`).
   Use the reducer (`Transcript.applyEvent` / the same event shapes the existing
   transcript tests use) to confirm your event sequence actually removes the
   `child:` unit before asserting on the repository.
2. Drive the SQL repository by calling `appendAll` with the pre-fold events,
   then `appendAll` again with the fold event (two separate appends — the bug
   only manifests when the removed unit was persisted by an earlier append).
3. Assert `get(turn.id)` returns **no** `ChildAgent` unit whose key equals the
   folded child's `child:` key — i.e. no phantom duplicate remains.
4. Assert parity: run the identical fixture through the **memory** repository
   and assert the SQL and memory `get(turn.id)` return the same ordered unit
   keys.

Include an edge case: a plain two-append sequence with no fold (a unit that
persists across appends) must still be present after the second append — proving
Step 1 does not delete units that should survive.

**Verify**: `bun --bun vitest run packages/persistence` → all pass, including the
new test; and confirm the new test FAILS if you temporarily revert Step 1 (run
it once against the unmodified `appendAll` to see the phantom row, then
re-apply Step 1).

### Step 3: Full gate

**Verify**: `bun run check` → exit 0.

## Test plan

- New test file/case: `packages/persistence/test/transcript-repository.test.ts`
  (or `sqlite.test.ts`), covering:
  - happy path: standalone child unit then fold event over two appends → no
    orphan child row in SQLite;
  - the regression: the exact orphan this plan fixes;
  - parity: SQL and memory `get` return identical ordered unit keys for the
    fixture;
  - edge: a non-folded unit persists across two appends (not wrongly deleted).
- Structural pattern: `packages/persistence/test/sqlite.test.ts` for the real
  `Database.layer` harness; `packages/persistence/test/transcript-repository.test.ts`
  for transcript event fixtures.
- Verification: `bun --bun vitest run packages/persistence` → all pass including
  the new cases.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0.
- [ ] `bun --bun vitest run packages/persistence` exits 0 with the new test(s)
      present and passing.
- [ ] Reverting Step 1 makes the new test fail (the test actually catches the
      orphan) — confirmed once, then Step 1 re-applied.
- [ ] `bun run check` exits 0.
- [ ] `git status` shows only `packages/persistence/src/transcript-repository.ts`,
      the persistence test file, and `plans/README.md` modified.
- [ ] `plans/README.md` status row for plan 006 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows `transcript-repository.ts` or `transcript/src/index.ts`
  changed since `ea247c4` and the "Current state" excerpts no longer match.
- `continueProjection` no longer rebuilds the full projection (e.g. it is
  changed to return only a delta of units) — then deleting `current \ projection`
  keys would drop units that must persist, and this whole approach is invalid.
  Verify `continueProjection` still seeds from `source(current)` and replays
  before proceeding.
- You cannot construct a source-event sequence that makes the reducer remove a
  unit (the fold path at `transcript/src/index.ts:460-467` did not fire) — the
  bug is unreproducible as described; report what the reducer actually did.
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file (the memory layer,
  the reducer, or a migration).

## Maintenance notes

- If a future reducer change makes `appendAll` receive a _partial_ projection
  (a delta rather than the full unit set), the removal computed here becomes
  wrong — the delete assumes `projection.units` is authoritative and complete.
  Any such change must revisit this deletion.
- Reviewer should scrutinize: that the delete is inside the `withTransaction`
  (atomic with the upsert and checkpoint), that it deletes by `unit_key` (not
  `turn_id`), and that the parity assertion in the test compares ordered keys,
  not just counts.
- Deferred out of this plan: the redundant full-tree rewrite on every step
  (PERF-03) touches the same `appendAll`/`replace` path but is a separate
  performance concern; do not fold it in here.

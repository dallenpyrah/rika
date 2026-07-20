# Plan 007: Add `rika diagnostics view [--follow] [--thread <id>]` to inspect diagnostic records in the terminal

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ea247c4..HEAD -- apps/rika/src/logging.ts apps/rika/src/commands/diagnostics.ts apps/rika/src/command.ts docs/features/diagnostics.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `ea247c4`, 2026-07-18
- **Issue**: https://github.com/dallenpyrah/rika/issues/154

## Why this matters

`PRODUCT.md` Direction #2 is "Make ongoing and completed agent work easy to
inspect in the terminal." Today `rika diagnostics` can only tell you the log
`path`, a `status` count, or `export` the JSONL files to another directory —
so inspecting a stalled agent or a failed durable Turn means exporting files
and opening JSON by hand, the opposite of in-terminal inspection. The
diagnostic records already exist, are bounded, and are credential-scrubbed by
construction (see Current state). This plan adds a read-only `view` subcommand
that renders those existing records in the terminal, with an optional live
`--follow` tail and a `--thread <id>` filter. It ships no new data and widens
no field — it surfaces what is already written.

## Current state

Files:

- `apps/rika/src/commands/diagnostics.ts` — the diagnostics command; defines
  the `dataRoot()` helper and the `path`/`status`/`export` subcommands. `view`
  is added here.
- `apps/rika/src/logging.ts` — owns the diagnostic record shape, the redaction
  allowlist, and the safe file-read path. A record _reader_ is added here.
- `apps/rika/src/command.ts` — the root command; imports the diagnostics
  command and defines the repo's CLI flag conventions.
- `docs/features/diagnostics.md` — the capability contract for diagnostics;
  must document the new subcommand.

### The record shape and the redaction guarantee (load-bearing — never widen)

`apps/rika/src/logging.ts:57-78` — every record is one JSONL line written by
`structuredLogger`. It emits **only** annotations whose key is in the fixed
allowlist `diagnosticAnnotations` (`logging.ts:14-55`, ~40 `rika.*` keys such
as `rika.operation`, `rika.duration.ms`, `rika.failure.kind`,
`rika.failure.reason`, `rika.thread.id`, `rika.turn.id`, `rika.model.name`,
`rika.process.role`):

```ts
// logging.ts:64-77
const annotations: Record<string, string | number | boolean> = {}
for (const [key, value] of Object.entries(current)) {
  if (
    diagnosticAnnotations.has(key) &&
    (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
  )
    annotations[key] = value
}
return JSON.stringify({
  message: operation,
  level: logLevel.toUpperCase(),
  timestamp: date.toISOString(),
  annotations,
})
```

**Because the records on disk are already allowlisted, a reader that renders
only fields present in the parsed JSONL line inherits the scrubbing.** The
render function must read only `message`, `level`, `timestamp`, and
`annotations[...]` from the parsed record — never re-open fiber annotations,
env, or any other source.

The docs state the same guarantee (`docs/features/diagnostics.md`): records
"exclude prompts, model bodies, tool arguments and output, shell content,
headers, credentials, and arbitrary error messages."

### The safe read path to reuse (do NOT hand-roll a directory read)

- `Logging.directory(dataRoot)` (`logging.ts:124-127`, exported) → the
  `<dataRoot>/diagnostics` directory.
- `availableLogFiles(diagnostics)` (`logging.ts:162-180`, **module-private**)
  is the only correct file enumerator: it filters `isLogFile` (`.jsonl` /
  `.bootstrap.log`), rejects symlinks (`fs.readLink` success → skip), and
  accepts a file only when it is a regular file with mode bits `& 0o077 === 0`
  and owner-uid matching the current user. `exportLogs` (`logging.ts:240-267`)
  and `status` (`:228-238`) both go through it. The new reader MUST reuse it,
  not re-list the directory.
- Files are named `<role>-<timestamp>-<pid>.jsonl`; the active file for the
  current process is `...-<pid>.open.jsonl`. `status`/`export` exclude
  `-${process.pid}.open.jsonl` (`logging.ts:235`, `:251`).

### `--thread` needs no new indexing

`rika.thread.id` is an allowlisted annotation present on each relevant record
line (`logging.ts:52`). `--thread <id>` is therefore a line-level filter over
the already-bounded files (`record.annotations["rika.thread.id"] === id`), not
a store query — no index or schema change is required.

### The CLI flag convention to match

`apps/rika/src/command.ts:1-3` imports `Argument, Command, Flag` from
`effect/unstable/cli`. Flags are defined with `Flag.*` and `Flag.optional`
(`command.ts:16-19`):

```ts
const workspace = Flag.directory("workspace").pipe(Flag.optional)
const thread = Flag.string("thread").pipe(Flag.optional)
const ephemeral = Flag.boolean("ephemeral")
```

Existing subcommands in `diagnostics.ts:20-37` use
`Command.make("<name>", { <args/flags> }, (parsed) => Effect)` and render with
`Console.log`. `path`/`status`/`export` resolve the data root with the local
`dataRoot()` helper and **never start the resident** — `view` must do the same
(it only needs `FileSystem`/`Path`, which the process already provides).

Vocabulary (`CONTEXT.md`): use "diagnostic records" / "diagnostics", "Thread",
"Turn", "resident" in any user-facing strings and names.

## Commands you will need

| Purpose   | Command                                                | Expected on success           |
| --------- | ------------------------------------------------------ | ----------------------------- |
| Install   | `bun install --frozen-lockfile`                        | exit 0                        |
| Typecheck | `bun run typecheck`                                    | exit 0, no errors             |
| Tests     | `bun run test`                                         | all pass (Unit+Scene+Journey) |
| Focused   | `bun --bun vitest run apps/rika/test/diagnostics-view` | new test passes               |
| Lint      | `bun run lint`                                         | exit 0                        |
| Full gate | `bun run check`                                        | exit 0                        |

(Exact commands from `package.json` scripts, verified during recon. Per
`apps/rika/CLAUDE.md`, keep `main.ts` from initializing SQL/Relay/models
before command parsing — `view` touches only the filesystem.)

## Suggested executor toolkit

- Invoke the `effect` skill if available — verify every Effect v4 API
  (`Stream`, `Schedule`, `FileSystem`) against the pinned source before use;
  do not rely on remembered v3 syntax.
- Reference `docs/decisions/effect-cli.md` (all commands use
  `effect/unstable/cli` with behavior behind Effect services).

## Scope

**In scope** (the only files you should modify or create):

- `apps/rika/src/logging.ts` — add an exported record reader + follower.
- `apps/rika/src/commands/diagnostics.ts` — add the `view` subcommand and
  register it in `Command.withSubcommands([...])`.
- `docs/features/diagnostics.md` — document `view`.
- `apps/rika/test/diagnostics-view.test.ts` (create) — unit coverage.
- `test/journey/diagnostics-view.journey.test.ts` (create) — packaged-path
  coverage including the redaction assertion.

**Out of scope** (do NOT touch, even though they look related):

- The `diagnosticAnnotations` allowlist (`logging.ts:14-55`) — do not add,
  remove, or widen keys. `view` renders only what is already written.
- `structuredLogger` / `layer` / the writer path — `view` is read-only.
- Any resident/transport code — `view` must not start the resident.
- `export`/`status`/`path` behavior — leave unchanged.

## Git workflow

- Branch: `advisor/007-diagnostics-view`
- Commit per step or logical unit; plain imperative messages matching the repo
  log style (e.g. `Add diagnostics view command`). Do NOT push or open a PR
  unless the operator instructed it.

## Steps

### Step 1: Add an exported record reader to `logging.ts`

Add a parsed-record type and a reader that reuses `availableLogFiles`. Do not
export `availableLogFiles` itself; wrap it.

Target shape (names indicative; match repo style, no comments):

```ts
export interface DiagnosticRecord {
  readonly message: string
  readonly level: string
  readonly timestamp: string
  readonly annotations: Record<string, string | number | boolean>
}

export const readRecords = Effect.fn("Logging.readRecords")(function* (
  dataRoot: string,
  options?: { readonly thread?: string },
) {
  // resolve directory(dataRoot); if missing → return []
  // reject a symlinked diagnostics dir the same way status() does (logging.ts:232-233)
  // for each availableLogFiles(diagnostics): read the file, split into lines,
  //   JSON.parse each non-empty line inside Effect.result and DROP unparseable lines,
  //   keep only records whose shape matches DiagnosticRecord,
  //   if options.thread is set, keep only annotations["rika.thread.id"] === thread
  // sort ascending by timestamp; return ReadonlyArray<DiagnosticRecord>
})
```

Move the private `availableLogFiles`/`directory` reuse inside `readRecords`;
parse defensively (a partially-written `.open.jsonl` last line may be
truncated — dropping unparseable lines is correct, never throw).

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Add a follower for `--follow`

Add `followRecords` returning a `Stream` of new records. Poll the diagnostics
directory on a fixed schedule (the writer batches with a 1s window,
`logging.ts:219`), tracking a per-file byte offset so only newly-appended lines
are parsed and emitted. Use `Stream` + `Schedule.spaced` (verify the exact v4
APIs against pinned Effect source). Apply the same parse-and-filter as Step 1.

```ts
export const followRecords = (
  dataRoot: string,
  options?: { readonly thread?: string },
): Stream.Stream<DiagnosticRecord, PlatformError, FileSystem.FileSystem | Path.Path> => ...
```

If a robust `FileSystem.watch` is available and simpler than offset polling,
either is acceptable — but it must not miss appended lines and must not
re-emit already-seen ones. Do not block process exit.

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Add a pure `renderRecord` and the `view` subcommand

In `diagnostics.ts`, add a pure `renderRecord(record: Logging.DiagnosticRecord): string`
that formats one line from ONLY the parsed record — e.g.
`` `${timestamp} ${level} ${message}` `` followed by a compact selection of
present annotations (thread/turn ids, `rika.duration.ms`, `rika.failure.kind`,
`rika.failure.reason`, `rika.operation`). Never read a field that is not on the
record.

Add the subcommand, matching the existing subcommand and flag style:

```ts
const viewCommand = Command.make(
  "view",
  { follow: Flag.boolean("follow"), thread: Flag.string("thread").pipe(Flag.optional) },
  ({ follow, thread }) =>
    dataRoot().pipe(
      Effect.flatMap((root) =>
        follow
          ? Logging.followRecords(root, threadOption(thread)).pipe(
              Stream.runForEach((record) => Console.log(renderRecord(record))),
            )
          : Logging.readRecords(root, threadOption(thread)).pipe(
              Effect.flatMap((records) =>
                Effect.forEach(records, (r) => Console.log(renderRecord(r)), { discard: true }),
              ),
            ),
      ),
    ),
)
```

Register it: `Command.withSubcommands([pathCommand, statusCommand, exportCommand, viewCommand])`.

**Verify**: `bun run typecheck` → exit 0; `bun --bun vitest run apps/rika/test/command` (the existing top-level command parse test) → still passes.

### Step 4: Document the subcommand

Update `docs/features/diagnostics.md`: extend the sentence listing the
resident-independent commands to include `view`, and add one clause stating
`view` renders the same records in the terminal with an optional live follow
and a Thread filter, preserving the exclusion guarantee. Keep the doc short —
`CLAUDE.md` forbids indexes/status tables/related-link sections.

**Verify**: `bun run format-check` → exit 0.

### Step 5: Tests

Write the tests in the Test plan below.

**Verify**: `bun run test` → all pass, including the two new tests.

## Test plan

- `apps/rika/test/diagnostics-view.test.ts` (Unit): construct a diagnostics
  directory under a temp data root with two hand-written `.jsonl` files (real
  SQLite/filesystem allowed per `apps/rika/CLAUDE.md`), containing records with
  different `rika.thread.id` values plus one deliberately-malformed line. Assert:
  (a) `readRecords` returns the well-formed records in timestamp order and drops
  the malformed line; (b) `readRecords(root, { thread })` returns only matching
  records; (c) `renderRecord` output contains the operation/level/timestamp and
  the whitelisted annotations and contains **none** of a planted
  not-on-the-allowlist key/value (the redaction assertion — seed a record whose
  raw file line, if any renderer widened, would leak a `secret`-looking value;
  since the writer never emits it, assert the rendered output never contains it).
  Model structure after the existing logging-related unit tests in
  `apps/rika/test/` and use `test/scene.ts` helpers only if needed.
- `test/journey/diagnostics-view.journey.test.ts` (Journey): drive the packaged
  product to produce at least one diagnostic record, run `rika diagnostics view`,
  and assert the output renders records and contains no field outside the
  documented exclusion set. Model after `test/journey/doctor.journey.test.ts`
  (the existing resident-independent diagnostics-style journey).
- Verification: `bun run test` → all pass, including both new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run test` exits 0; the two new tests exist and pass
- [ ] `bun run lint` exits 0 and `bun run format-check` exits 0
- [ ] `rika diagnostics view` renders records; `--thread <id>` filters; `--follow` tails (exercised by the journey test)
- [ ] `grep -n "diagnosticAnnotations" apps/rika/src/logging.ts` shows the allowlist unchanged (same key count as `ea247c4`)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `docs/features/diagnostics.md` documents `view`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts
  (the codebase has drifted since this plan was written).
- `readRecords` would require reading anything other than the on-disk JSONL
  lines to satisfy `--thread` or the render (it must not — the thread id is an
  allowlisted annotation; if it is genuinely absent from records, STOP and
  report rather than adding a store query or a new index).
- Implementing `--follow` appears to require a new writer-side change (e.g. the
  active `.open.jsonl` is not readable until settled) — implement the non-follow
  `view` and report the follow limitation rather than touching the writer.
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file (especially
  `diagnosticAnnotations`, `structuredLogger`, or any resident/transport code).

## Maintenance notes

- If the record schema in `structuredLogger` (`logging.ts:72-77`) ever changes,
  `DiagnosticRecord` and `renderRecord` must be updated in lockstep; the parse
  in `readRecords` is intentionally defensive (drops unrecognized lines) so a
  new field is ignored, not crashed on.
- A reviewer should scrutinize that `renderRecord` reads only parsed-record
  fields (the redaction guarantee) and that `readRecords`/`followRecords` reuse
  the owner/symlink/mode checks in `availableLogFiles` rather than a raw
  `readDirectory`.
- Deferred out of scope: a TUI trace panel keyed to the selected Thread
  (DIRECTION-03's larger form) — this plan delivers the CLI surface only.

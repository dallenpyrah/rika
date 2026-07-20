# Plan 012: Subagents return text by default; structured reports are opt-in and never fail the run

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 93c4029..HEAD -- packages/runtime/src/streaming-only-model.ts packages/runtime/src/agent-profiles.ts packages/runtime/src/execution-backend.ts apps/rika/src/model-provider-runtime.ts packages/transcript/src/index.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> **Boundary**: `repos/baton` and `repos/effect` are vendored, read-only.
> Every change lands in Rika-owned code (`packages/runtime`, `apps/rika`);
> Baton is influenced only through its released configuration surface.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug + product decision
- **Planned at**: commit `93c4029`, 2026-07-19 (revised 2026-07-19: text is
  the default contract — owner decision)
- **Issue**: —

## Why this matters

Users running research/audit prompts see subagents die with:

```
effect/ai/AiError/AiError: LanguageModel.generateObject: Structured output
validation failed: SchemaError(Missing key at ["summary"])
```

The subagent did the work — its transcript holds the full report — and the
run still ends `execution.failed` because a final JSON-extraction turn
omitted one required key on its only try. This hit twice in one session on
2026-07-19 (Task-profile subagents on a streaming-only route).

**Owner decision (Dallen, 2026-07-19): by default, subagents return plain
text to the main agent.** This matches the field: opencode's task tool
returns the subagent's last assistant text with no schema at all
(`task.ts`: `result.parts.findLast(p => p.type === "text")`); pi's subagent
extension does the same with a fallback chain `error → stderr → final text
→ "(no output)"`. Claude Code is the only surveyed tool that imposes a
schema, and it retries with validation feedback up to 5 times before
failing. Rika today has the strictest contract of the four with zero
retries and zero fallback — and the extra report turn costs a model call
per subagent even when it works.

After this plan:

- Default (Task and all profiles unless declared otherwise): **no
  structured report turn at all**. The subagent's final assistant text is
  the report. Nothing to validate, nothing to fail, one fewer model call.
- Opt-in (a profile that explicitly declares an output schema): the
  structured turn runs, but a decode miss repairs, retries once with the
  validation error, and finally degrades to the final text — it never
  fails the run.

## Current state

The failure chain, at commit `93c4029`:

1. Task/Review profiles require `summary` in their report schema —
   `packages/runtime/src/agent-profiles.ts:14-28`
   (`Task`: `Schema.Struct({ summary: Schema.String, files: ... })`,
   `Review`: `{ summary, findings }`), bound at `:107`
   (`outputSchema: outputSchemas[name]`), registered at `:167-170`, and
   layered into the backend at
   `packages/runtime/src/execution-backend.ts:57, 1789`.
2. When a profile has an `outputSchema`, the subagent runs an extra final
   report turn: `LanguageModel.generateObject` with `toolChoice: "none"` —
   `repos/baton/packages/core/src/agent-run.ts:1588` (`structuredFinalEvents`,
   `:1576-1631`). Read-only reference. (Executor: verify Baton skips this
   turn entirely when `outputSchema` is absent — that is the lever this
   plan pulls for the default path.)
3. On streaming-only routes (codex/chatgpt.com), Rika's wrapper replaces
   `generateObject` with a streamText emulation:
   `packages/runtime/src/streaming-only-model.ts:108-132` — inject a JSON
   instruction (`:88-99`), stream, decode (`:123-124`), retry once with
   brace-matching `extractJson` (`:125-127` — cannot repair a missing
   key), then fail via `structuredFailure(String(error), text)` (`:81-86`).
   The `String(error)` produces the exact `SchemaError(...)` wording the
   user saw, proving this path fired. Wired in
   `apps/rika/src/model-provider-runtime.ts:168-174, 186, 209, 269, 292`.
4. No model-level retry exists anywhere: Effect's base `generateObject`
   fails immediately on schema mismatch
   (`repos/effect/packages/effect/src/unstable/ai/LanguageModel.ts:836-915`,
   `2181-2211`); Baton's `ModelResilience` default schedule is
   `Schedule.recurs(0)` (`repos/baton/packages/core/src/model-resilience.ts:22`)
   and Rika never configures one (`modelResilience` optional at
   `packages/runtime/src/execution-backend.ts:141`; no call site sets it).
5. The `AiError` fails the child run (`agent-run.ts:1596-1612` →
   `AgentError` → `execution.failed`). The parent survives via
   `resolveChildResult` (`packages/runtime/src/execution-backend.ts:482-517`,
   commit `076bd09`): it recovers the last streamed text and reports
   `status: "success"` when a report was streamed, else `"failed"` with
   `"Subagent execution failed: <message>"` (`:474-480, 505-514`).

Why text-by-default is safe — today's consumers of the structured report:

- The transcript reducer already treats the report as loosely-typed text:
  `packages/transcript/src/index.ts:494-516` reads
  `value.summary ?? value.output ?? value.error`, and `:551` prefers
  `event.text ?? string(value.summary)`. A plain-text report flows through
  the existing `output` arm unchanged.
- The TUI subagent row prints `block.summary`
  (`packages/tui/src/adapter.ts:216, 1158`) — derivable from text.
- No product code consumes `files` (Task) or `findings` (Review) from
  subagent reports (repo-wide search, 2026-07-19, excluding tests; the
  only other `summary` consumer is context compaction,
  `packages/runtime/src/context-compaction.ts:103`, which has its own
  schema and is out of scope).

## Target design

```text
DEFAULT (no outputSchema on the profile)
   subagent final assistant text ──► child report (verbatim)
   • no report turn, no schema, no failure mode, one fewer model call
   • TUI row summary = first non-empty line of the text (existing
     summary ?? output fallback in the transcript reducer)

OPT-IN (profile explicitly declares outputSchema)
   report turn
     ├─ 1. decode with LENIENT wire schema; repair fills gaps
     │      (missing summary ← derived from streamed text)
     ├─ 2. on failure: ONE re-prompt carrying the validation error
     └─ 3. on final failure: report = final text, marked degraded;
            the run SUCCEEDS
```

- **Default path.** Remove `outputSchema` from the Task profile (and
  Review, unless the executor finds a live consumer of `findings` the
  search missed — then Review becomes the opt-in example). With no schema,
  Baton's `structuredFinalEvents` turn never runs; the child's report is
  its final text, exactly the opencode/pi contract.
- **Opt-in hardening.** Profiles keep the _ability_ to declare a schema
  (the `outputSchemas` map and registry stay as the mechanism). When one
  is declared, three layers make it unable to kill a run: lenient decode +
  deterministic repair, one retry with the validation error appended
  (native routes get the equivalent via configuring Baton's released
  `ModelResilience` with a one-retry schedule), and a final
  degrade-to-text that succeeds with a degraded marker the TUI renders as
  finished-with-note, not failed.

## Steps

### Step 1 — Regression tests first (red)

Scene test in `apps/rika/test/` (model on `child-runs.scene.test.ts`):

1. **Default text contract**: a `task` subagent whose scripted run ends
   with plain final text and NO report turn → parent receives that text;
   TUI shows the subagent finished; assert (via the scripted model's
   request log) that no extra report/JSON-instruction turn was issued.
   Fails today because the Task profile forces the report turn.

Unit tests in `packages/runtime/test/` (follow the package's existing test
layout) for the opt-in path, driven through the streaming-only wrapper
with a scripted model and `TestClock`:

2. Declared schema, streamed JSON missing `summary` → decoded report
   carries a derived summary, no error (layer 1).
3. Declared schema, garbage response → exactly one re-prompt containing
   the validation message; valid second response decodes (layer 2).
4. Declared schema, both attempts invalid → report falls back to streamed
   text, marked degraded; the effect SUCCEEDS (layer 3).
5. Valid strict JSON first try → unchanged, single turn.

Verification: all new tests fail on the asserted behavior against current
code (not on harness errors).

### Step 2 — Text by default

Remove `outputSchema` from Task (and Review per the consumer check) in
`packages/runtime/src/agent-profiles.ts:14-28, 107, 167-170`; confirm the
report turn disappears (test 1 goes green) and the child report equals the
final text end-to-end (`resolveChildResult` path,
`execution-backend.ts:482-517`, needs no change for success cases —
verify, don't assume). Update the TUI summary derivation if the row goes
blank: first non-empty line of the text, truncated to the row width.

### Step 3 — Opt-in hardening, layer 1+3 (repair and degrade-to-text)

In Rika-owned decode paths (`streaming-only-model.ts:81-86, 108-132`):
decode with a lenient variant of the declared schema, repair missing
fields deterministically from the streamed text, and where
`structuredFailure` would fire with streamed text present, succeed with
the text-derived report plus a degraded marker instead. Extend
`resolveChildResult` so a schema-only degrade renders as finished (with
note) — hard failures (no text at all) keep failing exactly as today.
TUI: `packages/tui/src/view-state.ts:1047`, status icon
`packages/tui/src/adapter.ts:675`.

### Step 4 — Opt-in hardening, layer 2 (one retry with feedback)

`streaming-only-model.ts`: on decode failure after `extractJson`, re-issue
the streamed request once with the schema error appended to
`jsonInstruction` (cap: 1). Native routes: configure `ModelResilience`
with a `Schedule.recurs(1)`-class schedule scoped to retryable
structured-output errors, from Rika's composition site
(`execution-backend.ts:141, 235-254`) — configuration only, no Baton
edits.

### Step 5 — Verification

- All step-1 tests green; `bun run check` green at full parallelism (no
  worker caps; a parallel-only flake means an isolation bug to fix, not a
  cap to add).
- Existing `076bd09` recovery tests stay green (hard-crash recovery is
  still the backstop).
- Live confirmation (needs a streaming-only route): run a Task subagent
  with a prompt that historically triggered the miss; confirm via
  `rika diagnostics status` + the newest `client-*.jsonl` that no report
  turn ran and the execution ended `success` with the text report. Report
  what fired.

## Test matrix

| Behavior                                               | Level | Location                             |
| ------------------------------------------------------ | ----- | ------------------------------------ |
| Task subagent returns final text, no report turn       | Scene | new `apps/rika/test/*.scene.test.ts` |
| Opt-in: missing key repaired from text                 | Unit  | `packages/runtime/test/`             |
| Opt-in: one retry with validation feedback             | Unit  | same                                 |
| Opt-in: double failure degrades to text, run succeeds  | Unit  | same                                 |
| Opt-in: valid report unchanged, single turn            | Unit  | same                                 |
| Native-route retry via ModelResilience config          | Unit  | backend tests' current home          |
| Degraded report renders finished-with-note, not failed | Unit  | `packages/tui/test/`                 |
| Hard failures (no text) still fail                     | Unit  | existing `076bd09` tests stay green  |

## STOP conditions

- Drift check mismatch on any in-scope file.
- Baton runs the report turn even without an `outputSchema` (step 2's
  lever missing) and no released configuration seam avoids it — stop and
  report; do not edit `repos/baton`.
- A live consumer of `files`/`findings` from subagent reports turns up —
  stop and confirm with the owner whether that profile keeps its schema
  (opt-in) before removing anything.
- The degrade change flips any existing hard-failure expectation — stop;
  hard failures must stay failures.

## Out of scope

- Rendering/scroll defects — plan 011.
- Context-compaction's summary schema
  (`packages/runtime/src/context-compaction.ts:103`) — different feature,
  keeps its schema.
- Upstream Baton/Effect changes (worth proposing separately: a
  retry-with-feedback option on `generateObject`).

# Plan 015: Consistent tool and subagent summary emphasis

## Goal

Make every unselected tool-call summary use the same visual hierarchy at every nesting depth:

- the semantic action or agent identity uses `colors.text`;
- lifecycle status, target, count, or contextual detail uses `colors.muted`;
- status icons, failure/cancellation tones, diff counts, and shell syntax keep their existing semantic colors;
- selection remains the explicit exception: a selected root row stays uniformly bold blue so focus remains unambiguous.

Representative results are `Read` + muted ` src/a.ts`, `Create` + muted ` file.ts`, `Subagent` + muted ` working`, `Oracle` + muted ` has spoken`, and `Ran` + muted ` 3 commands`. The visible copy, pluralization, ordering, connectors, expansion behavior, and durable transcript data do not change.

The current capability contract belongs in `docs/features/tool-presentation.md` and `docs/features/subagent-presentation.md`; update those files with the typography rule when the implementation lands. This plan only tracks the unfinished work.

## Executor drift gate

This plan was investigated at commit `dde2790`. Before implementation, run:

```sh
git diff --stat dde2790..HEAD -- packages/tui/src/adapter.ts packages/tui/src/markdown-renderer.ts packages/tui/src/transcript-presenter/rows.ts packages/tui/test apps/rika/test docs/features/tool-presentation.md docs/features/subagent-presentation.md
git status --short -- packages/tui/src packages/tui/test apps/rika/test docs/features
```

If an in-scope file changed, compare the current branches and tests with the cause inventory below before editing. Preserve all existing work. If the change already introduces a summary abstraction, extend that seam rather than creating a competing one; if it changes copy, layout, or mounted-renderer behavior assumed here, stop for review.

## Current cause

At commit `dde2790`, OpenTUI receives the styles that Rika builds. `splitStyledLines` preserves each source chunk in `packages/tui/src/adapter.ts:3371-3381`, and `buildTranscriptUnitBundles` preserves those chunks when it constructs mounted `StyledText` values at `:2384-2438`. The defect is therefore in summary construction, before mounting.

The renderer currently has several divergent paths:

- Expanded top-level exploration children already split the leading word from the rest, but do it locally with `label.indexOf(" ")` and `dim(fg(colors.text))` at `packages/tui/src/adapter.ts:936-943`.
- Normal edit summaries split verb and path at `:1004-1008`, while expanded multi-file child rows paint `Create/Edit <path>` as one text chunk at `:1025-1034`.
- Shell aggregates paint both `Ran/Running` and `<count> commands` with `colors.text` at `:1124-1128`.
- Agent summaries paint the complete `Subagent finished`, `Oracle has spoken`, or other specialist label as one chunk at `:1157-1187`.
- `toolDetail` flattens nested read, search, edit, shell, agent, and generic summaries into one `label` string in `packages/tui/src/transcript-presenter/rows.ts:70-120`.
- The recursive renderer then paints every non-cancelled nested label line as one `colors.text` chunk at `packages/tui/src/adapter.ts:1197-1238`. This is the shared cause of the reported nested behavior.
- Legacy standalone `ChildAgent` blocks also paint their whole phrase as one chunk at `:1280-1300`.
- Expanded multi-file edit children have the same action/target inconsistency at `:1025-1034`.
- Selected summaries deliberately go through `highlight`, which paints the complete selected row bold blue at `:807`. Existing coverage treats that as intentional and it should remain so.

The theme already has distinct semantic roles: `colors.text` is palette index 7 and `colors.muted` is palette index 8 in `packages/tui/src/theme.ts:3-22`. Do not introduce literal white/gray RGB values or ANSI escapes.

## Target design

Introduce one TUI-owned summary representation and one rich-text renderer. A suitable shape is:

```ts
interface ToolSummary {
  readonly primary: string
  readonly secondary?: string
}
```

The separator belongs to the secondary run, so a missing secondary value cannot leave trailing whitespace. If shell rows need a distinct shape to retain syntax highlighting, use a narrow discriminated variant rather than weakening all summaries into arbitrary styled fragments.

Keep responsibilities separated:

1. `packages/tui/src/transcript-presenter` derives display facts from `ToolCall` data. It must retain the primary/secondary boundary instead of returning only a flattened label.
2. A TUI summary renderer turns those facts into `TextChunk`s using `colors.text` and `colors.muted`.
3. Root and recursive renderers own only status icons, selection, connectors, expansion markers, indentation, and placement. They both call the same summary renderer.
4. Wrapping operates on styled chunks and preserves the role of every grapheme across continuation lines. The current `wrapTextToWidth(detail.label, ...)` path cannot remain because it flattens the style boundary before wrapping.

Construct boundaries semantically; never split an arbitrary label at its first space. Multiword tool actions such as `Web Search` and `Sending message to thread`, and multiword custom agent identities, remain intact as primary text. Known agent lifecycle suffixes become secondary: `Subagent` + ` working`, `Oracle` + ` has spoken`, `Librarian` + ` researching`, and a custom identity + ` finished`. Action-form specialists use action plus object: `Reviewing/Reviewed` + ` code` and `Searching/Searched` + ` codebase`. A static label with no status, target, count, object, or `ToolCall.detail`, such as `Checking available agent modes`, remains wholly primary. Derive read/search/edit targets and aggregate counts from their already separate values rather than reparsing paths or commands. Paths containing spaces must remain one secondary value. Agent labels must cover Task, Oracle, Librarian, Review, finder/codebase-search labels, custom transferred profiles, failed/cancelled labels, and legacy `ChildAgent` rows.

Preserve the three existing agent copy/layout contracts while sharing only derivation and styling mechanics:

| Context             | Header behavior to preserve                            | Detail behavior to preserve                                                                 |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Modern root agent   | Uses current running/complete/failed/cancelled wording | Delegated task stays out of the header and appears only in the expanded body                |
| Nested agent tool   | Uses the current `toolDetail` visible wording          | Delegated task stays inline in the nested header and is also available in the expanded body |
| Legacy `ChildAgent` | Keeps its independent Oracle/Librarian/general wording | Summary and activity stay in the expanded body                                              |

Keep every existing visible word and placement exactly as it is. In particular, do not use this typography fix to normalize nested write calls from their current `Edit` wording to `Create`, or to normalize nested failed/cancelled agent wording to the modern root wording. The existing first-space failed/cancelled helper is a compatibility constraint, not a pattern to copy. If a multiword custom identity cannot be styled correctly without changing its current text or the durable presentation schema, trigger the stop condition instead of guessing.

Shell command rows remain a special presentation:

- preserve `$` treatment and `highlightShellCommand` for command text;
- apply the shared summary treatment to aggregate `Running/Ran <count> commands` headers;
- do not regress cancelled strikethrough, exit-code red, or command syntax colors;
- make nested non-cancelled shell rows use the same syntax-highlighted command treatment as equivalent top-level shell rows instead of painting the complete command as one color.

## Implementation slices

### 1. Lock the style contract with failing tests

Add style-aware assertions before changing the renderer. Plain-text assertions are insufficient because the text is already correct.

In `packages/tui/test/tool-presentation.test.ts`:

- assert an expanded `Read src/a.ts` has a `Read` chunk in `colors.text` and a separate ` src/a.ts` chunk in `colors.muted`;
- assert `Created src/new.ts` or `Edited src/a.ts` follows the same split;
- assert an actual aggregate such as `Ran 3 commands` uses a primary action plus muted count; one shell call must remain the existing `$ <command>` row, so singular pluralization is only a pure-helper concern if that helper is already tested;
- table-test running and complete Task, Oracle, Librarian, Review, and a custom child profile so identity/action stays primary and lifecycle text is muted;
- assert failed and cancelled agent copy follows the same primary/secondary boundary while the icon and terminal reason retain red/amber behavior;
- retain the existing selected-shell test and add one selected agent/group assertion proving selection intentionally overrides summary colors.

In `packages/tui/test/adapter.test.ts` or a focused transcript-summary test beside it:

- build an expanded Oracle or Subagent tree containing nested read, search, create/edit, shell, and another agent call;
- assert primary and secondary `TextChunk` foregrounds at depth one and depth two;
- include a long path and long delegated prompt in a narrow model, then assert wrapped continuation chunks remain muted; assert connector text/placement and its `DIM` attribute separately because `colors.subtle` and `colors.muted` currently resolve to the same palette index;
- assert an equivalent top-level and nested call have identical summary foreground roles after excluding their icons/connectors.

The tests should fail because the current nested, agent, edit-child, legacy-child, and shell-aggregate paths each emit a uniform chunk.

### 2. Preserve summary structure in the presenter

Replace the flat-only `ToolDetail.label` contract in `packages/tui/src/transcript-presenter/rows.ts` with structured summary data while preserving `block` and `target`.

Derive the structure while facts are separate:

- read/media: preserve `Read` or `Viewed` plus path/location;
- grep/search: preserve `Grep` or `Searched` plus query/workspace detail and the `workspace` fallback;
- exploration special cases: keep `skill` as the bare skill name and `git-status` as `Checked <detail>` exactly as `exploreChildLabel` does today;
- edit/write: preserve each context’s existing `Edit`, `Create`, `Edited`, or `Created` wording plus path rather than normalizing them;
- direct/generic: keep the complete active/complete presentation label as primary and only `ToolCall.detail` as secondary, with an explicit action-specific mapping if a catalog label itself contains dynamic metadata;
- agents: preserve the root/nested/legacy compatibility matrix above while separating semantic identity/action from lifecycle text where the existing contract makes that boundary reliable;
- shell: retain the command separately for syntax rendering.

Expose a pure plain-text join only where hit testing, snapshots, or compatibility assertions need the complete visible string. Do not make recursive rendering recover roles with path-sensitive parsing after this point.

Keep `presentation.activeLabel`, `presentation.completeLabel`, and the durable transcript schema unchanged unless implementation proves that an agent boundary cannot be derived from the existing `family`, `action`, status, labels, and detail. If a schema extension becomes necessary, stop and review it as a compatibility change rather than silently changing persisted transcript data for a color fix.

Update the presenter tests that currently assert only `toolDetail(...).label` so they assert both the joined text and the primary/secondary fields, including partial/streaming input.

### 3. Add one rich summary renderer with style-preserving wrapping

Add a narrowly named TUI module such as `packages/tui/src/tool-summary.ts`, or a cohesive private section in the adapter if extraction would create an artificial abstraction. It should own:

- joining a summary without stray spaces;
- rendering one `StyledText`/chunk sequence with primary `colors.text` and secondary `colors.muted`;
- a selected mode that deliberately emits one bold-blue run;
- preservation of wide characters, paths containing spaces, and hard line breaks.

Do not add a third wrapping algorithm. Extract the generic styled `TextChunk` splitting/grapheme/word-wrapping primitives currently private in `packages/tui/src/markdown-renderer.ts:21-122` into a narrowly named TUI text module, then reuse them from markdown and tool summaries. The summary renderer may own when and how that shared primitive is called, not its duplicate implementation.

Do not use terminal `DIM` as the only distinction. Use `colors.muted` so the foreground role is explicit and style tests are deterministic. Existing summary call sites that currently use `dim(fg(colors.text))` should move to the same muted role; body text and connector dimming are outside this normalization and can remain unchanged.

Keep icons, connectors, markers, diff additions/deletions, errors, and terminal answers outside the helper so their current semantic styles cannot leak into summary text.

### 4. Route every summary branch through the shared renderer

Migrate all unselected summary paths in `packages/tui/src/adapter.ts`:

- exploration aggregate headers and expanded read/search children;
- edit/create aggregate headers and expanded multi-file children; standalone `Diff` transcript units are outside this tool-call typography fix;
- multi-command shell aggregate headers;
- direct/generic tool rows;
- root Task, Oracle, Librarian, Review, finder, and custom child-agent rows;
- recursive nested read/search/edit/direct/agent rows at every depth;
- legacy standalone `ChildAgent` rows.

For nested shell rows, compose the connector and status icon with the existing shell syntax renderer. For selected root rows, continue using the selected override. Nested rows currently do not have a selected typography branch; do not invent one as part of this fix.

Delete the duplicated first-space styling in `renderExploreBody` once the shared renderer owns it. Remove any whole-label `fg(colors.text)` calls superseded by the shared path. Do not put a foreground color on a recursive container or continuation prefix that can override its child chunks.

### 5. Prove mounted OpenTUI and real-app behavior

Extend `packages/tui/test/opentui-adapter.test.ts:1706-1895`, which already mounts an Oracle tree with nested read, Task, and shell calls:

- inspect each mounted header’s `StyledText.chunks`, not only `captureCharFrame()`;
- assert the Oracle/Task/action chunk resolves to `colors.text` and lifecycle/path/detail chunks resolve to `colors.muted`;
- assert the nested read target is still clickable and expansion behavior is unchanged;
- update the model from running to complete and prove the role stays primary while `working` becomes `finished` in the muted run;
- keep the existing wrapping, connector, and independent-expansion assertions.

Add or extend an in-process app `*.tui.test.ts` using `apps/rika/test/tui-app.ts`, as required for user-visible interactive behavior:

- script a real Oracle or Task call whose child performs a read and returns a final answer;
- expose a read-only `captureSpans` accessor from the harness if needed so the app test can inspect foreground runs instead of relying on a character frame;
- assert the live app shows the parent specialist row and nested tool exactly once, with primary/muted spans preserved through the real product stack;
- assert the row updates in place from running to complete without stale lifecycle text.

Keep provider/network access forbidden and reuse the existing app instance pattern where practical.

### 6. Update visual evidence and capability contracts

Update the smallest existing visual scenario affected by the renderer change. Prefer extending `cancelled-subagent` only if it can remain focused, or add one compact completed nested-agent scenario if no current fixture exposes primary/muted nested spans. Do not duplicate the complete type/depth/lifecycle matrix already covered by chunk-level and mounted tests. Existing `tool-group-states` or another focused fixture can carry the `Ran <count> commands` evidence separately.

Regenerate only affected `.frame.txt`, `.styles.json`, and `.ppm` fixtures through the existing visual capture workflow. Review the style-span diff: primary and muted runs should change, while text, layout, connectors, and unrelated colors should not.

Update `docs/features/tool-presentation.md` with one short sentence stating that actions/agent identities are primary, statuses/targets/counts are muted, and nesting does not change typography. Update `docs/features/subagent-presentation.md` only if needed to make the same lifecycle emphasis explicit without duplicating the full tool contract.

## Verification

Run focused checks while implementing:

```sh
bun --bun vitest run --project unit packages/tui/test/tool-presentation.test.ts
bun --bun vitest run --project unit packages/tui/test/adapter.test.ts packages/tui/test/opentui-adapter.test.ts
bun --bun vitest run --project unit packages/tui/test/visual.test.ts
bun run test-tui
bun run typecheck
```

Then run the supported full gate:

```sh
bun run check
```

Run manual TUI acceptance through the repository’s `pilotty` or `agent-tty` workflow. Inspect one running and completed nested-agent session; confirm Task, Oracle, Librarian/Review or another specialist, nested read/edit calls, and `Ran 3 commands`, plus a narrow wrapped row and a selected root row. Report which checks and manual cases ran and which did not.

## Done criteria

- Every unselected summary in the styled `buildTranscript`/`renderTranscriptStyled` tool and subagent path uses the shared primary/muted renderer; string-only compatibility/debug APIs such as `renderBlock` and `renderTranscript` retain their exact plain text.
- `Read`, `Create/Edit`, `Subagent`, `Oracle`, other specialist identities/actions, and `Ran` retain primary emphasis while their path/status/count/detail is muted.
- The same summary has the same foreground roles at depth zero, depth one, and deeper nesting.
- Wrapped secondary text remains muted on continuation lines.
- Nested shell rows retain syntax highlighting; errors, cancellation, diff counts, connectors, and selection retain their existing semantic treatments.
- Mounted OpenTUI, the real app TUI test, and visual style fixtures prove foreground boundaries rather than only visible characters.
- No literal white/gray colors, ANSI escapes, transport labels, or copy changes are introduced.
- Focused tests, `bun run test-tui`, type checking, and `bun run check` pass.

## Stop conditions

Stop and request review rather than broadening the change if:

- preserving agent identity/status boundaries requires a non-optional change to the durable `Presentation` or transcript schema;
- the fix would change tool copy, ordering, grouping, lifecycle semantics, or expansion behavior;
- mounted OpenTUI actually overwrites child foregrounds after the new style-aware chunks are present, which would invalidate the current root-cause finding;
- a selected-row product change is required instead of preserving the existing bold-blue focus treatment;
- unrelated worktree changes overlap an in-scope file and cannot be preserved cleanly.

Do not edit, build, format, or test `repos/*`.

## Out of scope

- Changing the terminal palette or literal theme colors.
- Redesigning status icons, connectors, selection, or expansion affordances.
- Restyling standalone `Diff` transcript units or other non-tool summary-like rows.
- Changing tool labels or agent lifecycle wording.
- Changing grouping rules, nested projection, persistence, or execution behavior.
- General extraction of `packages/tui/src/adapter.ts` beyond the narrow summary renderer.

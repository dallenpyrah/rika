# Plan 011: Transcript viewport — one scroll owner, correct collapse rendering, unit-window integrity

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 93c4029..HEAD -- packages/tui/src/adapter.ts packages/tui/src/view-state.ts packages/tui/src/transcript-units.ts packages/tui/src/execution-events.ts apps/rika/src/main.ts apps/rika/src/interactive-controller.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> **Boundary**: `repos/*` (OpenTUI, Baton, Relay, Effect) is vendored,
> read-only reference. Every fix in this plan lives in Rika-owned code. Do
> not edit, build, or test anything under `repos/*`.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: bug + structure
- **Planned at**: commit `93c4029`, 2026-07-19
- **Issue**: —

## Why this matters

Three user-visible defects share one root: Rika and OpenTUI's ScrollBox both
think they own transcript scrolling, and neither fully does.

1. **Blank/stale transcript after collapse.** Expand a subagent row, scroll
   up, collapse it: the messages above (including the user's own prompt)
   disappear or stale expanded content stays painted until a manual scroll
   forces a repaint. Reproduced deterministically by
   `apps/rika/test/transcript-collapse-rendering.scene.test.ts` (in the
   working tree, currently failing on purpose — it is the regression test
   for this plan).
2. **Scroll jumps.** While streaming or toggling rows, the viewport snaps to
   the bottom, snaps to a stale offset, or stutters during wheel scrolling.
3. **Subagent rows show nested child subagents but not their own tool
   calls.** The 200-item mounted window re-includes ancestors of surviving
   rows but silently drops the parent subagent's earlier direct tool-call
   siblings.

The fix is not another patch on the render path. The scroll/anchor/window
logic is smeared across `view-state.ts`, `adapter.ts`, and `main.ts` with two
divergent definitions of a page, a dead reducer branch, and two uncoordinated
writers of `scrollTop`. This plan extracts one small, pure, unit-testable
viewport state machine, makes the adapter its only executor, and brings
Rika's OpenTUI usage in line with OpenTUI's own documented contract.

## Current state — defect inventory

All line numbers at commit `93c4029`.

### A. Collapse leaves blank/stale content (reproduced)

- `packages/tui/src/view-state.ts:1373-1385` — `DetailToggled` changes only
  `expandedRowKeys` + `detailSelection`. It never touches `scrollOffset` or
  `scrollFollow`. (This reducer is fine; the control scene test that
  collapses while pinned to bottom passes.)
- `apps/rika/src/main.ts:2299-2301` (mouse `clickToggle`) and `:2318-2330`
  (Enter key) both re-render with `preserveTranscriptAnchor` defaulting to
  false, so `preserveTranscriptPosition` is false
  (`packages/tui/src/adapter.ts:2389-2396`) and the anchor capture/restore
  machinery (`adapter.ts:2686-2727`) never engages for a toggle.
- `adapter.ts:2730-2733` — when detached (`scrollFollow=false`) the adapter
  writes `this.transcriptScroll.scrollTop = model.scrollOffset`
  **synchronously inside `update()`**, before Yoga re-lays-out the shrunken
  content. OpenTUI's clamp (`repos/opentui/packages/core/src/renderables/ScrollBar.ts:72-73`)
  runs against the stale, still-tall `scrollHeight`, so the stale offset
  survives past the new maximum.
- OpenTUI repaints vacated cells only if something draws there: the output
  buffer is persistent (never cleared per frame,
  `repos/opentui/packages/core/src/renderer.ts:4433`), transparent boxes
  draw nothing (`Box.ts:255-262`, default transparent `Box.ts:63`), and
  viewport-culled rows are dropped from the render list entirely
  (`ScrollBox.ts:38-55`). Rika creates `transcriptScroll` with
  `viewportCulling: true` and **no** `viewportOptions`/`contentOptions`
  backgrounds (`adapter.ts:1509-1527`), while every official OpenTUI example
  sets opaque backgrounds on all scrollbox sub-boxes
  (`repos/opentui/packages/examples/src/sticky-scroll-example.ts:200-212`,
  `packages/react/examples/scroll.tsx:50-61`).
- OpenTUI itself defers its shrink repaint via `process.nextTick`
  (`ScrollBox.ts:793-804`, an acknowledged workaround) and has a documented
  culling ordering hazard
  (`repos/opentui/packages/core/src/tests/scrollbox-culling-bug.test.ts:22-27`).
  Its own regression test only asserts a correct reveal **after an explicit
  scroll** (`scrollbox.test.ts:134-173`) — matching the "blank until the
  user scrolls" symptom exactly.

### B. Scroll jumps — eight interacting defects

1. **Two writers per wheel tick.** Rika registers `onMouseScroll`
   (`adapter.ts:1517` → `handleTranscriptWheel` `:1851-1881`), and OpenTUI
   **also** runs its own accelerated scroll for the same event —
   `Renderable.ts:1597-1605` calls the listener and then unconditionally
   `this.onMouseEvent(event)` (`ScrollBox.ts:542-584`); there is no
   `defaultPrevented` gate for mouse events. The two writers use different
   deltas, and Rika's `wheelScrollBy` bookkeeping (`adapter.ts:1865`) feeds
   window paging with a third notion of distance.
2. **Toggle snap.** Following → expand/collapse yanks to bottom; detached →
   snaps to the stale absolute offset (defect A path).
3. **Streaming with detached scroll drifts.** Every `TranscriptPatched`
   renders with `preserveAnchor:false`
   (`apps/rika/src/interactive-controller.ts:451, 503-517`; only
   `TranscriptPagePrepended` preserves, `:420`). Growth of a unit above the
   viewport shifts everything; OpenTUI has no scroll anchoring, so the
   reading position drifts by the growth delta.
4. **Sticky re-engage fuzz.** OpenTUI re-pins when
   `scrollTop >= maxScrollTop - 1` (`ScrollBox.ts:497-512`); a user parked
   one row off the bottom is yanked down by the next streamed chunk. Rika
   mirrors the same `-1` fuzz (`adapter.ts:1826-1832`).
5. **Two bottoms.** `followTranscriptAfterLayout` targets
   `scrollHeight - viewport.height` (`adapter.ts:1949-1951`) while the
   scrollbar sync computes rows from
   `model.height - renderedInputHeight - queueHeight` (`adapter.ts:2650`,
   `1919-1925`); they disagree whenever composer/queue height changes.
6. **Height-only resize.** Only a width change sets
   `preserveTranscriptPosition` (`adapter.ts:2389-2394`); a height resize
   while detached re-applies the stale offset (`main.ts:2358-2359` →
   `adapter.ts:2730-2733`).
7. **Dead, divergent page reducer.** `view-state.ts:1494-1507` implements
   pageup/pagedown/end as `scrollOffset ± (height-6)`, but the adapter
   intercepts those keys first (`adapter.ts:1805-1822`) and scrolls the
   renderable directly with `viewport.height-1`. Worse: `scrollOffset` is
   never synced while following, so the reducer path (when reachable) jumps
   to offset 0 — confirmed during reproduction (PageUp jumps to the very
   top and collapse then leaves stale content _below_ the prompt).
8. **Asymmetric feedback.** `handlers.scroll` re-renders synchronously from
   inside a ScrollBar `onChange` (`main.ts:2223-2225`, re-entrant
   `update()`), while `handlers.scrollGeometry` mutates the model without a
   render (`main.ts:2239-2241`, called at `adapter.ts:2721`) — so
   `model.scrollOffset` and live `scrollTop` transiently disagree, feeding
   defects 2 and 6.

### C. Window drops a subagent's direct tool calls

- `adapter.ts:568-632` — `boundedTranscriptModel` keeps the last
  `maxMountedTranscriptEntries` (200) items (`:1489-1494`), then re-includes
  only **ancestors** of surviving items (`:585-605`). Nested subagent
  projections attach later than the parent's own tool calls
  (`apps/rika/src/interactive-controller.ts:184-204`,
  `packages/tui/src/execution-events.ts:322-333`), so when the window cuts
  through a large subagent, the nested child row survives as an ancestor
  while the parent's earlier direct tool-call siblings fall out and are
  never re-included. Symptom: subagent shows nested subagents but not its
  own tool calls.
- Related fragility to fix while in there:
  - `transcript-units.ts:309, 321` — expandable row ids for entries/blocks
    fall back to index-derived keys (`turnId:role:index`,
    `block:_tag:index`), which change when the window shifts, silently
    dropping rows from `expandedRowKeys`.
  - Suffix-based child→parent matching
    (`interactive-controller.ts:176-179`, `execution-events.ts:213-215`)
    can attach a child's tools to the wrong parent when tool-call ids share
    suffixes; a child whose parent is not yet projected is silently skipped
    for that pass (`interactive-controller.ts:196-197`).

### D. Structural debt that makes all of this hard to fix piecemeal

- `packages/tui/src/adapter.ts` — 3711 lines. `buildTranscript`
  (`:640-1279`) and `Surface.update` (`:2380-2826`) each mix several
  concerns including all scroll/anchor/window logic.
- `packages/tui/src/view-state.ts` — 1967 lines; `KeyPressed` alone is
  `:1437-1965`.
- Dead duplicate reducers: `EventReplayed` (`view-state.ts:1025-1110`),
  `AssistantStreamed` (`:1221`), `ReasoningStreamed` (`:1187`) are never
  dispatched by the app (projection now flows through
  `execution-events.ts:projectUnitsImpl`); they are a second, divergent
  implementation of transcript upserts.

## Target design

One principle: **exactly one owner per piece of scroll state, and every
`scrollTop` write happens after layout, clamped, through one function.**

```text
              user input                model/projection changes
        (wheel, PageUp, click)        (patch, toggle, resize, follow)
                 │                                │
                 ▼                                ▼
        ┌─────────────────────────────────────────────────┐
        │   TranscriptViewport (pure state machine,       │
        │   packages/tui/src/transcript-viewport.ts)      │
        │                                                 │
        │   state: Following | Anchored{unitId, offset}   │
        │   + mounted window {start, end}                 │
        │                                                 │
        │   transitions (pure, unit-tested):              │
        │     wheel(delta)      → Anchored | Following    │
        │     page(dir)         → Anchored                │
        │     follow()          → Following               │
        │     contentChanged()  → same state, new anchor  │
        │     toggled(unitId)   → anchor on toggled unit  │
        │     resized(w,h)      → keep anchor             │
        └───────────────────┬─────────────────────────────┘
                            │ ViewportPlan {window, anchor|bottom}
                            ▼
        ┌─────────────────────────────────────────────────┐
        │   adapter applyViewport() — the ONLY scrollTop  │
        │   writer; runs AFTER reconcile + layout,        │
        │   clamps to live scrollHeight, then requests    │
        │   a re-cull render on next tick                 │
        └───────────────────┬─────────────────────────────┘
                            ▼
                 OpenTUI ScrollBoxRenderable
          (sticky machinery disabled; Rika owns follow)
```

Design decisions:

- **Rika owns follow/anchor; OpenTUI executes.** Today both layers run
  sticky/manual-scroll logic and fight (defects B1, B4). The viewport
  machine decides; the adapter sets `stickyScroll` permanently false and
  positions explicitly. OpenTUI's wheel default is suppressed by not
  letting the ScrollBox see the wheel event as unhandled — Rika's handler
  consumes it and routes through the machine. If OpenTUI's mouse pipeline
  offers no consume mechanism (audit: `Renderable.ts:1597-1605` has none),
  invert instead: delete Rika's scroll math from `handleTranscriptWheel`
  and make OpenTUI the sole wheel executor, with Rika reading position from
  the scroll callback. Either way there is one writer; the spike in step 2
  picks which.
- **Anchor is a unit id + pixel offset, not an absolute `scrollTop`.**
  Absolute offsets are what go stale (A, B2, B3, B6). On every content
  change while detached, restore = find anchor unit's new layout position,
  set `scrollTop = unitTop - anchorOffset`, clamp.
- **Window at unit granularity.** `boundedTranscriptModel` mounts whole
  top-level units (a subagent with all its direct tools and nested
  children) instead of slicing raw items, eliminating defect C's
  sibling-dropping by construction. Budget stays ~200 items but the cut
  lands on unit boundaries.
- **Stable row ids.** Expandable row keys derive from durable ids (turn id
  - unit key), never array indexes.
- **Opaque scrollbox backgrounds + post-shrink nudge.** Follow OpenTUI's
  own examples: set `viewportOptions.backgroundColor` and
  `contentOptions.backgroundColor` to the theme background, and after any
  content-shrinking reconcile schedule `requestRender()` (next tick, same
  as OpenTUI's internal workaround) so culling re-runs against settled
  layout.
- **Delete the dead reducers and the reducer-side page math.** One
  projection implementation (`execution-events.ts`), one page definition
  (the viewport machine's).

## Steps

### Step 1 — Lock in the reproductions (no product change)

The failing scene test
`apps/rika/test/transcript-collapse-rendering.scene.test.ts` already exists.
Add two more failing/characterizing tests before touching product code:

1. **Windowing unit test** (`packages/tui/test/` beside existing adapter
   tests): build a model where a subagent with 30 direct tool calls plus a
   nested subagent straddles the 200-item boundary; assert the parent's
   direct tool calls render whenever the nested child does. Fails today.
2. **Streaming-drift scene test**: stream a long assistant response, wheel
   up, keep streaming; assert the visible line under the cursor position is
   unchanged (reconstructed-screen technique from
   `transcript-collapse-rendering.scene.test.ts`). Expected to fail today
   (defect B3).

Verification: `bun --bun vitest run --project scene apps/rika/test/transcript-collapse-rendering.scene.test.ts` fails on the
`TRIGGER_PROMPT_TOP` assertion; the two new tests fail on their asserted
symptom, not on harness errors.

### Step 2 — Spike the single-wheel-writer decision (throwaway)

Prove which owner works with vendored OpenTUI: (a) Rika consumes wheel and
is sole writer, or (b) OpenTUI's default wheel scroll is sole executor and
Rika only observes. Drive a minimal scrollbox via the pilotty/agent-tty
skill; check for double-scroll per tick. Record the choice and evidence in
this plan's PR description. Discard the spike code.

### Step 3 — Extract `TranscriptViewport` (pure module + unit tests)

New file `packages/tui/src/transcript-viewport.ts` with the state machine
above; `packages/tui/test/transcript-viewport.test.ts` covering every
transition: wheel detach, re-follow at true bottom (no `-1` fuzz), page
up/down, toggle-anchoring, content growth above/below anchor, shrink
clamping, resize, window advance/retreat at boundaries. Pure data in/out —
no OpenTUI imports. Port the follow/detach/window fields out of
`view-state.ts` (`scrollFollow`, `scrollOffset`) and `adapter.ts`
(`transcriptWindowEnd`, `pendingTranscriptAnchor`, `userScrollDetached`,
`wheelScrollBy`) into machine state; the old fields become derived or are
deleted. Delete the dead page-key reducer branch
(`view-state.ts:1494-1507`) and the dead `EventReplayed` /
`AssistantStreamed` / `ReasoningStreamed` cases after confirming with a
repo-wide grep that nothing dispatches them.

Verification: `bun run typecheck && bun --bun vitest run packages/tui` —
new machine tests green, existing adapter/view-state tests updated to the
new state shape, no test deleted without a replacement.

### Step 4 — Adapter integration: one writer, post-layout clamp, opaque backgrounds

- Replace every direct `transcriptScroll.scrollTop` / `scrollBy` write in
  `adapter.ts` (`:1805-1822`, `:1851-1881`, `:1949-1951`, `:2686-2733`)
  with one `applyViewport(plan)` that runs after `reconcileTranscript` and
  layout, clamps to live `scrollHeight - viewport.height`, and schedules a
  next-tick `requestRender()` after shrinks.
- Wire the step-2 decision for wheel ownership; delete the losing path.
- Set `stickyScroll: false` at construction (`adapter.ts:1509-1527`); Rika's
  Following state now owns pinning. Set opaque `viewportOptions` /
  `contentOptions` backgrounds from the theme.
- Toggle dispatches (`main.ts:2299-2301`, `:2318-2330`) route through
  `viewport.toggled(unitId)` so collapse anchors on the toggled row.
- Unify the two bottom computations (defect B5) on the machine's single
  viewport-height input.
- Collapse the `scroll`/`scrollGeometry` handler pair (defect B8) into one
  non-re-entrant position report.

Verification: the step-1 scene tests now pass; `bun --bun vitest run
--project scene apps/rika/test/child-runs.scene.test.ts
apps/rika/test/subagent-presentation.scene.test.ts
apps/rika/test/parallel-subagents.scene.test.ts` stays green.

### Step 5 — Unit-granularity window + stable row ids

Rewrite `boundedTranscriptModel` (`adapter.ts:568-632`) to cut on top-level
unit boundaries; replace index-derived expandable ids
(`transcript-units.ts:300-322`) with durable keys. Keep the suffix-based
child→parent matching in scope only if the step-1 windowing test still
fails without touching it; otherwise file it as a follow-up with the
evidence (it is a distinct routing defect, not a rendering one).

Verification: step-1 windowing unit test passes; expand a row, force a
window shift (long stream), row stays expanded (add a unit test for
`expandedRowKeys` stability across window shifts).

### Step 6 — Split the monoliths along the now-real seams (behavior-neutral)

With scroll state extracted, split mechanically — no behavior change:

- `buildTranscript` per-unit render closures (`adapter.ts:687-1194`) →
  `packages/tui/src/render/` pure unit renderers (one file per unit kind).
- `Surface.update` (`adapter.ts:2380-2826`) → ordered passes: transcript
  reconcile → viewport apply → queue → composer → overlays.
- `KeyPressed` (`view-state.ts:1437-1965`) → per-mode handlers (composer,
  palette, thread switcher, pickers, permission, queue).

Each extraction lands as its own commit with `bun run check` green. If time
pressure hits, steps 1-5 ship without step 6; step 6 must not ship without
steps 1-5.

### Step 7 — Full verification

- `bun run check` (typecheck, lint, full deterministic test suite) green at
  full parallelism — do not cap workers; if a parallel-only flake appears,
  fix the isolation defect, never serialize.
- Manual pass with the `testing-with-pilotty` skill: expand → wheel up →
  collapse; stream while detached; resize while detached; PageUp/PageDown;
  confirm no jump, no blank region, subagent tool calls visible alongside
  nested children.

## Test matrix (all deterministic, `bun run test`)

| Behavior                                                                | Level | File                                                                       |
| ----------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------- |
| Collapse while scrolled up keeps content above visible                  | Scene | `apps/rika/test/transcript-collapse-rendering.scene.test.ts` (exists, red) |
| Collapse while pinned at bottom renders collapsed view                  | Scene | same file (control, green today — must stay green)                         |
| Streaming while detached does not drift the viewport                    | Scene | new, step 1                                                                |
| Windowed subagent keeps direct tool calls with nested children          | Unit  | new, step 1                                                                |
| Every viewport transition (wheel/page/toggle/grow/shrink/resize/window) | Unit  | `packages/tui/test/transcript-viewport.test.ts`, step 3                    |
| `expandedRowKeys` survive window shifts                                 | Unit  | step 5                                                                     |
| Existing subagent/child-run scenes unchanged                            | Scene | `child-runs`, `subagent-presentation`, `parallel-subagents`                |

## STOP conditions

- The drift check shows in-scope files changed and the cited excerpts no
  longer match — stop and re-audit before editing.
- Step 2 finds that neither wheel-ownership option can produce a single
  writer against vendored OpenTUI — stop; the fallback (patching OpenTUI)
  crosses the `repos/*` boundary and needs the user's decision.
- Any existing scene test goes red in a way that looks like changed product
  behavior rather than changed internals — stop and report the diff in
  observed screens.
- Step 3's grep finds a live dispatcher of `EventReplayed` /
  `AssistantStreamed` / `ReasoningStreamed` — do not delete them; report.

## Out of scope

- Editing anything under `repos/*` (upstream OpenTUI fixes for the culling
  hazard are welcome but happen in the OpenTUI repo, not here).
- The subagent structured-report failure (`Missing key ["summary"]`) —
  plan 012.
- The suffix-based child→parent routing rewrite, unless step 5's test
  proves it necessary for the windowing symptom.

# Spike: Decide Whether Rika Should Move to OpenTUI Solid

## Recommendation

Do not approve a full renderer rewrite yet. Approve a three-day spike that proves the hard parts against Rika's current behavior and packaging path.

Solid is likely to improve component ownership and make overlays, sidebars, the composer, and top-level layout easier to change. It does not replace Rika's pure state reducer, transcript presentation, bounded mounting, scroll anchors, selection preservation, focus control, animation clock, or Effect-owned renderer lifecycle. Rika also already has the main testing benefit seen in OpenCode: real OpenTUI renderables, memory-backed frames, mock input, and an in-process harness using the real product stack.

The expected decision is:

- **Full migration:** not worth the cost unless Solid can replace transcript reconciliation without losing behavior or performance.
- **Shell-only migration:** worth considering only if the spike removes substantial mutable synchronization without leaving two permanent UI owners.
- **Current renderer:** keep it if the Solid version still needs the same maps, refs, frame callbacks, and scroll controller. In that case, split `Surface` by responsibility instead of changing rendering frameworks.

## Goal

Determine whether `@opentui/solid` materially lowers the cost and risk of changing Rika's TUI, rather than only replacing imperative OpenTUI construction with JSX.

The spike must answer:

1. Can Solid run under Rika's Vitest, Effect, Bun build, package, and release-smoke paths without a second test workflow or fragile transform setup?
2. Can components consume the existing immutable `ViewState.Model` without duplicating product state in Solid stores or contexts?
3. Can keyed Solid rendering preserve transcript identity, bounded mounting, selection, and scroll anchors?
4. Does a representative overlay become clearly smaller and easier to test?
5. Can one renderer destruction still release the Solid owner, OpenTUI listeners, timers, and Effect resources exactly once?

The spike does not change product behavior, redesign state, adopt OpenCode's provider tree or keymap, or upgrade OpenTUI at the same time.

## Evidence and Current Path

Rika's current public path is already a useful migration seam:

```diagram
Operation events / input
          │
          ▼
apps/rika interactive loop
          │  ViewState.update(model, message)
          │
          ▼
immutable ViewState.Model
          │  surface.update(model)
          ▼
@rika/tui OpenTUI adapter
          │
          ▼
OpenTUI renderer
```

- `packages/tui/src/view-state.ts` owns the pure `Model`, `Message`, reducer, input rules, responsive layout calculations, picker state, and scroll intent. It is about 1,984 lines and should remain renderer-independent.
- `packages/tui/src/transcript-presenter.ts` and `packages/tui/src/transcript-presenter/` own transcript projection, stable row identity, expansion, and row windows. Markdown, diff, syntax, and tool renderers already produce framework-independent `StyledText`.
- `packages/tui/src/adapter.ts` is about 4,040 lines. `Surface.update` owns too many visible regions, but the difficult code is not just element creation. It includes:
  - bounded transcript entry and row windows;
  - keyed renderable reconciliation and pinning selected renderables;
  - prepend, reflow, and detached-reading scroll anchors;
  - scrollbar feedback suppression;
  - virtual sidebar geometry;
  - explicit editor focus and cursor restoration;
  - renderer-clock animation and teardown.
- `apps/rika/src/main.ts` owns product event application, Effect fibers, 16 ms feed/render batching, actions, terminal suspend/resume, and scoped lifecycle. Solid must not take over these responsibilities.
- `apps/rika/test/tui-app.ts` already uses `createTestRenderer`, the real `Surface`, the real interactive loop, real persistence/runtime layers, a scripted model, mock input, and captured frames. Moving the main harness to `testRender` would not improve its fidelity.
- `packages/tui/test/opentui-adapter.test.ts` already proves the main migration risks: 500-entry windows, 300-child expanded subagents, stable renderable identity while typing, scrolling, selection, cursor behavior, resize storms, anchors, and teardown.
- The TUI has high recent churn: roughly 12,412 added and 4,091 deleted lines across 22 TUI paths in the last six months. Reducing the central update method would have real value if the replacement is simpler.
- Rika is pinned to OpenTUI `0.4.3`. `@opentui/solid@0.4.3` depends on `@opentui/core@0.4.3` and has an exact `solid-js@1.9.12` peer, so the experiment can keep the core renderer version fixed.

OpenCode shows what Solid does and does not provide:

- It uses one Solid root with JSX components, signals, memos, conditional control flow, and contexts.
- It keeps renderer creation and release in an Effect scope.
- It still uses raw renderable refs for focus, prompt behavior, selection, and scroll handling.
- It has manual focus restoration and layout timing workarounds.
- Its component tests use `testRender`, but lifecycle tests still inject a core test renderer.
- It uses Bun preload and a Solid transform plugin. OpenCode uses `bun:test`; Rika uses Vitest through Bun, so transform compatibility must be proven rather than assumed.

## Target Design if the Spike Passes

Keep the current ownership model and replace only the rendering implementation:

```diagram
┌──────────────────────────────────────────────────────┐
│ apps/rika                                            │
│ Effect lifecycle, event batching, actions, I/O       │
└─────────────────────────┬────────────────────────────┘
                          │ model + handlers
                          ▼
┌──────────────────────────────────────────────────────┐
│ @rika/tui adapter                                    │
│ one Solid root, one model signal, terminal mechanics │
├──────────────────────────────────────────────────────┤
│ AppShell                                             │
│ ├─ ThreadSidebar                                     │
│ ├─ TranscriptViewport ── imperative anchor controller│
│ ├─ Queue                                             │
│ ├─ Composer ───────────── renderable ref/focus bridge│
│ ├─ FileSidebar                                       │
│ └─ Overlay / Toast                                   │
└─────────────────────────┬────────────────────────────┘
                          ▼
                  OpenTUI renderer
```

The supported adapter remains equivalent to:

```ts
interface Surface {
  update(model: ViewState.Model, preserveTranscriptAnchor?: boolean): void
  showToast(message: string, color?: ColorInput): void
  destroy(): void
}
```

Rules for the target:

- Use one Solid owner per renderer and one signal containing the current immutable model.
- Do not copy `Model` fields into Solid stores or create a large OpenCode-style provider tree.
- Keep all user input rules in `ViewState.update`; Solid handlers only translate OpenTUI events into existing messages or handlers.
- Keep renderer acquisition, suspend/resume, batching, product actions, and release in Effect.
- Keep transcript projection and row-window calculations pure.
- Keep unavoidable focus, selection, scroll anchoring, and custom-renderable work in named adapter controllers with explicit cleanup.
- Destroying the renderer must dispose the Solid tree. Do not create independent panel roots.
- Keep the existing real-product `tuiApp` harness. Use Solid `testRender` only for narrow component tests where it is simpler.

## Decisions

- **Do not copy OpenCode's architecture.** Its contexts own OpenCode product and transport state. Rika already has a pure model and Effect-owned product loop.
- **Do not adopt OpenTUI keymap in this migration.** Key interpretation currently belongs to Rika's reducer. A keymap redesign is a separate product change.
- **Do not replace deterministic projection tests with snapshots.** Frame tests prove layout; reducer and presenter tests continue to prove rules and identity.
- **Do not upgrade OpenTUI during the spike.** Core and Solid stay at `0.4.3`, with `solid-js@1.9.12`, so only the renderer approach changes.
- **Do not add a second test command.** Vitest remains the supported deterministic test runner. If Solid requires moving TUI tests to `bun:test`, the spike fails unless a small supported Vitest integration is available.
- **Do not keep a permanent half-migrated renderer by default.** A shell-only result needs enough measured value to justify its added dependency and build path.

## Implementation Slices

### 1. Record the Baseline and Isolate the Experiment

- **Result:** The experiment has fixed behavior, resource, and performance comparisons.
- **Changes:** Run the spike on a clean branch after the current broad TUI and test-harness work lands. Record current frame fixtures, relevant adapter test results, package size, package startup, mounted transcript counts, and allocations/identity available from existing tests.
- **Tests:** Select the current tests for resize, cursor/focus, selection, transcript windows, giant subagent rows, prepend/reflow anchors, streaming drift, and teardown. Do not rewrite their expected behavior during the spike.
- **Checks:**
  - `bun run test-unit -- packages/tui/test/opentui-adapter.test.ts`
  - `bun run test-scene -- apps/rika/test/transcript-streaming-drift.scene.test.ts apps/rika/test/responsive-terminal-layout.scene.test.ts`
  - `bun run package -- --target <current-platform>`
  - `bun run release-smoke`
- **Depends on:** Current uncommitted TUI and harness changes being settled so the comparison is stable.
- **Cleanup:** None.

### 2. Prove Tooling and Lifecycle Before Porting UI

- **Result:** One trivial Solid root works in source, Vitest, build, packaged binary, and scoped teardown.
- **Changes:**
  - Add catalog entries for `@opentui/solid@0.4.3` and `solid-js@1.9.12`.
  - Add package-scoped TSX settings: `jsx: "preserve"` and `jsxImportSource: "@opentui/solid"`.
  - Add the minimum supported preload/transform setup for Vitest and Bun builds.
  - Update both `@rika/tui` and `@rika/cli` build paths if workspace source TSX is compiled from either entrypoint.
  - Mount into the existing renderer so Effect still owns acquisition and release.
  - Verify that `renderer.destroy()` disposes the Solid owner and component cleanup exactly once.
- **Tests:** A lifecycle test mounts reactive text, updates it, destroys the renderer, and proves no later update, listener, timer, or cleanup survives. Run the existing terminal suspend/resume and release tests unchanged.
- **Checks:** Package typecheck, focused Vitest file, package build, current-platform package, and release smoke.
- **Depends on:** Slice 1.
- **Cleanup:** Remove the experiment immediately if Vitest needs a separate runner, TSX cannot use the normal build path, or packaged execution depends on runtime source transforms.

### 3. Port a Composition-Heavy Slice: Command Palette

- **Result:** The spike shows whether Solid improves ordinary component work.
- **Changes:** Under the single root, port the command palette, overlay editor, selected rows, narrow layout, and focus handoff. Continue to consume `ViewState.Model` and existing handlers. Do not move picker rules into signals.
- **Tests:** Preserve open/close, filtering, keyboard selection, mouse selection, resize, editor cursor, Escape, submit, and composer focus restoration. Add a component-level test only where it replaces direct private-renderable assertions with visible behavior.
- **Checks:** Focused palette adapter tests, `apps/rika/test/tui-pickers.test.ts`, command-palette scene tests, typecheck, and lint.
- **Depends on:** Slice 2.
- **Cleanup:** Compare old and new implementation size, mutable fields, refs, effects, and direct renderer calls. Delete the Solid palette if it merely moves equivalent code behind effects.

### 4. Probe the Hard Part: Transcript Reconciliation

- **Result:** The spike proves whether a full migration is technically and economically sound.
- **Changes:** Reuse the real transcript descriptor and row-window pipeline. Render bounded descriptors with keyed Solid control flow. Keep anchor/scroll behavior in an adapter controller. Preserve selected renderables across window changes or prove an equally correct replacement.
- **Tests:** The probe must cover:
  - 500 transcript entries while moving the mounted window;
  - a 300-child expanded subagent tree while keeping mounted rows bounded;
  - composer-only updates preserving transcript renderable identity;
  - streaming header/spinner updates without replacing unchanged bodies;
  - selection while the virtual window changes;
  - detached reading while content streams;
  - prepended history and Markdown-width reflow anchors;
  - follow-tail recovery and scrollbar feedback suppression;
  - renderer destruction while frame work is pending.
- **Checks:** Focused adapter tests, transcript stress driver, transcript streaming scene, and native renderer stats where stable enough to compare.
- **Depends on:** Slices 2 and 3.
- **Cleanup:** If keyed Solid rendering still needs the current reconciliation map plus equivalent effects and frame callbacks, stop the full migration and remove this probe.

### 5. Make the Go/No-Go Decision

- **Result:** The spike ends with one chosen path and no ambiguous dual renderer.
- **Changes:** Record measurements in this plan or a lasting tradeoff document only if the decision will matter again.
- **Tests:** Run the fixed baseline set and package checks against the spike.
- **Checks:** Use the gates below.
- **Depends on:** Slices 1–4.
- **Cleanup:** Delete rejected spike code. If approved, keep only the proven single-root foundation and migrated slice as the first production migration step.

## Go/No-Go Gates

Proceed with a full migration only if every gate passes:

1. Existing frames, cursor position, selection, focus, resize, scroll, and product-harness behavior remain unchanged.
2. Mounted transcript renderables remain within the current entry and row budgets.
3. Composer-only updates preserve transcript renderable identity and do not allocate replacement transcript nodes.
4. Detached reading, prepend anchors, reflow anchors, and followed-tail behavior match current tests.
5. Selection remains valid while transcript windows change.
6. Animation and delayed work use the injected OpenTUI clock or Effect time; no host polling or unowned timers are introduced.
7. Renderer destruction disposes the Solid owner and leaves no active listener, callback, timer, or fiber.
8. The palette implementation is clearly easier to locate and change, with fewer branches and mutable synchronization—not an equivalent set of refs and effects.
9. Vitest, `bun run build`, `bun run package`, and `bun run release-smoke` remain the one supported paths.
10. The transcript probe removes the hand-written reconciliation owner or makes it substantially smaller. JSX around the same controller is not enough.

Stop a full migration if any gate fails. Consider a shell-only migration only when gate 8 shows a large maintenance win and the retained imperative transcript has one clear owner with no duplicated tree or state.

## Production Migration if Approved

### 6. Establish the Single Solid Root

- **Result:** Production still exposes `create()` and `surface.update(model)`, but one Solid root owns visible composition.
- **Changes:** Land the tooling and lifecycle foundation. Keep the existing transcript and virtual sidebars as hosted custom renderables temporarily.
- **Tests:** Lifecycle, resize, input translation, frame, and `tuiApp` tests.
- **Checks:** Focused tests, `bun run check`, package, and release smoke.
- **Cleanup:** Remove duplicate imperative construction for any shell region now owned by Solid.

### 7. Move Shell, Composer, Queue, and Overlays

- **Result:** Top-level layout and common interaction regions have separate component ownership.
- **Changes:** Move the welcome view, queue, composer, status labels, palette, pickers, permission overlay, shortcuts, toast, and loading states. Keep reducer rules unchanged and use renderable refs only for editor mechanics.
- **Tests:** Migrate internal-heavy tests toward visible frames, input, focus, and cursor assertions while retaining regression coverage. Keep scene expectations stable.
- **Checks:** Unit and scene TUI suites, visual fixtures, typecheck, lint, and package smoke.
- **Depends on:** Slice 6.
- **Cleanup:** Delete the corresponding fields and update branches from the old `Surface`.

### 8. Move Sidebars

- **Result:** Thread and file sidebars are component-owned without losing bounded rendering or drag behavior.
- **Changes:** Port sidebar composition. Retain or replace `SidebarScrollBoxRenderable` only after virtual-height, hover, scroll, and resize behavior is proven.
- **Tests:** Narrow and wide layouts, 10,000-file behavior, hover, click, wheel, selection, thread preview, and drag resize.
- **Checks:** Sidebar adapter tests, responsive and thread-browser scenes, product harness, visual fixtures.
- **Depends on:** Slice 7.
- **Cleanup:** Remove the old sidebar tree and temporary hosting bridge.

### 9. Move the Transcript Only if Its Probe Passed

- **Result:** One transcript owner handles keyed rows, windowing, selection, anchors, and streaming.
- **Changes:** Promote the proven transcript approach. Keep pure presenter and viewport code unchanged. Keep imperative mechanics in one named controller if still required.
- **Tests:** Run the full transcript adapter, presenter, viewport, stress, scene, visual, and product-harness coverage unchanged before removing the old path.
- **Checks:** `bun run test`, `bun run check`, package all supported targets in CI, release smoke, then manual Pilotty/agent-tty acceptance.
- **Depends on:** Slice 8 and all transcript spike gates.
- **Cleanup:** Delete old reconciliation, renderable records, bridge components, private-state test casts, and obsolete visual capture support. Keep a small supported diagnostics surface for mounted counts and identity if tests still need it.

## Rollout and Recovery

- Ship vertical slices that preserve the existing `Surface` contract. Do not run two independently interactive roots.
- Keep frame fixtures and real-product tests fixed during each behavior-preserving slice. Update them only for an intentional, separately reviewed visual change.
- Each slice must be revertible without stored-data migration; the TUI owns no durable execution state.
- A regression in input, focus, selection, transcript position, lifecycle, packaging, or release smoke blocks the next slice.
- Manual acceptance is required before removing the old transcript path because core test input cannot prove emulator-specific behavior.

## Effort and Value

| Option                     |                      Estimated effort | Expected value                                    | Main risk                                                | Recommendation                 |
| -------------------------- | ------------------------------------: | ------------------------------------------------- | -------------------------------------------------------- | ------------------------------ |
| Keep current renderer      |                     0 migration weeks | No new dependency or build risk                   | `Surface.update` remains costly to change                | Acceptable now                 |
| Three-day spike            |                     2–3 engineer-days | Replaces assumptions with measured evidence       | Small throwaway cost                                     | Do this                        |
| Shell-only Solid migration |                    1–2 engineer-weeks | Better component ownership for common UI          | Permanent hybrid and build complexity                    | Only if measured gain is large |
| Full Solid migration       | 5–8 engineer-weeks plus stabilization | Consistent component model and easier composition | Transcript, selection, scroll, and packaging regressions | No-go until spike passes       |

The likely payoff is maintainability, not new user behavior or stronger testing. The migration is worth doing only if Rika expects sustained UI growth and the spike proves Solid removes a large part of the current synchronization code. If near-term work is mostly runtime, durability, tools, or transcript semantics, the opportunity cost is too high.

## Open Questions

- Can `@opentui/solid`'s Bun preload/transform work cleanly inside the current Vitest projects, or is custom Vite integration required? This gates slice 2.
- Does the current package flow compile workspace TSX from `@rika/tui` through the CLI build, requiring the Solid plugin in both package builds? This gates slice 2.
- Can Solid keyed control flow preserve a renderable that remains selected after it leaves the normal transcript window? This gates a full migration.
- Does OpenTUI `0.4.3` Solid update arbitrary `StyledText` children correctly under streaming, or is a later core/Solid version required? Test this without upgrading; any upgrade becomes a separate baseline change.
- Is a shell-only result valuable enough to carry Solid when the hardest transcript code remains imperative? Decide from measured code and test changes, not preference.

# Rika V1 Baseline

The Rika v1 repository was renamed from `/Users/dallen.pyrah/projects/rika` to `/Users/dallen.pyrah/projects/rika-old` without cleaning or modifying its worktree.

## Git Identity

- Commit: `809bc12129eb4741851db827dec62a49190fe006`
- Branch at rename: `main`
- Upstream at rename: `origin/main`
- Modified/untracked status entries at capture: `98`
- Tracked diff summary at capture: `87 files changed, 5324 insertions, 1343 deletions`

The dirty worktree is intentional reference state. It contains substantial TUI, streaming, model-routing, tool, actor, and test work beyond the commit.

## Visual Runtime

- OpenTUI: `@opentui/core@0.4.2`
- Diff renderer: `@pierre/diffs@1.2.11`
- Primary visual source: `rika-old/packages/tui/src/adapter.ts`
- Pure interaction source: `rika-old/packages/tui/src/view-state.ts`
- Keymap source: `rika-old/packages/tui/src/keymap.ts`
- Palette source: `rika-old/packages/tui/src/palette.ts`
- Renderer tests: `rika-old/packages/tui/test/adapter.test.ts`

## Deterministic Visual Capture

Rika v2 freezes native OpenTUI test-renderer captures in `packages/tui/test/fixtures/visual`. The suite covers welcome, prompt, streaming, collapsed and expanded reasoning, tool, diff, permission, mode picker, palette, sidebar, queued turn, child/workflow activity, image metadata, narrow layout, and restart replay.

Each scenario has a character frame and a portable PPM screenshot. The screenshot is a deterministic cell raster rather than host-font pixels: non-space cells use the recorded foreground and empty cells use the recorded background. This preserves layout regression coverage without operating-system font, antialiasing, GPU, or terminal-emulator flakes. `metadata.json` records dimensions, theme, Bun/OpenTUI native versions, masks, and exact comparison thresholds. Dynamic values are replaced with stable fixture values before rendering, so no masks are currently needed.

Run `bun run scripts/capture-tui-visuals.ts` to create a review candidate in a temporary directory. After reviewing both formats, run `bun run scripts/capture-tui-visuals.ts --approve` to deliberately replace the frozen baseline. `bun test packages/tui/test/visual.native.test.ts` captures with native OpenTUI and byte-compares every approved artifact. Baseline replacement is never implicit in a test run.

## Remaining V1 Capture Work

- Preserve a patch of tracked modifications as a reference artifact.
- Preserve the untracked-file manifest.
- Record startup, input-latency, scrolling, and long-thread memory measurements.

Rika v2 does not import from this repository. It is evidence and design reference only.

import { CliRenderEvents } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Data, Effect } from "effect"
import { Surface } from "../src/adapter"
import { initial, ready, update, type Model } from "../src/view-state"

class OpenTuiError extends Data.TaggedError("OpenTuiError")<{ readonly cause: unknown }> {}

const openTui = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new OpenTuiError({ cause }) })

const insertText = (model: Model, text: string) => update(model, { _tag: "Pasted", text })

const nonSpaceBounds = (frame: string, height: number) => {
  const points = frame
    .split("\n")
    .slice(0, height - 5)
    .flatMap((row, y) => Array.from(row, (cell, x) => ({ cell, x, y })))
    .filter(({ cell }) => cell !== " ")
  return {
    left: Math.min(...points.map(({ x }) => x)),
    right: Math.max(...points.map(({ x }) => x)),
    top: Math.min(...points.map(({ y }) => y)),
    bottom: Math.max(...points.map(({ y }) => y)),
  }
}

test("copies trimmed selected transcript text through OSC52", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const copied: Array<string> = []
      setup.renderer.copyToClipboardOSC52 = (text: string) => {
        copied.push(text)
        return true
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        setup.renderer.emit(CliRenderEvents.SELECTION, { getSelectedText: () => "selected transcript  \n" })
        expect(copied).toEqual(["selected transcript"])
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("loads the workspace file tree with Opt+T and keeps it separate from changed files", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 24 }))
      let model = update(initial("/work", "high"), {
        _tag: "FilesReplaced",
        files: ["apps/rika/src/main.ts", "packages/tui/src/adapter.ts", "README.md"],
      })
      model = update(model, {
        _tag: "ChangedFilesReplaced",
        files: [{ path: "packages/tui/src/adapter.ts", status: "M", added: 4, removed: 1 }],
      })
      const surface = new Surface(setup.renderer, {
        key: (key) => {
          model = update(model, { _tag: "KeyPressed", key })
          surface.update(model)
        },
        resize: () => undefined,
      })
      try {
        surface.update(model)
        setup.mockInput.pressKey("t", { meta: true })
        yield* openTui(() => setup.flush())
        expect((model as Model & { readonly workspaceFilesOpen: boolean }).workspaceFilesOpen).toBe(true)
        expect(model.changedFilesOpen).toBe(false)
        const workspaceFrame = setup.captureCharFrame()
        expect(workspaceFrame).toContain("Files (3)")
        expect(workspaceFrame).toContain("apps/")
        expect(workspaceFrame).toContain("README.md")

        setup.mockInput.pressKey("s", { meta: true })
        yield* openTui(() => setup.flush())
        expect((model as Model & { readonly workspaceFilesOpen: boolean }).workspaceFilesOpen).toBe(false)
        expect(model.changedFilesOpen).toBe(true)
        const changedFrame = setup.captureCharFrame()
        expect(changedFrame).toContain("Changed files (1)")
        expect(changedFrame).toContain("adapter.ts +4 -1")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("renders and scrolls nested changed files within the bordered sidebar", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 24 }))
      const opened: Array<string> = []
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        openPath: ({ path }) => opened.push(path),
        resize: () => undefined,
      })
      const changedFiles = Array.from({ length: 30 }, (_, index) => ({
        path: `apps/rika/src/features/feature-${String(index).padStart(2, "0")}.ts`,
        status: "M",
        added: index + 1,
        removed: index,
      }))
      try {
        surface.update({
          ...initial("/work", "high"),
          width: 100,
          height: 24,
          entries: [{ role: "assistant", text: "answer" }],
          changedFilesOpen: true,
          changedFiles: ready(changedFiles),
        })
        yield* openTui(() => setup.renderOnce())
        yield* Effect.sleep("0 millis")
        yield* openTui(() => setup.renderOnce())
        const initialFrame = setup.captureCharFrame()
        expect(initialFrame).toContain("Changed files (30)")
        expect(initialFrame).toContain("apps/")
        expect(initialFrame).toContain("  rika/")
        expect(initialFrame).toContain("feature-00.ts")
        expect(initialFrame).not.toContain("feature-29.ts")
        yield* openTui(() => setup.mockMouse.click(72, 5))
        expect(opened).toEqual(["apps/rika/src/features/feature-00.ts"])
        surface.changedFilesBox.scrollTo(surface.changedFilesBox.scrollHeight - surface.changedFilesBox.viewport.height)
        yield* openTui(() => setup.renderOnce())
        const scrolledFrame = setup.captureCharFrame()
        expect(scrolledFrame).toContain("feature-29.t +30 -29")
        expect(scrolledFrame.split("\n")[0]?.slice(66).startsWith("╭")).toBe(true)
        expect(scrolledFrame.split("\n")[23]?.slice(66).startsWith("╰")).toBe(true)
        expect(scrolledFrame.split("\n")[23]?.slice(0, 66).startsWith("╰")).toBe(true)
        yield* openTui(() => setup.mockMouse.click(72, 22))
        expect(opened).toEqual(["apps/rika/src/features/feature-00.ts", "apps/rika/src/features/feature-29.ts"])
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("refreshes the changed-files virtual window after resize layout completes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 120, height: 35 }))
      let model: Model = {
        ...initial("/work", "high"),
        width: 120,
        height: 35,
        entries: [{ role: "assistant", text: "answer" }],
        changedFilesOpen: true,
        changedFiles: ready(
          Array.from({ length: 50 }, (_, index) => ({
            path: `file-${String(index).padStart(3, "0")}.ts`,
            status: "M",
            added: 1,
            removed: 0,
          })),
        ),
      }
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: (width, height) => {
          model = { ...model, width, height }
          surface.update(model)
        },
      })
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        expect(setup.captureCharFrame()).not.toContain("file-041.ts")

        setup.renderer.resize(140, 45)
        yield* openTui(() => setup.flush())

        const frame = setup.captureCharFrame()
        expect(frame).toContain("file-041.ts")
        expect(frame.split("\n").slice(0, -1)).toHaveLength(45)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps click rows stable after a clipped wide-character filename", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 24 }))
      const opened: Array<string> = []
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        openPath: ({ path }) => opened.push(path),
        resize: () => undefined,
      })
      try {
        surface.update({
          ...initial("/work", "high"),
          width: 100,
          height: 24,
          changedFilesOpen: true,
          changedFiles: ready([
            { path: "a/非常非常非常非常非常非常长的文件名.ts", status: "M", added: 1, removed: 1 },
            { path: "b/after.ts", status: "M", added: 2, removed: 0 },
          ]),
        })
        yield* openTui(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        expect(frame).toContain("+1 -1")
        expect(frame).toContain("after.ts +2 -0")
        yield* openTui(() => setup.mockMouse.moveTo(72, 4))
        yield* openTui(() => setup.renderOnce())
        expect(
          setup
            .captureSpans()
            .lines.flatMap((line) => line.spans)
            .some((span) => span.text.includes("after.ts") && (span.attributes & 8) === 8),
        ).toBe(true)
        yield* openTui(() => setup.mockMouse.click(72, 4))
        expect(opened).toEqual(["b/after.ts"])
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("escapes control characters without shifting changed-file click rows", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 24 }))
      const opened: Array<string> = []
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        openPath: ({ path }) => opened.push(path),
        resize: () => undefined,
      })
      try {
        surface.update({
          ...initial("/work", "high"),
          width: 100,
          height: 24,
          changedFilesOpen: true,
          changedFiles: ready([
            { path: "a-bad\n\tname.ts", status: "M", added: 1, removed: 1 },
            { path: "z-after.ts", status: "M", added: 2, removed: 0 },
          ]),
        })
        yield* openTui(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        expect(frame).toContain("a-bad\\n\\tname.ts +1 -1")
        expect(frame).toContain("z-after.ts +2 -0")
        yield* openTui(() => setup.mockMouse.click(72, 2))
        expect(opened).toEqual(["z-after.ts"])
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps the mode label and picker grouped with the narrowed composer", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 24 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update({
          ...initial("/work", "high"),
          width: 100,
          height: 24,
          costUsd: 0.004,
          changedFilesOpen: true,
          changedFiles: ready([{ path: "src/main.ts", status: "M", added: 2, removed: 1 }]),
          modePicker: { open: true, selected: 2 },
        })
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).toContain(" $0.004 ─ high ")
        const composerRight = surface.inputBox.x + surface.inputBox.width
        expect(surface.modeLabel.x + surface.modeLabel.width).toBeLessThanOrEqual(composerRight)
        expect(surface.paletteBox.x + surface.paletteBox.width).toBeLessThanOrEqual(composerRight)
        expect(surface.paletteBox.x + surface.paletteBox.width).toBeLessThanOrEqual(surface.changedFilesBox.x)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

for (const width of [80, 50] as const) {
  test(`renders a visible error action and leaves the composer usable at width ${width}`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* openTui(() => createTestRenderer({ width, height: 20 }))
        let model: Model = { ...initial("/work", "high"), width, height: 20 }
        model = update(model, { _tag: "ExecutionFailed", message: "The model is unavailable." })
        const surface = new Surface(setup.renderer, {
          key: (key) => {
            model = update(model, { _tag: "KeyPressed", key })
            if (key.name === "return" && !key.shift) model = update(model, { _tag: "Submitted" })
            surface.update(model)
          },
          resize: () => undefined,
        })
        try {
          surface.update(model)
          yield* openTui(() => setup.renderOnce())
          const failed = setup.captureCharFrame()
          expect(failed).toContain("ERROR: Execution failed")
          expect(failed.replaceAll(/\s+/g, " ")).toContain("Next: Edit your prompt and press Enter to try again.")
          expect(
            setup
              .captureSpans()
              .lines.flatMap((line) => line.spans)
              .some(
                (span) => span.text.includes("ERROR: Execution failed") && span.fg.toInts().join(",") === "128,0,0,255",
              ),
          ).toBe(true)
          yield* openTui(() => setup.mockInput.typeText("retry"))
          setup.mockInput.pressEnter()
          expect(model.busy).toBe(true)
          model = update(model, { _tag: "TurnStarted", turnId: "turn-retry", prompt: "retry" })
          surface.update(model)
          yield* openTui(() => setup.renderOnce())
          expect(model.entries.at(-1)).toEqual({ role: "user", text: "retry", turnId: "turn-retry" })
          expect(setup.captureCharFrame()).toContain("┃ retry")
        } finally {
          surface.destroy()
          setup.renderer.destroy()
        }
      }),
    ))
}

test("routes ctrl+v to injected image paste and inserts its attachment path", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      let model = initial("/work", "high")
      let calls = 0
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        pasteImage: () => {
          calls += 1
          model = insertText(model, "[.rika/pasted/paste-1.png]")
          surface.update(model)
        },
        resize: () => undefined,
      })
      try {
        surface.update(model)
        setup.mockInput.pressKey("v", { ctrl: true })
        expect(calls).toBe(1)
        expect(model.input).toBe("[.rika/pasted/paste-1.png]")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

for (const [width, height] of [
  [100, 30],
  [80, 24],
  [60, 20],
] as const) {
  test(`keeps the animated welcome centered above the bottom composer at ${width}x${height}`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* openTui(() => createTestRenderer({ width, height }))
        const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
        try {
          const state = { ...initial("/workspace", "high"), width, height }
          const capturePhases = Effect.fn("capturePhases")(function* (
            remaining: number,
          ): Effect.fn.Return<ReadonlyArray<ReturnType<typeof nonSpaceBounds>>, OpenTuiError> {
            if (remaining === 0) return []
            surface.update(state)
            yield* openTui(() => setup.renderOnce())
            const frame = setup.captureCharFrame()
            expect(frame).toContain("Welcome to Rika")
            expect(frame).not.toMatch(/Threads|Local durable coding agent|▏/)
            expect(frame.split("\n")[height - 5]?.startsWith("╭")).toBe(true)
            expect(frame.split("\n")[height - 1]?.startsWith("╰")).toBe(true)
            return [nonSpaceBounds(frame, height), ...(yield* capturePhases(remaining - 1))]
          })
          const phases = yield* capturePhases(10)
          expect(phases.every(({ left, right }) => left >= 0 && right < width)).toBe(true)
          expect(new Set(phases.map(({ top, bottom }) => `${top}:${bottom}`)).size).toBeLessThanOrEqual(2)
          const coloredMark = setup
            .captureSpans()
            .lines.flatMap((line) => line.spans)
            .some((span) => /[•●·]/u.test(span.text) && span.fg.toInts().join(",") === "61,212,255,255")
          expect(coloredMark).toBe(true)
        } finally {
          surface.destroy()
          setup.renderer.destroy()
        }
      }),
    ))
}

for (const height of [13, 16, 19] as const) {
  test(`keeps essential compact welcome copy visible at 60x${height}`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* openTui(() => createTestRenderer({ width: 60, height }))
        const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
        try {
          surface.update({ ...initial("/workspace", "high"), width: 60, height })
          yield* openTui(() => setup.renderOnce())
          const frame = setup.captureCharFrame()
          expect(frame).toContain("Welcome to Rika")
          expect(frame).toContain("ctrl+o commands")
          expect(frame).toContain("? help")
          expect(frame.split("\n")[height - 5]?.startsWith("╭")).toBe(true)
        } finally {
          surface.destroy()
          setup.renderer.destroy()
        }
      }),
    ))
}

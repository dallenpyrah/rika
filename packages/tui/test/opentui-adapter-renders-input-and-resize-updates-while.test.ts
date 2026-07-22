import { CliRenderEvents, Renderable, RendererControlState } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Data, Effect } from "effect"
import stringWidth from "string-width"
import { Surface, maxMountedTranscriptEntries, maxMountedTranscriptRows } from "../src/adapter"
import { initial, ready, update, type Model } from "../src/view-state"

class OpenTuiError extends Data.TaggedError("OpenTuiError")<{ readonly cause: unknown }> {}

const openTui = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new OpenTuiError({ cause }) })

const giantSubagentModel = (childCount: number): Model => {
  const rootBlock = {
    _tag: "ToolCall" as const,
    id: "root-tool",
    name: "task",
    input: "{}",
    status: "complete" as const,
    presentation: {
      family: "agent" as const,
      action: "task",
      activeLabel: "Subagent working",
      completeLabel: "Subagent finished",
    },
    detail: "delegated task",
    files: [],
  }
  const childBlocks = Array.from({ length: childCount }, (_, index) => ({
    _tag: "ToolCall" as const,
    id: `child-${index}`,
    name: "bash",
    input: "{}",
    status: "complete" as const,
    presentation: {
      family: "shell" as const,
      action: "shell",
      activeLabel: "Running",
      completeLabel: "Ran",
    },
    detail: `cmd-${index}`,
    files: [],
  }))
  const blocks = [rootBlock, ...childBlocks]
  const items = blocks.map((block, index) => ({
    _tag: "Block" as const,
    index,
    id: `block-${block.id}`,
    turnId: "turn-1",
    ...(index === 0 ? {} : { parentId: "root-tool" }),
  }))
  return {
    ...initial("/work", "high"),
    blocks,
    items,
    expandedRowKeys: ["tool:root-tool"],
    scrollFollow: false,
  }
}

test("renders input and resize updates while the renderer remains event-driven", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      let model: Model = {
        ...initial("/work", "high"),
        entries: [{ role: "assistant", text: "settled response" }],
      }
      const surface = new Surface(setup.renderer, {
        key: (key) => {
          model = update(model, { _tag: "KeyPressed", key })
          surface.update(model)
        },
        resize: (width, height) => {
          model = update(model, { _tag: "Resized", width, height })
          surface.update(model)
        },
      })
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).toContain("settled response")
        expect(setup.renderer.controlState).toBe(RendererControlState.IDLE)
        expect(setup.renderer.isRunning).toBe(false)
        yield* openTui(() => setup.mockInput.typeText("next"))
        yield* openTui(() => setup.flush())
        expect(setup.captureCharFrame()).toContain("next")
        expect(setup.renderer.isRunning).toBe(false)
        setup.renderer.resize(60, 18)
        yield* openTui(() => setup.flush())
        expect(model.width).toBe(60)
        expect(model.height).toBe(18)
        expect(setup.renderer.isRunning).toBe(false)
        setup.renderer.suspend()
        setup.renderer.resume()
        yield* openTui(() => setup.flush())
        expect(setup.captureCharFrame()).toContain("next")
        expect(setup.renderer.controlState).toBe(RendererControlState.IDLE)
        expect(setup.renderer.isRunning).toBe(false)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps the submitted transcript echo stable when typing resumes before TurnStarted", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      let model: Model = { ...initial("/work", "high"), width: 80, height: 24 }
      let submittedPrompt: string | undefined
      const surface = new Surface(setup.renderer, {
        key: (key) => {
          const submitting = key.name === "return" && !key.shift && model.input.length > 0
          if (submitting) submittedPrompt = model.input
          model = update(model, { _tag: "KeyPressed", key })
          if (submitting) model = update(model, { _tag: "Submitted" })
          surface.update(model)
        },
        resize: () => undefined,
      })
      try {
        surface.update(model)
        yield* openTui(() => setup.mockInput.typeText("Explore in depth"))
        setup.mockInput.pressEnter()
        yield* openTui(() => setup.mockInput.typeText("ExE"))
        expect(submittedPrompt).toBe("Explore in depth")
        expect(model.input).toBe("ExE")
        model = update(model, { _tag: "TurnStarted", turnId: "turn-explore", prompt: submittedPrompt! })
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        expect(model.entries.at(-1)).toEqual({
          role: "user",
          text: "Explore in depth",
          turnId: "turn-explore",
        })
        const frame = setup.captureCharFrame()
        expect(frame).toContain("┃ Explore in depth")
        expect(frame).not.toContain("ExEExplore")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("coalesces a resize storm into one transcript reflow at the final width", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 200, height: 66, clock }))
      const resizeCalls: Array<readonly [number, number]> = []
      let model: Model = {
        ...initial("/work", "high"),
        width: 200,
        height: 66,
        entries: [{ role: "assistant", text: "alpha ".repeat(25).trimEnd(), turnId: "turn-1" }],
      }
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: (width, height) => {
          resizeCalls.push([width, height])
          model = update(model, { _tag: "Resized", width, height })
          surface.update(model)
        },
      })
      try {
        surface.update(model)
        const transcript = surface as unknown as {
          readonly transcriptChildren: ReadonlyArray<{
            readonly content: { readonly chunks: ReadonlyArray<{ text: string }> }
          }>
        }
        const mounted = transcript.transcriptChildren[0]!
        const content = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(mounted), "content")!
        let contentWrites = 0
        Object.defineProperty(mounted, "content", {
          configurable: true,
          get: () => content.get!.call(mounted),
          set: (value: unknown) => {
            contentWrites += 1
            content.set!.call(mounted, value)
          },
        })
        const renderer = setup.renderer as unknown as { handleResize: (width: number, height: number) => void }
        const resizes = [
          [180, 60],
          [160, 50],
          [140, 42],
          [120, 36],
          [100, 30],
        ] as const
        for (const [index, [width, height]] of resizes.entries()) {
          renderer.handleResize(width, height)
          if (index < resizes.length - 1) clock.advance(50)
        }
        expect(resizeCalls.length).toBe(0)
        expect(contentWrites).toBe(0)
        clock.advance(99)
        expect(resizeCalls.length).toBe(0)
        clock.advance(1)
        expect(resizeCalls).toEqual([[100, 30]])
        expect(contentWrites).toBe(1)
        expect(setup.renderer.terminalWidth).toBe(100)
        expect(setup.renderer.terminalHeight).toBe(30)
        const narrowed = transcript.transcriptChildren
          .map((child) => child.content.chunks.map((chunk) => chunk.text).join(""))
          .join("\n")
        expect(narrowed.split("\n").every((line) => stringWidth(line) <= 100)).toBe(true)
        expect(narrowed.match(/alpha/g)?.length).toBe(25)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("converges the model to the physical terminal size when a resize event reports a stale size", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      let model: Model = { ...initial("/work", "high"), width: 80, height: 24 }
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: (width, height) => {
          model = update(model, { _tag: "Resized", width, height })
          surface.update(model)
        },
      })
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        const renderer = setup.renderer as unknown as {
          _usesProcessStdout: boolean
          stdout: { columns: number; rows: number }
          resize: (width: number, height: number) => void
          emit: (event: string, ...args: ReadonlyArray<unknown>) => boolean
        }
        renderer._usesProcessStdout = true
        renderer.stdout = { columns: 132, rows: 43 }
        let corrected: readonly [number, number] | undefined
        renderer.resize = (width, height) => {
          corrected = [width, height]
        }
        renderer.emit(CliRenderEvents.RESIZE, 80, 24)
        expect(corrected).toEqual([132, 43])
        expect([model.width, model.height]).toEqual([132, 43])
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("uses OpenTUI's native cursor position with a blinking block style", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { animate: false })
      const base = { ...initial("/work", "high"), width: 100, height: 30, input: "draft", cursor: 5 }
      try {
        surface.update(base)
        yield* openTui(() => setup.flush())
        const composerCursor = setup.renderer.getCursorState()
        expect(composerCursor).toMatchObject({ visible: true, style: "block", blinking: true })

        surface.update({
          ...base,
          paletteOpen: true,
          palette: { open: true, query: "mode", selected: 0 },
        })
        yield* openTui(() => setup.flush())
        const paletteCursor = setup.renderer.getCursorState()
        expect(paletteCursor).toMatchObject({ visible: true, style: "block", blinking: true })
        expect(paletteCursor.y).not.toBe(composerCursor.y)

        surface.update({
          ...base,
          threadSwitcher: { ...base.threadSwitcher, open: true, query: "cursor" },
        })
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState()).toMatchObject({ visible: true, style: "block", blinking: true })

        surface.update({
          ...base,
          filePicker: { ...base.filePicker, open: true, query: "src", items: ready(["src/main.ts"]) },
        })
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState()).toMatchObject({ visible: true, style: "block", blinking: true })

        surface.update({ ...base, modePicker: { open: true, selected: 0 } })
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState().visible).toBe(false)

        surface.update({
          ...base,
          threadSidebar: { open: true, focused: true, selected: 0, scrollTop: 0 },
        })
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState().visible).toBe(false)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps the application-controlled cursor visible when animation is disabled", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { animate: false })
      const base = { ...initial("/work", "high"), width: 100, height: 30, input: "draft", cursor: 5 }
      try {
        surface.update(base)
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState().visible).toBe(true)

        surface.update({ ...base, input: "drafts", cursor: 6 })
        expect(setup.renderer.getCursorState().visible).toBe(true)

        const palette = {
          ...base,
          paletteOpen: true,
          palette: { open: true, query: "mode", selected: 0 },
        }
        surface.update(palette)
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState().visible).toBe(true)

        surface.update({ ...palette, palette: { ...palette.palette, query: "modes" } })
        expect(setup.renderer.getCursorState().visible).toBe(true)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

for (const historySize of [1, maxMountedTranscriptEntries + 1] as const) {
  test(`keeps composer updates bounded with ${historySize} transcript entries`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
        const entries = Array.from({ length: historySize }, (_, index) => ({
          role: "assistant" as const,
          text: `settled answer ${index}`,
          turnId: `turn-${index}`,
        }))
        const base: Model = { ...initial("/work", "high"), entries }
        const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
        try {
          surface.update(base)
          yield* openTui(() => setup.flush())
          const state = surface as unknown as { readonly transcriptChildren: ReadonlyArray<Renderable> }
          const mounted = [...state.transcriptChildren]
          for (let index = 0; index < 2; index += 1)
            surface.update({ ...base, input: `next ${index}`, cursor: `next ${index}`.length })

          expect(state.transcriptChildren.length).toBeLessThanOrEqual(maxMountedTranscriptEntries * 2)
          expect(state.transcriptChildren.every((child, index) => child === mounted[index])).toBe(true)
        } finally {
          surface.destroy()
          setup.renderer.destroy()
        }
      }),
    ))
}

test("moves the bounded transcript window to older mounted entries and keeps it while typing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 500 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }))
      const base: Model = { ...initial("/work", "high"), entries, items, scrollFollow: false }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(base)
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(0)
        const firstBefore = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])
        setup.mockInput.pressKey("\x1b[5~")
        yield* openTui(() => setup.flush())
        const firstAfter = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])
        const state = surface as unknown as {
          readonly transcriptWindowEnd: number
          readonly transcriptChildren: ReadonlyArray<Renderable>
        }
        expect(state.transcriptWindowEnd).toBe(400)
        expect(firstBefore).toBe(300)
        expect(firstAfter).toBeLessThan(300)
        expect(firstAfter).toBeGreaterThan(200)
        expect(state.transcriptChildren.length).toBeLessThanOrEqual(maxMountedTranscriptEntries * 2)
        surface.update({ ...base, input: "next", cursor: 4 })
        expect(state.transcriptWindowEnd).toBe(400)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps mounted renderables bounded inside one giant expanded subagent tree", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const model = giantSubagentModel(300)
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        const state = surface as unknown as { readonly transcriptChildren: ReadonlyArray<Renderable> }
        expect(state.transcriptChildren.length).toBeLessThanOrEqual(maxMountedTranscriptRows * 2)
        expect(state.transcriptChildren.length).toBeGreaterThan(0)
        const frame = setup.captureCharFrame()
        expect(frame).toContain("├ ✓ $ cmd-61")
        expect(frame).not.toContain("cmd-60 ")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("grows the row window backward inside a giant tree and keeps the reading position", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const model = giantSubagentModel(300)
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(0)
        yield* openTui(() => setup.flush())
        const firstBefore = Number(/cmd-(\d+)/.exec(setup.captureCharFrame())?.[1])
        setup.mockInput.pressKey("\x1b[5~")
        yield* openTui(() => setup.flush())
        const state = surface as unknown as {
          readonly transcriptRowWindow: { readonly end: number }
          readonly transcriptChildren: ReadonlyArray<Renderable>
        }
        const firstAfter = Number(/cmd-(\d+)/.exec(setup.captureCharFrame())?.[1])
        expect(state.transcriptRowWindow.end).toBeGreaterThan(0)
        expect(state.transcriptRowWindow.end).toBeLessThan(301)
        expect(firstAfter).toBeLessThan(firstBefore)
        expect(state.transcriptChildren.length).toBeLessThanOrEqual(maxMountedTranscriptRows * 2)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

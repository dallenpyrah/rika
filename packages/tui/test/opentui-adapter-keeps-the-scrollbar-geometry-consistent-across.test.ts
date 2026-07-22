import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Data, Effect } from "effect"
import { Surface } from "../src/adapter"
import { initial, update, type Model } from "../src/view-state"

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

test("keeps the scrollbar geometry consistent across backward row-window growth", () =>
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
        setup.mockInput.pressKey("\x1b[5~")
        yield* openTui(() => setup.flush())
        expect(surface.transcriptScrollbar.scrollSize).toBe(surface.transcriptScroll.scrollHeight)
        expect(surface.transcriptScrollbar.viewportSize).toBeGreaterThanOrEqual(1)
        expect(surface.transcriptScrollbar.scrollPosition).toBe(surface.transcriptScroll.scrollTop)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("detaches on the first upward wheel event and stays detached through streaming updates", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 80 }, (_, index) => ({
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
      let model: Model = { ...initial("/work", "high"), busy: true, entries, items }
      const surface = new Surface(
        setup.renderer,
        {
          key: () => undefined,
          resize: () => undefined,
          scroll: (offset) => {
            model = update(model, { _tag: "ScrollMoved", offset })
            surface.update(model)
          },
          scrollFollow: () => {
            model = update(model, { _tag: "ScrollFollowed" })
            surface.update(model)
          },
        },
        { clock },
      )
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        yield* openTui(() => setup.mockMouse.scroll(10, 5, "up", { delayMs: 0 }))
        expect(model.scrollFollow).toBe(false)
        const detachedTop = surface.transcriptScroll.scrollTop

        for (let index = 80; index < 90; index += 1) {
          model = {
            ...model,
            entries: [...model.entries, { role: "assistant", text: `answer ${index}`, turnId: `turn-${index}` }],
            items: [...model.items, { _tag: "Entry", index, id: `answer-${index}`, turnId: `turn-${index}` }],
          }
          surface.update(model)
          yield* openTui(() => setup.renderOnce())
          expect(model.scrollFollow).toBe(false)
          expect(surface.transcriptScroll.scrollTop).toBe(detachedTop)
        }

        surface.transcriptScroll.scrollTo(
          surface.transcriptScroll.scrollHeight - surface.transcriptScroll.viewport.height - 2,
        )
        yield* openTui(() => setup.mockMouse.scroll(10, 5, "down", { delayMs: 0 }))
        clock.advance(16)
        yield* openTui(() => setup.flush())
        expect(model.scrollFollow).toBe(false)

        surface.transcriptScroll.scrollTo(surface.transcriptScroll.scrollHeight)
        for (let index = 0; index < 20; index += 1)
          yield* openTui(() => setup.mockMouse.scroll(10, 5, "down", { delayMs: 0 }))
        clock.advance(16)
        yield* openTui(() => setup.flush())
        expect(model.scrollFollow).toBe(true)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("does not follow the tail while a forward transcript-window anchor is pending", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
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
      let model: Model = { ...initial("/work", "high"), entries, items }
      const surface = new Surface(
        setup.renderer,
        {
          key: () => undefined,
          resize: () => undefined,
          scroll: (offset) => {
            model = update(model, { _tag: "ScrollMoved", offset })
            surface.update(model)
          },
          scrollFollow: () => {
            model = update(model, { _tag: "ScrollFollowed" })
            surface.update(model)
          },
        },
        { clock },
      )
      const state = surface as unknown as {
        readonly transcriptWindowEnd: number
        readonly pendingTranscriptAnchor:
          | {
              readonly scrollBy: number
            }
          | undefined
      }
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())

        surface.transcriptScroll.scrollTo(0)
        setup.mockInput.pressKey("\x1b[5~")
        yield* openTui(() => setup.flush())
        expect(state.transcriptWindowEnd).toBe(400)

        surface.transcriptScroll.scrollTo(surface.transcriptScroll.scrollHeight)
        setup.renderer.requestRender()
        yield* openTui(() => setup.flush())
        expect(model.scrollFollow).toBe(false)
        const firstBefore = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])

        yield* openTui(() => setup.mockMouse.scroll(10, 5, "down", { delayMs: 0 }))
        clock.advance(16)
        expect(state.transcriptWindowEnd).toBe(500)
        expect(state.pendingTranscriptAnchor).toBeDefined()

        yield* openTui(() => setup.mockMouse.scroll(10, 5, "down", { delayMs: 0 }))
        const queuedDown = state.pendingTranscriptAnchor?.scrollBy ?? 0
        yield* openTui(() => setup.mockMouse.scroll(10, 5, "up", { delayMs: 0 }))
        expect(model.scrollFollow).toBe(false)
        expect(state.pendingTranscriptAnchor?.scrollBy).toBeLessThan(queuedDown)

        yield* openTui(() => setup.flush())
        const firstAfter = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])
        expect(model.scrollFollow).toBe(false)
        expect(firstAfter).toBeGreaterThan(firstBefore)
        expect(firstAfter).toBeLessThan(firstBefore + 10)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("coalesces rapid wheel offsets into one report per frame", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 400 }, (_, index) => ({
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
      let model: Model = { ...initial("/work", "high"), entries, items }
      const offsets = new Array<number>()
      const surface = new Surface(
        setup.renderer,
        {
          key: () => undefined,
          resize: () => undefined,
          scroll: (offset) => {
            offsets.push(offset)
            model = update(model, { _tag: "ScrollMoved", offset })
            surface.update(model)
          },
        },
        { clock },
      )
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        for (let index = 0; index < 20; index += 1)
          yield* openTui(() => setup.mockMouse.scroll(10, 5, "up", { delayMs: 0 }))

        expect(offsets).toHaveLength(1)
        clock.advance(15)
        expect(offsets).toHaveLength(1)
        clock.advance(1)
        expect(offsets).toHaveLength(2)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("moves the bounded transcript window forward by one measured page", () =>
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
        setup.mockInput.pressKey("\x1b[5~")
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(surface.transcriptScroll.scrollHeight)
        setup.renderer.requestRender()
        yield* openTui(() => setup.flush())
        const firstBefore = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])
        setup.mockInput.pressKey("\x1b[6~")
        yield* openTui(() => setup.flush())
        const firstAfter = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])
        const state = surface as unknown as {
          readonly transcriptWindowEnd: number
          readonly transcriptAnchorScrollBy: number
        }
        expect(state.transcriptWindowEnd).toBe(500)
        expect(firstAfter).toBeGreaterThan(firstBefore)
        expect(firstAfter).toBeLessThan(firstBefore + 50)
        expect(state.transcriptAnchorScrollBy).toBe(0)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("coalesces repeated page keys until the transcript anchor frame", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 600 }, (_, index) => ({
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
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      const state = surface as unknown as { readonly transcriptWindowEnd: number }
      try {
        surface.update({ ...initial("/work", "high"), entries, items, scrollFollow: false })
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(0)
        setup.mockInput.pressKey("\x1b[5~")
        setup.mockInput.pressKey("\x1b[5~")
        expect(state.transcriptWindowEnd).toBe(500)
        yield* openTui(() => setup.flush())
        const firstAfterRepeatedUp = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])
        expect(firstAfterRepeatedUp).toBeGreaterThan(300)
        expect(firstAfterRepeatedUp).toBeLessThan(400)

        surface.transcriptScroll.scrollTo(0)
        setup.mockInput.pressKey("\x1b[5~")
        yield* openTui(() => setup.flush())
        expect(state.transcriptWindowEnd).toBe(400)
        surface.transcriptScroll.scrollTo(surface.transcriptScroll.scrollHeight)
        setup.renderer.requestRender()
        yield* openTui(() => setup.flush())
        const firstBeforeRepeatedDown = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])
        setup.mockInput.pressKey("\x1b[6~")
        setup.mockInput.pressKey("\x1b[6~")
        expect(state.transcriptWindowEnd).toBe(500)
        yield* openTui(() => setup.flush())
        const firstAfterRepeatedDown = Number(/answer (\d+)/.exec(setup.captureCharFrame())?.[1])
        expect(firstAfterRepeatedDown).toBeGreaterThan(firstBeforeRepeatedDown)
        expect(firstAfterRepeatedDown).toBeLessThan(firstBeforeRepeatedDown + 50)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("preserves a pending prepend anchor through an intervening composer update", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 100 }, (_, index) => ({
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
        surface.transcriptScroll.scrollTo(40)
        const firstBefore = /answer (\d+)/.exec(setup.captureCharFrame())?.[1]
        const older = Array.from({ length: 50 }, (_, index) => ({
          role: "assistant" as const,
          text: `older ${index}`,
          turnId: `older-${index}`,
        }))
        const prepended: Model = {
          ...base,
          entries: [...older, ...entries],
          items: [
            ...older.map((_, index) => ({
              _tag: "Entry" as const,
              index,
              id: `older-${index}`,
              turnId: `older-${index}`,
            })),
            ...items.map((item) => Object.assign({}, item, { index: item.index + older.length })),
          ],
        }
        surface.update(prepended, true)
        surface.update({ ...prepended, input: "x", cursor: 1 })
        yield* openTui(() => setup.flush())
        expect(/answer (\d+)/.exec(setup.captureCharFrame())?.[1]).toBe(firstBefore)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

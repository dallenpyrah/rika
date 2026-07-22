import { Renderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Data, Effect } from "effect"
import { Surface } from "../src/adapter"
import { initial, ready, update, type Model } from "../src/view-state"

class OpenTuiError extends Data.TaggedError("OpenTuiError")<{ readonly cause: unknown }> {}

const openTui = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new OpenTuiError({ cause }) })

test("keeps the nearest transcript content in view when markdown reflows", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 200, height: 30 }))
      const entries = Array.from({ length: 80 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index} ${"word ".repeat(40)}`,
        turnId: `turn-${index}`,
      }))
      const items = entries.map((_, index) => ({
        _tag: "Entry" as const,
        index,
        id: `answer-${index}`,
        turnId: `turn-${index}`,
      }))
      let model: Model = {
        ...initial("/work", "high"),
        width: 200,
        height: 30,
        entries,
        items,
        scrollFollow: false,
      }
      const geometry = new Array<number>()
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: () => undefined,
        scrollGeometry: (offset) => geometry.push(offset),
      })
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(80)
        setup.renderer.requestRender()
        yield* openTui(() => setup.flush())
        model = { ...model, scrollOffset: surface.transcriptScroll.scrollTop }
        const before = /answer (\d+)/.exec(setup.captureCharFrame())?.[1]

        surface.update(update(model, { _tag: "Resized", width: 100, height: 30 }))
        yield* openTui(() => setup.flush())

        expect(/answer (\d+)/.exec(setup.captureCharFrame())?.[1]).toBe(before)
        expect(geometry.at(-1)).toBe(surface.transcriptScroll.scrollTop)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps a followed transcript pinned to the bottom after markdown reflows", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 200, height: 30 }))
      const entries = Array.from({ length: 80 }, (_, index) => ({
        role: "assistant" as const,
        text: `answer ${index} ${"word ".repeat(40)}`,
        turnId: `turn-${index}`,
      }))
      const model: Model = {
        ...initial("/work", "high"),
        width: 200,
        height: 30,
        entries,
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        surface.update(update(model, { _tag: "Resized", width: 100, height: 30 }))
        yield* openTui(() => setup.flush())

        expect(surface.transcriptScroll.scrollTop).toBeGreaterThanOrEqual(
          surface.transcriptScroll.scrollHeight - surface.transcriptScroll.viewport.height - 1,
        )
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("suppresses programmatic scrollbar feedback and queued work after teardown", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const offsets = new Array<number>()
      const entries = Array.from({ length: 300 }, (_, index) => ({
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
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: () => undefined,
        scroll: (offset) => offsets.push(offset),
      })
      try {
        surface.update({ ...initial("/work", "high"), entries, items, scrollFollow: false })
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(20)
        surface.transcriptScrollbar.scrollPosition = 10
        surface.destroy()
        yield* Effect.yieldNow
        expect(offsets).toEqual([])
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps a detached transcript window stable when live entries arrive", () =>
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
        const firstBefore = /answer (\d+)/.exec(setup.captureCharFrame())?.[1]
        surface.update({
          ...base,
          entries: [...entries, { role: "assistant", text: "answer 500", turnId: "turn-500" }],
          items: [...items, { _tag: "Entry", index: 500, id: "answer-500", turnId: "turn-500" }],
        })
        yield* openTui(() => setup.flush())
        expect(/answer (\d+)/.exec(setup.captureCharFrame())?.[1]).toBe(firstBefore)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("defers the scrollbar detach report instead of reporting inside onChange", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const scrolls = new Array<number>()
      const entries = Array.from({ length: 300 }, (_, index) => ({
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
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: () => undefined,
        scroll: (offset) => {
          scrolls.push(offset)
          model = update(model, { _tag: "ScrollMoved", offset })
          surface.update(model)
        },
        scrollFollow: () => {
          model = update(model, { _tag: "ScrollFollowed" })
          surface.update(model)
        },
      })
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        // A user drag away from the bottom fires the scrollbar onChange. The report
        // must be queued, not run synchronously inside onChange (no re-entrant update).
        surface.transcriptScrollbar.scrollPosition = 3
        expect(scrolls).toEqual([])
        yield* openTui(() => setup.flush())
        expect(scrolls.length).toBeGreaterThan(0)
        expect(model.scrollFollow).toBe(false)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("mounts entries appended below a detached transcript that fits the mount budget", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const entries = Array.from({ length: 40 }, (_, index) => ({
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
      const state = surface as unknown as { readonly transcriptWindowEnd: number }
      try {
        surface.update(base)
        yield* openTui(() => setup.flush())
        surface.transcriptScroll.scrollTo(0)
        setup.renderer.requestRender()
        yield* openTui(() => setup.flush())
        const firstBefore = /answer (\d+)/.exec(setup.captureCharFrame())?.[1]
        const heightBefore = surface.transcriptScroll.scrollHeight

        const grownEntries = [
          ...entries,
          ...Array.from({ length: 20 }, (_, index) => ({
            role: "assistant" as const,
            text: `answer ${40 + index}`,
            turnId: `turn-${40 + index}`,
          })),
        ]
        const grownItems = grownEntries.map((_, index) => ({
          _tag: "Entry" as const,
          index,
          id: `answer-${index}`,
          turnId: `turn-${index}`,
        }))
        surface.update({ ...base, entries: grownEntries, items: grownItems })
        yield* openTui(() => setup.flush())

        // The appended entries mount below the viewport: the window tracks the tail
        // and the content grows, while the detached reading position stays put.
        expect(state.transcriptWindowEnd).toBe(60)
        expect(surface.transcriptScroll.scrollHeight).toBeGreaterThan(heightBefore)
        expect(/answer (\d+)/.exec(setup.captureCharFrame())?.[1]).toBe(firstBefore)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("reports prepend anchor geometry without requesting another page", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const requested = new Array<number>()
      const geometry = new Array<number>()
      const entries = Array.from({ length: 200 }, (_, index) => ({
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
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: () => undefined,
        scroll: (offset) => requested.push(offset),
        scrollGeometry: (offset) => geometry.push(offset),
      })
      try {
        surface.update(base)
        yield* openTui(() => setup.flush())
        const older = Array.from({ length: 50 }, (_, index) => ({
          role: "assistant" as const,
          text: `older ${index}`,
          turnId: `older-${index}`,
        }))
        surface.update(
          {
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
          },
          true,
        )
        yield* openTui(() => setup.flush())
        expect(requested).toEqual([])
        expect(geometry).toHaveLength(1)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

for (const panel of ["changed", "workspace"] as const) {
  test(`keeps composer updates bounded with a large ${panel} files sidebar`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* openTui(() => createTestRenderer({ width: 120, height: 40 }))
        const paths = Array.from(
          { length: 10_000 },
          (_, index) => `src/feature-${Math.floor(index / 20)}/file-${index}.ts`,
        )
        const initialModel = initial("/work", "high")
        const base: Model = {
          ...initialModel,
          width: 120,
          height: 40,
          entries: [{ role: "assistant", text: "settled response" }],
          ...(panel === "changed"
            ? {
                changedFilesOpen: true,
                changedFiles: ready(paths.map((path) => ({ path, status: "M", added: 1, removed: 0 }))),
              }
            : {
                workspaceFilesOpen: true,
                filePicker: { ...initialModel.filePicker, items: ready(paths) },
              }),
        }
        const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
        try {
          surface.update(base)
          yield* openTui(() => setup.flush())
          const state = surface as unknown as {
            readonly changedRows: ReadonlyArray<unknown>
            readonly transcriptChildren: ReadonlyArray<Renderable>
          }
          const sidebarRows = state.changedRows
          expect(surface.changedFilesBox.scrollHeight).toBe(sidebarRows.length)
          expect(surface.changedFilesBox.content.height).toBeLessThanOrEqual(
            surface.changedFilesBox.viewport.height + 1,
          )
          const transcriptChildren = [...state.transcriptChildren]
          for (let index = 0; index < 20; index += 1)
            surface.update({ ...base, input: `next ${index}`, cursor: `next ${index}`.length })

          expect(state.changedRows).toBe(sidebarRows)
          expect(state.transcriptChildren.every((child, index) => child === transcriptChildren[index])).toBe(true)
        } finally {
          surface.destroy()
          setup.renderer.destroy()
        }
      }),
    ))
}

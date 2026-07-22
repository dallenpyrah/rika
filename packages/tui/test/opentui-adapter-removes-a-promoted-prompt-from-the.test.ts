import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Data, Effect } from "effect"
import { Surface } from "../src/adapter"
import { applyQueueDelta, initial, replaceQueue, resetQueue, update } from "../src/view-state"

class OpenTuiError extends Data.TaggedError("OpenTuiError")<{ readonly cause: unknown }> {}

const openTui = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new OpenTuiError({ cause }) })

test("removes a promoted prompt from the queue when it starts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const base = resetQueue(
        { ...initial("/work", "medium"), busy: true, width: 80, height: 24, currentThreadId: "t" },
        "t",
        1,
        [
          { id: "a", prompt: "alpha" },
          { id: "b", prompt: "beta" },
        ],
      )
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(base)
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).toContain("beta")
        const started = update(applyQueueDelta(base, "t", 2, { _tag: "Removed", turnId: "a" }).model, {
          _tag: "TurnStarted",
          turnId: "a",
          prompt: "alpha",
        })
        surface.update(started)
        yield* openTui(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        expect(frame).toContain("beta")
        expect(frame).not.toContain("queued 1/1")
        expect(frame).not.toContain("queued 2/2")
        expect(frame).toContain("alpha")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("clamps an oversized focused queued prompt to the queue box with an indicator", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 40, height: 12 }))
      const model = {
        ...replaceQueue({ ...initial("/work", "medium"), busy: true, width: 40, height: 12 }, [
          { id: "big", prompt: "x".repeat(400) },
        ]),
        queueSelection: "big",
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const text = (surface.queueText.content as unknown as { chunks: ReadonlyArray<{ text: string }> }).chunks
          .map((chunk) => chunk.text)
          .join("")
        expect(text).toContain("…")
        expect(text.length).toBeLessThan(40)
        const frame = setup.captureCharFrame()
        const row = frame.split("\n").find((candidate) => candidate.includes("Enter to steer"))
        expect(row).toContain("x")
        expect(row).not.toContain("Backspace to dequeue")
        expect(row).not.toContain("Ctrl+E to edit")
        expect(surface.queueBox.height).toBe(3)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("drops the inline queue hint before hiding message text in a very narrow terminal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 24, height: 12 }))
      const model = {
        ...replaceQueue({ ...initial("/work", "medium"), busy: true, width: 24, height: 12 }, [
          { id: "narrow", prompt: "message survives" },
        ]),
        queueSelection: "narrow",
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        expect(frame).toContain("message survives")
        expect(frame).not.toContain("Enter to steer")
        expect(frame).not.toContain("Backspace to dequeue")
        expect(frame).not.toContain("Ctrl+E to edit")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

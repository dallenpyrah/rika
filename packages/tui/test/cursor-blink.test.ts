import { assert, it } from "@effect/vitest"
import { Effect, Fiber, Ref } from "effect"
import { TestClock } from "effect/testing"
import { cursorBlink, cursorBlinkInterval } from "../src/cursor-blink"

it.effect("toggles the cursor every 600 milliseconds after an initial visible phase", () =>
  Effect.gen(function* () {
    const visible = yield* Ref.make(true)
    const fiber = yield* cursorBlink(Ref.update(visible, (current) => !current)).pipe(Effect.forkChild)

    yield* TestClock.adjust(cursorBlinkInterval - 1)
    assert.isTrue(yield* Ref.get(visible))

    yield* TestClock.adjust(1)
    assert.isFalse(yield* Ref.get(visible))

    yield* TestClock.adjust(cursorBlinkInterval)
    assert.isTrue(yield* Ref.get(visible))

    yield* Fiber.interrupt(fiber)
  }),
)

it.effect("stops toggling after interruption", () =>
  Effect.gen(function* () {
    const visible = yield* Ref.make(true)
    const fiber = yield* cursorBlink(Ref.update(visible, (current) => !current)).pipe(Effect.forkChild)

    yield* TestClock.adjust(cursorBlinkInterval)
    assert.isFalse(yield* Ref.get(visible))

    yield* Fiber.interrupt(fiber)
    yield* TestClock.adjust(cursorBlinkInterval)
    assert.isFalse(yield* Ref.get(visible))
  }),
)

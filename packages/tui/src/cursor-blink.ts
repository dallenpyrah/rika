import { Effect, Schedule } from "effect"

export const cursorBlinkInterval = 600

export const cursorBlink = (tick: Effect.Effect<void>) =>
  Effect.sleep(cursorBlinkInterval).pipe(
    Effect.andThen(tick.pipe(Effect.repeat(Schedule.spaced(cursorBlinkInterval)))),
    Effect.asVoid,
  )

import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Effect, FileSystem, Layer, Option, Schema } from "effect"

const JsonLine = Schema.UnknownFromJsonString

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const state = yield* Config.option(Config.string("RIKA_TEST_STUB_STATE"))
  if (Option.isNone(state)) return 64
  const previous = (yield* fs.exists(state.value))
    ? (yield* fs.readFileString(state.value)).split("\n").filter((line) => line.length > 0)
    : []
  const restarted = yield* Config.string("RIKA_INTERNAL_RUNTIME_RESTARTED").pipe(Config.withDefault(""))
  const thread = yield* Config.string("RIKA_INTERNAL_RESTART_THREAD").pipe(Config.withDefault(""))
  const entry = yield* Schema.encodeUnknownEffect(JsonLine)({ restarted, thread })
  yield* fs.writeFileString(state.value, `${entry}\n`, { flag: "a" })
  const mode = yield* Config.string("RIKA_TEST_STUB_MODE").pipe(Config.withDefault("restart-once"))
  const descriptor = yield* Config.string("RIKA_INTERNAL_RUNTIME_RESTART_FD").pipe(Config.withDefault("3"))
  const emitRestart = Effect.gen(function* () {
    const signal = yield* Schema.encodeUnknownEffect(JsonLine)({ _tag: "restart", threadId: "t-1" })
    yield* fs.writeFileString(`/dev/fd/${descriptor}`, `${signal}\n`)
  })
  if (mode === "always-restart") {
    yield* emitRestart
    return 75
  }
  if (mode === "restart-once" && previous.length === 0) {
    yield* emitRestart
    return 75
  }
  if (mode === "silent-75" && previous.length === 0) return 75
  return 0
})

process.exit(
  await Effect.runPromise(
    Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(program, context)))),
  ),
)

import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Clock, Config, Deferred, Effect, FileSystem, Layer, Logger, Path, Ref, Schema, Stdio, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { make } from "../../src/resident-client-transport"
import * as ResidentProcessStartup from "../../src/resident-process-startup"

import { internal as interactiveInternal } from "./resident-client-interactive"
import { internal as streamingInternal } from "./resident-client-streaming"
const { handleResidentCommand: handleInteractiveCommand } = interactiveInternal
const { handleResidentCommand: handleStreamingCommand } = streamingInternal
const JsonLine = Schema.UnknownFromJsonString
const HostStatus = Schema.fromJsonString(Schema.Struct({ hostPid: Schema.Finite }))

const program = Effect.gen(function* () {
  const dataRoot = yield* Config.string("RIKA_TEST_RESIDENT_DATA_ROOT")
  const grace = yield* Config.string("RIKA_TEST_RESIDENT_GRACE").pipe(Config.withDefault("500"))
  const finalizerDelay = yield* Config.string("RIKA_TEST_RESIDENT_FINALIZER_DELAY").pipe(Config.withDefault("0"))
  const delayedWork = yield* Config.string("RIKA_TEST_RESIDENT_DELAYED_WORK").pipe(Config.withDefault("0"))
  const startupHold = yield* Config.string("RIKA_TEST_RESIDENT_STARTUP_HOLD").pipe(Config.withDefault("0"))
  const outboundCapacity = yield* Config.string("RIKA_TEST_RESIDENT_OUTBOUND_CAPACITY").pipe(Config.withDefault("1024"))
  const stdio = yield* Stdio.Stdio
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const clock = yield* Clock.Clock
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const hostPid = yield* Ref.make(0)
  const emit = Effect.fn("ResidentClient.emit")(function* (value: unknown) {
    const encoded = yield* Schema.encodeUnknownEffect(JsonLine)(value)
    yield* Stream.make(`${encoded}\n`).pipe(Stream.run(stdio.stdout({ endOnDone: false })))
  }, Effect.orDie)
  const kill = Effect.fn("ResidentClient.kill")(
    function* (pid: number) {
      const killer = yield* spawner.spawn(ChildProcess.make("kill", ["-KILL", String(pid)]))
      yield* killer.exitCode
    },
    Effect.scoped,
    Effect.orDie,
  )
  const service = yield* make()
  const connected = yield* Effect.result(
    service.getOrCreate({
      profile: "default",
      dataRoot,
      clientKind: "run",
      graceMilliseconds: Number(grace),
      startHost: () =>
        ResidentProcessStartup.spawn({
          executable: "bun",
          arguments: ["test/fixtures/resident-host.ts"],
          cwd: path.dirname(path.dirname(import.meta.dir)),
          environment: {
            RIKA_TEST_RESIDENT_DATA_ROOT: dataRoot,
            RIKA_TEST_RESIDENT_GRACE: grace,
            RIKA_TEST_RESIDENT_FINALIZER_DELAY: finalizerDelay,
            RIKA_TEST_RESIDENT_DELAYED_WORK: delayedWork,
            RIKA_TEST_RESIDENT_STARTUP_HOLD: startupHold,
            RIKA_TEST_RESIDENT_OUTBOUND_CAPACITY: outboundCapacity,
          },
        }),
    }),
  )
  if (connected._tag === "Failure") {
    yield* emit({ type: "rejected", error: connected.failure.message })
    return
  }
  const connection = connected.success
  yield* Effect.addFinalizer(() => connection.close)
  yield* connection.run(
    { _tag: "Doctor" },
    {
      stdout: (text) =>
        Schema.decodeUnknownEffect(HostStatus)(text).pipe(
          Effect.flatMap((status) => Ref.set(hostPid, status.hostPid)),
          Effect.orDie,
        ),
    },
  )
  yield* emit({
    type: "attached",
    role: connection.role,
    id: connection.connectionId,
    clientPid: process.pid,
    hostPid: yield* Ref.get(hostPid),
  })
  const commands = stdio.stdin.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
  )
  const done = yield* Deferred.make<void>()
  yield* Effect.raceFirst(
    commands.pipe(
      Stream.runForEach((command) => {
        const workspace = path.dirname(path.dirname(import.meta.dir))
        const context = { connection, path, fs, dataRoot, emit, kill, hostPid, clock, done, workspace }
        return handleInteractiveCommand(command, context) ?? handleStreamingCommand(command, context) ?? Effect.void
      }),
    ),
    Deferred.await(done),
  )
})

let supersedeStatusCount = 0
const statusLogger = Logger.make(({ message }) => {
  if (!Array.isArray(message) || !message.some((value: unknown) => String(value) === "resident.startup.superseding"))
    return
  supersedeStatusCount += 1
  process.stdout.write(`${JSON.stringify({ type: "resident-status", callbacks: supersedeStatusCount })}\n`)
})
const MainLayer = Layer.mergeAll(BunServices.layer, Logger.layer([statusLogger]))

BunRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(MainLayer)
      yield* Effect.provide(program, context)
    }),
  ),
)

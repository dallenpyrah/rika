import * as ResidentService from "@rika/app/resident-service"
import { Config, Effect, FileSystem, Option, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const StartupMessage = Schema.Union([
  Schema.Struct({ _tag: Schema.tag("ready") }),
  Schema.Struct({ _tag: Schema.tag("failed"), message: Schema.String }),
])

const encode = Schema.encodeSync(Schema.UnknownFromJsonString)
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(StartupMessage))
const startupFdEnvironment = "RIKA_INTERNAL_RESIDENT_STARTUP_FD"
const startupFd = 3
let signalled = false
const closeDescriptor = (descriptor: number) =>
  Effect.sync(() => process.getBuiltinModule("node:fs").closeSync(descriptor))

const error = (reason: "startup-failed" | "transport-failed", cause: unknown) =>
  ResidentService.ResidentServiceError.make({ reason, message: String(cause) })

const signal = (message: typeof StartupMessage.Type) =>
  Effect.gen(function* () {
    const configured = yield* Config.option(Config.string(startupFdEnvironment))
    if (Option.isNone(configured) || signalled) return
    signalled = true
    const fs = yield* FileSystem.FileSystem
    const descriptor = Number(configured.value)
    yield* fs
      .writeFileString(`/dev/fd/${descriptor}`, `${encode(message)}\n`)
      .pipe(Effect.ensuring(closeDescriptor(descriptor)))
  }).pipe(Effect.mapError((cause) => error("startup-failed", `Could not report resident startup: ${String(cause)}`)))

export const signalReady = signal({ _tag: "ready" })
export const signalFailure = (message: string) => signal({ _tag: "failed", message })

const awaitStartup = <E>(output: Stream.Stream<Uint8Array, E>) =>
  Stream.runHead(Stream.splitLines(Stream.decodeText(output))).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(error("startup-failed", "Resident startup signal timed out")),
    }),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(error("startup-failed", "Resident startup signal ended without a message")),
        onSome: (text) => decode(text).pipe(Effect.mapError((cause) => error("startup-failed", cause))),
      }),
    ),
    Effect.flatMap((message) =>
      message._tag === "ready" ? Effect.void : Effect.fail(error("startup-failed", message.message)),
    ),
    Effect.mapError((cause) =>
      Schema.is(ResidentService.ResidentServiceError)(cause) ? cause : error("startup-failed", cause),
    ),
  )

export const spawn = Effect.fn("ResidentProcessStartup.spawn")(function* (options: {
  readonly executable: string
  readonly arguments: ReadonlyArray<string>
  readonly cwd?: string
  readonly environment: Readonly<Record<string, string | undefined>>
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(options.executable, options.arguments, {
        detached: true,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        additionalFds: { fd3: { type: "output" } },
        extendEnv: true,
        env: { ...options.environment, [startupFdEnvironment]: String(startupFd) },
      }),
    )
    .pipe(Effect.mapError((cause) => error("transport-failed", cause)))
  return {
    pid: Number(handle.pid),
    startup: awaitStartup(handle.getOutputFd(startupFd)),
    detach: handle.unref.pipe(
      Effect.asVoid,
      Effect.mapError((cause) => error("transport-failed", cause)),
    ),
    abort: handle
      .kill({ killSignal: "SIGKILL" })
      .pipe(Effect.andThen(handle.exitCode), Effect.timeout("2 seconds"), Effect.ignore),
  } satisfies ResidentService.StartedHost
})

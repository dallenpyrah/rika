import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export class ProcessTestError extends Schema.TaggedErrorClass<ProcessTestError>()("ProcessTestError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface Sandbox {
  readonly root: string
  readonly workspace: string
  readonly binary: string
  readonly env: Record<string, string | undefined>
  readonly dispose: Effect.Effect<void>
}

export interface ProcessResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const causeChain = (cause: unknown): string => {
  const parts: Array<string> = []
  let current: unknown = cause
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    parts.push(String(current))
    const detail = current as { readonly cause?: unknown; readonly description?: unknown; readonly syscall?: unknown }
    if (typeof detail.description === "string") parts.push(`description=${detail.description}`)
    if (typeof detail.syscall === "string") parts.push(`syscall=${detail.syscall}`)
    current = detail.cause
  }
  return [...new Set(parts)].join(" <- ")
}

const processFailure = (operation: string, cause: unknown) =>
  ProcessTestError.make({ operation, message: causeChain(cause) })

export const command = Effect.fn("E2eProcess.command")(function* (
  executable: string,
  args: ReadonlyArray<string>,
  options: ChildProcess.CommandOptions = {},
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.make(executable, args, options))
      return yield* handle.exitCode
    }),
  ).pipe(Effect.mapError((cause) => processFailure(`${executable} ${args.join(" ")}`, cause)))
})

export const sandbox: Effect.Effect<Sandbox, ProcessTestError, BunServices.BunServices> = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fileSystem
    .makeTempDirectory({ prefix: "rika-e2e-" })
    .pipe(Effect.mapError((cause) => processFailure("create sandbox", cause)))
  const home = path.join(root, "home")
  const workspace = path.join(root, "workspace")
  const state = path.join(root, "state")
  yield* Effect.forEach([home, workspace, state], (directory) =>
    fileSystem.makeDirectory(directory).pipe(Effect.mapError((cause) => processFailure("create sandbox", cause))),
  )
  const artifacts = path.resolve("artifacts")
  const binary = path.join(artifacts, "extracted", `rika-${process.platform}-${process.arch}`, "bin", "rika")
  const available = yield* fileSystem
    .exists(binary)
    .pipe(Effect.mapError((cause) => processFailure("find packaged artifact", cause)))
  if (!available)
    return yield* ProcessTestError.make({
      operation: "find packaged artifact",
      message: `Extracted packaged product for ${process.platform}-${process.arch} is missing; run the journey global setup`,
    })
  return {
    root,
    workspace,
    binary,
    env: {
      HOME: home,
      RIKA_DATABASE: path.join(state, "rika.db"),
      RIKA_RELAY_DATABASE: path.join(state, "relay.db"),
      RIKA_INTERNAL_RESIDENT_GRACE: "0",
      RIKA_TEST_MODEL_RESPONSE: "deterministic response",
    },
    dispose: fileSystem.remove(root, { recursive: true }).pipe(Effect.ignore),
  }
})

export const runCommand = Effect.fn("E2eProcess.runCommand")(function* (
  context: Sandbox,
  executable: string,
  args: ReadonlyArray<string>,
  options: {
    readonly input?: string
    readonly timeout?: number
    readonly env?: Record<string, string | undefined>
  } = {},
) {
  const encoder = new TextEncoder()
  const budget = options.timeout ?? 60_000
  let killedByTimeout = false
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(
        ChildProcess.make(executable, args, {
          cwd: context.workspace,
          env: { ...context.env, ...options.env },
          stdin: options.input === undefined ? "ignore" : Stream.make(encoder.encode(options.input)),
          stdout: "pipe",
          stderr: "pipe",
        }),
      )
      return yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: 3 },
      ).pipe(
        Effect.timeoutOrElse({
          duration: budget,
          orElse: () =>
            Effect.sync(() => {
              killedByTimeout = true
            }).pipe(
              Effect.andThen(handle.kill({ killSignal: "SIGKILL" })),
              Effect.ignore,
              Effect.andThen(
                Effect.fail(
                  ProcessTestError.make({
                    operation: `${executable} ${args.join(" ")}`,
                    message: `process exceeded ${budget}ms`,
                  }),
                ),
              ),
            ),
        }),
      )
    }),
  ).pipe(
    Effect.map(
      ([stdout, stderr, exitCode]): ProcessResult => ({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: Number(exitCode),
      }),
    ),
    Effect.mapError((cause) =>
      Schema.is(ProcessTestError)(cause)
        ? cause
        : killedByTimeout
          ? ProcessTestError.make({
              operation: `${executable} ${args.join(" ")}`,
              message: `process exceeded ${budget}ms and was killed`,
            })
          : processFailure(`${executable} ${args.join(" ")}`, cause),
    ),
  )
})

export const run = (
  context: Sandbox,
  args: ReadonlyArray<string>,
  options: { readonly input?: string; readonly timeout?: number } = {},
) => runCommand(context, context.binary, args, options)

export const runSignaled = Effect.fn("E2eProcess.runSignaled")(function* (
  context: Sandbox,
  args: ReadonlyArray<string>,
  signal: ChildProcess.Signal,
  delay = 300,
  timeout = 5_000,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(
        ChildProcess.make(context.binary, args, {
          cwd: context.workspace,
          env: { ...context.env, TERM: "xterm-256color" },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      yield* Effect.sleep(delay)
      yield* handle.kill({ killSignal: signal }).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            handle
              .kill({ killSignal: "SIGKILL" })
              .pipe(
                Effect.ignore,
                Effect.andThen(
                  Effect.fail(
                    ProcessTestError.make({ operation: "signal packaged process", message: "process did not exit" }),
                  ),
                ),
              ),
        }),
      )
    }),
  ).pipe(
    Effect.mapError((cause) =>
      Schema.is(ProcessTestError)(cause) ? cause : processFailure("signal packaged process", cause),
    ),
  )
})

export const runTest = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer), Effect.scoped))

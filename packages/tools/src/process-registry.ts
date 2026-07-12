import { Context, Deferred, Effect, Layer, Option, Ref, Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export interface Output {
  readonly processId: string
  readonly stdout: string
  readonly stderr: string
  readonly running: boolean
  readonly exitCode?: number
  readonly truncated: boolean
}

interface Entry {
  readonly process: ChildProcessSpawner.ChildProcessHandle
  readonly stdout: Ref.Ref<string>
  readonly stderr: Ref.Ref<string>
  readonly exit: Deferred.Deferred<number>
}

export class ProcessNotFound extends Error {
  readonly _tag = "ProcessNotFound"
}

export interface Interface {
  readonly start: (command: string, args: ReadonlyArray<string>, cwd: string) => Effect.Effect<string, unknown>
  readonly poll: (processId: string, waitMillis: number, outputLimit: number) => Effect.Effect<Output, ProcessNotFound>
}

export class Service extends Context.Service<Service, Interface>()("@rika/tools/ProcessRegistry") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const entries = yield* Ref.make(new Map<string, Entry>())
    let nextId = 1
    yield* Effect.addFinalizer(() =>
      Ref.get(entries).pipe(
        Effect.flatMap((current) =>
          Effect.forEach(current.values(), (entry) => entry.process.kill(), { discard: true }),
        ),
        Effect.ignore,
      ),
    )
    const append = (ref: Ref.Ref<string>, bytes: Uint8Array) =>
      Ref.update(ref, (value) => value + new TextDecoder().decode(bytes))
    return Service.of({
      start: Effect.fn("ProcessRegistry.start")(function* (command, args, cwd) {
        const process = yield* spawner
          .spawn(ChildProcess.make(command, args, { cwd }))
          .pipe(Effect.provideService(Scope.Scope, scope))
        const stdout = yield* Ref.make("")
        const stderr = yield* Ref.make("")
        const exit = yield* Deferred.make<number>()
        const processId = String(nextId++)
        yield* Ref.update(entries, (current) => new Map(current).set(processId, { process, stdout, stderr, exit }))
        yield* Effect.forkIn(
          Stream.runForEach(process.stdout, (bytes) => append(stdout, bytes)),
          scope,
        )
        yield* Effect.forkIn(
          Stream.runForEach(process.stderr, (bytes) => append(stderr, bytes)),
          scope,
        )
        yield* Effect.forkIn(
          process.exitCode.pipe(Effect.flatMap((code) => Deferred.succeed(exit, Number(code)))),
          scope,
        )
        return processId
      }),
      poll: Effect.fn("ProcessRegistry.poll")(function* (processId, waitMillis, outputLimit) {
        const entry = (yield* Ref.get(entries)).get(processId)
        if (entry === undefined) return yield* Effect.fail(new ProcessNotFound(`Unknown process id: ${processId}`))
        if (waitMillis > 0)
          yield* Deferred.await(entry.exit).pipe(Effect.timeout(`${waitMillis} millis`), Effect.ignore)
        const pendingExit = yield* Deferred.poll(entry.exit)
        const exit = Option.isSome(pendingExit) ? Option.some(yield* pendingExit.value) : Option.none<number>()
        const stdout = yield* Ref.getAndSet(entry.stdout, "")
        const stderr = yield* Ref.getAndSet(entry.stderr, "")
        const combinedLength = stdout.length + stderr.length
        const stdoutBounded = stdout.slice(0, outputLimit)
        const stderrBounded = stderr.slice(0, Math.max(0, outputLimit - stdoutBounded.length))
        return {
          processId,
          stdout: stdoutBounded,
          stderr: stderrBounded,
          running: Option.isNone(exit),
          ...(Option.isSome(exit) ? { exitCode: exit.value } : {}),
          truncated: combinedLength > outputLimit,
        }
      }),
    })
  }),
)

export const testLayer = (implementation: Interface) => Layer.succeed(Service, Service.of(implementation))

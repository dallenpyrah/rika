import * as ResidentService from "@rika/app/resident-service"
import * as Operation from "@rika/app/operation-contract"
import { Clock, Deferred, Effect, Fiber, FiberSet, Ref, Scope } from "effect"
import { json } from "../resident-wire"

const drainingFailureFrame = (requestId: string, operation: string) =>
  json({
    _tag: "operation-failed",
    requestId,
    error: Operation.OperationUnavailable.make({ operation, message: "Resident service is draining" }),
  } satisfies ResidentService.ServerMessage)

export const internal = { drainingFailureFrame }

export const makeGraceScheduler =
  (options: {
    readonly lifecycle: Effect.Success<ReturnType<typeof ResidentService.makeLifecycle>>
    readonly stopped: Deferred.Deferred<void>
    readonly graceMilliseconds: number
    readonly hostScope: Scope.Scope
    readonly graceFiber: Ref.Ref<Fiber.Fiber<void> | undefined>
    readonly coldCohortUntil: Ref.Ref<number>
  }) =>
  (generation: number, delay = options.graceMilliseconds) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const cohortUntil = yield* Ref.get(options.coldCohortUntil)
      const effectiveDelay = Math.max(delay, cohortUntil - now)
      const fiber = yield* Effect.forkIn(
        Effect.sleep(effectiveDelay).pipe(
          Effect.andThen(options.lifecycle.expireGrace(generation)),
          Effect.flatMap((draining) => (draining ? Deferred.succeed(options.stopped, undefined) : Effect.void)),
          Effect.asVoid,
        ),
        options.hostScope,
      )
      yield* Ref.set(options.graceFiber, fiber)
    })

export const addShutdownFinalizer = Effect.fn("ResidentTransport.addShutdownFinalizer")(function* (options: {
  readonly lifecycle: Effect.Success<ReturnType<typeof ResidentService.makeLifecycle>>
  readonly hostWork: FiberSet.FiberSet<void, unknown>
  readonly ownerScope: Scope.Scope
  readonly serverScope: Scope.Scope
  readonly activeConnections: Ref.Ref<Map<string, Effect.Effect<void>>>
  readonly ownerDrainMilliseconds: number
}) {
  const hardExit = (reason: string) =>
    Effect.logError("resident.shutdown.hard_exit").pipe(
      Effect.annotateLogs("rika.resident.shutdown.reason", reason),
      Effect.andThen(Effect.sync(() => process.exit(typeof process.exitCode === "number" ? process.exitCode : 143))),
      Effect.asVoid,
    )
  yield* Effect.addFinalizer((exit) =>
    options.lifecycle.beginDrain.pipe(
      Effect.andThen(FiberSet.clear(options.hostWork)),
      Effect.andThen(
        Effect.raceFirst(
          FiberSet.awaitEmpty(options.hostWork).pipe(Effect.andThen(Scope.close(options.ownerScope, exit))),
          Effect.sleep(options.ownerDrainMilliseconds).pipe(
            Effect.andThen(hardExit(`owner drain exceeded ${options.ownerDrainMilliseconds}ms`)),
          ),
        ),
      ),
      Effect.andThen(
        Ref.get(options.activeConnections).pipe(
          Effect.flatMap((connections) =>
            Effect.forEach(
              connections.values(),
              (close) =>
                close.pipe(
                  Effect.timeoutOrElse({
                    duration: "250 millis",
                    orElse: () => Effect.logWarning("resident.shutdown.connection_close.timeout").pipe(Effect.asVoid),
                  }),
                ),
              { concurrency: "unbounded", discard: true },
            ),
          ),
        ),
      ),
      Effect.andThen(
        Scope.close(options.serverScope, exit).pipe(
          Effect.timeoutOrElse({
            duration: "500 millis",
            orElse: () => Effect.logWarning("resident.shutdown.server_close.timeout").pipe(Effect.asVoid),
          }),
        ),
      ),
    ),
  )
})

import * as Operation from "@rika/app/operation-contract"
import * as ResidentService from "@rika/app/resident-service"
import {
  Cause,
  Clock,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Ref,
  Schedule,
  Schema,
  Scope,
} from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { readOrCreateToken, recordedResidentProcesses, resolve } from "../resident-endpoint"
import * as ResidentProcessStartup from "../resident-process-startup"
import { claimStartup } from "../resident-startup"
import {
  isDisconnectedOperation,
  isReconnectableTransport,
  reconnectFailureLimit,
  reconnectSchedule,
  reconnectStableMilliseconds,
} from "./connection-policy"
import { failureKind, transportError } from "../resident-wire"

import { connect } from "./connection"
import { ignoreInteractiveEvent, probeLegacyResident } from "./connection-policy"
export const make = Effect.fn("ResidentTransport.make")(() =>
  Effect.succeed(
    ResidentService.Service.of({
      getOrCreate: (input) =>
        Effect.gen(function* () {
          const endpoint = yield* resolve(input.profile, input.dataRoot)
          const token = yield* readOrCreateToken(endpoint.tokenPath)
          const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const crypto = yield* Crypto.Crypto
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const connectionScope = yield* Scope.make()
          yield* Effect.addFinalizer((exit) => Scope.close(connectionScope, exit))
          const attach = (role: ResidentService.Connection["role"]) =>
            Effect.gen(function* () {
              const attemptScope = yield* Scope.fork(connectionScope)
              const result = yield* Effect.exit(
                connect({ ...endpoint, ...input, token, role }).pipe(Scope.provide(attemptScope)),
              )
              if (result._tag === "Failure") {
                yield* Scope.close(attemptScope, result)
                return yield* Effect.failCause(result.cause)
              }
              return result.value
            }).pipe(
              Effect.mapError((error) =>
                Schema.is(ResidentService.ResidentServiceError)(error)
                  ? error
                  : transportError(`Resident connection attempt failed: ${String(error)}`),
              ),
            )
          yield* Effect.logInfo("resident.connection.acquiring").pipe(
            Effect.annotateLogs("rika.resident.client.kind", input.clientKind),
          )
          const acquire = Effect.fn("ResidentTransport.acquireConnection")(function* () {
            const startedAt = yield* Clock.currentTimeMillis
            const deadline = startedAt + 30_000
            const first = yield* Effect.result(attach("attached"))
            if (first._tag === "Success") return first.success
            if (
              first.failure.reason !== "resident-absent" &&
              first.failure.reason !== "resident-draining" &&
              first.failure.reason !== "incompatible-resident"
            )
              return yield* first.failure
            if (input.startHost === undefined) return yield* first.failure
            if (input.startHost !== undefined) {
              let attempt = 0
              let lastFailure = first.failure
              while (true) {
                const connected = yield* Effect.result(attach("attached"))
                if (connected._tag === "Success") {
                  yield* Effect.logInfo("resident.startup.ready").pipe(
                    Effect.annotateLogs("rika.duration.ms", (yield* Clock.currentTimeMillis) - startedAt),
                  )
                  return connected.success
                }
                lastFailure = connected.failure
                if (
                  lastFailure.reason !== "resident-absent" &&
                  lastFailure.reason !== "resident-draining" &&
                  lastFailure.reason !== "incompatible-resident"
                )
                  return yield* lastFailure
                if (lastFailure.reason === "resident-absent" || lastFailure.reason === "incompatible-resident") {
                  const claim = yield* claimStartup(endpoint.startupPath, endpoint.identity, deadline)
                  if (claim._tag === "Owner") {
                    const existing = yield* Effect.result(attach("attached"))
                    if (existing._tag === "Success") {
                      yield* claim.release
                      yield* Effect.logInfo("resident.startup.ready").pipe(
                        Effect.annotateLogs("rika.duration.ms", (yield* Clock.currentTimeMillis) - startedAt),
                      )
                      return existing.success
                    }
                    lastFailure = existing.failure
                    if (lastFailure.reason === "resident-absent" || lastFailure.reason === "incompatible-resident") {
                      if (yield* ResidentProcessStartup.listenerIsLive(endpoint.port)) {
                        const protocolVerified =
                          lastFailure.reason === "incompatible-resident" ||
                          (yield* probeLegacyResident({
                            urls: [endpoint.url, endpoint.legacyUrl],
                            identity: endpoint.identity,
                            token,
                            clientKind: input.clientKind,
                          }))
                        const recorded = yield* recordedResidentProcesses(endpoint).pipe(Effect.orElseSucceed(() => []))
                        const alive = [] as Array<(typeof recorded)[number]>
                        for (const resident of recorded)
                          if (
                            resident.pid !== process.pid &&
                            (yield* ResidentProcessStartup.processIsAlive(resident.pid))
                          )
                            alive.push(resident)
                        const listeners = yield* ResidentProcessStartup.listenerProcessIds(
                          endpoint.port,
                          alive.map((resident) => resident.pid),
                        )
                        if (listeners.length !== 1 || !protocolVerified) {
                          yield* claim.release
                          return yield* transportError(
                            protocolVerified
                              ? `The stale Rika resident on port ${endpoint.port} was authenticated, but its PID could not be verified. Stop it, then run rika again`
                              : `A process is listening on Rika resident port ${endpoint.port}, but it could not be verified as this profile's resident. Stop that process, then run rika again`,
                            "foreign-listener",
                          )
                        }
                        yield* Effect.logWarning("resident.startup.superseding").pipe(
                          Effect.annotateLogs({
                            "rika.resident.previous.pid": listeners[0]!,
                            "rika.resident.port": endpoint.port,
                          }),
                        )
                        const superseded = yield* Effect.result(
                          ResidentProcessStartup.supersede(listeners[0]!, endpoint.port),
                        )
                        if (superseded._tag === "Failure") {
                          yield* claim.release
                          return yield* superseded.failure
                        }
                      }
                      const spawned = yield* Effect.result(input.startHost())
                      if (spawned._tag === "Failure") {
                        yield* claim.release
                        return yield* spawned.failure
                      }
                      const adopted = yield* Effect.result(claim.adopt(spawned.success.pid))
                      if (adopted._tag === "Failure") {
                        yield* spawned.success.abort
                        yield* claim.release
                        return yield* adopted.failure
                      }
                      const started = yield* Effect.result(spawned.success.startup)
                      if (started._tag === "Failure") {
                        yield* spawned.success.abort
                        yield* claim.release
                        return yield* started.failure
                      }
                      const attached = yield* Effect.result(attach("attached"))
                      if (attached._tag === "Failure") {
                        yield* spawned.success.abort
                        yield* claim.release
                        return yield* attached.failure
                      }
                      const detached = yield* Effect.result(spawned.success.detach)
                      if (detached._tag === "Failure") {
                        yield* spawned.success.abort
                        yield* claim.release
                        return yield* detached.failure
                      }
                      yield* claim.release
                      yield* Effect.logInfo("resident.startup.ready").pipe(
                        Effect.annotateLogs("rika.duration.ms", (yield* Clock.currentTimeMillis) - startedAt),
                      )
                      return attached.success
                    } else {
                      yield* claim.release
                      if (lastFailure.reason !== "resident-draining") return yield* lastFailure
                    }
                  }
                }
                const now = yield* Clock.currentTimeMillis
                if (now >= deadline)
                  return yield* transportError(
                    `Resident did not become ready within 30 seconds: ${lastFailure.message}`,
                    "transport-failed",
                  )
                const ceiling = Math.min(250, 10 * 2 ** Math.min(attempt, 5))
                const jitter = (process.pid * 17 + attempt * 31) % Math.max(1, ceiling)
                attempt += 1
                yield* Effect.sleep(Math.min(deadline - now, ceiling + jitter))
              }
            }
            return yield* first.failure
          })
          const acquireReady = acquire().pipe(
            Effect.timeoutOrElse({
              duration: "30 seconds",
              orElse: () =>
                Effect.fail(transportError("Resident acquisition exceeded its 30-second deadline", "transport-failed")),
            }),
            Scope.provide(connectionScope),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.mapError((error) =>
              Schema.is(ResidentService.ResidentServiceError)(error) ? error : transportError(String(error)),
            ),
            Effect.tapError((error) =>
              Effect.logWarning("resident.connection.failed").pipe(
                Effect.annotateLogs({
                  "rika.failure.kind": error._tag,
                  "rika.failure.reason": error.reason,
                  "rika.resident.client.kind": input.clientKind,
                }),
              ),
            ),
          )
          const initial = yield* acquireReady
          const logicalClosed = yield* Deferred.make<void>()
          const supervise = Effect.fn("ResidentTransport.superviseInteractive")(function* (
            operationInput: ResidentService.InteractiveInput,
            interactive: NonNullable<NonNullable<Parameters<ResidentService.Connection["run"]>[1]>["interactive"]>,
          ) {
            const firstSession = yield* Deferred.make<void>()
            const initialChange = yield* Deferred.make<void>()
            const sessions = yield* Ref.make<{
              readonly session: Operation.InteractiveSession | undefined
              readonly changed: Deferred.Deferred<void>
            }>({ session: undefined, changed: initialChange })
            const selected = yield* Ref.make<
              { readonly _tag: "thread"; readonly threadId: string } | { readonly _tag: "latest" } | undefined
            >(undefined)
            const wireEpoch = yield* Ref.make(0)
            let eventDispatch = ignoreInteractiveEvent
            let feedAttached = false
            const nextWireEpoch = (requested?: number) =>
              Ref.modify(wireEpoch, (current) => {
                const next = Math.max(current + 1, requested ?? current + 1)
                return [next, next]
              })
            const awaitSession: Effect.Effect<Operation.InteractiveSession> = Effect.suspend(() =>
              Ref.get(sessions).pipe(
                Effect.flatMap((state) =>
                  state.session === undefined
                    ? Deferred.await(state.changed).pipe(Effect.andThen(awaitSession))
                    : Effect.succeed(state.session),
                ),
              ),
            )
            const invalidate = (session: Operation.InteractiveSession) =>
              Effect.gen(function* () {
                const next = yield* Deferred.make<void>()
                const changed = yield* Ref.modify(sessions, (state) =>
                  state.session === session
                    ? [state.changed, { session: undefined, changed: next }]
                    : [undefined, state],
                )
                if (changed !== undefined) yield* Deferred.succeed(changed, undefined)
              })
            const report = (event: Operation.InteractiveEvent) => eventDispatch(event)
            const retryRead = (
              invoke: (session: Operation.InteractiveSession) => Effect.Effect<void, Operation.OperationUnavailable>,
            ): Effect.Effect<void> =>
              Effect.suspend(() =>
                awaitSession.pipe(
                  Effect.flatMap((session) =>
                    invoke(session).pipe(
                      Effect.catchCause((cause) =>
                        Cause.hasInterruptsOnly(cause)
                          ? Effect.interrupt
                          : isDisconnectedOperation(Cause.squash(cause))
                            ? invalidate(session).pipe(Effect.andThen(retryRead(invoke)))
                            : Effect.sync(() =>
                                report({
                                  _tag: "ExecutionFailed",
                                  selectionEpoch: 0,
                                  message: String(Cause.squash(cause)),
                                }),
                              ),
                      ),
                    ),
                  ),
                ),
              )
            const mutation = (
              invoke: (session: Operation.InteractiveSession) => Effect.Effect<void, Operation.OperationUnavailable>,
            ) =>
              awaitSession.pipe(
                Effect.flatMap((session) =>
                  invoke(session).pipe(
                    Effect.catchCause((cause) =>
                      Cause.hasInterruptsOnly(cause)
                        ? Effect.interrupt
                        : isDisconnectedOperation(Cause.squash(cause))
                          ? invalidate(session).pipe(
                              Effect.andThen(
                                Effect.sync(() =>
                                  report({
                                    _tag: "ExecutionFailed",
                                    selectionEpoch: 0,
                                    message:
                                      "Resident transport disconnected; the action outcome is unknown and was not retried",
                                  }),
                                ),
                              ),
                            )
                          : Effect.sync(() =>
                              report({
                                _tag: "ExecutionFailed",
                                selectionEpoch: 0,
                                message: String(Cause.squash(cause)),
                              }),
                            ),
                    ),
                  ),
                ),
              )
            const stable: Operation.InteractiveSession = {
              events: (dispatch) =>
                Effect.suspend(() => {
                  if (feedAttached)
                    return Effect.fail(
                      Operation.OperationUnavailable.make({
                        operation: "InteractiveSession.events",
                        message: "Interactive session already has an event consumer",
                      }),
                    )
                  feedAttached = true
                  eventDispatch = dispatch
                  return retryRead((session) => session.events(dispatch)).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        feedAttached = false
                        eventDispatch = ignoreInteractiveEvent
                      }),
                    ),
                  )
                }),
              submit: (prompt, mode, parts, tuning) =>
                mutation((session) => session.submit(prompt, mode, parts, tuning)),
              shell: (command, incognito) => mutation((session) => session.shell(command, incognito)),
              editQueued: (turnId, prompt) => mutation((session) => session.editQueued(turnId, prompt)),
              dequeue: (turnId) => mutation((session) => session.dequeue(turnId)),
              steerQueued: (turnId, text) => mutation((session) => session.steerQueued(turnId, text)),
              steer: (text) => mutation((session) => session.steer(text)),
              interruptAndSend: (prompt) => mutation((session) => session.interruptAndSend(prompt)),
              cancel: mutation((session) => session.cancel),
              newThread: nextWireEpoch().pipe(
                Effect.andThen(Ref.set(selected, { _tag: "latest" as const })),
                Effect.andThen(mutation((session) => session.newThread)),
              ),
              resolvePermission: (waitId, kind, decision) =>
                mutation((session) => session.resolvePermission(waitId, kind, decision)),
              selectThread: (threadId, selectionEpoch) =>
                Effect.gen(function* () {
                  const epoch = yield* nextWireEpoch(selectionEpoch)
                  yield* Ref.set(selected, { _tag: "thread" as const, threadId })
                  yield* retryRead((session) => session.selectThread(threadId, epoch))
                }),
              readQueue: (threadId) => retryRead((session) => session.readQueue(threadId)),
              loadOlder: retryRead((session) => session.loadOlder),
              previewThread: (threadId) => retryRead((session) => session.previewThread(threadId)),
              reopenThread: (selectionEpoch) =>
                Effect.gen(function* () {
                  const epoch = yield* nextWireEpoch(selectionEpoch)
                  yield* Ref.set(selected, { _tag: "latest" as const })
                  yield* retryRead((session) => session.reopenThread(epoch))
                }),
              replay: (turnId, afterCursor) => retryRead((session) => session.replay(turnId, afterCursor)),
            }
            const publish = (session: Operation.InteractiveSession, first: boolean) =>
              Effect.gen(function* () {
                if (!first) {
                  const selection = yield* Ref.get(selected)
                  const epoch = yield* nextWireEpoch()
                  if (selection?._tag === "thread") yield* session.selectThread(selection.threadId, epoch)
                  else if (selection?._tag === "latest") yield* session.reopenThread(epoch)
                }
                const changed = yield* Ref.modify(sessions, (state) => [state.changed, { ...state, session }])
                yield* Deferred.succeed(changed, undefined)
                if (first) yield* Deferred.succeed(firstSession, undefined)
              })
            const runPhysical = (connection: ResidentService.Connection, first: boolean) =>
              connection
                .run(operationInput, {
                  interactive: (_, session) => publish(session, first).pipe(Effect.andThen(connection.closed)),
                })
                .pipe(Effect.ensuring(connection.close))
            let nextReconnectDelay = yield* Schedule.toStepWithMetadata(reconnectSchedule)
            const loop = (
              connection: ResidentService.Connection | undefined,
              first: boolean,
              consecutiveFailures: number,
            ): Effect.Effect<void, ResidentService.ResidentServiceError | Operation.OperationUnavailable> =>
              Effect.gen(function* () {
                const acquired = yield* Effect.exit(
                  connection === undefined ? acquireReady : Effect.succeed(connection),
                )
                if (acquired._tag === "Failure")
                  return yield* recover(acquired.cause, undefined, first, consecutiveFailures)
                const startedAt = yield* Clock.currentTimeMillis
                const outcome = yield* Effect.exit(runPhysical(acquired.value, first))
                const duration = (yield* Clock.currentTimeMillis) - startedAt
                if (outcome._tag === "Success") return
                return yield* recover(outcome.cause, duration, first, consecutiveFailures, acquired.value.connectionId)
              })
            const recover = (
              cause: Cause.Cause<ResidentService.ResidentServiceError | Operation.OperationUnavailable>,
              duration: number | undefined,
              first: boolean,
              consecutiveFailures: number,
              connectionId?: string,
            ): Effect.Effect<void, ResidentService.ResidentServiceError | Operation.OperationUnavailable> =>
              Effect.gen(function* () {
                if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause)
                const failure = Cause.squash(cause)
                if (!isDisconnectedOperation(failure) && !isReconnectableTransport(failure))
                  return yield* Effect.failCause(cause)
                const current = (yield* Ref.get(sessions)).session
                if (current !== undefined) yield* invalidate(current)
                const stableConnection = duration !== undefined && duration >= reconnectStableMilliseconds
                const nextFailure = stableConnection ? 1 : consecutiveFailures + 1
                if (stableConnection) nextReconnectDelay = yield* Schedule.toStepWithMetadata(reconnectSchedule)
                if (nextFailure >= reconnectFailureLimit) {
                  yield* Effect.logError("resident.connection.reconnect_exhausted").pipe(
                    Effect.annotateLogs({
                      "rika.failure.kind": failureKind(cause),
                      "rika.resident.connection.duration.ms": duration ?? 0,
                      "rika.resident.connection.failures": nextFailure,
                      ...(connectionId === undefined ? {} : { "rika.resident.connection.id": connectionId }),
                    }),
                  )
                  return yield* Operation.OperationUnavailable.make({
                    operation: "ResidentConnection",
                    message: `Resident connection closed ${nextFailure} times before becoming stable`,
                  })
                }
                const delay = yield* nextReconnectDelay(failure).pipe(Effect.orDie)
                yield* Effect.logWarning("resident.connection.reconnecting").pipe(
                  Effect.annotateLogs({
                    "rika.failure.kind": failureKind(cause),
                    "rika.resident.connection.duration.ms": duration ?? 0,
                    "rika.resident.connection.retry": nextFailure,
                    "rika.resident.connection.retry_delay.ms": Duration.toMillis(delay.duration),
                    ...(connectionId === undefined ? {} : { "rika.resident.connection.id": connectionId }),
                  }),
                )
                const nextFirst = first && !(yield* Deferred.isDone(firstSession))
                return yield* loop(undefined, nextFirst, nextFailure)
              })
            const supervisor = yield* Effect.forkChild(
              Effect.raceFirst(loop(initial, true, 0), Deferred.await(logicalClosed)),
            )
            yield* Effect.raceFirst(
              Deferred.await(firstSession),
              Effect.raceFirst(Deferred.await(logicalClosed), Fiber.join(supervisor)),
            )
            yield* Effect.raceFirst(
              interactive(operationInput, stable),
              Effect.raceFirst(Deferred.await(logicalClosed), Fiber.join(supervisor)),
            ).pipe(Effect.ensuring(Fiber.interrupt(supervisor)))
          })
          return {
            ...initial,
            run: (operationInput, options) =>
              operationInput._tag === "Interactive" && options?.interactive !== undefined
                ? supervise(operationInput, options.interactive)
                : initial.run(operationInput, options),
            closed: Deferred.await(logicalClosed),
            close: Deferred.succeed(logicalClosed, undefined).pipe(
              Effect.andThen(Scope.close(connectionScope, Exit.void)),
            ),
          } satisfies ResidentService.Connection
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(ResidentService.ResidentServiceError)(cause) ? cause : transportError(String(cause)),
          ),
        ),
    }),
  ),
)

export const layer = Layer.effect(ResidentService.Service, make())

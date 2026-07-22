import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as Operation from "@rika/app/operation-contract"
import * as ResidentService from "@rika/app/resident-service"
import {
  Cause,
  Clock,
  Console,
  Crypto,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  FiberSet,
  Formatter,
  Queue,
  Ref,
  Schema,
  Scope,
  Semaphore,
} from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { makeInteractiveRouting } from "./interactive-routing"
import { addShutdownFinalizer, internal as shutdownInternal, makeGraceScheduler } from "./shutdown"
const { drainingFailureFrame } = shutdownInternal
import {
  decodeClient,
  failureKind,
  json,
  makeClientMessageFrameDecoder,
  maxFrameBytes,
  outputFrames,
  parse,
  transportError,
} from "../resident-wire"
const formatOutput = (values: ReadonlyArray<unknown>) =>
  `${values.map((value) => (typeof value === "string" ? value : Formatter.format(value))).join(" ")}\n`
export const host = Effect.fn("ResidentTransport.host")(function* (options: {
  readonly port: number
  readonly identity: string
  readonly token: string
  readonly graceMilliseconds: number
  readonly ownerDrainMilliseconds: number
  readonly startupHoldMilliseconds: number
  readonly outboundCapacity: number
  readonly stopped: Deferred.Deferred<void>
  readonly ready: Deferred.Deferred<void>
  readonly onReady: Effect.Effect<void, ResidentService.ResidentServiceError, FileSystem.FileSystem>
  readonly owner: ResidentService.Owner
}) {
  const crypto = yield* Crypto.Crypto
  const baseConsole = yield* Console.Console
  const hostScope = yield* Effect.scope
  const serviceNonce = yield* crypto.randomUUIDv4
  const graceFiber = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined)
  const coldCohortUntil = yield* Ref.make(0)
  const lifecycle = yield* ResidentService.makeLifecycle(() => Effect.void)
  const hostWork = yield* FiberSet.make<void, unknown>()
  const activeConnections = yield* Ref.make(new Map<string, Effect.Effect<void>>())
  const operationAdmission = yield* Semaphore.make(32)
  const scheduleGrace = makeGraceScheduler({
    lifecycle,
    stopped: options.stopped,
    graceMilliseconds: options.graceMilliseconds,
    hostScope,
    graceFiber,
    coldCohortUntil,
  })
  const { interactive, requestByInput, routes } = yield* makeInteractiveRouting({
    crypto,
    hostScope,
    outboundCapacity: options.outboundCapacity,
  })
  const ownerScope = yield* Scope.make()
  const serverScope = yield* Scope.make()
  yield* addShutdownFinalizer({
    lifecycle,
    hostWork,
    ownerScope,
    serverScope,
    activeConnections,
    ownerDrainMilliseconds: options.ownerDrainMilliseconds,
  })
  const server = yield* Scope.provide(BunHttpServer.make({ hostname: "127.0.0.1", port: options.port }), serverScope)
  const operationReady = yield* Deferred.make<Operation.Interface>()
  const handle = Effect.fn("ResidentTransport.connection")(function* (socket: Socket.Socket) {
    const rawWriter = yield* socket.writer
    const outbound = yield* Queue.bounded<string | Socket.CloseEvent>(options.outboundCapacity)
    const outboundMessages = yield* Semaphore.make(1)
    const closeWritten = yield* Deferred.make<void>()
    const writer = (frame: string | Socket.CloseEvent): Effect.Effect<void, ResidentService.ResidentServiceError> => {
      if (typeof frame === "string" && new TextEncoder().encode(frame).byteLength > maxFrameBytes)
        return Effect.fail(transportError("Resident frame exceeds maximum size"))
      return Queue.offer(outbound, frame).pipe(Effect.asVoid)
    }
    yield* Effect.forkChild(
      Effect.gen(function* () {
        while (true) {
          const frame = yield* Queue.take(outbound)
          yield* rawWriter(frame)
          if (typeof frame !== "string") {
            yield* Deferred.succeed(closeWritten, undefined)
            return
          }
        }
      }),
    )
    const inbound = yield* Semaphore.make(1)
    const attached = yield* Ref.make(false)
    const decodeClientFrame = makeClientMessageFrameDecoder()
    const requests = yield* Ref.make(new Map<string, Fiber.Fiber<void, unknown>>())
    const connectionId = yield* crypto.randomUUIDv4
    const routeKey = (requestId: string) => `${connectionId}\0${requestId}`
    const close = (code: number, reason?: string) => writer(new Socket.CloseEvent(code, reason))
    yield* Ref.update(activeConnections, (current) =>
      current.set(
        connectionId,
        Queue.offer(outbound, new Socket.CloseEvent(1001)).pipe(
          Effect.andThen(Deferred.await(closeWritten)),
          Effect.ignore,
        ),
      ),
    )
    yield* socket
      .runString((text) =>
        inbound.withPermits(1)(
          Effect.gen(function* () {
            if (new TextEncoder().encode(text).byteLength > maxFrameBytes) return yield* close(4400)
            const isAttached = yield* Ref.get(attached)
            const decoded = yield* Effect.result(
              Effect.try({
                try: () => (isAttached ? decodeClientFrame(text) : decodeClient(parse(text))),
                catch: () => transportError("Invalid resident request"),
              }),
            )
            if (decoded._tag === "Failure") return yield* close(4400)
            const message = decoded.success
            if (message === undefined) return
            if (!isAttached) {
              if (!("family" in message)) return yield* close(4401)
              const result = ResidentService.validateHandshake(message, {
                identity: options.identity,
                token: options.token,
                buildIdentity: ResidentService.buildIdentity,
              })
              if (result._tag !== "Accepted") {
                const incompatible = result._tag === "ProtocolMismatch" || result._tag === "BuildMismatch"
                const reason = incompatible
                  ? `Incompatible Rika resident PID ${process.pid}; Rika can replace it after other clients disconnect`
                  : `Rika resident PID ${process.pid} rejected this credential; close other Rika clients, stop PID ${process.pid}, then run rika again`
                yield* Effect.logWarning("resident.connection.rejected").pipe(
                  Effect.annotateLogs({
                    "rika.resident.connection.id": connectionId,
                    "rika.resident.rejection.reason": result._tag,
                  }),
                )
                return yield* close(incompatible ? 4406 : 4401, reason)
              }
              if (!(yield* lifecycle.tryAttach)) {
                yield* writer(
                  json({ _tag: "rejected", reason: "draining" } satisfies ResidentService.HandshakeRejected),
                )
                return yield* close(4409)
              }
              yield* Ref.set(attached, true)
              const existing = yield* Ref.get(graceFiber)
              if (existing !== undefined) yield* Fiber.interrupt(existing)
              yield* Ref.set(graceFiber, undefined)
              const acceptedProof = ResidentService.serverProof(options.token, message, {
                serviceNonce,
                connectionId,
                buildIdentity: ResidentService.buildIdentity,
              })
              yield* writer(
                json({
                  _tag: "accepted",
                  family: "rika-resident",
                  identity: options.identity,
                  clientNonce: message.clientNonce,
                  serviceNonce,
                  connectionId,
                  protocolVersion: ResidentService.protocolVersion,
                  buildIdentity: ResidentService.buildIdentity,
                  serverProof: acceptedProof,
                  residentPid: process.pid,
                } satisfies ResidentService.HandshakeAccepted),
              )
              yield* Effect.logInfo("resident.connection.accepted").pipe(
                Effect.annotateLogs({
                  "rika.resident.client.kind": message.clientKind,
                  "rika.resident.connection.id": connectionId,
                }),
              )
              return
            }
            if (!("_tag" in message)) return
            if (message._tag === "ping") yield* writer(json({ _tag: "pong", id: message.id }))
            if (message._tag === "cancel") {
              const fiber = (yield* Ref.get(requests)).get(message.requestId)
              if (fiber !== undefined) yield* Fiber.interrupt(fiber)
            }
            if (message._tag === "interactive-end") {
              const active = (yield* Ref.get(routes)).get(routeKey(message.requestId))?.sessions.get(message.sessionId)
              if (
                message.connectionId !== connectionId ||
                active === undefined ||
                active.feedGeneration !== message.feedGeneration
              )
                return yield* close(4400)
              yield* Deferred.succeed(active.ended, undefined)
            }
            if (message._tag === "cancel-interactive-command") {
              const active = (yield* Ref.get(routes)).get(routeKey(message.requestId))?.sessions.get(message.sessionId)
              if (
                message.connectionId !== connectionId ||
                active === undefined ||
                active.feedGeneration !== message.feedGeneration
              )
                return yield* close(4400)
              const command = active.commands.get(message.commandSequence)
              if (command !== undefined) yield* Deferred.succeed(command, undefined)
            }
            if (message._tag === "interactive-feed-ack") {
              const active = (yield* Ref.get(routes)).get(routeKey(message.requestId))?.sessions.get(message.sessionId)
              if (
                message.connectionId !== connectionId ||
                active === undefined ||
                active.feedGeneration !== message.feedGeneration ||
                !(yield* active.acknowledge(message.throughSequence))
              )
                return yield* close(4400)
              if (message.throughSequence % 1_024 === 0)
                yield* Effect.logInfo("resident.feed.ack_received").pipe(
                  Effect.annotateLogs("rika.resident.feed.sequence", message.throughSequence),
                )
            }
            if (message._tag === "interactive-feed-replay") {
              const active = (yield* Ref.get(routes)).get(routeKey(message.requestId))?.sessions.get(message.sessionId)
              if (
                message.connectionId !== connectionId ||
                active === undefined ||
                active.feedGeneration !== message.feedGeneration
              )
                return yield* close(4400)
              yield* active.replay(message.afterSequence)
            }
            if (message._tag === "interactive-command") {
              const active = (yield* Ref.get(routes)).get(routeKey(message.requestId))?.sessions.get(message.sessionId)
              if (
                message.connectionId !== connectionId ||
                active === undefined ||
                active.feedGeneration !== message.feedGeneration ||
                !active.acceptCommand(message.commandSequence)
              )
                return yield* close(4400)
              const startedAt = yield* Clock.currentTimeMillis
              yield* Effect.logInfo("resident.interactive_command.accepted").pipe(
                Effect.annotateLogs({
                  "rika.resident.request.id": message.requestId,
                  "rika.resident.session.id": message.sessionId,
                  "rika.resident.command.sequence": message.commandSequence,
                  "rika.resident.command.tag": message.command._tag,
                }),
              )
              const state = yield* lifecycle.state
              if (state === "draining" || state === "stopped") {
                yield* writer(
                  json({
                    _tag: "interactive-command-failed",
                    connectionId,
                    requestId: message.requestId,
                    sessionId: message.sessionId,
                    feedGeneration: message.feedGeneration,
                    commandSequence: message.commandSequence,
                    error: Operation.OperationUnavailable.make({
                      operation: message.command._tag,
                      message: "Resident service is draining",
                    }),
                  } satisfies ResidentService.ServerMessage),
                )
                return
              }
              const cancelled = yield* Deferred.make<void>()
              const effect = Effect.gen(function* () {
                yield* Operation.executeInteractiveCommand(active.session, message.command)
                const completedAt = yield* Clock.currentTimeMillis
                yield* Effect.logInfo("resident.interactive_command.completed").pipe(
                  Effect.annotateLogs({
                    "rika.resident.request.id": message.requestId,
                    "rika.resident.session.id": message.sessionId,
                    "rika.resident.command.sequence": message.commandSequence,
                    "rika.resident.command.tag": message.command._tag,
                    "rika.duration.ms": completedAt - startedAt,
                  }),
                )
                yield* writer(
                  json({
                    _tag: "interactive-command-completed",
                    connectionId,
                    requestId: message.requestId,
                    sessionId: message.sessionId,
                    feedGeneration: message.feedGeneration,
                    commandSequence: message.commandSequence,
                  } satisfies ResidentService.ServerMessage),
                )
              }).pipe(
                Effect.asVoid,
                Effect.catch((failure) =>
                  Clock.currentTimeMillis.pipe(
                    Effect.flatMap((failedAt) =>
                      Effect.logError("resident.interactive_command.failed").pipe(
                        Effect.annotateLogs({
                          "rika.resident.request.id": message.requestId,
                          "rika.resident.session.id": message.sessionId,
                          "rika.resident.command.sequence": message.commandSequence,
                          "rika.resident.command.tag": message.command._tag,
                          "rika.failure.kind": failure._tag,
                          "rika.duration.ms": failedAt - startedAt,
                        }),
                      ),
                    ),
                    Effect.andThen(
                      writer(
                        json({
                          _tag: "interactive-command-failed",
                          connectionId,
                          requestId: message.requestId,
                          sessionId: message.sessionId,
                          feedGeneration: message.feedGeneration,
                          commandSequence: message.commandSequence,
                          error: Schema.is(Operation.OperationUnavailable)(failure)
                            ? failure
                            : Operation.OperationUnavailable.make({
                                operation: message.command._tag,
                                message: String(failure),
                              }),
                        } satisfies ResidentService.ServerMessage),
                      ),
                    ),
                  ),
                ),
              )
              active.commands.set(message.commandSequence, cancelled)
              if (message.command._tag === "ResolvePermission" || message.command._tag === "Cancel")
                yield* Effect.forkIn(
                  Effect.raceFirst(Deferred.await(cancelled), effect).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        if (active.commands.get(message.commandSequence) === cancelled)
                          active.commands.delete(message.commandSequence)
                      }),
                    ),
                  ),
                  hostScope,
                )
              else
                yield* Queue.offer(active.commandQueue, {
                  sequence: message.commandSequence,
                  cancelled,
                  effect,
                })
            }
            if (message._tag === "operation") {
              if ((yield* Ref.get(requests)).has(message.requestId)) return yield* close(4400)
              yield* Effect.logInfo("resident.operation.accepted").pipe(
                Effect.annotateLogs({
                  "rika.operation": message.input._tag,
                  "rika.resident.request.id": message.requestId,
                }),
              )
              const requestRouteKey = routeKey(message.requestId)
              requestByInput.set(message.input, { requestId: message.requestId, routeKey: requestRouteKey })
              const send = (frame: string) =>
                writer(frame).pipe(
                  Effect.mapError((error) =>
                    Operation.OperationUnavailable.make({
                      operation: "ResidentConnection",
                      message: error.message,
                    }),
                  ),
                )
              const sendFrames = (frames: ReadonlyArray<string>) =>
                outboundMessages.withPermits(1)(Effect.forEach(frames, send, { discard: true }))
              yield* Ref.update(routes, (current) =>
                current.set(requestRouteKey, {
                  connectionId,
                  send,
                  sendFrames,
                  sessions: new Map(),
                }),
              )
              const started = yield* Deferred.make<void>()
              const fiber = yield* lifecycle.runWork(
                hostWork,
                Deferred.await(started).pipe(
                  Effect.andThen(
                    Effect.gen(function* () {
                      const startedAt = yield* Clock.currentTimeMillis
                      const output = yield* Queue.bounded<
                        | { readonly _tag: "output"; readonly channel: "stdout" | "stderr"; readonly text: string }
                        | { readonly _tag: "finished" }
                      >(options.outboundCapacity)
                      let outputOverflowed = false
                      const write = (channel: "stdout" | "stderr", values: ReadonlyArray<unknown>) => {
                        if (!Queue.offerUnsafe(output, { _tag: "output", channel, text: formatOutput(values) }))
                          outputOverflowed = true
                      }
                      const requestConsole = Object.assign(Object.create(baseConsole) as Console.Console, {
                        assert: (condition: boolean, ...values: ReadonlyArray<unknown>) => {
                          if (!condition) write("stderr", values)
                        },
                        debug: (...values: ReadonlyArray<unknown>) => write("stdout", values),
                        error: (...values: ReadonlyArray<unknown>) => write("stderr", values),
                        info: (...values: ReadonlyArray<unknown>) => write("stdout", values),
                        log: (...values: ReadonlyArray<unknown>) => write("stdout", values),
                        warn: (...values: ReadonlyArray<unknown>) => write("stderr", values),
                      })
                      const sender = yield* Effect.forkChild(
                        Effect.gen(function* () {
                          while (true) {
                            const frame = yield* Queue.take(output)
                            if (frame._tag === "finished") return
                            for (const encoded of outputFrames(message.requestId, frame.channel, frame.text))
                              yield* send(encoded)
                          }
                        }),
                      )
                      const operation = yield* Deferred.await(operationReady)
                      const execution = operation
                        .run(message.input)
                        .pipe(Effect.provideService(Console.Console, requestConsole))
                      const result = yield* Effect.exit(
                        message.input._tag === "Interactive" ? execution : operationAdmission.withPermits(1)(execution),
                      )
                      const delivery = yield* Effect.raceFirst(
                        Fiber.await(sender),
                        Queue.offer(output, { _tag: "finished" }).pipe(Effect.andThen(Fiber.await(sender))),
                      )
                      const outcome = Exit.isFailure(delivery)
                        ? Exit.fail(
                            Operation.OperationUnavailable.make({
                              operation: message.input._tag,
                              message: `Resident output delivery failed: ${Cause.pretty(delivery.cause)}`,
                            }),
                          )
                        : outputOverflowed
                          ? Exit.fail(
                              Operation.OperationUnavailable.make({
                                operation: message.input._tag,
                                message: "Resident client output queue is overloaded",
                              }),
                            )
                          : result
                      yield* Exit.match(outcome, {
                        onFailure: (cause) => {
                          const failure = Cause.squash(cause)
                          const error = Schema.is(Operation.OperationUnavailable)(failure)
                            ? failure
                            : Operation.OperationUnavailable.make({
                                operation: message.input._tag,
                                message: String(failure),
                              })
                          return Clock.currentTimeMillis.pipe(
                            Effect.flatMap((failedAt) =>
                              Effect.logError("resident.operation.failed").pipe(
                                Effect.annotateLogs({
                                  "rika.duration.ms": failedAt - startedAt,
                                  "rika.failure.kind": failureKind(cause),
                                }),
                              ),
                            ),
                            Effect.andThen(
                              send(
                                json({
                                  _tag: "operation-failed",
                                  requestId: message.requestId,
                                  error,
                                } satisfies ResidentService.ServerMessage),
                              ).pipe(Effect.catch(() => rawWriter(new Socket.CloseEvent(1011)).pipe(Effect.ignore))),
                            ),
                          )
                        },
                        onSuccess: () =>
                          Clock.currentTimeMillis.pipe(
                            Effect.flatMap((completedAt) =>
                              Effect.logInfo("resident.operation.completed").pipe(
                                Effect.annotateLogs("rika.duration.ms", completedAt - startedAt),
                              ),
                            ),
                            Effect.andThen(
                              send(
                                json({
                                  _tag: "operation-completed",
                                  requestId: message.requestId,
                                } satisfies ResidentService.ServerMessage),
                              ).pipe(Effect.catch(() => rawWriter(new Socket.CloseEvent(1011)).pipe(Effect.ignore))),
                            ),
                          ),
                      })
                    }).pipe(
                      Effect.annotateLogs({
                        "rika.operation": message.input._tag,
                        "rika.resident.connection.id": connectionId,
                        "rika.resident.request.id": message.requestId,
                      }),
                      Effect.ensuring(
                        Ref.update(requests, (current) => (current.delete(message.requestId), current)).pipe(
                          Effect.andThen(Ref.update(routes, (current) => (current.delete(requestRouteKey), current))),
                          Effect.andThen(Effect.sync(() => requestByInput.delete(message.input))),
                        ),
                      ),
                      Effect.asVoid,
                    ),
                  ),
                ),
              )
              if (fiber === undefined) {
                yield* Ref.update(routes, (current) => (current.delete(requestRouteKey), current))
                requestByInput.delete(message.input)
                yield* writer(drainingFailureFrame(message.requestId, message.input._tag))
                return
              }
              yield* Ref.update(requests, (current) => current.set(message.requestId, fiber))
              yield* Deferred.succeed(started, undefined)
            }
          }),
        ),
      )
      .pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Ref.update(activeConnections, (current) => (current.delete(connectionId), current))
            if (!(yield* Ref.get(attached))) return
            const activeRequests = yield* Ref.get(requests)
            const activeRoutes = yield* Ref.get(routes)
            for (const requestId of activeRequests.keys()) {
              const route = activeRoutes.get(routeKey(requestId))
              if (route === undefined) continue
              for (const session of route.sessions.values()) {
                for (const command of session.commands.values()) yield* Deferred.succeed(command, undefined)
                yield* Deferred.succeed(session.ended, undefined)
              }
            }
            for (const fiber of activeRequests.values()) yield* Fiber.interrupt(fiber)
            yield* Ref.update(routes, (current) => {
              for (const requestId of activeRequests.keys()) current.delete(routeKey(requestId))
              return current
            })
            const generation = yield* lifecycle.detach
            yield* Effect.logInfo("resident.connection.closed").pipe(
              Effect.annotateLogs("rika.resident.connection.id", connectionId),
            )
            if (generation === undefined) return
            yield* scheduleGrace(generation)
            yield* Effect.logInfo("resident.idle-generation.started").pipe(
              Effect.annotateLogs({
                "rika.resident.connection.id": connectionId,
                "rika.resident.generation": generation,
              }),
            )
          }),
        ),
      )
  })
  const app = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.url === "/resident/v1") {
      const socket = yield* request.upgrade
      yield* Effect.scoped(
        Effect.gen(function* () {
          const writer = yield* socket.writer
          yield* writer(new Socket.CloseEvent(4403, "Resident protocol upgrade required"))
        }),
      )
      return HttpServerResponse.empty()
    }
    if (request.url !== "/resident") return HttpServerResponse.empty({ status: 404 })
    const socket = yield* request.upgrade
    yield* handle(socket)
    return HttpServerResponse.empty()
  })
  yield* Scope.provide(server.serve(app), serverScope)
  const operation = yield* Scope.provide(options.owner(interactive), ownerScope)
  yield* Deferred.succeed(operationReady, operation)
  yield* Ref.set(coldCohortUntil, (yield* Clock.currentTimeMillis) + options.startupHoldMilliseconds)
  const startupGrace = yield* lifecycle.ready
  if (startupGrace !== undefined) yield* scheduleGrace(startupGrace)
  yield* options.onReady
  yield* Effect.logInfo("resident.listener.ready")
  yield* Deferred.succeed(options.ready, undefined)
  yield* Deferred.await(options.stopped)
})

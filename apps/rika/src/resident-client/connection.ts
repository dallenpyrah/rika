import * as BunSocket from "@effect/platform-bun/BunSocket"
import * as Operation from "@rika/app/operation-contract"
import * as ResidentService from "@rika/app/resident-service"
import { Context, Crypto, Deferred, Effect, Exit, Layer, Queue, Ref, Schema, Scope, Semaphore } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import type { InteractiveFeedFrame, PhysicalFeed } from "./connection-policy"
import { internal, makeHandshake, residentSocketFailure } from "./connection-policy"
const { closeConnection, traceInteractiveEvent, writeClientMessage } = internal
import {
  clientMessageFrames,
  defaultOutboundCapacity,
  json,
  makeServerMessageFrameDecoder,
  maxFrameBytes,
  transportError,
} from "../resident-wire"

export const connect = Effect.fn("ResidentTransport.connect")(function* (options: {
  readonly url: string
  readonly identity: string
  readonly token: string
  readonly clientKind: ResidentService.Handshake["clientKind"]
  readonly role: ResidentService.Connection["role"]
}) {
  const crypto = yield* Crypto.Crypto
  const connectionScope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(connectionScope, Exit.void))
  const webSocketContext = yield* Scope.provide(Layer.build(BunSocket.layerWebSocketConstructor), connectionScope)
  const webSocketConstructor = Context.get(webSocketContext, Socket.WebSocketConstructor)
  const socket = yield* Scope.provide(
    Socket.makeWebSocket(options.url).pipe(Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor)),
    connectionScope,
  )
  const rawWriter = yield* Scope.provide(socket.writer, connectionScope)
  const outbound = yield* Queue.bounded<string | Socket.CloseEvent>(defaultOutboundCapacity)
  const closing = yield* Deferred.make<void>()
  const closed = yield* Deferred.make<void>()
  const writer = (frame: string | Socket.CloseEvent) =>
    Deferred.isDone(closing).pipe(
      Effect.flatMap((isClosing) =>
        isClosing
          ? Effect.fail(transportError("Resident connection is closing"))
          : typeof frame === "string" && new TextEncoder().encode(frame).byteLength > maxFrameBytes
            ? Effect.fail(transportError("Resident frame exceeds maximum size"))
            : Queue.offer(outbound, frame).pipe(
                Effect.timeoutOrElse({
                  duration: "1 second",
                  orElse: () => Effect.fail(transportError("Resident outbound queue is overloaded")),
                }),
                Effect.asVoid,
              ),
      ),
    )
  yield* Effect.forkIn(Effect.forever(Queue.take(outbound).pipe(Effect.flatMap(rawWriter))), connectionScope)
  const accepted = yield* Deferred.make<ResidentService.HandshakeAccepted>()
  let acceptedConnectionId: string | undefined
  const clientNonce = yield* crypto.randomUUIDv4
  const connectionFailure = yield* Deferred.make<never, ResidentService.ResidentServiceError>()
  const write = (frame: string | Socket.CloseEvent) =>
    writer(frame).pipe(Effect.tapError((error) => Deferred.fail(connectionFailure, error)))
  const pongs = yield* Ref.make(new Map<string, Deferred.Deferred<void, ResidentService.ResidentServiceError>>())
  const inbound = yield* Semaphore.make(1)
  const receivedDeltas = new Set<string>(),
    dispatchedDeltas = new Set<string>()
  const requests = yield* Ref.make(
    new Map<
      string,
      {
        readonly done: Deferred.Deferred<void, Operation.OperationUnavailable>
        readonly stdout?: (text: string) => Effect.Effect<void>
        readonly stderr?: (text: string) => Effect.Effect<void>
        readonly interactive?: (
          input: ResidentService.InteractiveInput,
          session: Operation.InteractiveSession,
        ) => Effect.Effect<void, Operation.OperationUnavailable>
        readonly interactiveStarted?: Deferred.Deferred<{
          readonly sessionId: string
          readonly feedGeneration: string
          readonly session: Operation.InteractiveSession
        }>
        readonly input: Operation.Input
        readonly commands: Map<number, Deferred.Deferred<void, Operation.OperationUnavailable>>
        feed?: PhysicalFeed
      }
    >(),
  )
  const handshake = makeHandshake({
    identity: options.identity,
    token: options.token,
    clientNonce,
    clientKind: options.clientKind,
  })
  const decodeFrame = makeServerMessageFrameDecoder()
  yield* socket
    .runString(
      (frame) =>
        inbound.withPermits(1)(
          (new TextEncoder().encode(frame).byteLength > maxFrameBytes
            ? Effect.fail(transportError("Resident frame exceeds maximum size"))
            : Effect.try({
                try: () => decodeFrame(frame),
                catch: () => transportError("Invalid resident response"),
              })
          ).pipe(
            Effect.flatMap((message) =>
              message === undefined
                ? Effect.void
                : message._tag === "accepted"
                  ? message.identity !== options.identity || message.clientNonce !== clientNonce
                    ? Effect.fail(transportError("Foreign resident listener", "foreign-listener"))
                    : message.protocolVersion !== ResidentService.protocolVersion
                      ? Effect.fail(
                          transportError(
                            `An incompatible Rika resident${message.residentPid === undefined ? "" : ` (PID ${message.residentPid})`} is still running at ${options.url}; close other Rika clients, then run rika again`,
                            "incompatible-resident",
                          ),
                        )
                      : !ResidentService.verifyServerProof(
                            options.token,
                            {
                              identity: options.identity,
                              clientNonce,
                              clientKind: options.clientKind,
                              protocolVersion: ResidentService.protocolVersion,
                              buildIdentity: ResidentService.buildIdentity,
                            },
                            message,
                          )
                        ? Effect.fail(transportError("Foreign resident listener", "foreign-listener"))
                        : message.buildIdentity !== ResidentService.buildIdentity
                          ? Effect.fail(
                              transportError(
                                `A different Rika build${message.residentPid === undefined ? "" : ` (resident PID ${message.residentPid})`} is still running at ${options.url}; Rika will replace it when no clients are using it`,
                                "incompatible-resident",
                              ),
                            )
                          : Effect.sync(() => (acceptedConnectionId = message.connectionId)).pipe(
                              Effect.andThen(Deferred.succeed(accepted, message)),
                            )
                  : message._tag === "rejected"
                    ? Deferred.fail(
                        connectionFailure,
                        transportError("Resident service is draining", "resident-draining"),
                      )
                    : message._tag === "pong"
                      ? Effect.gen(function* () {
                          const pending = (yield* Ref.get(pongs)).get(message.id)
                          if (pending !== undefined) yield* Deferred.succeed(pending, undefined)
                        })
                      : Effect.gen(function* () {
                          const request = (yield* Ref.get(requests)).get(message.requestId)
                          if (request === undefined) return
                          if (message._tag === "output")
                            yield* (message.channel === "stdout"
                              ? request.stdout?.(message.text)
                              : request.stderr?.(message.text)) ?? Effect.void
                          if (message._tag === "interactive-feed-event" || message._tag === "interactive-feed-resync") {
                            const feed = request.feed
                            if (
                              acceptedConnectionId !== message.connectionId ||
                              feed === undefined ||
                              feed.sessionId !== message.sessionId ||
                              feed.generation !== message.feedGeneration
                            )
                              return yield* transportError("Resident sent an event for a stale interactive feed")
                            if (message.sequence < feed.expectedSequence) return
                            if (message._tag === "interactive-feed-event" && message.sequence > feed.expectedSequence) {
                              const afterSequence = feed.expectedSequence - 1
                              if (feed.replayRequestedAfter !== afterSequence) {
                                feed.replayRequestedAfter = afterSequence
                                yield* write(
                                  json({
                                    _tag: "interactive-feed-replay",
                                    connectionId: message.connectionId,
                                    requestId: message.requestId,
                                    sessionId: message.sessionId,
                                    feedGeneration: message.feedGeneration,
                                    afterSequence,
                                  } satisfies ResidentService.ClientMessage),
                                )
                              }
                              return
                            }
                            feed.expectedSequence = message.sequence + 1
                            feed.replayRequestedAfter = undefined
                            if (message._tag === "interactive-feed-resync")
                              yield* Effect.logInfo("resident.feed.barrier_received")
                            if (message._tag === "interactive-feed-event")
                              yield* traceInteractiveEvent("client.feed.event_received", receivedDeltas, message.event)
                            yield* Queue.offer(feed.frames, message)
                          }
                          if (
                            message._tag === "interactive-command-completed" ||
                            message._tag === "interactive-command-failed"
                          ) {
                            const feed = request.feed
                            if (
                              acceptedConnectionId !== message.connectionId ||
                              feed === undefined ||
                              feed.sessionId !== message.sessionId ||
                              feed.generation !== message.feedGeneration
                            )
                              return yield* transportError("Resident sent a result for a stale interactive feed")
                            const command = request.commands.get(message.commandSequence)
                            if (command !== undefined)
                              yield* message._tag === "interactive-command-completed"
                                ? Deferred.succeed(command, undefined)
                                : Deferred.fail(command, message.error)
                          }
                          if (
                            message._tag === "interactive-started" &&
                            request.input._tag === "Interactive" &&
                            request.interactive !== undefined
                          ) {
                            if (
                              acceptedConnectionId !== message.connectionId ||
                              request.feed !== undefined ||
                              message.feedCapacity < 1
                            )
                              return yield* transportError("Resident started an invalid interactive feed")
                            const feed: PhysicalFeed = {
                              sessionId: message.sessionId,
                              generation: message.feedGeneration,
                              frames: yield* Queue.bounded<InteractiveFeedFrame>(message.feedCapacity),
                              expectedSequence: 1,
                              replayRequestedAfter: undefined,
                              consumerAttached: false,
                            }
                            request.feed = feed
                            let nextCommandSequence = 1
                            const commandWriteLock = yield* Semaphore.make(1)
                            const unavailable = (text: string) =>
                              Operation.OperationUnavailable.make({ operation: "ResidentConnection", message: text })
                            const invoke = Effect.fn("ResidentTransport.interactiveCommand")(function* (
                              command: Operation.InteractiveCommand,
                            ) {
                              const done = yield* Deferred.make<void, Operation.OperationUnavailable>()
                              const commandSequence = yield* commandWriteLock.withPermits(1)(
                                Effect.gen(function* () {
                                  const frames = yield* Effect.try({
                                    try: () =>
                                      clientMessageFrames(`${message.requestId}:${nextCommandSequence}`, {
                                        _tag: "interactive-command",
                                        connectionId: message.connectionId,
                                        requestId: message.requestId,
                                        sessionId: message.sessionId,
                                        feedGeneration: message.feedGeneration,
                                        commandSequence: nextCommandSequence,
                                        command,
                                      }),
                                    catch: (error) =>
                                      Schema.is(ResidentService.ResidentServiceError)(error) &&
                                      error.reason === "message-too-large"
                                        ? Operation.OperationUnavailable.make({
                                            operation: command._tag,
                                            message:
                                              "The prompt and attachments exceed the 16 MiB resident message limit; remove or shrink image attachments",
                                          })
                                        : unavailable(String(error)),
                                  })
                                  const sequence = nextCommandSequence
                                  nextCommandSequence += 1
                                  request.commands.set(sequence, done)
                                  yield* Effect.forEach(frames, write, { discard: true }).pipe(
                                    Effect.mapError((error) => unavailable(error.message)),
                                  )
                                  return sequence
                                }),
                              )
                              yield* Effect.raceFirst(
                                Deferred.await(done),
                                Deferred.await(closed).pipe(
                                  Effect.andThen(
                                    Effect.fail(
                                      unavailable("Resident connection closed before the command outcome was known"),
                                    ),
                                  ),
                                ),
                              ).pipe(
                                Effect.ensuring(
                                  Deferred.isDone(done).pipe(
                                    Effect.flatMap((completed) =>
                                      completed
                                        ? Effect.void
                                        : sendBestEffort(
                                            json({
                                              _tag: "cancel-interactive-command",
                                              connectionId: message.connectionId,
                                              requestId: message.requestId,
                                              sessionId: message.sessionId,
                                              feedGeneration: message.feedGeneration,
                                              commandSequence,
                                            } satisfies ResidentService.ClientMessage),
                                          ),
                                    ),
                                    Effect.andThen(Effect.sync(() => request.commands.delete(commandSequence))),
                                  ),
                                ),
                              )
                            })
                            const session: Operation.InteractiveSession = {
                              events: (dispatch) =>
                                Effect.suspend(() => {
                                  if (feed.consumerAttached)
                                    return Effect.fail(
                                      Operation.OperationUnavailable.make({
                                        operation: "InteractiveSession.events",
                                        message: "Interactive session already has an event consumer",
                                      }),
                                    )
                                  feed.consumerAttached = true
                                  const consume = Effect.gen(function* () {
                                    while (true) {
                                      const frames = yield* Queue.takeAll(feed.frames)
                                      const batchTails = new Map<string, (typeof frames)[number]>()
                                      for (const queued of frames) {
                                        yield* Effect.uninterruptible(
                                          Effect.sync(() => {
                                            if (queued._tag === "interactive-feed-event") dispatch(queued.event)
                                            else for (const event of queued.events) dispatch(event)
                                          }).pipe(
                                            Effect.andThen(
                                              queued._tag === "interactive-feed-event"
                                                ? traceInteractiveEvent(
                                                    "client.feed.event_dispatched",
                                                    dispatchedDeltas,
                                                    queued.event,
                                                  )
                                                : Effect.void,
                                            ),
                                          ),
                                        )
                                        batchTails.set(
                                          `${queued.connectionId} ${queued.requestId} ${queued.sessionId} ${queued.feedGeneration}`,
                                          queued,
                                        )
                                      }
                                      for (const queued of batchTails.values()) {
                                        yield* Effect.uninterruptible(
                                          write(
                                            json({
                                              _tag: "interactive-feed-ack",
                                              connectionId: queued.connectionId,
                                              requestId: queued.requestId,
                                              sessionId: queued.sessionId,
                                              feedGeneration: queued.feedGeneration,
                                              throughSequence: queued.sequence,
                                            } satisfies ResidentService.ClientMessage),
                                          ).pipe(Effect.mapError((error) => unavailable(error.message))),
                                        )
                                        if (queued.sequence % 1_024 === 0)
                                          yield* Effect.logInfo("resident.feed.ack_consumed").pipe(
                                            Effect.annotateLogs("rika.resident.feed.sequence", queued.sequence),
                                          )
                                      }
                                    }
                                  }).pipe(
                                    Effect.ensuring(
                                      Effect.sync(() => {
                                        feed.consumerAttached = false
                                      }),
                                    ),
                                  )
                                  return Effect.raceFirst(
                                    consume,
                                    Deferred.await(closed).pipe(
                                      Effect.andThen(Effect.fail(unavailable("Resident connection closed"))),
                                    ),
                                  )
                                }),
                              submit: (prompt, mode, promptParts, modelTuning) =>
                                invoke({
                                  _tag: "Submit",
                                  prompt,
                                  ...(mode === undefined ? {} : { mode }),
                                  ...(promptParts === undefined ? {} : { promptParts }),
                                  ...(modelTuning === undefined ? {} : { modelTuning }),
                                }),
                              shell: (command, incognito) => invoke({ _tag: "Shell", command, incognito }),
                              editQueued: (turnId, prompt) => invoke({ _tag: "EditQueued", turnId, prompt }),
                              dequeue: (turnId) => invoke({ _tag: "Dequeue", turnId }),
                              steerQueued: (turnId, text) => invoke({ _tag: "SteerQueued", turnId, text }),
                              steer: (text) => invoke({ _tag: "Steer", text }),
                              interruptAndSend: (prompt) => invoke({ _tag: "InterruptAndSend", prompt }),
                              cancel: invoke({ _tag: "Cancel" }),
                              newThread: invoke({ _tag: "NewThread" }),
                              resolvePermission: (waitId, kind, decision) =>
                                invoke({ _tag: "ResolvePermission", waitId, kind, decision }),
                              selectThread: (threadId, selectionEpoch) =>
                                invoke({ _tag: "SelectThread", threadId, selectionEpoch }),
                              readQueue: (threadId) => invoke({ _tag: "ReadQueue", threadId }),
                              loadOlder: invoke({ _tag: "LoadOlder" }),
                              previewThread: (threadId) => invoke({ _tag: "PreviewThread", threadId }),
                              reopenThread: (selectionEpoch) => invoke({ _tag: "ReopenThread", selectionEpoch }),
                              replay: (turnId, afterCursor) =>
                                invoke({
                                  _tag: "Replay",
                                  turnId,
                                  ...(afterCursor === undefined ? {} : { afterCursor }),
                                }),
                            }
                            if (request.interactiveStarted !== undefined)
                              yield* Deferred.succeed(request.interactiveStarted, {
                                sessionId: message.sessionId,
                                feedGeneration: message.feedGeneration,
                                session,
                              })
                          }
                          if (message._tag === "operation-completed" || message._tag === "operation-failed") {
                            if (message._tag === "operation-completed") yield* Deferred.succeed(request.done, undefined)
                            else yield* Deferred.fail(request.done, message.error)
                            for (const command of request.commands.values())
                              yield* Deferred.fail(
                                command,
                                message._tag === "operation-failed"
                                  ? message.error
                                  : Operation.OperationUnavailable.make({
                                      operation: "ResidentConnection",
                                      message: "Resident operation completed before the command outcome was known",
                                    }),
                              )
                            if (request.feed !== undefined) yield* Queue.shutdown(request.feed.frames)
                          }
                        }),
            ),
          ),
        ),
      { onOpen: write(handshake).pipe(Effect.ignore) },
    )
    .pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const failure = Schema.is(ResidentService.ResidentServiceError)(cause)
            ? cause
            : residentSocketFailure(cause, yield* Deferred.isDone(accepted))
          yield* Deferred.fail(connectionFailure, failure)
        }),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          const failure = transportError("Resident connection closed", "resident-absent")
          const operationFailure = Operation.OperationUnavailable.make({
            operation: "ResidentConnection",
            message: failure.message,
          })
          for (const waiter of (yield* Ref.get(pongs)).values()) yield* Deferred.fail(waiter, failure)
          for (const request of (yield* Ref.get(requests)).values()) {
            yield* Deferred.fail(request.done, operationFailure)
            if (request.interactiveStarted !== undefined) yield* Deferred.interrupt(request.interactiveStarted)
            for (const command of request.commands.values()) yield* Deferred.fail(command, operationFailure)
            if (request.feed !== undefined) yield* Queue.shutdown(request.feed.frames)
          }
          yield* Deferred.succeed(closed, undefined)
        }),
      ),
      Effect.forkIn(connectionScope),
    )
  const disconnected = Effect.raceFirst(
    Deferred.await(connectionFailure),
    Deferred.await(closed).pipe(
      Effect.andThen(Effect.fail(transportError("Resident connection closed", "resident-absent"))),
    ),
  )
  const whileConnected = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.raceFirst(effect, disconnected)
  const sendBestEffort = (frame: string | Socket.CloseEvent) =>
    writer(frame).pipe(Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.void }), Effect.ignore)
  const response = yield* Effect.raceFirst(Deferred.await(accepted), disconnected).pipe(
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => Effect.fail(transportError("Resident handshake timed out", "transport-failed")),
    }),
  )
  yield* Effect.logInfo("resident.connection.ready").pipe(
    Effect.annotateLogs({
      "rika.resident.client.kind": options.clientKind,
      "rika.resident.connection.id": response.connectionId,
      "rika.resident.connection.role": options.role,
    }),
  )
  const ping = Effect.acquireUseRelease(
    Effect.gen(function* () {
      const id = yield* crypto.randomUUIDv4
      const completed = yield* Deferred.make<void, ResidentService.ResidentServiceError>()
      yield* Ref.update(pongs, (current) => current.set(id, completed))
      yield* write(json({ _tag: "ping", id } satisfies ResidentService.ClientMessage))
      return { id, completed }
    }),
    ({ completed }) =>
      Deferred.await(completed).pipe(
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () => Effect.fail(transportError("Resident ping timed out")),
        }),
      ),
    ({ id }) => Ref.update(pongs, (current) => (current.delete(id), current)),
  ).pipe(
    Effect.mapError((cause) =>
      Schema.is(ResidentService.ResidentServiceError)(cause)
        ? cause
        : transportError(`Resident ping failed: ${String(cause)}`),
    ),
  )
  return {
    role: options.role,
    endpoint: options.url,
    connectionId: response.connectionId,
    ping,
    run: (input, runOptions) =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          const requestId = yield* crypto.randomUUIDv4
          const done = yield* Deferred.make<void, Operation.OperationUnavailable>()
          const interactiveStarted =
            runOptions?.interactive === undefined
              ? undefined
              : yield* Deferred.make<{
                  readonly sessionId: string
                  readonly feedGeneration: string
                  readonly session: Operation.InteractiveSession
                }>()
          yield* Ref.update(requests, (current) =>
            current.set(requestId, {
              done,
              ...(runOptions?.stdout === undefined ? {} : { stdout: runOptions.stdout }),
              ...(runOptions?.stderr === undefined ? {} : { stderr: runOptions.stderr }),
              ...(runOptions?.interactive === undefined ? {} : { interactive: runOptions.interactive }),
              ...(interactiveStarted === undefined ? {} : { interactiveStarted }),
              input,
              commands: new Map(),
            }),
          )
          yield* writeClientMessage(requestId, { _tag: "operation", requestId, input }, write)
          return { requestId, done, interactiveStarted }
        }),
        ({ requestId, done, interactiveStarted }) =>
          interactiveStarted === undefined || runOptions?.interactive === undefined
            ? whileConnected(Deferred.await(done))
            : Effect.raceFirst(
                whileConnected(Deferred.await(interactiveStarted)).pipe(
                  Effect.map((started) => ({ _tag: "Started" as const, started })),
                ),
                whileConnected(Deferred.await(done)).pipe(Effect.as({ _tag: "Completed" as const })),
              ).pipe(
                Effect.flatMap((state) =>
                  state._tag === "Completed"
                    ? Effect.void
                    : Effect.raceFirst(
                        whileConnected(
                          runOptions.interactive!(input as ResidentService.InteractiveInput, state.started.session),
                        ).pipe(
                          Effect.exit,
                          Effect.map((outcome) => ({ _tag: "Callback" as const, outcome })),
                        ),
                        whileConnected(Deferred.await(done)).pipe(
                          Effect.exit,
                          Effect.map((outcome) => ({ _tag: "Operation" as const, outcome })),
                        ),
                      ).pipe(
                        Effect.flatMap((completed) =>
                          completed._tag === "Operation"
                            ? completed.outcome
                            : sendBestEffort(
                                json({
                                  _tag: "interactive-end",
                                  connectionId: response.connectionId,
                                  requestId,
                                  sessionId: state.started.sessionId,
                                  feedGeneration: state.started.feedGeneration,
                                } satisfies ResidentService.ClientMessage),
                              ).pipe(Effect.andThen(completed.outcome)),
                        ),
                      ),
                ),
                Effect.andThen(whileConnected(Deferred.await(done))),
              ),
        ({ requestId }) =>
          sendBestEffort(json({ _tag: "cancel", requestId } satisfies ResidentService.ClientMessage)).pipe(
            Effect.andThen(Ref.update(requests, (current) => (current.delete(requestId), current))),
          ),
      ).pipe(
        Effect.mapError((error) =>
          Schema.is(Operation.OperationUnavailable)(error) ? error : transportError(String(error)),
        ),
      ),
    closed: Deferred.await(closed),
    close: closeConnection(
      closing,
      closed,
      rawWriter(new Socket.CloseEvent(1000)).pipe(Effect.ignore),
      Scope.close(connectionScope, Exit.void),
    ),
  } satisfies ResidentService.Connection
})

import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import { Operation, ResidentService } from "@rika/app"
import {
  Cause,
  Console,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Formatter,
  Layer,
  Queue,
  Ref,
  Schedule,
  Schema,
  Scope,
} from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { readOrCreateToken, resolve } from "./resident-endpoint"

const decodeClient = Schema.decodeUnknownSync(ResidentService.ClientMessage)
const decodeServer = Schema.decodeUnknownSync(ResidentService.ServerMessage)
const transportError = (message: string, reason: ResidentService.ResidentServiceError["reason"] = "transport-failed") =>
  new ResidentService.ResidentServiceError({ reason, message })
const json = (value: unknown) => JSON.stringify(value)
const parse = (value: string) => JSON.parse(value) as unknown
const formatOutput = (values: ReadonlyArray<unknown>) =>
  `${values.map((value) => (typeof value === "string" ? value : Formatter.format(value))).join(" ")}\n`

const host = Effect.fn("ResidentTransport.host")(function* (options: {
  readonly port: number
  readonly identity: string
  readonly token: string
  readonly graceMilliseconds: number
  readonly stopped: Deferred.Deferred<void>
  readonly ready: Deferred.Deferred<void>
  readonly owner: NonNullable<Parameters<ResidentService.Interface["getOrCreate"]>[0]["owner"]>
}) {
  const crypto = yield* Crypto.Crypto
  const baseConsole = yield* Console.Console
  const server = yield* BunHttpServer.make({ hostname: "127.0.0.1", port: options.port })
  const operationReady = yield* Deferred.make<Operation.Interface>()
  const serviceNonce = yield* crypto.randomUUIDv4
  const graceFiber = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined)
  const lifecycle = yield* ResidentService.makeLifecycle(() => Effect.void)
  const hostWork = yield* FiberSet.make<void, unknown>()
  const drainingFailure = (requestId: string, operation: string) =>
    writerFailure(requestId, new Operation.OperationUnavailable({ operation, message: "Resident service is draining" }))
  const writerFailure = (requestId: string, error: Operation.OperationUnavailable) =>
    json({ _tag: "operation-failed", requestId, error } satisfies ResidentService.ServerMessage)
  const scheduleGrace = (generation: number) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkDetach(
        Effect.sleep(options.graceMilliseconds).pipe(
          Effect.andThen(lifecycle.expireGrace(generation)),
          Effect.flatMap((draining) => (draining ? Deferred.succeed(options.stopped, undefined) : Effect.void)),
          Effect.asVoid,
        ),
      )
      yield* Ref.set(graceFiber, fiber)
    })
  const requestByInput = new WeakMap<object, string>()
  const routes = yield* Ref.make(
    new Map<
      string,
      {
        readonly send: (text: string) => Effect.Effect<void>
        readonly sessions: Map<string, { session: Operation.InteractiveSession; ended: Deferred.Deferred<void> }>
      }
    >(),
  )
  const interactive = Effect.fn("ResidentTransport.interactive")(function* (
    input: ResidentService.InteractiveInput,
    session: Operation.InteractiveSession,
  ) {
    const requestId = requestByInput.get(input)
    if (requestId === undefined)
      return yield* new Operation.OperationUnavailable({
        operation: "Interactive",
        message: "Missing interactive request",
      })
    const route = (yield* Ref.get(routes)).get(requestId)
    if (route === undefined)
      return yield* new Operation.OperationUnavailable({
        operation: "Interactive",
        message: "Interactive client disconnected",
      })
    const sessionId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (error) => new Operation.OperationUnavailable({ operation: "Interactive", message: String(error) }),
      ),
    )
    const ended = yield* Deferred.make<void>()
    route.sessions.set(sessionId, { session, ended })
    yield* route.send(
      json({ _tag: "interactive-started", requestId, sessionId } satisfies ResidentService.ServerMessage),
    )
    yield* Deferred.await(ended).pipe(Effect.ensuring(Effect.sync(() => route.sessions.delete(sessionId))))
  })
  const handle = Effect.fn("ResidentTransport.connection")(function* (socket: Socket.Socket) {
    const writer = yield* socket.writer
    const attached = yield* Ref.make(false)
    const requests = yield* Ref.make(new Map<string, Fiber.Fiber<void, unknown>>())
    const actions = yield* Ref.make(
      new Map<
        string,
        {
          readonly requestId: string
          readonly sessionId: string
          readonly fiber: Fiber.Fiber<void, unknown>
        }
      >(),
    )
    const connectionId = yield* crypto.randomUUIDv4
    const close = (code: number) => writer(new Socket.CloseEvent(code))
    yield* socket
      .runString((text) =>
        Effect.gen(function* () {
          let message: ResidentService.ClientMessage
          try {
            message = decodeClient(parse(text))
          } catch {
            return yield* close(4400)
          }
          if (!(yield* Ref.get(attached))) {
            if (!("family" in message)) return yield* close(4401)
            const result = ResidentService.validateHandshake(message, {
              identity: options.identity,
              token: options.token,
              capabilities: ["ping"],
            })
            if (result._tag !== "Accepted") return yield* close(result._tag === "UpgradeRequired" ? 4403 : 4401)
            if (!(yield* lifecycle.tryAttach)) {
              yield* writer(json({ _tag: "rejected", reason: "draining" } satisfies ResidentService.HandshakeRejected))
              return yield* close(4409)
            }
            yield* Ref.set(attached, true)
            yield* Deferred.await(operationReady)
            const existing = yield* Ref.get(graceFiber)
            if (existing !== undefined) yield* Fiber.interrupt(existing)
            yield* Ref.set(graceFiber, undefined)
            return yield* writer(
              json({
                _tag: "accepted",
                family: "rika-resident",
                version: ResidentService.protocolVersion,
                identity: options.identity,
                clientNonce: message.clientNonce,
                serviceNonce,
                connectionId,
                state: "ready",
                capabilities: ["ping"],
              } satisfies ResidentService.HandshakeAccepted),
            )
          }
          if (!("_tag" in message)) return
          if (message._tag === "ping") yield* writer(json({ _tag: "pong", id: message.id }))
          if (message._tag === "cancel") {
            const fiber = (yield* Ref.get(requests)).get(message.requestId)
            if (fiber !== undefined) yield* Fiber.interrupt(fiber)
          }
          if (message._tag === "interactive-end") {
            const active = (yield* Ref.get(routes)).get(message.requestId)?.sessions.get(message.sessionId)
            if (active !== undefined) yield* Deferred.succeed(active.ended, undefined)
          }
          if (message._tag === "cancel-interactive-action") {
            const active = (yield* Ref.get(actions)).get(message.actionId)
            if (
              active !== undefined &&
              active.requestId === message.requestId &&
              active.sessionId === message.sessionId
            )
              yield* Fiber.interrupt(active.fiber)
          }
          if (message._tag === "interactive-action") {
            const active = (yield* Ref.get(routes)).get(message.requestId)?.sessions.get(message.sessionId)
            if (active === undefined) return
            const dispatch = (event: Operation.InteractiveEvent) => {
              Effect.runFork(
                writer(
                  json({
                    _tag: "interactive-event",
                    requestId: message.requestId,
                    sessionId: message.sessionId,
                    actionId: message.actionId,
                    event,
                  } satisfies ResidentService.ServerMessage),
                ),
              )
            }
            const args = message.arguments
            const action = (() => {
              switch (message.method) {
                case "initialize":
                  return active.session.initialize(dispatch)
                case "submit":
                  return active.session.submit(
                    args[0] as string,
                    dispatch,
                    args[1] as "low" | "medium" | "high" | "ultra" | undefined,
                    args[2] as ReadonlyArray<import("@rika/persistence/turn").PromptPart> | undefined,
                    args[3] as { readonly reasoningEffort?: string; readonly fastMode?: boolean } | undefined,
                  )
                case "shell":
                  return active.session.shell(args[0] as string, args[1] as boolean, dispatch)
                case "editQueued":
                  return active.session.editQueued(args[0] as string, args[1] as string, dispatch)
                case "dequeue":
                  return active.session.dequeue(args[0] as string, dispatch)
                case "steerQueued":
                  return active.session.steerQueued(args[0] as string, args[1] as string, dispatch)
                case "steer":
                  return active.session.steer(args[0] as string, dispatch)
                case "interruptAndSend":
                  return active.session.interruptAndSend(args[0] as string, dispatch)
                case "cancel":
                  return active.session.cancel(dispatch)
                case "resolvePermission":
                  return active.session.resolvePermission(
                    args[0] as string,
                    args[1] as "permission" | "tool-approval",
                    args[2] as "allow" | "deny" | "always",
                    dispatch,
                  )
                case "selectThread":
                  return active.session.selectThread(args[0] as string, dispatch)
                case "previewThread":
                  return active.session.previewThread(args[0] as string, dispatch)
                case "reopenThread":
                  return active.session.reopenThread(dispatch)
                case "followSelected":
                  return active.session.followSelected(dispatch)
                case "replay":
                  return active.session.replay(args[0] as string, args[1] as string | undefined, dispatch)
                default:
                  return Effect.void
              }
            })()
            const started = yield* Deferred.make<void>()
            const actionFiber = yield* lifecycle.runWork(
              hostWork,
              Deferred.await(started).pipe(
                Effect.andThen(
                  action.pipe(
                    Effect.andThen(
                      writer(
                        json({
                          _tag: "action-completed",
                          requestId: message.requestId,
                          sessionId: message.sessionId,
                          actionId: message.actionId,
                        } satisfies ResidentService.ServerMessage),
                      ),
                    ),
                    Effect.asVoid,
                  ),
                ),
                Effect.ensuring(Ref.update(actions, (current) => (current.delete(message.actionId), current))),
              ),
            )
            if (actionFiber === undefined) {
              yield* writer(
                json({
                  _tag: "action-failed",
                  requestId: message.requestId,
                  sessionId: message.sessionId,
                  actionId: message.actionId,
                  error: new Operation.OperationUnavailable({
                    operation: message.method,
                    message: "Resident service is draining",
                  }),
                } satisfies ResidentService.ServerMessage),
              )
              return
            }
            yield* Ref.update(actions, (current) =>
              current.set(message.actionId, {
                requestId: message.requestId,
                sessionId: message.sessionId,
                fiber: actionFiber,
              }),
            )
            yield* Deferred.succeed(started, undefined)
          }
          if (message._tag === "operation") {
            requestByInput.set(message.input, message.requestId)
            const send = (frame: string) => writer(frame).pipe(Effect.catch(() => Effect.void))
            yield* Ref.update(routes, (current) =>
              current.set(message.requestId, {
                send,
                sessions: new Map(),
              }),
            )
            const fiber = yield* lifecycle.runWork(
              hostWork,
              Effect.gen(function* () {
                const operation = yield* Deferred.await(operationReady)
                const output = yield* Queue.unbounded<
                  | { readonly _tag: "output"; readonly channel: "stdout" | "stderr"; readonly text: string }
                  | { readonly _tag: "finished" }
                >()
                const write = (channel: "stdout" | "stderr", values: ReadonlyArray<unknown>) =>
                  Queue.offerUnsafe(output, { _tag: "output", channel, text: formatOutput(values) })
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
                      yield* send(
                        json({
                          _tag: "output",
                          requestId: message.requestId,
                          channel: frame.channel,
                          text: frame.text,
                        } satisfies ResidentService.ServerMessage),
                      )
                    }
                  }),
                )
                const result = yield* Effect.exit(
                  operation.run(message.input).pipe(Effect.provideService(Console.Console, requestConsole)),
                )
                Queue.offerUnsafe(output, { _tag: "finished" })
                yield* Fiber.join(sender)
                yield* Exit.match(result, {
                  onFailure: (cause) => {
                    const failure = Cause.squash(cause)
                    const error =
                      failure instanceof Operation.OperationUnavailable
                        ? failure
                        : new Operation.OperationUnavailable({
                            operation: message.input._tag,
                            message: String(failure),
                          })
                    return send(
                      json({
                        _tag: "operation-failed",
                        requestId: message.requestId,
                        error,
                      } satisfies ResidentService.ServerMessage),
                    )
                  },
                  onSuccess: () =>
                    send(
                      json({
                        _tag: "operation-completed",
                        requestId: message.requestId,
                      } satisfies ResidentService.ServerMessage),
                    ),
                })
              }).pipe(
                Effect.ensuring(
                  Ref.update(requests, (current) => (current.delete(message.requestId), current)).pipe(
                    Effect.andThen(Ref.update(routes, (current) => (current.delete(message.requestId), current))),
                    Effect.andThen(Effect.sync(() => requestByInput.delete(message.input))),
                  ),
                ),
                Effect.asVoid,
              ),
            )
            if (fiber === undefined) {
              yield* Ref.update(routes, (current) => (current.delete(message.requestId), current))
              requestByInput.delete(message.input)
              yield* writer(drainingFailure(message.requestId, message.input._tag))
              return
            }
            yield* Ref.update(requests, (current) => current.set(message.requestId, fiber))
          }
        }),
      )
      .pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (!(yield* Ref.get(attached))) return
            const activeRequests = yield* Ref.get(requests)
            for (const fiber of activeRequests.values()) yield* Fiber.interrupt(fiber)
            const activeActions = yield* Ref.get(actions)
            for (const action of activeActions.values()) yield* Fiber.interrupt(action.fiber)
            yield* Ref.update(routes, (current) => {
              for (const requestId of activeRequests.keys()) current.delete(requestId)
              return current
            })
            const generation = yield* lifecycle.detach
            if (generation === undefined) return
            yield* scheduleGrace(generation)
          }),
        ),
      )
  })

  const app = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.url !== "/resident/v1") return HttpServerResponse.empty({ status: 404 })
    const socket = yield* request.upgrade
    yield* handle(socket)
    return HttpServerResponse.empty()
  })
  yield* server.serve(app)
  const ownerScope = yield* Scope.make()
  yield* Effect.addFinalizer((exit) => Scope.close(ownerScope, exit))
  const operation = yield* Scope.provide(options.owner(interactive), ownerScope)
  yield* Effect.addFinalizer(() =>
    lifecycle.beginDrain.pipe(Effect.andThen(FiberSet.clear(hostWork)), Effect.andThen(FiberSet.awaitEmpty(hostWork))),
  )
  const startupGrace = yield* lifecycle.ready
  if (startupGrace !== undefined) yield* scheduleGrace(startupGrace)
  yield* Deferred.succeed(operationReady, operation)
  yield* Deferred.succeed(options.ready, undefined)
  yield* Deferred.await(options.stopped)
})

const connect = Effect.fn("ResidentTransport.connect")(function* (options: {
  readonly url: string
  readonly identity: string
  readonly token: string
  readonly clientKind: ResidentService.Handshake["clientKind"]
  readonly clientVersion: string
  readonly role: ResidentService.Connection["role"]
}) {
  const crypto = yield* Crypto.Crypto
  const connectionScope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(connectionScope, Exit.void))
  const socket = yield* Socket.makeWebSocket(options.url).pipe(Effect.provide(BunSocket.layerWebSocketConstructor))
  const writer = yield* Scope.provide(socket.writer, connectionScope)
  const accepted = yield* Deferred.make<ResidentService.HandshakeAccepted>()
  const clientNonce = yield* crypto.randomUUIDv4
  const closed = yield* Deferred.make<void>()
  const connectionFailure = yield* Deferred.make<never, ResidentService.ResidentServiceError>()
  const pongs = yield* Ref.make(new Map<string, Deferred.Deferred<void>>())
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
          readonly session: Operation.InteractiveSession
        }>
        readonly input: Operation.Input
        readonly actions: Map<
          string,
          {
            readonly done: Deferred.Deferred<void, Operation.OperationUnavailable>
            readonly dispatch: (event: Operation.InteractiveEvent) => void
          }
        >
      }
    >(),
  )
  const handshake = json({
    family: "rika-resident",
    version: ResidentService.protocolVersion,
    identity: options.identity,
    token: options.token,
    clientNonce,
    clientKind: options.clientKind,
    clientVersion: options.clientVersion,
    capabilities: ["ping"],
  } satisfies ResidentService.Handshake)
  yield* socket
    .runString(
      (frame) =>
        Effect.try({
          try: () => decodeServer(parse(frame)),
          catch: () => transportError("Invalid resident response"),
        }).pipe(
          Effect.flatMap((message) =>
            message._tag === "accepted"
              ? message.identity !== options.identity || message.clientNonce !== clientNonce
                ? Effect.fail(transportError("Foreign resident listener", "foreign-listener"))
                : Deferred.succeed(accepted, message)
              : message._tag === "rejected"
                ? Deferred.fail(connectionFailure, transportError("Resident service is draining", "resident-draining"))
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
                      if (message._tag === "interactive-event")
                        request.actions.get(message.actionId)?.dispatch(message.event as Operation.InteractiveEvent)
                      if (message._tag === "action-completed") {
                        const action = request.actions.get(message.actionId)
                        if (action !== undefined) yield* Deferred.succeed(action.done, undefined)
                      }
                      if (message._tag === "action-failed") {
                        const action = request.actions.get(message.actionId)
                        if (action !== undefined) yield* Deferred.fail(action.done, message.error)
                      }
                      if (
                        message._tag === "interactive-started" &&
                        request.input._tag === "Interactive" &&
                        request.interactive !== undefined
                      ) {
                        const invoke = Effect.fn("ResidentTransport.interactiveAction")(function* (
                          method: string,
                          args: ReadonlyArray<unknown>,
                          dispatch: (event: Operation.InteractiveEvent) => void,
                        ) {
                          const actionId = yield* crypto.randomUUIDv4
                          const done = yield* Deferred.make<void, Operation.OperationUnavailable>()
                          request.actions.set(actionId, { done, dispatch })
                          yield* writer(
                            json({
                              _tag: "interactive-action",
                              requestId: message.requestId,
                              sessionId: message.sessionId,
                              actionId,
                              method,
                              arguments: args,
                            } satisfies ResidentService.ClientMessage),
                          ).pipe(Effect.catch(() => Effect.void))
                          yield* Effect.raceFirst(Deferred.await(done), Deferred.await(closed)).pipe(
                            Effect.ensuring(
                              Deferred.isDone(done).pipe(
                                Effect.flatMap((completed) =>
                                  completed
                                    ? Effect.void
                                    : sendBestEffort(
                                        json({
                                          _tag: "cancel-interactive-action",
                                          requestId: message.requestId,
                                          sessionId: message.sessionId,
                                          actionId,
                                        } satisfies ResidentService.ClientMessage),
                                      ),
                                ),
                                Effect.andThen(Effect.sync(() => request.actions.delete(actionId))),
                              ),
                            ),
                          )
                        })
                        const safeInvoke = (
                          method: string,
                          args: ReadonlyArray<unknown>,
                          dispatch: (event: Operation.InteractiveEvent) => void,
                        ) => invoke(method, args, dispatch).pipe(Effect.catch(() => Effect.void))
                        const session: Operation.InteractiveSession = {
                          initialize: (dispatch) => safeInvoke("initialize", [], dispatch),
                          submit: (prompt, dispatch, mode, parts, tuning) =>
                            safeInvoke("submit", [prompt, mode, parts, tuning], dispatch),
                          shell: (command, incognito, dispatch) => safeInvoke("shell", [command, incognito], dispatch),
                          editQueued: (turnId, prompt, dispatch) =>
                            safeInvoke("editQueued", [turnId, prompt], dispatch),
                          dequeue: (turnId, dispatch) => safeInvoke("dequeue", [turnId], dispatch),
                          steerQueued: (turnId, text, dispatch) => safeInvoke("steerQueued", [turnId, text], dispatch),
                          steer: (text, dispatch) => safeInvoke("steer", [text], dispatch),
                          interruptAndSend: (prompt, dispatch) => safeInvoke("interruptAndSend", [prompt], dispatch),
                          cancel: (dispatch) => safeInvoke("cancel", [], dispatch),
                          resolvePermission: (waitId, kind, decision, dispatch) =>
                            safeInvoke("resolvePermission", [waitId, kind, decision], dispatch),
                          selectThread: (threadId, dispatch) => safeInvoke("selectThread", [threadId], dispatch),
                          previewThread: (threadId, dispatch) => safeInvoke("previewThread", [threadId], dispatch),
                          reopenThread: (dispatch) => safeInvoke("reopenThread", [], dispatch),
                          followSelected: (dispatch) => safeInvoke("followSelected", [], dispatch),
                          replay: (turnId, afterCursor, dispatch) =>
                            safeInvoke("replay", [turnId, afterCursor], dispatch),
                        }
                        if (request.interactiveStarted !== undefined)
                          yield* Deferred.succeed(request.interactiveStarted, {
                            sessionId: message.sessionId,
                            session,
                          })
                      }
                      if (message._tag === "operation-completed") yield* Deferred.succeed(request.done, undefined)
                      if (message._tag === "operation-failed") yield* Deferred.fail(request.done, message.error)
                    }),
          ),
        ),
      { onOpen: writer(handshake).pipe(Effect.catch(() => Effect.void)) },
    )
    .pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const failure =
            cause instanceof ResidentService.ResidentServiceError
              ? cause
              : transportError(
                  String(cause),
                  (yield* Deferred.isDone(accepted)) ? "transport-failed" : "resident-absent",
                )
          yield* Deferred.fail(connectionFailure, failure)
        }),
      ),
      Effect.ensuring(Deferred.succeed(closed, undefined)),
      Effect.forkDetach,
    )
  const disconnected = Effect.raceFirst(
    Deferred.await(connectionFailure),
    Deferred.await(closed).pipe(
      Effect.andThen(Effect.fail(transportError("Resident connection closed", "resident-absent"))),
    ),
  )
  const whileConnected = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.raceFirst(effect, disconnected)
  const sendBestEffort = (frame: string | Socket.CloseEvent) =>
    writer(frame).pipe(
      Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.void }),
      Effect.catch(() => Effect.void),
    )
  const response = yield* Effect.raceFirst(Deferred.await(accepted), disconnected).pipe(
    Effect.timeoutOrElse({
      duration: 5_000,
      orElse: () => Effect.fail(transportError("Foreign resident listener", "foreign-listener")),
    }),
  )
  const ping = Effect.acquireUseRelease(
    Effect.gen(function* () {
      const id = yield* crypto.randomUUIDv4
      const completed = yield* Deferred.make<void>()
      yield* Ref.update(pongs, (current) => current.set(id, completed))
      yield* writer(json({ _tag: "ping", id } satisfies ResidentService.ClientMessage))
      return { id, completed }
    }),
    ({ completed }) =>
      Deferred.await(completed).pipe(
        Effect.timeoutOrElse({
          duration: 1_000,
          orElse: () => Effect.fail(transportError("Resident ping timed out")),
        }),
      ),
    ({ id }) => Ref.update(pongs, (current) => (current.delete(id), current)),
  ).pipe(
    Effect.mapError((cause) =>
      cause instanceof ResidentService.ResidentServiceError
        ? cause
        : transportError(`Resident ping failed: ${String(cause)}`),
    ),
  )
  yield* Effect.forkIn(
    ping.pipe(
      Effect.repeat({ schedule: Schedule.spaced("250 millis") }),
      Effect.catch((cause) => Deferred.fail(connectionFailure, cause)),
    ),
    connectionScope,
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
              : yield* Deferred.make<{ readonly sessionId: string; readonly session: Operation.InteractiveSession }>()
          yield* Ref.update(requests, (current) =>
            current.set(requestId, {
              done,
              ...(runOptions?.stdout === undefined ? {} : { stdout: runOptions.stdout }),
              ...(runOptions?.stderr === undefined ? {} : { stderr: runOptions.stderr }),
              ...(runOptions?.interactive === undefined ? {} : { interactive: runOptions.interactive }),
              ...(interactiveStarted === undefined ? {} : { interactiveStarted }),
              input,
              actions: new Map(),
            }),
          )
          yield* writer(json({ _tag: "operation", requestId, input } satisfies ResidentService.ClientMessage))
          return { requestId, done, interactiveStarted }
        }),
        ({ requestId, done, interactiveStarted }) =>
          interactiveStarted === undefined || runOptions?.interactive === undefined
            ? whileConnected(Deferred.await(done))
            : whileConnected(Deferred.await(interactiveStarted)).pipe(
                Effect.flatMap(({ sessionId, session }) =>
                  whileConnected(runOptions.interactive!(input as ResidentService.InteractiveInput, session)).pipe(
                    Effect.ensuring(
                      sendBestEffort(
                        json({
                          _tag: "interactive-end",
                          requestId,
                          sessionId,
                        } satisfies ResidentService.ClientMessage),
                      ),
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
          error instanceof Operation.OperationUnavailable ? error : transportError(String(error)),
        ),
      ),
    closed: Deferred.await(closed),
    close: sendBestEffort(new Socket.CloseEvent(1000)).pipe(Effect.ensuring(Scope.close(connectionScope, Exit.void))),
  } satisfies ResidentService.Connection
})

export const make = Effect.fn("ResidentTransport.make")(() =>
  Effect.succeed(
    ResidentService.Service.of({
      getOrCreate: (input) =>
        Effect.gen(function* () {
          const endpoint = yield* resolve(input.profile, input.dataRoot)
          const token = yield* readOrCreateToken(endpoint.tokenPath)
          const attach = (role: ResidentService.Connection["role"]) => connect({ ...endpoint, ...input, token, role })
          const first = yield* Effect.result(attach("attached"))
          if (first._tag === "Success") return first.success
          if (first.failure.reason !== "resident-absent") return yield* Effect.fail(first.failure)
          if (input.startHost === undefined && input.owner === undefined) return yield* Effect.fail(first.failure)
          if (input.startHost !== undefined) {
            yield* input.startHost()
            return yield* attach("attached").pipe(Effect.retry({ times: 400, schedule: Schedule.spaced(25) }))
          }
          const stopped = yield* Deferred.make<void>()
          const ready = yield* Deferred.make<void>()
          if (input.owner === undefined)
            return yield* Effect.fail(transportError("Resident owner operation layer is unavailable"))
          const owner = yield* host({
            ...endpoint,
            token,
            graceMilliseconds: input.graceMilliseconds ?? 500,
            stopped,
            ready,
            owner: input.owner,
          }).pipe(Effect.scoped, Effect.exit, Effect.forkDetach)
          const ownsListener = yield* Effect.raceFirst(
            Deferred.await(ready).pipe(Effect.as(true)),
            Fiber.join(owner).pipe(Effect.as(false)),
          )
          const connection = yield* attach(ownsListener ? "owner" : "attached").pipe(
            Effect.retry({ times: 20, schedule: Schedule.spaced(25) }),
            Effect.catch(() => attach("attached")),
          )
          return connection
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof ResidentService.ResidentServiceError ? cause : transportError(String(cause)),
          ),
        ),
    }),
  ),
)

export const layer = Layer.effect(ResidentService.Service, make())

export const serve = Effect.fn("ResidentTransport.serve")(function* (options: {
  readonly profile: string
  readonly dataRoot: string
  readonly graceMilliseconds?: number
  readonly owner: NonNullable<Parameters<ResidentService.Interface["getOrCreate"]>[0]["owner"]>
}) {
  const endpoint = yield* resolve(options.profile, options.dataRoot)
  const token = yield* readOrCreateToken(endpoint.tokenPath)
  const stopped = yield* Deferred.make<void>()
  const ready = yield* Deferred.make<void>()
  yield* host({
    ...endpoint,
    token,
    graceMilliseconds: options.graceMilliseconds ?? 500,
    stopped,
    ready,
    owner: options.owner,
  })
})

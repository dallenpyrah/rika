import * as Operation from "@rika/app/operation-contract"
import * as ResidentService from "@rika/app/resident-service"
import { Crypto, Deferred, Duration, Effect, Function, Queue, Schedule, Schema } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { clientMessageFrames, json, parse, transportError } from "../resident-wire"

export const makeHandshake = (options: {
  readonly identity: string
  readonly token: string
  readonly clientKind: ResidentService.Handshake["clientKind"]
  readonly clientNonce: string
}) =>
  json({
    family: "rika-resident",
    identity: options.identity,
    clientNonce: options.clientNonce,
    clientKind: options.clientKind,
    protocolVersion: ResidentService.protocolVersion,
    buildIdentity: ResidentService.buildIdentity,
    clientProof: ResidentService.clientProof(options.token, {
      identity: options.identity,
      clientNonce: options.clientNonce,
      clientKind: options.clientKind,
      protocolVersion: ResidentService.protocolVersion,
      buildIdentity: ResidentService.buildIdentity,
    }),
  } satisfies ResidentService.Handshake)

const writeClientMessage = (
  messageId: string,
  message: ResidentService.ClientMessage,
  write: (frame: string) => Effect.Effect<void, ResidentService.ResidentServiceError>,
) =>
  Effect.try({
    try: () => clientMessageFrames(messageId, message),
    catch: (error) => (Schema.is(ResidentService.ResidentServiceError)(error) ? error : transportError(String(error))),
  }).pipe(Effect.flatMap(Effect.forEach((frame) => write(frame), { discard: true })))

const closeConnection = (
  closing: Deferred.Deferred<void>,
  closed: Deferred.Deferred<void>,
  closeSocket: Effect.Effect<void>,
  release: Effect.Effect<void>,
) =>
  Deferred.isDone(closing).pipe(
    Effect.flatMap((alreadyClosing) =>
      alreadyClosing
        ? Deferred.await(closed)
        : Deferred.succeed(closing, undefined).pipe(
            Effect.andThen(closeSocket),
            Effect.andThen(Deferred.await(closed)),
          ),
    ),
    Effect.timeoutOrElse({ duration: "500 millis", orElse: () => Effect.void }),
    Effect.ensuring(release),
  )

const mapResidentSocketFailure = (cause: unknown, accepted: boolean): ResidentService.ResidentServiceError => {
  if (Socket.SocketError.is(cause) && cause.reason._tag === "SocketCloseError") {
    if (cause.reason.code === 4409 || cause.reason.code === 1001)
      return transportError("Resident service is draining", "resident-draining")
    if (cause.reason.code === 4406)
      return transportError(
        cause.reason.closeReason ??
          "An incompatible Rika resident is still running; close other Rika clients, then run rika again",
        "incompatible-resident",
      )
    if (cause.reason.code === 4401)
      return transportError(
        cause.reason.closeReason ??
          "A Rika resident with different credentials is still running; close other Rika clients, then run rika again",
        "foreign-listener",
      )
  }
  return transportError(String(cause), accepted ? "transport-failed" : "resident-absent")
}

export const residentSocketFailure: {
  (accepted: boolean): (cause: unknown) => ResidentService.ResidentServiceError
  (cause: unknown, accepted: boolean): ResidentService.ResidentServiceError
} = Function.dual(2, mapResidentSocketFailure)

export const reconnectFailureLimit = 8
export const reconnectStableMilliseconds = 30_000
export const reconnectSchedule = Schedule.exponential("25 millis").pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(1)))),
)

export const isDisconnectedOperation = (error: unknown) =>
  Schema.is(Operation.OperationUnavailable)(error) && error.operation === "ResidentConnection"

export const isReconnectableTransport = (error: unknown) =>
  Schema.is(ResidentService.ResidentServiceError)(error) &&
  (error.reason === "resident-absent" || error.reason === "resident-draining" || error.reason === "transport-failed")

export const ignoreInteractiveEvent = (_event: Operation.InteractiveEvent) => {}

const tracedEventTypes = new Set([
  "model.reasoning.delta",
  "model.output.delta",
  "model.toolcall.delta",
  "tool.call.requested",
  "tool.result.received",
])

const traceInteractiveEvent = (name: string, seenDeltas: Set<string>, event: Operation.InteractiveEvent) => {
  if (event._tag !== "TranscriptPatched" || !tracedEventTypes.has(event.event.type)) return Effect.void
  const delta = event.event.type.endsWith(".delta")
  const key = `${event.turnId}:${event.event.type}`
  if (delta && seenDeltas.has(key)) return Effect.void
  if (delta) seenDeltas.add(key)
  return Effect.logInfo(name).pipe(
    Effect.annotateLogs({
      "rika.event.cursor": event.event.cursor,
      "rika.event.type": event.event.type,
      "rika.thread.id": String(event.threadId),
      "rika.turn.id": String(event.turnId),
    }),
  )
}

export type InteractiveFeedFrame = Extract<
  ResidentService.ServerMessage,
  { readonly _tag: "interactive-feed-event" | "interactive-feed-resync" }
>
export type PhysicalFeed = {
  readonly sessionId: string
  readonly generation: string
  readonly frames: Queue.Queue<InteractiveFeedFrame>
  expectedSequence: number
  replayRequestedAfter: number | undefined
  consumerAttached: boolean
}
const legacyCapabilities = ["ping", "startup-state", "transcript-pages", "interactive-ack"]
const probeWebSocket = (url: string, handshake: string, matches: (text: string) => boolean) =>
  Effect.callback<boolean>((resume) => {
    const socket = new WebSocket(url)
    let settled = false
    const finish = (matched: boolean) => {
      if (settled) return
      settled = true
      socket.close()
      resume(Effect.succeed(matched))
    }
    socket.addEventListener("open", () => socket.send(handshake))
    socket.addEventListener("message", (event) => finish(matches(String(event.data))))
    socket.addEventListener("close", () => finish(false))
    socket.addEventListener("error", () => finish(false))
    return Effect.sync(() => {
      settled = true
      socket.close()
    })
  }).pipe(Effect.timeoutOrElse({ duration: "750 millis", orElse: () => Effect.succeed(false) }))

export const internal = { closeConnection, traceInteractiveEvent, writeClientMessage }

export const probeLegacyResident = Effect.fn("ResidentTransport.probeLegacyResident")(function* (options: {
  readonly urls: ReadonlyArray<string>
  readonly identity: string
  readonly token: string
  readonly clientKind: ResidentService.Handshake["clientKind"]
}) {
  const crypto = yield* Crypto.Crypto
  for (const url of options.urls) {
    const clientNonce = yield* crypto.randomUUIDv4
    const matched = yield* probeWebSocket(
      url,
      json({
        family: "rika-resident",
        version: { major: 1, minor: 0 },
        identity: options.identity,
        token: options.token,
        clientNonce,
        clientKind: options.clientKind,
        clientVersion: "resident-upgrade",
        capabilities: legacyCapabilities,
      }),
      (text) => {
        const message = parse(text)
        return (
          message !== null &&
          typeof message === "object" &&
          "_tag" in message &&
          message._tag === "accepted" &&
          "family" in message &&
          message.family === "rika-resident" &&
          "identity" in message &&
          message.identity === options.identity &&
          "clientNonce" in message &&
          message.clientNonce === clientNonce
        )
      },
    )
    if (matched) return true
  }
  return false
})

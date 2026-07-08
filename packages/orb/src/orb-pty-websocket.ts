import { createHash, timingSafeEqual } from "node:crypto"
import { Diagnostics } from "@rika/core"
import { Cause, Effect, Fiber, Queue, Schema } from "effect"
import * as OrbPty from "./orb-pty"

export interface OrbPtyRouteMode {
  readonly workspace_root: string
}

export interface OrbPtySocketData {
  readonly pty: OrbPty.Interface
  readonly diagnostics: Diagnostics.Interface
  readonly workspace_root: string
  readonly cols: number
  readonly rows: number
  closed: boolean
  pendingMessages: Array<OrbPtyClientMessage>
  openFiber?: Fiber.Fiber<void>
  outputQueue?: Queue.Queue<Uint8Array>
  drainQueue?: Queue.Queue<void>
  forwarder?: Fiber.Fiber<void>
  session?: OrbPty.Session
}

export interface OrbPtyUpgradeServer {
  readonly upgrade: (request: Request, options: { readonly data: OrbPtySocketData }) => boolean
}

export type OrbPtyUpgradeResult =
  | { readonly _tag: "not_matched" }
  | { readonly _tag: "response"; readonly response: Response }
  | { readonly _tag: "upgraded" }

export interface OrbPtyWebSocket {
  readonly data: OrbPtySocketData
  readonly send: (bytes: Uint8Array) => number
  readonly close: (code?: number, reason?: string) => void
}

interface ResizeControl extends Schema.Schema.Type<typeof ResizeControl> {}
const ResizeControl = Schema.Struct({
  type: Schema.Literal("resize"),
  cols: Schema.Int,
  rows: Schema.Int,
}).annotate({ identifier: "Rika.Orb.OrbPtyWebSocket.ResizeControl" })

type OrbPtyClientMessage =
  | { readonly type: "resize"; readonly cols: number; readonly rows: number }
  | { readonly type: "write"; readonly bytes: Uint8Array }

const orbPtyOutputQueueSize = 256
const orbPtyPendingMessageLimit = 256

const emptyOrbPtySocketData: OrbPtySocketData = {
  pty: OrbPty.Service.of({
    open: () =>
      Effect.fail(
        new OrbPty.OrbPtyError({
          message: "PTY socket data was not initialized",
          operation: "open",
        }),
      ),
  }),
  diagnostics: Diagnostics.Service.of({
    emit: () => Effect.die(new Error("PTY socket diagnostics were not initialized")),
    redactEntry: () => {
      throw new Error("PTY socket diagnostics were not initialized")
    },
    redactFields: () => {
      throw new Error("PTY socket diagnostics were not initialized")
    },
  }),
  workspace_root: "",
  cols: 80,
  rows: 24,
  closed: true,
  pendingMessages: [],
}

export const orbPtyWebSocketHandler: Bun.WebSocketHandler<OrbPtySocketData> = {
  data: emptyOrbPtySocketData,
  open: openOrbPtyWebSocket,
  message: messageOrbPtyWebSocket,
  drain: drainOrbPtyWebSocket,
  close: closeOrbPtyWebSocketHandler,
}

export const upgradeOrbPty = (
  orbPty: OrbPty.Interface | undefined,
  diagnostics: Diagnostics.Interface,
  request: Request,
  server: OrbPtyUpgradeServer,
  requiredToken: string | undefined,
  orbMode: OrbPtyRouteMode | undefined,
): OrbPtyUpgradeResult => {
  const url = new URL(request.url)
  if (request.method !== "GET" || url.pathname !== "/v1/orb/pty") return { _tag: "not_matched" }
  if (orbMode === undefined) return { _tag: "response", response: notFound() }
  const required = tokenValue(requiredToken)
  if (required !== undefined && !constantTimeTokenEquals(url.searchParams.get("token"), required))
    return { _tag: "response", response: unauthorizedJson() }
  if (orbPty === undefined)
    return {
      _tag: "response",
      response: json({ error: { message: "PTY service unavailable", code: "pty_unavailable" } }, 503),
    }
  const upgraded = server.upgrade(request, {
    data: {
      pty: orbPty,
      diagnostics,
      workspace_root: orbMode.workspace_root,
      cols: dimensionOrDefault(intParam(url, "cols"), 80, 1, 500),
      rows: dimensionOrDefault(intParam(url, "rows"), 24, 1, 300),
      closed: false,
      pendingMessages: [],
    },
  })
  return upgraded
    ? { _tag: "upgraded" }
    : {
        _tag: "response",
        response: json({ error: { message: "WebSocket upgrade failed", code: "upgrade_failed" } }, 400),
      }
}

export function openOrbPtyWebSocket(ws: OrbPtyWebSocket) {
  const data = ws.data
  let fiber: Fiber.Fiber<void> | undefined
  fiber = Effect.runFork(
    Effect.suspend(() =>
      Effect.gen(function* () {
        const outputQueue = yield* Queue.bounded<Uint8Array>(orbPtyOutputQueueSize)
        const drainQueue = yield* Queue.unbounded<void>()
        const forwarder = yield* Effect.sync(() => Effect.runFork(forwardOrbPtyOutput(ws, outputQueue, drainQueue)))
        const ready = yield* Effect.sync(() => {
          if (data.closed) return false
          data.outputQueue = outputQueue
          data.drainQueue = drainQueue
          data.forwarder = forwarder
          return true
        })
        if (!ready) {
          yield* Fiber.interrupt(forwarder)
          yield* Queue.shutdown(outputQueue)
          yield* Queue.shutdown(drainQueue)
          return
        }
        const session = yield* data.pty.open({
          workspace_root: data.workspace_root,
          cols: data.cols,
          rows: data.rows,
          onData: (bytes) =>
            Effect.sync(() => {
              const queue = data.outputQueue
              if (data.closed || queue === undefined) return
              const offered = Queue.offerUnsafe(queue, new Uint8Array(bytes))
              if (!offered) closeOrbPtySocket(ws, 1011, "pty output buffer full", "output_overflow")
            }),
          onExit: (exit) =>
            Effect.sync(() => {
              closeOrbPtySocket(ws, 1000, `pty ${exit.source} exited`, "pty_exit")
            }),
        })
        const pending = yield* Effect.sync(() => {
          if (data.closed) return undefined
          data.session = session
          const messages = data.pendingMessages
          data.pendingMessages = []
          return messages
        })
        if (pending === undefined) {
          yield* session.close.pipe(Effect.ignore)
          return
        }
        yield* Effect.forEach(pending, (message) => applyOrbPtyClientMessage(ws, session, message), { discard: true })
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            closeOrbPtySocket(ws, 1011, "pty open failed", "open_failed")
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            const current = fiber
            if (current !== undefined && data.openFiber === current) delete data.openFiber
          }),
        ),
      ),
    ),
  )
  if (!data.closed) data.openFiber = fiber
}

export function messageOrbPtyWebSocket(ws: OrbPtyWebSocket, message: string | Buffer<ArrayBuffer>) {
  const decoded = decodeOrbPtyClientMessage(message)
  if (decoded === undefined) {
    closeOrbPtySocket(ws, 1008, "invalid control frame", "invalid_message")
    return
  }
  const session = ws.data.session
  if (session === undefined) {
    if (ws.data.pendingMessages.length >= orbPtyPendingMessageLimit) {
      closeOrbPtySocket(ws, 1011, "pty input buffer full", "input_overflow")
      return
    }
    ws.data.pendingMessages.push(decoded)
    return
  }
  Effect.runFork(applyOrbPtyClientMessage(ws, session, decoded))
}

export function drainOrbPtyWebSocket(ws: OrbPtyWebSocket) {
  const drainQueue = ws.data.drainQueue
  if (drainQueue !== undefined) Queue.offerUnsafe(drainQueue, undefined)
}

export function closeOrbPtyWebSocketHandler(ws: OrbPtyWebSocket, code: number = 1000, reason: string = "") {
  finalizeOrbPtySocket(ws, code, reason, "websocket_close")
}

const decodeResizeControl = (message: string): ResizeControl | undefined => {
  try {
    const decoded = Schema.decodeUnknownSync(ResizeControl)(JSON.parse(message))
    if (!validDimension(decoded.cols, 1, 500) || !validDimension(decoded.rows, 1, 300)) return undefined
    return decoded
  } catch {
    return undefined
  }
}

const binaryMessage = (message: ArrayBuffer | Uint8Array) =>
  message instanceof Uint8Array ? message : new Uint8Array(message)

const decodeOrbPtyClientMessage = (message: string | Buffer<ArrayBuffer>): OrbPtyClientMessage | undefined => {
  if (typeof message === "string") {
    const resize = decodeResizeControl(message)
    return resize === undefined ? undefined : { type: "resize", cols: resize.cols, rows: resize.rows }
  }
  return { type: "write", bytes: binaryMessage(message) }
}

const applyOrbPtyClientMessage = (ws: OrbPtyWebSocket, session: OrbPty.Session, message: OrbPtyClientMessage) => {
  const applied = message.type === "resize" ? session.resize(message.cols, message.rows) : session.write(message.bytes)
  return applied.pipe(
    Effect.catch(() =>
      Effect.sync(() => {
        closeOrbPtySocket(ws, 1011, message.type === "resize" ? "pty resize failed" : "pty write failed", message.type)
      }),
    ),
  )
}

const forwardOrbPtyOutput = (
  ws: OrbPtyWebSocket,
  outputQueue: Queue.Queue<Uint8Array>,
  drainQueue: Queue.Queue<void>,
) =>
  Effect.forever(Queue.take(outputQueue).pipe(Effect.flatMap((bytes) => sendOrbPtyOutput(ws, bytes, drainQueue)))).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.sync(() => {
            closeOrbPtySocket(ws, 1011, "pty output forwarding failed", "output_forward")
          }),
    ),
  )

const sendOrbPtyOutput = (ws: OrbPtyWebSocket, bytes: Uint8Array, drainQueue: Queue.Queue<void>) =>
  Effect.suspend(() => {
    if (ws.data.closed) return Effect.void
    const status = ws.send(bytes)
    if (status > 0) return Effect.void
    if (status === -1) return Queue.take(drainQueue)
    return Effect.sync(() => {
      closeOrbPtySocket(ws, 1011, "pty output dropped", "output_dropped")
    })
  })

const closeOrbPtySocket = (ws: OrbPtyWebSocket, code: number, reason: string, source: string) => {
  const shouldClose = !ws.data.closed
  if (shouldClose) ws.close(code, reason)
  finalizeOrbPtySocket(ws, code, reason, source)
}

const finalizeOrbPtySocket = (ws: OrbPtyWebSocket, code: number, reason: string, source: string) => {
  const data = ws.data
  if (data.closed) return
  data.closed = true
  const openFiber = data.openFiber
  const forwarder = data.forwarder
  const outputQueue = data.outputQueue
  const drainQueue = data.drainQueue
  const session = data.session
  delete data.openFiber
  delete data.forwarder
  delete data.outputQueue
  delete data.drainQueue
  delete data.session
  data.pendingMessages = []
  if (openFiber !== undefined) Effect.runFork(Fiber.interrupt(openFiber))
  if (forwarder !== undefined) Effect.runFork(Fiber.interrupt(forwarder))
  if (outputQueue !== undefined) Effect.runFork(Queue.shutdown(outputQueue).pipe(Effect.asVoid))
  if (drainQueue !== undefined) Effect.runFork(Queue.shutdown(drainQueue).pipe(Effect.asVoid))
  if (session !== undefined) Effect.runFork(session.close.pipe(Effect.ignore))
  emitOrbPtySocketClose(data, code, reason, source)
}

const emitOrbPtySocketClose = (data: OrbPtySocketData, code: number, reason: string, source: string) => {
  Effect.runFork(
    Diagnostics.event("orb_pty.websocket_close", () => Effect.void, {
      workspace_root: data.workspace_root,
      code,
      reason,
      source,
    }).pipe(
      Effect.provideService(Diagnostics.Service, data.diagnostics),
      Effect.catchCause(() => Effect.void),
    ),
  )
}

const dimensionOrDefault = (value: number | undefined, fallback: number, minimum: number, maximum: number) =>
  value === undefined || !validDimension(value, minimum, maximum) ? fallback : value

const validDimension = (value: number, minimum: number, maximum: number) =>
  Number.isInteger(value) && value >= minimum && value <= maximum

const unauthorizedJson = () => json({ error: { message: "Unauthorized", code: "unauthorized" } }, 401)

const notFound = () => json({ error: { message: "Not found", code: "not_found" } }, 404)

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })

const tokenValue = (token: string | undefined) => (token === undefined || token.length === 0 ? undefined : token)

const constantTimeTokenEquals = (actual: string | null | undefined, expected: string): boolean => {
  const actualValue = actual ?? ""
  const actualDigest = tokenDigest(actualValue)
  const expectedDigest = tokenDigest(expected)
  return timingSafeEqual(actualDigest, expectedDigest) && actualValue.length === expected.length
}

const tokenDigest = (value: string) => createHash("sha256").update(value, "utf8").digest()

const intParam = (url: URL, name: string) => {
  const value = url.searchParams.get(name)
  if (value === null) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

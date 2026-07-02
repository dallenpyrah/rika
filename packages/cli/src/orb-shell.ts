import { Config } from "@rika/core"
import { OrbActivity } from "@rika/orb"
import { Ids } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"
import * as BackendEndpoint from "./backend-endpoint"

const detachByte = 0x1c
const inputTouchThrottleMs = 30_000

export class OrbShellError extends Schema.TaggedErrorClass<OrbShellError>()("CliOrbShellError", {
  message: Schema.String,
  operation: Schema.String,
  exit_code: Schema.Int,
  thread_id: Schema.optional(Ids.ThreadId),
}) {}

export interface SystemRunInput {
  readonly url: string
  readonly onOpen: Effect.Effect<void, OrbActivity.RunError>
  readonly onInput: Effect.Effect<void, OrbActivity.RunError>
}

export type SystemRunError = OrbShellError | OrbActivity.RunError

export interface TerminalInput {
  readonly isTTY: boolean
  readonly isRaw?: boolean
  readonly setRawMode: (raw: boolean) => unknown
  readonly resume: () => unknown
  readonly on: (event: "data", listener: (chunk: Buffer) => void) => unknown
  readonly off: (event: "data", listener: (chunk: Buffer) => void) => unknown
}

export interface TerminalOutput {
  readonly isTTY: boolean
  readonly columns?: number
  readonly rows?: number
  readonly write: (data: string | Uint8Array) => unknown
}

export interface SignalTarget {
  readonly on: (event: "SIGWINCH", listener: () => void) => unknown
  readonly off: (event: "SIGWINCH", listener: () => void) => unknown
}

export interface SocketLike {
  binaryType: string
  readonly readyState: number
  readonly send: (data: string | Buffer) => unknown
  readonly close: () => unknown
  readonly addEventListener: (
    event: "open" | "message" | "error" | "close",
    listener: (event: { readonly data?: unknown }) => void,
    options?: AddEventListenerOptions,
  ) => unknown
}

export interface Platform {
  readonly stdin: TerminalInput
  readonly stdout: TerminalOutput
  readonly signals: SignalTarget
  readonly openWebSocket: (url: string) => SocketLike
  readonly now: () => number
}

export interface SystemInterface {
  readonly run: (input: SystemRunInput) => Effect.Effect<void, SystemRunError>
}

export class System extends Context.Service<System, SystemInterface>()("@rika/cli/OrbShell/System") {}

export type RunError = OrbShellError | BackendEndpoint.ResolveError | Config.ConfigError | OrbActivity.RunError

export interface Interface {
  readonly shell: (threadId: Ids.ThreadId) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/OrbShell") {}

export const layerFromEnv = (env: Record<string, string | undefined>) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const resolver = yield* BackendEndpoint.Resolver
      const activity = yield* OrbActivity.Service
      const system = yield* System
      return Service.of({
        shell: Effect.fn("Cli.OrbShell.shell")(function* (threadId: Ids.ThreadId) {
          const values = yield* config.get
          const endpoint = yield* resolver.resolveEndpoint({
            thread_id: threadId,
            workspace_root: values.workspace_root,
            data_dir: values.data_dir,
            mode: values.default_mode,
            env,
          })
          if (endpoint.kind !== "orb") {
            return yield* new OrbShellError({
              message: `Thread ${threadId} is not backed by a running orb`,
              operation: "resolveEndpoint",
              exit_code: 2,
              thread_id: threadId,
            })
          }
          const touch = activity.touch(endpoint.orb_id)
          yield* system.run({
            url: ptyWebSocketUrl(endpoint.url, endpoint.token),
            onOpen: touch,
            onInput: touch,
          })
          return 0
        }),
      })
    }),
  )

export const systemLayerWithPlatform = (platform: Platform) =>
  Layer.succeed(
    System,
    System.of({
      run: Effect.fn("Cli.OrbShell.System.run")((input: SystemRunInput) =>
        Effect.tryPromise({
          try: () => runSystem(input, platform),
          catch: (cause) =>
            new OrbShellError({
              message: cause instanceof Error ? cause.message : String(cause),
              operation: "run",
              exit_code: 1,
            }),
        }),
      ),
    }),
  )

export const systemLayer = systemLayerWithPlatform(livePlatform())

export const layer = layerFromEnv(process.env).pipe(Layer.provide(systemLayer))

export const testLayer = (implementation: Interface) => Layer.succeed(Service, Service.of(implementation))

export const systemTestLayer = (implementation: SystemInterface) => Layer.succeed(System, System.of(implementation))

export const shell = Effect.fn("Cli.OrbShell.shell.call")(function* (threadId: Ids.ThreadId) {
  const service = yield* Service
  return yield* service.shell(threadId)
})

export const ptyWebSocketUrl = (endpointUrl: string, token: string) => {
  const url = new URL(`${endpointUrl.replace(/\/$/, "")}/v1/orb/pty`)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("token", token)
  return url.toString()
}

const runSystem = (input: SystemRunInput, platform: Platform) =>
  new Promise<void>((resolve, reject) => {
    const stdin = platform.stdin
    const stdout = platform.stdout
    if (!stdin.isTTY || !stdout.isTTY) {
      reject(new Error("orb shell requires an interactive TTY"))
      return
    }

    const previousRawMode = stdin.isRaw === true
    const socket = platform.openWebSocket(input.url)
    socket.binaryType = "arraybuffer"
    let closed = false
    let lastInputTouch = 0

    const finish = (error?: unknown) => {
      if (closed) return
      closed = true
      platform.signals.off("SIGWINCH", sendResize)
      stdin.off("data", onData)
      stdin.setRawMode(previousRawMode)
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close()
      if (error === undefined) {
        resolve()
      } else {
        reject(error)
      }
    }

    const sendResize = () => {
      if (socket.readyState !== WebSocket.OPEN) return
      socket.send(
        JSON.stringify({
          type: "resize",
          cols: stdout.columns ?? 80,
          rows: stdout.rows ?? 24,
        }),
      )
    }

    const touchInput = () => {
      const now = platform.now()
      if (now - lastInputTouch < inputTouchThrottleMs) return
      lastInputTouch = now
      void Effect.runPromise(input.onInput).catch(finish)
    }

    const onData = (chunk: Buffer) => {
      if (chunk.includes(detachByte)) {
        finish()
        return
      }
      if (socket.readyState !== WebSocket.OPEN) return
      socket.send(chunk)
      touchInput()
    }

    socket.addEventListener(
      "open",
      () => {
        stdin.setRawMode(true)
        stdin.resume()
        stdin.on("data", onData)
        platform.signals.on("SIGWINCH", sendResize)
        sendResize()
        void Effect.runPromise(input.onOpen).catch(finish)
      },
      { once: true },
    )
    socket.addEventListener("message", (event) => {
      stdout.write(outputData(event.data))
    })
    socket.addEventListener("error", () => finish(new Error("orb shell websocket failed")), { once: true })
    socket.addEventListener("close", () => finish(), { once: true })
  })

const outputData = (data: unknown) =>
  typeof data === "string"
    ? data
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : data instanceof Uint8Array
        ? data
        : String(data)

function livePlatform(): Platform {
  return {
    stdin: process.stdin as TerminalInput,
    stdout: process.stdout as TerminalOutput,
    signals: {
      on: (event, listener) => process.on(event, listener),
      off: (event, listener) => process.off(event, listener),
    },
    openWebSocket: (url) => new WebSocket(url) as SocketLike,
    now: () => Date.now(),
  }
}

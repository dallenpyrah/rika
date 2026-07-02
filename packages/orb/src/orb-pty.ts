import { Context, Effect, Layer, Schema } from "effect"

export class OrbPtyError extends Schema.TaggedErrorClass<OrbPtyError>()("OrbPtyError", {
  message: Schema.String,
  operation: Schema.String,
  workspace_root: Schema.optional(Schema.String),
}) {}

export interface OpenInput extends Schema.Schema.Type<typeof OpenInput> {}
export const OpenInput = Schema.Struct({
  workspace_root: Schema.String,
  cols: Schema.Int,
  rows: Schema.Int,
}).annotate({ identifier: "Rika.Orb.OrbPty.OpenInput" })

export interface OpenOptions extends OpenInput {
  readonly onData: (bytes: Uint8Array) => Effect.Effect<void>
}

export interface Session {
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, OrbPtyError>
  readonly resize: (cols: number, rows: number) => Effect.Effect<void, OrbPtyError>
  readonly close: Effect.Effect<void, OrbPtyError>
}

export interface SystemOpenInput {
  readonly command: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly cols: number
  readonly rows: number
  readonly onData: (bytes: Uint8Array) => Effect.Effect<void>
}

export interface SystemInterface {
  readonly open: (input: SystemOpenInput) => Effect.Effect<Session, OrbPtyError>
}

export class System extends Context.Service<System, SystemInterface>()("@rika/orb/OrbPty/System") {}

export interface Interface {
  readonly open: (input: OpenOptions) => Effect.Effect<Session, OrbPtyError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/orb/OrbPty") {}

const tmuxCommand = ["tmux", "new-session", "-A", "-s", "rika"] as const

const serviceLayerFromEnv = (env: Record<string, string | undefined>) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const system = yield* System
      return Service.of({
        open: Effect.fn("OrbPty.open")((input: OpenOptions) =>
          system.open({
            command: tmuxCommand,
            cwd: input.workspace_root,
            env: childEnv(env),
            cols: input.cols,
            rows: input.rows,
            onData: input.onData,
          }),
        ),
      })
    }),
  )

export const systemLayer = Layer.succeed(
  System,
  System.of({
    open: Effect.fn("OrbPty.System.open")(function* (input: SystemOpenInput) {
      return yield* Effect.try({
        try: () => {
          const subprocess = Bun.spawn([...input.command], {
            cwd: input.cwd,
            env: input.env,
            terminal: {
              cols: input.cols,
              rows: input.rows,
              name: "xterm-256color",
              data: (_terminal, data) => {
                void Effect.runPromise(input.onData(data))
              },
            },
          })
          const terminal = subprocess.terminal
          if (terminal === null || terminal === undefined) {
            throw new Error("Bun did not attach a PTY terminal")
          }
          return {
            write: Effect.fn("OrbPty.Session.write")((bytes: Uint8Array) =>
              Effect.try({
                try: () => terminal.write(bytes),
                catch: toError("write", input.cwd),
              }).pipe(Effect.asVoid),
            ),
            resize: Effect.fn("OrbPty.Session.resize")((cols: number, rows: number) =>
              Effect.try({
                try: () => terminal.resize(cols, rows),
                catch: toError("resize", input.cwd),
              }),
            ),
            close: Effect.try({
              try: () => terminal.close(),
              catch: toError("close", input.cwd),
            }),
          }
        },
        catch: toError("open", input.cwd),
      })
    }),
  }),
)

export const layerFromEnv = (env: Record<string, string | undefined>) =>
  serviceLayerFromEnv(env).pipe(Layer.provide(systemLayer))

export const layer = layerFromEnv({})

export const layerWithSystem = (system: Layer.Layer<System>, env: Record<string, string | undefined> = {}) =>
  serviceLayerFromEnv(env).pipe(Layer.provide(system))

export const testLayer = (implementation: Interface) => Layer.succeed(Service, Service.of(implementation))

export const systemTestLayer = (implementation: SystemInterface) => Layer.succeed(System, System.of(implementation))

export const open = Effect.fn("OrbPty.open.call")(function* (input: OpenOptions) {
  const service = yield* Service
  return yield* service.open(input)
})

const toError = (operation: string, workspaceRoot: string) => (cause: unknown) =>
  new OrbPtyError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
    workspace_root: workspaceRoot,
  })

const childEnv = (env: Record<string, string | undefined>): Readonly<Record<string, string>> => {
  const entries = Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  return { ...Object.fromEntries(entries), TERM: "xterm-256color" }
}

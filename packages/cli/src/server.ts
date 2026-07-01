import { Config, Diagnostics } from "@rika/core"
import { HttpServer } from "@rika/server"
import { Context, Effect, Layer, Schema } from "effect"
import { basename } from "node:path"
import * as Args from "./args"
import * as Output from "./output"

export class ServerError extends Schema.TaggedErrorClass<ServerError>()("ServerError", {
  message: Schema.String,
}) {}

export type RunError = HttpServer.HttpServerError | ServerError

export interface Interface {
  readonly executeCommand: (command: Args.ServerCommand) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Server") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const output = yield* Output.Service
    const httpServer = yield* HttpServer.Service
    const config = yield* Config.Service
    const configValues = yield* config.get
    const diagnostics = yield* Diagnostics.Service

    return Service.of({
      executeCommand: Effect.fn("Cli.Server.executeCommand")(function* (command: Args.ServerCommand) {
        return yield* Diagnostics.event(
          "cli.server",
          (fields) =>
            Effect.gen(function* () {
              const handle = yield* httpServer.serve({
                ...(command.host === undefined ? {} : { host: command.host }),
                ...(command.port === undefined ? {} : { port: command.port }),
                ...(command.token === undefined ? {} : { token: command.token }),
              })
              fields.url = handle.url
              yield* output.stdout(JSON.stringify({ url: handle.url }))
              return yield* Effect.never.pipe(Effect.ensuring(handle.close()))
            }),
          {
            ...(command.host === undefined ? {} : { host: command.host }),
            ...(command.port === undefined ? {} : { port: command.port }),
            workspace_root: basename(configValues.workspace_root),
            ephemeral: command.ephemeral,
          },
        ).pipe(Effect.provideService(Diagnostics.Service, diagnostics))
      }),
    })
  }),
)

export const executeCommand = Effect.fn("Cli.Server.executeCommand.call")(function* (command: Args.ServerCommand) {
  const service = yield* Service
  return yield* service.executeCommand(command)
})

export const formatError = (error: RunError) => {
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

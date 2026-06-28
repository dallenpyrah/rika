import { McpClient } from "@rika/tools"
import { Context, Effect, Layer, Schema } from "effect"
import * as Args from "./args"
import * as Output from "./output"

export class McpError extends Schema.TaggedErrorClass<McpError>()("McpError", {
  message: Schema.String,
  action: Args.McpAction,
}) {}

export type RunError = McpClient.RunError | McpError

export interface Interface {
  readonly executeCommand: (command: Args.McpCommand) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Mcp") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const output = yield* Output.Service
    const mcp = yield* McpClient.Service

    return Service.of({
      executeCommand: Effect.fn("Cli.Mcp.executeCommand")(function* (command: Args.McpCommand) {
        switch (command.action) {
          case "list": {
            const servers = yield* mcp.servers
            yield* output.stdout(formatJson(servers))
            return 0
          }
          case "approve": {
            const serverName = yield* requireServerName(command)
            const approval = yield* mcp.approve(serverName)
            yield* output.stdout(formatJson(approval))
            return 0
          }
        }
        return yield* new McpError({ message: "Unsupported MCP action", action: command.action })
      }),
    })
  }),
)

export const executeCommand = Effect.fn("Cli.Mcp.executeCommand.call")(function* (command: Args.McpCommand) {
  const service = yield* Service
  return yield* service.executeCommand(command)
})

export const formatError = (error: RunError) => {
  if (error instanceof McpError) return error.message
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const requireServerName = (command: Args.McpCommand) =>
  command.server_name === undefined
    ? Effect.fail(new McpError({ message: `Server name is required for ${command.action}`, action: command.action }))
    : Effect.succeed(command.server_name)

const formatJson = (value: unknown) => JSON.stringify(value)

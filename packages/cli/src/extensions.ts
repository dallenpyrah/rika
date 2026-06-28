import { SelfExtension } from "@rika/plugin"
import { Context, Effect, Layer, Schema } from "effect"
import * as Args from "./args"
import * as Output from "./output"

export class ExtensionsError extends Schema.TaggedErrorClass<ExtensionsError>()("ExtensionsError", {
  message: Schema.String,
  action: Args.ExtensionAction,
}) {}

export type RunError = SelfExtension.SelfExtensionError | ExtensionsError

export interface Interface {
  readonly executeCommand: (command: Args.ExtensionCommand) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Extensions") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const output = yield* Output.Service
    const extensions = yield* SelfExtension.Service

    return Service.of({
      executeCommand: Effect.fn("Cli.Extensions.executeCommand")(function* (command: Args.ExtensionCommand) {
        switch (command.action) {
          case "create-skill": {
            const result = yield* extensions.createSkill({
              name: command.name,
              description: yield* requireDescription(command),
              ...(command.instructions === undefined ? {} : { instructions: command.instructions }),
              ...(command.thread_id === undefined ? {} : { thread_id: command.thread_id }),
            })
            yield* output.stdout(formatJson(result))
            return 0
          }
          case "create-plugin": {
            const result = yield* extensions.createPlugin({
              name: command.name,
              description: yield* requireDescription(command),
              ...(command.thread_id === undefined ? {} : { thread_id: command.thread_id }),
            })
            yield* output.stdout(formatJson(result))
            return 0
          }
          case "enable-plugin": {
            const result = yield* extensions.enablePlugin({
              name: command.name,
              verification_command: yield* requireVerification(command),
              ...(command.thread_id === undefined ? {} : { thread_id: command.thread_id }),
            })
            yield* output.stdout(formatJson(result))
            return result.enabled ? 0 : 1
          }
          case "disable-plugin": {
            const result = yield* extensions.disablePlugin({
              name: command.name,
              ...(command.reason === undefined ? {} : { reason: command.reason }),
              ...(command.thread_id === undefined ? {} : { thread_id: command.thread_id }),
            })
            yield* output.stdout(formatJson(result))
            return 0
          }
          case "rollback-plugin": {
            const result = yield* extensions.rollbackPlugin({
              name: command.name,
              ...(command.reason === undefined ? {} : { reason: command.reason }),
              ...(command.thread_id === undefined ? {} : { thread_id: command.thread_id }),
            })
            yield* output.stdout(formatJson(result))
            return 0
          }
        }
        return yield* new ExtensionsError({ message: "Unsupported extension action", action: command.action })
      }),
    })
  }),
)

export const executeCommand = Effect.fn("Cli.Extensions.executeCommand.call")(function* (
  command: Args.ExtensionCommand,
) {
  const service = yield* Service
  return yield* service.executeCommand(command)
})

export const formatError = (error: RunError) => {
  if (error instanceof ExtensionsError) return error.message
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const requireDescription = (command: Args.ExtensionCommand) =>
  command.description === undefined
    ? Effect.fail(
        new ExtensionsError({ message: `Description is required for ${command.action}`, action: command.action }),
      )
    : Effect.succeed(command.description)

const requireVerification = (command: Args.ExtensionCommand) =>
  command.verification_command === undefined
    ? Effect.fail(
        new ExtensionsError({
          message: `Verification command is required for ${command.action}`,
          action: command.action,
        }),
      )
    : Effect.succeed(command.verification_command)

const formatJson = (value: unknown) => JSON.stringify(value)

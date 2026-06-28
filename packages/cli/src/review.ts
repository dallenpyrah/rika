import { ReviewService } from "@rika/agent"
import { Context, Effect, Layer, Schema } from "effect"
import * as Args from "./args"
import * as Output from "./output"

export class ReviewError extends Schema.TaggedErrorClass<ReviewError>()("ReviewError", {
  message: Schema.String,
}) {}

export type RunError = ReviewService.RunError | ReviewError

export interface Interface {
  readonly executeCommand: (command: Args.ReviewCommand) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Review") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const output = yield* Output.Service
    const review = yield* ReviewService.Service

    return Service.of({
      executeCommand: Effect.fn("Cli.Review.executeCommand")(function* (command: Args.ReviewCommand) {
        const result = yield* review.run({
          staged: command.staged,
          ...(command.base_ref === undefined ? {} : { base_ref: command.base_ref }),
          ...(command.paths.length === 0 ? {} : { paths: command.paths }),
        })
        yield* output.stdout(formatJson(result.run))
        return 0
      }),
    })
  }),
)

export const executeCommand = Effect.fn("Cli.Review.executeCommand.call")(function* (command: Args.ReviewCommand) {
  const service = yield* Service
  return yield* service.executeCommand(command)
})

export const formatError = (error: RunError) => {
  if (error instanceof ReviewError) return error.message
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const formatJson = (value: unknown) => JSON.stringify(value)

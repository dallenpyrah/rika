import { Common, ErrorEnvelope, Tool } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"

export interface Descriptor extends Schema.Schema.Type<typeof Descriptor> {}
export const Descriptor = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  input_schema: Schema.optional(Common.JsonValue),
}).annotate({ identifier: "Rika.Agent.ToolExecutor.Descriptor" })

export class ToolExecutorError extends Schema.TaggedErrorClass<ToolExecutorError>()("ToolExecutorError", {
  message: Schema.String,
  name: Schema.optional(Schema.String),
  retryable: Schema.optional(Schema.Boolean),
  details: Schema.optional(Common.JsonValue),
}) {}

export interface Interface {
  readonly describe: Effect.Effect<ReadonlyArray<Descriptor>>
  readonly execute: (call: Tool.Call) => Effect.Effect<Tool.Result, ToolExecutorError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/ToolExecutor") {}

export type FakeHandler = (call: Tool.Call) => Effect.Effect<Common.JsonValue, ToolExecutorError>

export const emptyLayer = Layer.succeed(
  Service,
  Service.of({
    describe: Effect.succeed([]),
    execute: Effect.fn("ToolExecutor.empty.execute")(function* (call: Tool.Call) {
      return yield* new ToolExecutorError({ message: `No tool named ${call.name} is registered`, name: call.name })
    }),
  }),
)

export const fakeLayer = (
  handlers: Readonly<Record<string, FakeHandler>>,
  descriptors: ReadonlyArray<Descriptor> = descriptorsFromHandlers(handlers),
) =>
  Layer.succeed(
    Service,
    Service.of({
      describe: Effect.succeed(descriptors),
      execute: Effect.fn("ToolExecutor.fake.execute")(function* (call: Tool.Call) {
        const handler = handlers[call.name]
        if (handler === undefined) {
          return yield* new ToolExecutorError({
            message: `No fake tool named ${call.name} is registered`,
            name: call.name,
          })
        }

        const output = yield* handler(call)
        return successResult(call, output)
      }),
    }),
  )

export const describe = Effect.fn("ToolExecutor.describe.call")(function* () {
  const executor = yield* Service
  return yield* executor.describe
})

export const execute = Effect.fn("ToolExecutor.execute.call")(function* (call: Tool.Call) {
  const executor = yield* Service
  return yield* executor.execute(call)
})

export const successResult = (call: Tool.Call, output: Common.JsonValue): Tool.Result => ({
  id: call.id,
  name: call.name,
  status: "success",
  output,
})

export const errorResult = (call: Tool.Call, error: ToolExecutorError): Tool.Result => ({
  id: call.id,
  name: call.name,
  status: "error",
  error: errorEnvelope(error),
})

export const errorEnvelope = (error: ToolExecutorError): ErrorEnvelope.Envelope => ({
  kind: "tool",
  message: error.message,
  ...(error.name === undefined ? {} : { code: error.name }),
  ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
  ...(error.details === undefined ? {} : { details: error.details }),
})

const descriptorsFromHandlers = (handlers: Readonly<Record<string, FakeHandler>>): ReadonlyArray<Descriptor> =>
  Object.keys(handlers).map((name) => ({ name, description: `Fake tool ${name}` }))

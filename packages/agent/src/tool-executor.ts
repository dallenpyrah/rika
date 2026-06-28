import { Config } from "@rika/core"
import { Common, ErrorEnvelope, Tool } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"
import * as PermissionPolicy from "./permission-policy"
import * as ToolRegistry from "./tool-registry"

export type Descriptor = ToolRegistry.Descriptor
export const Descriptor = ToolRegistry.Descriptor

export class ToolExecutorError extends Schema.TaggedErrorClass<ToolExecutorError>()("ToolExecutorError", {
  message: Schema.String,
  kind: Schema.optional(ErrorEnvelope.ErrorKind),
  name: Schema.optional(Schema.String),
  retryable: Schema.optional(Schema.Boolean),
  details: Schema.optional(Common.JsonValue),
}) {}

export interface Interface {
  readonly describe: Effect.Effect<ReadonlyArray<Descriptor>>
  readonly execute: (call: Tool.Call) => Effect.Effect<Tool.Result>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/ToolExecutor") {}

export type FakeHandler = ToolRegistry.FakeHandler

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const policy = yield* PermissionPolicy.Service

    return Service.of({
      describe: registry.describe,
      execute: Effect.fn("ToolExecutor.execute")(function* (call: Tool.Call) {
        const mode = yield* policy.mode
        const decision = yield* policy.decide(call).pipe(
          Effect.match({
            onFailure: (error) => PermissionPolicy.reject(error.message, error.details),
            onSuccess: (allowed) => allowed,
          }),
        )
        const metadata = permissionMetadata(mode, decision.action)

        switch (decision.action) {
          case "allow":
            return yield* executeRegistryCall(registry, call).pipe(
              Effect.map((result) => withMetadata(result, metadata)),
            )
          case "modify":
            return yield* executeRegistryCall(registry, modifiedCall(call, decision.input)).pipe(
              Effect.map((result) => withMetadata(result, metadata)),
            )
          case "reject-and-continue":
            return withMetadata(
              errorResult(
                call,
                new ToolExecutorError({
                  message: decision.message,
                  kind: "permission",
                  name: call.name,
                  retryable: false,
                  ...(decision.details === undefined ? {} : { details: decision.details }),
                }),
              ),
              metadata,
            )
          case "synthesize":
            return withMetadata(normalizeSynthesizedResult(call, decision.result), metadata)
          default:
            return yield* Effect.die(new Error("Unknown permission policy decision"))
        }
      }),
    })
  }),
)

export const emptyLayer = layer.pipe(
  Layer.provideMerge(ToolRegistry.emptyLayer),
  Layer.provideMerge(PermissionPolicy.allowLayer),
)

export const fakeLayer = (handlers: Readonly<Record<string, FakeHandler>>, descriptors?: ReadonlyArray<Descriptor>) =>
  layer.pipe(
    Layer.provideMerge(ToolRegistry.fakeLayer(handlers, descriptors)),
    Layer.provideMerge(PermissionPolicy.allowLayer),
  )

export const shellLayer: Layer.Layer<Service, never, Config.Service> = layer.pipe(
  Layer.provideMerge(ToolRegistry.shellLayer),
  Layer.provideMerge(PermissionPolicy.allowLayer),
)

export const describe = Effect.fn("ToolExecutor.describe.call")(function* () {
  const executor = yield* Service
  return yield* executor.describe
})

export const execute = Effect.fn("ToolExecutor.execute.call")(function* (call: Tool.Call) {
  const executor = yield* Service
  return yield* executor.execute(call)
})

const executeRegistryCall = (registry: ToolRegistry.Interface, call: Tool.Call) =>
  registry.execute(call).pipe(
    Effect.match({
      onFailure: (error) => errorResult(call, fromRegistryError(error)),
      onSuccess: (output) => successResult(call, output),
    }),
  )

const modifiedCall = (call: Tool.Call, input: Common.JsonValue): Tool.Call => ({
  ...call,
  input,
  metadata: { ...call.metadata, permission_action: "modify" },
})

const normalizeSynthesizedResult = (call: Tool.Call, result: Tool.Result): Tool.Result => ({
  ...result,
  id: call.id,
  name: call.name,
})

const permissionMetadata = (
  mode: PermissionPolicy.PermissionMode,
  action: PermissionPolicy.Decision["action"],
): Common.Metadata => ({
  permission_mode: mode,
  permission_action: action,
})

const withMetadata = (result: Tool.Result, metadata: Common.Metadata): Tool.Result => ({
  ...result,
  metadata: { ...result.metadata, ...metadata },
})

const fromRegistryError = (error: ToolRegistry.ToolRegistryError) =>
  new ToolExecutorError({
    message: error.message,
    kind: "tool",
    ...(error.name === undefined ? {} : { name: error.name }),
    ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
    ...(error.details === undefined ? {} : { details: error.details }),
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
  kind: error.kind ?? "tool",
  message: error.message,
  ...(error.name === undefined ? {} : { code: error.name }),
  ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
  ...(error.details === undefined ? {} : { details: error.details }),
})

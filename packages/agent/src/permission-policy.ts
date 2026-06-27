import { Common, ErrorEnvelope, Tool } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"

export interface AllowDecision extends Schema.Schema.Type<typeof AllowDecision> {}
export const AllowDecision = Schema.Struct({
  action: Schema.Literal("allow"),
}).annotate({ identifier: "Rika.Agent.PermissionPolicy.AllowDecision" })

export interface RejectAndContinueDecision extends Schema.Schema.Type<typeof RejectAndContinueDecision> {}
export const RejectAndContinueDecision = Schema.Struct({
  action: Schema.Literal("reject-and-continue"),
  message: Schema.String,
  details: Schema.optional(Common.JsonValue),
}).annotate({ identifier: "Rika.Agent.PermissionPolicy.RejectAndContinueDecision" })

export interface ModifyDecision extends Schema.Schema.Type<typeof ModifyDecision> {}
export const ModifyDecision = Schema.Struct({
  action: Schema.Literal("modify"),
  input: Common.JsonValue,
}).annotate({ identifier: "Rika.Agent.PermissionPolicy.ModifyDecision" })

export interface SynthesizeDecision extends Schema.Schema.Type<typeof SynthesizeDecision> {}
export const SynthesizeDecision = Schema.Struct({
  action: Schema.Literal("synthesize"),
  result: Tool.Result,
}).annotate({ identifier: "Rika.Agent.PermissionPolicy.SynthesizeDecision" })

export type Decision = AllowDecision | RejectAndContinueDecision | ModifyDecision | SynthesizeDecision
export const Decision = Schema.Union([
  AllowDecision,
  RejectAndContinueDecision,
  ModifyDecision,
  SynthesizeDecision,
]).pipe(Schema.toTaggedUnion("action"), Schema.annotate({ identifier: "Rika.Agent.PermissionPolicy.Decision" }))

export class PermissionPolicyError extends Schema.TaggedErrorClass<PermissionPolicyError>()("PermissionPolicyError", {
  message: Schema.String,
  details: Schema.optional(Common.JsonValue),
}) {}

export interface Interface {
  readonly decide: (call: Tool.Call) => Effect.Effect<Decision, PermissionPolicyError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/PermissionPolicy") {}

export type Decider = (call: Tool.Call) => Effect.Effect<Decision, PermissionPolicyError>

export const allow: Decision = { action: "allow" }

export const reject = (message: string, details?: Common.JsonValue): Decision => ({
  action: "reject-and-continue",
  message,
  ...(details === undefined ? {} : { details }),
})

export const modify = (input: Common.JsonValue): Decision => ({ action: "modify", input })

export const synthesize = (result: Tool.Result): Decision => ({ action: "synthesize", result })

export const layerFromDecider = (decider: Decider) =>
  Layer.succeed(
    Service,
    Service.of({
      decide: Effect.fn("PermissionPolicy.decide")(function* (call: Tool.Call) {
        return yield* decider(call)
      }),
    }),
  )

export const allowLayer = layerFromDecider(() => Effect.succeed(allow))

export const rejectLayer = (message: string, details?: Common.JsonValue) =>
  layerFromDecider(() => Effect.succeed(reject(message, details)))

export const decide = Effect.fn("PermissionPolicy.decide.call")(function* (call: Tool.Call) {
  const policy = yield* Service
  return yield* policy.decide(call)
})

export const errorEnvelope = (error: PermissionPolicyError): ErrorEnvelope.Envelope => ({
  kind: "permission",
  message: error.message,
  ...(error.details === undefined ? {} : { details: error.details }),
})

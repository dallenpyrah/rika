import { Schema } from "effect"
import { ThreadId } from "./thread-schema"

export const TurnId = Schema.String.pipe(Schema.brand("RikaTurnId"))
export type TurnId = typeof TurnId.Type

export const Status = Schema.Literals(["accepted", "queued", "running", "waiting", "completed", "failed", "cancelled"])
export type Status = typeof Status.Type

export const ExecutionExtensionPin = Schema.Struct({
  generation: Schema.String,
  sourceDigest: Schema.String,
  configFingerprint: Schema.String,
  toolSchemaDigest: Schema.String,
  mcpFingerprint: Schema.String,
  resolvedContextDigest: Schema.String,
})
export type ExecutionExtensionPin = typeof ExecutionExtensionPin.Type

export const ExecutionModelRoute = Schema.Struct({
  role: Schema.Literals(["main", "oracle"]),
  alias: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  registrationKey: Schema.String,
  gatewayProtocol: Schema.Literals(["openai", "anthropic", "test"]),
  gatewayBaseUrl: Schema.String,
  gatewayAuth: Schema.String,
  effort: Schema.String,
  fast: Schema.Boolean,
  requestVariant: Schema.String,
  providerOptions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  compaction: Schema.Struct({
    contextWindow: Schema.Number,
    reserveTokens: Schema.Number,
    keepRecentTokens: Schema.Number,
  }),
})
export type ExecutionModelRoute = typeof ExecutionModelRoute.Type

export const ExecutionRoutePin = Schema.Struct({
  version: Schema.Literal(1),
  mode: Schema.Literals(["low", "medium", "high", "ultra", "test"]),
  tokenBudget: Schema.Number,
  main: ExecutionModelRoute,
  oracle: ExecutionModelRoute,
})
export type ExecutionRoutePin = typeof ExecutionRoutePin.Type

export const testExecutionRoute = (mode: "low" | "medium" | "high" | "ultra" | "test" = "test"): ExecutionRoutePin => {
  const route = {
    alias: "test",
    provider: "test",
    model: "test",
    registrationKey: "test",
    gatewayProtocol: "test" as const,
    gatewayBaseUrl: "test://model",
    gatewayAuth: "none",
    effort: "medium",
    fast: false,
    requestVariant: "test",
    compaction: { contextWindow: 372_000, reserveTokens: 128_000, keepRecentTokens: 32_000 },
  }
  return {
    version: 1,
    mode,
    tokenBudget: 64_000,
    main: { ...route, role: "main" },
    oracle: { ...route, role: "oracle" },
  }
}

export const PromptPart = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("image"),
    mediaType: Schema.String,
    data: Schema.String,
    filename: Schema.optionalKey(Schema.String),
  }),
])
export type PromptPart = typeof PromptPart.Type

export const Turn = Schema.Struct({
  id: TurnId,
  threadId: ThreadId,
  prompt: Schema.String,
  promptParts: Schema.optionalKey(Schema.Array(PromptPart)),
  status: Status,
  lastCursor: Schema.optionalKey(Schema.String),
  extensionPin: Schema.optionalKey(ExecutionExtensionPin),
  executionRoute: Schema.optionalKey(ExecutionRoutePin),
  reviewFanOutId: Schema.optionalKey(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type Turn = typeof Turn.Type

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
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type Turn = typeof Turn.Type

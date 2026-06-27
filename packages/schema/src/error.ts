import { Schema } from "effect"
import { JsonValue } from "./common"

export const ErrorKind = Schema.Literals([
  "validation",
  "permission",
  "tool",
  "model",
  "persistence",
  "actor",
  "cancelled",
  "unknown",
]).annotate({ identifier: "Rika.ErrorKind" })
export type ErrorKind = typeof ErrorKind.Type

export interface Envelope extends Schema.Schema.Type<typeof Envelope> {}
export const Envelope = Schema.Struct({
  kind: ErrorKind,
  message: Schema.String,
  code: Schema.optional(Schema.String),
  retryable: Schema.optional(Schema.Boolean),
  details: Schema.optional(JsonValue),
}).annotate({ identifier: "Rika.ErrorEnvelope" })

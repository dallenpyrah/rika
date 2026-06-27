import { Schema } from "effect"
import { JsonValue, Metadata } from "./common"
import { Envelope } from "./error"
import { ToolCallId } from "./ids"

export const ToolResultStatus = Schema.Literals(["success", "error"]).annotate({ identifier: "Rika.ToolResultStatus" })
export type ToolResultStatus = typeof ToolResultStatus.Type

export interface Call extends Schema.Schema.Type<typeof Call> {}
export const Call = Schema.Struct({
  id: ToolCallId,
  name: Schema.String,
  input: JsonValue,
  metadata: Schema.optional(Metadata),
}).annotate({ identifier: "Rika.ToolCall" })

export interface Result extends Schema.Schema.Type<typeof Result> {}
export const Result = Schema.Struct({
  id: ToolCallId,
  name: Schema.String,
  status: ToolResultStatus,
  output: Schema.optional(JsonValue),
  error: Schema.optional(Envelope),
  metadata: Schema.optional(Metadata),
}).annotate({ identifier: "Rika.ToolResult" })

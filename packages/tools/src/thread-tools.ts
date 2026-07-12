import { Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"

export const Result = Schema.Struct({
  text: Schema.String,
  truncated: Schema.Boolean,
})
export type Result = typeof Result.Type

export class ToolError extends Schema.TaggedErrorClass<ToolError>()("ThreadToolError", {
  tool: Schema.String,
  message: Schema.String,
}) {}

export const findThreadTool = Tool.make("find_thread", {
  description:
    "Find local Rika threads by bounded metadata query terms. Supports plain text and workspace:, repo:, ref:, author:, label:, file:, after:, and before: terms.",
  parameters: Schema.Struct({
    query: Schema.String,
    includeArchived: Schema.optionalKey(Schema.Boolean),
    limit: Schema.optionalKey(Schema.Number),
  }),
  success: Result,
  failure: ToolError,
  failureMode: "return",
})

export const readThreadTool = Tool.make("read_thread", {
  description: "Read a bounded deterministic transcript for one local Rika thread by id",
  parameters: Schema.Struct({
    threadId: Schema.String,
    includeArchived: Schema.optionalKey(Schema.Boolean),
    maxTurns: Schema.optionalKey(Schema.Number),
    maxChars: Schema.optionalKey(Schema.Number),
  }),
  success: Result,
  failure: ToolError,
  failureMode: "return",
})

export const toolkit = Toolkit.make(findThreadTool, readThreadTool)

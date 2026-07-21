import { Function, Schema } from "effect"

export const Permission = Schema.Literals(["allow", "ask"])
export type Permission = typeof Permission.Type

export const Idempotency = Schema.Literals(["safe", "unsafe"])
export type Idempotency = typeof Idempotency.Type

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

export const Presentation = Schema.Struct({
  family: Schema.Literals(["explore", "shell", "edit", "agent", "direct", "generic"]),
  action: Schema.String,
  activeLabel: Schema.String,
  completeLabel: Schema.String,
  outputDisplay: Schema.optionalKey(Schema.Literals(["hidden", "expandable"])),
  counter: Schema.optionalKey(
    Schema.Literals([
      "file",
      "media file",
      "web page",
      "thread",
      "skill",
      "guidance file",
      "search",
      "web search",
      "review",
      "GitHub check",
      "list",
    ]),
  ),
})
export type Presentation = typeof Presentation.Type

export const Policy = Schema.Struct({
  permission: Permission,
  idempotency: Idempotency,
  timeoutMillis: PositiveInt,
  outputLimit: PositiveInt,
  presentation: Presentation,
})
export type Policy = typeof Policy.Type

export interface RegisteredTool {
  readonly name: string
  readonly description?: string | undefined
}

export interface Registration {
  readonly tool: RegisteredTool
  readonly policy: Policy
}

export const allow: {
  (idempotency: Idempotency, timeoutMillis: number, outputLimit: number, presentation: Presentation): Policy
  (timeoutMillis: number, outputLimit: number, presentation: Presentation): (idempotency: Idempotency) => Policy
} = Function.dual(
  4,
  (idempotency: Idempotency, timeoutMillis: number, outputLimit: number, presentation: Presentation): Policy => ({
    permission: "allow",
    idempotency,
    timeoutMillis,
    outputLimit,
    presentation,
  }),
)

export const register: {
  (tool: RegisteredTool, policy: Policy): Registration
  (policy: Policy): (tool: RegisteredTool) => Registration
} = Function.dual(2, (tool: RegisteredTool, policy: Policy): Registration => ({ tool, policy }))

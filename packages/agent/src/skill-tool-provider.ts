import { Common } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"
import * as SkillRegistry from "./skill-registry"
import * as ToolRegistry from "./tool-registry"

export class SkillToolProviderError extends Schema.TaggedErrorClass<SkillToolProviderError>()(
  "SkillToolProviderError",
  {
    message: Schema.String,
    operation: Schema.String,
    skill: Schema.optional(Schema.String),
    details: Schema.optional(Common.JsonValue),
  },
) {}

export interface Interface {
  readonly definitionsForSkills: (
    skills: ReadonlyArray<SkillRegistry.Skill>,
  ) => Effect.Effect<ReadonlyArray<ToolRegistry.Definition>, SkillToolProviderError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/SkillToolProvider") {}

export const empty: Interface = {
  definitionsForSkills: Effect.fn("SkillToolProvider.empty.definitionsForSkills")(function* () {
    return []
  }),
}

export const emptyLayer = Layer.succeed(Service, Service.of(empty))

export const definitionsForSkills = Effect.fn("SkillToolProvider.definitionsForSkills.call")(function* (
  skills: ReadonlyArray<SkillRegistry.Skill>,
) {
  const service = yield* Service
  return yield* service.definitionsForSkills(skills)
})

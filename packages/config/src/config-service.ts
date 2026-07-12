import { Config, Context, Effect, Layer, Redacted } from "effect"
import {
  defaults,
  type Diagnostic,
  type EffectiveConfig,
  type Environment,
  type ModeId,
  type Settings,
  type SettingsInput,
} from "./config-contract"

export interface Interface {
  readonly effective: Effect.Effect<EffectiveConfig>
}

export class Service extends Context.Service<Service, Interface>()("@rika/config/ConfigService") {}

const mergeSettings = (global: SettingsInput, workspace: SettingsInput): Settings => {
  const mode = (id: ModeId) => ({ ...defaults.modes[id], ...global.modes?.[id], ...workspace.modes?.[id] })
  const modes = { low: mode("low"), medium: mode("medium"), high: mode("high"), ultra: mode("ultra") }
  return {
    providers: { ...defaults.providers, ...global.providers, ...workspace.providers },
    models: { ...defaults.models, ...global.models, ...workspace.models },
    modes,
    keymap: { ...defaults.keymap, ...global.keymap, ...workspace.keymap },
    permissions: { ...defaults.permissions, ...global.permissions, ...workspace.permissions },
    extensionRoots: workspace.extensionRoots ?? global.extensionRoots ?? defaults.extensionRoots,
    mcp: { ...defaults.mcp, ...global.mcp, ...workspace.mcp },
    notifications: { ...defaults.notifications, ...global.notifications, ...workspace.notifications },
    logging: { ...defaults.logging, ...global.logging, ...workspace.logging },
  }
}

const diagnostics = (
  global: SettingsInput,
  workspace: SettingsInput,
  environment: Environment,
): ReadonlyArray<Diagnostic> => {
  const entries: Array<Diagnostic> = []
  const record = (input: SettingsInput, source: "global" | "workspace") => {
    for (const path of Object.keys(input).toSorted()) entries.push({ path, source, message: `${source} value applied` })
  }
  record(global, "global")
  record(workspace, "workspace")
  if (environment.parallelApiKey !== undefined)
    entries.push({ path: "parallelApiKey", source: "environment", message: "environment value applied (redacted)" })
  if (environment.modelApiKey !== undefined)
    entries.push({ path: "modelApiKey", source: "environment", message: "environment value applied (redacted)" })
  return entries
}

export const memoryLayer = (
  options: {
    readonly global?: SettingsInput
    readonly workspace?: SettingsInput
    readonly environment?: Environment
  } = {},
) => {
  const global = options.global ?? {}
  const workspace = options.workspace ?? {}
  const environment = options.environment ?? {}
  return Layer.succeed(
    Service,
    Service.of({
      effective: Effect.succeed({
        settings: mergeSettings(global, workspace),
        environment,
        diagnostics: diagnostics(global, workspace, environment),
      }),
    }),
  )
}

export const testLayer = memoryLayer

const environmentConfig = Config.all({
  parallelApiKey: Config.option(Config.redacted("PARALLEL_API_KEY")),
  modelApiKey: Config.option(
    Config.redacted("RIKA_MODEL_API_KEY").pipe(Config.orElse(() => Config.redacted("OPENROUTER_API_KEY"))),
  ),
})

export const liveEnvironmentLayer = (
  options: { readonly global?: SettingsInput; readonly workspace?: SettingsInput } = {},
) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const values = yield* environmentConfig
      const environment: Environment =
        values.parallelApiKey._tag === "Some"
          ? { parallelApiKey: Redacted.make(Redacted.value(values.parallelApiKey.value)) }
          : {}
      const completeEnvironment: Environment = {
        ...environment,
        ...(values.modelApiKey._tag === "Some"
          ? { modelApiKey: Redacted.make(Redacted.value(values.modelApiKey.value)) }
          : {}),
      }
      const global = options.global ?? {}
      const workspace = options.workspace ?? {}
      return Service.of({
        effective: Effect.succeed({
          settings: mergeSettings(global, workspace),
          environment: completeEnvironment,
          diagnostics: diagnostics(global, workspace, completeEnvironment),
        }),
      })
    }),
  )

export const effective = Effect.fn("ConfigService.effective")(function* () {
  const service = yield* Service
  return yield* service.effective
})

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"

const defaultOrbTemplate = "rika-orb"
const defaultOrbIdleTimeoutSeconds = 300

export const SettingSource = Schema.Literals(["env", "workspace", "user", "default"]).annotate({
  identifier: "Rika.Settings.SettingSource",
})
export type SettingSource = typeof SettingSource.Type

export const SettingKey = Schema.Literals(["orb.template", "orb.idleTimeoutSeconds", "project.default"]).annotate({
  identifier: "Rika.Settings.SettingKey",
})
export type SettingKey = typeof SettingKey.Type

export interface Values {
  readonly orb: {
    readonly template: string
    readonly idleTimeoutSeconds: number
  }
  readonly project: {
    readonly default?: string
  }
}

export interface Warning {
  readonly source: Exclude<SettingSource, "env" | "default">
  readonly path: string
  readonly message: string
}

export interface Snapshot {
  readonly values: Values
  readonly sources: Partial<Record<SettingKey, SettingSource>>
  readonly warnings: ReadonlyArray<Warning>
}

export interface Interface {
  readonly snapshot: Effect.Effect<Snapshot>
}

export class Service extends Context.Service<Service, Interface>()("@rika/core/Settings") {}

export const userSettingsPath = (home: string) => join(home, ".config", "rika", "settings.json")

export const workspaceSettingsPath = (workspaceRoot: string) => join(workspaceRoot, ".rika", "settings.json")

export const layerFromEnv = (env: Record<string, string | undefined>, workspaceRoot: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const loaded = yield* loadFiles(env.HOME ?? homedir(), workspaceRoot)
      return Service.of({
        snapshot: Effect.succeed(resolve(env, loaded)),
      })
    }),
  )

export const layer = layerFromEnv(process.env, process.cwd())

export const snapshot: Effect.Effect<Snapshot, never, Service> = Effect.flatMap(Service, (service) => service.snapshot)

export const defaultValues = (): Values => ({
  orb: {
    template: defaultOrbTemplate,
    idleTimeoutSeconds: defaultOrbIdleTimeoutSeconds,
  },
  project: {},
})

interface LoadedSettings {
  readonly user: Partial<Record<SettingKey, unknown>>
  readonly workspace: Partial<Record<SettingKey, unknown>>
  readonly warnings: ReadonlyArray<Warning>
}

interface ResolvedValue<A> {
  readonly value: A
  readonly source: SettingSource
}

const loadFiles = (home: string, workspaceRoot: string): Effect.Effect<LoadedSettings> =>
  Effect.gen(function* () {
    const user = yield* loadFile(userSettingsPath(home), "user")
    const workspace = yield* loadFile(workspaceSettingsPath(workspaceRoot), "workspace")
    return {
      user: user.values,
      workspace: workspace.values,
      warnings: [...user.warnings, ...workspace.warnings],
    }
  })

const loadFile = (
  path: string,
  source: Exclude<SettingSource, "env" | "default">,
): Effect.Effect<{
  readonly values: Partial<Record<SettingKey, unknown>>
  readonly warnings: ReadonlyArray<Warning>
}> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => cause,
  }).pipe(
    Effect.flatMap((content) =>
      Effect.sync(() => {
        try {
          const parsed: unknown = JSON.parse(content)
          if (!isRecord(parsed)) {
            return {
              values: {},
              warnings: [{ source, path, message: "Settings file must contain a JSON object." }],
            }
          }
          return { values: pickRecognized(parsed), warnings: [] }
        } catch (cause) {
          return {
            values: {},
            warnings: [{ source, path, message: messageFromUnknown(cause) }],
          }
        }
      }),
    ),
    Effect.catch((cause) => {
      if (isNotFound(cause)) return Effect.succeed({ values: {}, warnings: [] })
      return Effect.succeed({
        values: {},
        warnings: [{ source, path, message: messageFromUnknown(cause) }],
      })
    }),
  )

const resolve = (env: Record<string, string | undefined>, loaded: LoadedSettings): Snapshot => {
  const template = resolveString("orb.template", env.RIKA_ORB_TEMPLATE, loaded, defaultOrbTemplate)
  const idleTimeoutSeconds = resolvePositiveInteger(
    "orb.idleTimeoutSeconds",
    env.RIKA_ORB_IDLE_TIMEOUT,
    loaded,
    defaultOrbIdleTimeoutSeconds,
  )
  const projectDefault = resolveOptionalString("project.default", env.RIKA_ORB_PROJECT, loaded)
  return {
    values: {
      orb: {
        template: template.value,
        idleTimeoutSeconds: idleTimeoutSeconds.value,
      },
      project: projectDefault.value === undefined ? {} : { default: projectDefault.value },
    },
    sources: {
      "orb.template": template.source,
      "orb.idleTimeoutSeconds": idleTimeoutSeconds.source,
      ...(projectDefault.value === undefined ? {} : { "project.default": projectDefault.source }),
    },
    warnings: loaded.warnings,
  }
}

const resolveString = (
  key: SettingKey,
  envValue: string | undefined,
  loaded: LoadedSettings,
  fallback: string,
): ResolvedValue<string> => {
  const envString = validString(envValue)
  if (envString !== undefined) return { value: envString, source: "env" }
  const workspace = validString(loaded.workspace[key])
  if (workspace !== undefined) return { value: workspace, source: "workspace" }
  const user = validString(loaded.user[key])
  if (user !== undefined) return { value: user, source: "user" }
  return { value: fallback, source: "default" }
}

const resolveOptionalString = (
  key: SettingKey,
  envValue: string | undefined,
  loaded: LoadedSettings,
): ResolvedValue<string | undefined> => {
  const envString = validString(envValue)
  if (envString !== undefined) return { value: envString, source: "env" }
  const workspace = validString(loaded.workspace[key])
  if (workspace !== undefined) return { value: workspace, source: "workspace" }
  const user = validString(loaded.user[key])
  if (user !== undefined) return { value: user, source: "user" }
  return { value: undefined, source: "default" }
}

const resolvePositiveInteger = (
  key: SettingKey,
  envValue: string | undefined,
  loaded: LoadedSettings,
  fallback: number,
): ResolvedValue<number> => {
  const envNumber = validPositiveInteger(envValue)
  if (envNumber !== undefined) return { value: envNumber, source: "env" }
  const workspace = validPositiveInteger(loaded.workspace[key])
  if (workspace !== undefined) return { value: workspace, source: "workspace" }
  const user = validPositiveInteger(loaded.user[key])
  if (user !== undefined) return { value: user, source: "user" }
  return { value: fallback, source: "default" }
}

const pickRecognized = (record: Record<string, unknown>): Partial<Record<SettingKey, unknown>> => {
  const values: Partial<Record<SettingKey, unknown>> = {}
  if ("orb.template" in record) values["orb.template"] = record["orb.template"]
  if ("orb.idleTimeoutSeconds" in record) values["orb.idleTimeoutSeconds"] = record["orb.idleTimeoutSeconds"]
  if ("project.default" in record) values["project.default"] = record["project.default"]
  return values
}

const validString = (value: unknown) => {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

const validPositiveInteger = (value: unknown) => {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
  }
  return undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isNotFound = (cause: unknown) =>
  isRecord(cause) && "code" in cause && typeof cause.code === "string" && cause.code === "ENOENT"

const messageFromUnknown = (cause: unknown) => {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

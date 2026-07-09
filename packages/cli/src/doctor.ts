import { Config, Settings, Telemetry } from "@rika/core"
import { Live } from "@rika/llm"
import { LocalHost } from "@rika/rivet-host"
import { Context, Effect, Layer, Schema } from "effect"
import { join } from "node:path"
import * as Args from "./args"
import * as Output from "./output"

export interface EnvironmentSummary extends Schema.Schema.Type<typeof EnvironmentSummary> {}
export const EnvironmentSummary = Schema.Struct({
  bun_version: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
  cwd: Schema.String,
  ci: Schema.Boolean,
}).annotate({ identifier: "Rika.Cli.Doctor.EnvironmentSummary" })

export interface ConfigSummary extends Schema.Schema.Type<typeof ConfigSummary> {}
export const ConfigSummary = Schema.Struct({
  workspace_root: Schema.String,
  data_dir: Schema.String,
  database_url_configured: Schema.Boolean,
  base_url_configured: Schema.Boolean,
  model_base_url: Schema.String,
  model_base_url_source: Schema.Literals(["env", "default"]),
  api_key_configured: Schema.Boolean,
  embeddings_api_key_configured: Schema.Boolean,
  telemetry: Schema.Literals(["disabled", "enabled"]),
  telemetry_endpoint: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Cli.Doctor.ConfigSummary" })

export interface RivetSummary extends Schema.Schema.Type<typeof RivetSummary> {}
export const RivetSummary = Schema.Struct({
  mode: Schema.Literal("local"),
  endpoint: Schema.String,
  run_engine: Schema.Boolean,
  storage_path: Schema.String,
  engine_file_system_path: Schema.String,
  foundationdb: Schema.Literal("not-used"),
}).annotate({ identifier: "Rika.Cli.Doctor.RivetSummary" })

export const CheckStatus = Schema.Literals(["ok", "warning", "skipped"])
export type CheckStatus = typeof CheckStatus.Type

export interface Check extends Schema.Schema.Type<typeof Check> {}
export const Check = Schema.Struct({
  name: Schema.String,
  status: CheckStatus,
  message: Schema.String,
}).annotate({ identifier: "Rika.Cli.Doctor.Check" })

export interface Report extends Schema.Schema.Type<typeof Report> {}
export const Report = Schema.Struct({
  version: Schema.String,
  environment: EnvironmentSummary,
  config: ConfigSummary,
  rivet: RivetSummary,
  checks: Schema.Array(Check),
}).annotate({ identifier: "Rika.Cli.Doctor.Report" })

export interface Input {
  readonly env: Record<string, string | undefined>
  readonly cwd: string
  readonly version?: string
}

export class DoctorError extends Schema.TaggedErrorClass<DoctorError>()("DoctorError", {
  message: Schema.String,
}) {}

export type RunError = DoctorError | Config.ConfigError | Settings.SettingsError

export interface Interface {
  readonly executeCommand: (command: Args.DoctorCommand) => Effect.Effect<number, RunError>
  readonly report: Effect.Effect<Report, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Doctor") {}

export const layerFromInput = (input: Input) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const output = yield* Output.Service
      const makeReport = reportFromInput(input)
      return Service.of({
        executeCommand: Effect.fn("Cli.Doctor.executeCommand")(function* (_command: Args.DoctorCommand) {
          const report = yield* makeReport
          yield* output.stdout(JSON.stringify(report))
          return 0
        }),
        report: makeReport,
      })
    }),
  )

export const executeCommand = Effect.fn("Cli.Doctor.executeCommand.call")(function* (command: Args.DoctorCommand) {
  const service = yield* Service
  return yield* service.executeCommand(command)
})

export const report = Effect.fn("Cli.Doctor.report.call")(function* () {
  const service = yield* Service
  return yield* service.report
})

export const formatError = (error: RunError) => `Rika failed: ${error.message}`

const reportFromInput = (input: Input): Effect.Effect<Report, RunError> =>
  Effect.gen(function* () {
    const workspaceRoot = input.env.RIKA_WORKSPACE_ROOT ?? input.cwd
    const config = yield* Config.valuesFromEnv(input.env, workspaceRoot)
    const settingsSnapshot = yield* Settings.loadSnapshotFromEnv(input.env, workspaceRoot)
    const telemetry = Telemetry.fromSettingsSnapshot(settingsSnapshot, input.version ?? "0.0.0")
    const rivet = rivetSummary(input.env, config.data_dir)
    const modelBaseUrl = Live.modelProviderBaseUrlFromEnv(input.env)
    return {
      version: input.version ?? "0.0.0",
      environment: {
        bun_version: Bun.version,
        platform: process.platform,
        arch: process.arch,
        cwd: input.cwd,
        ci: input.env.CI === "true" || input.env.CI === "1",
      },
      config: {
        workspace_root: config.workspace_root,
        data_dir: config.data_dir,
        database_url_configured: input.env.RIKA_DATABASE_URL !== undefined,
        base_url_configured: secretConfigured(input.env.RIKA_BASE_URL),
        model_base_url: modelBaseUrl,
        model_base_url_source: secretConfigured(input.env.RIKA_BASE_URL) ? "env" : "default",
        api_key_configured: secretConfigured(input.env.RIKA_API_KEY),
        embeddings_api_key_configured: secretConfigured(input.env.RIKA_EMBEDDINGS_API_KEY),
        telemetry: telemetry.enabled ? "enabled" : "disabled",
        ...(telemetry.enabled ? { telemetry_endpoint: telemetry.endpoint } : {}),
      },
      rivet,
      checks: checks({ env: input.env, dataDir: config.data_dir, modelBaseUrl, rivet }),
    }
  })

const rivetSummary = (env: Record<string, string | undefined>, dataDir: string): RivetSummary => {
  const endpoint = env.RIKA_RIVET_ENDPOINT ?? LocalHost.defaultEndpoint
  const storagePath = env.RIVETKIT_STORAGE_PATH ?? join(dataDir, "rivetkit")
  return {
    mode: "local",
    endpoint,
    run_engine: true,
    storage_path: storagePath,
    engine_file_system_path: env.RIVET__FILE_SYSTEM__PATH ?? join(storagePath, ".rivetkit", "var", "engine", "db"),
    foundationdb: "not-used",
  }
}

const checks = (input: {
  readonly env: Record<string, string | undefined>
  readonly dataDir: string
  readonly modelBaseUrl: string
  readonly rivet: RivetSummary
}): ReadonlyArray<Check> => [
  {
    name: "data-dir",
    status: input.dataDir.length > 0 ? "ok" : "warning",
    message: input.dataDir.length > 0 ? "Data directory is configured." : "Data directory is empty.",
  },
  {
    name: "model-provider",
    status: secretConfigured(input.env.RIKA_API_KEY) ? "ok" : "warning",
    message: secretConfigured(input.env.RIKA_API_KEY)
      ? "Model provider API key is configured. Secret values are not printed."
      : "RIKA_API_KEY is required for live model calls.",
  },
  {
    name: "model-base-url",
    status: "ok",
    message: `Model provider base URL is ${input.modelBaseUrl}.`,
  },
  {
    name: "rivet-engine",
    status: "ok",
    message: "Local Rivet Engine will be spawned by RivetKit and backed by filesystem storage.",
  },
  {
    name: "rivet-storage",
    status: "ok",
    message: `Rivet filesystem storage is configured at ${input.rivet.engine_file_system_path}. FoundationDB is not used for local-only Rika.`,
  },
]

const secretConfigured = (value: string | undefined) => value !== undefined && value.length > 0

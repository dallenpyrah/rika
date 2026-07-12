import { Schema, type Redacted } from "effect"

export type ModeId = "low" | "medium" | "high" | "ultra"
export type PermissionDecision = "allow" | "ask" | "deny"
export type LogLevel = "debug" | "info" | "warning" | "error"

export interface ModelAlias {
  readonly model: string
  readonly provider: string
}

export interface ProviderConnection {
  readonly baseUrl?: string
}

export interface ModeConfig {
  readonly budget: number
  readonly model: string
  readonly oracleModel: string
  readonly reasoning: "low" | "medium" | "high"
}

export interface McpCommandDefinition {
  readonly transport: "command"
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string
  readonly environment: Readonly<Record<string, string>>
  readonly enabled: boolean
}

export interface McpRemoteDefinition {
  readonly transport: "remote"
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly enabled: boolean
}

export type McpDefinition = McpCommandDefinition | McpRemoteDefinition

export interface Settings {
  readonly providers: Readonly<Record<string, ProviderConnection>>
  readonly models: Readonly<Record<string, ModelAlias>>
  readonly modes: Readonly<Record<ModeId, ModeConfig>>
  readonly keymap: Readonly<Record<string, string>>
  readonly permissions: Readonly<Record<string, PermissionDecision>>
  readonly extensionRoots: ReadonlyArray<string>
  readonly mcp: Readonly<Record<string, McpDefinition>>
  readonly notifications: { readonly enabled: boolean; readonly command?: string }
  readonly logging: { readonly level: LogLevel; readonly file?: string }
}

export interface SettingsInput {
  readonly providers?: Readonly<Record<string, ProviderConnection>>
  readonly models?: Readonly<Record<string, ModelAlias>>
  readonly modes?: Partial<Readonly<Record<ModeId, Partial<ModeConfig>>>>
  readonly keymap?: Readonly<Record<string, string>>
  readonly permissions?: Readonly<Record<string, PermissionDecision>>
  readonly extensionRoots?: ReadonlyArray<string>
  readonly mcp?: Readonly<Record<string, McpDefinition>>
  readonly notifications?: Partial<Settings["notifications"]>
  readonly logging?: Partial<Settings["logging"]>
}

export interface Environment {
  readonly modelApiKey?: Redacted.Redacted
  readonly parallelApiKey?: Redacted.Redacted
}

export interface Diagnostic {
  readonly path: string
  readonly source: "default" | "global" | "workspace" | "environment"
  readonly message: string
}

export interface EffectiveConfig {
  readonly settings: Settings
  readonly environment: Environment
  readonly diagnostics: ReadonlyArray<Diagnostic>
}

export class ConfigFileError extends Schema.TaggedErrorClass<ConfigFileError>()("ConfigFileError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export class ModelRouteError extends Schema.TaggedErrorClass<ModelRouteError>()("ModelRouteError", {
  mode: Schema.String,
  message: Schema.String,
}) {}

export interface ResolvedModelRoute extends ModelAlias {
  readonly alias: string
  readonly baseUrl?: string
}

export const resolveModelRoute = (settings: Settings, mode: ModeId): ResolvedModelRoute => {
  const alias = settings.modes[mode].model
  const model = settings.models[alias]
  if (model === undefined)
    throw new ModelRouteError({ mode, message: `Mode ${mode} references missing model alias ${alias}` })
  const connection = settings.providers[model.provider]
  return { alias, ...model, ...(connection?.baseUrl === undefined ? {} : { baseUrl: connection.baseUrl }) }
}

export const decodeSettingsInput = (path: string, value: unknown): SettingsInput => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ConfigFileError({ path, message: "Configuration must be a JSON object" })
  const input = value as Record<string, unknown>
  if ("apiKey" in input) throw new ConfigFileError({ path, message: "apiKey is environment-only" })
  for (const [name, connection] of Object.entries((input.providers ?? {}) as Record<string, unknown>)) {
    if (connection === null || typeof connection !== "object" || Array.isArray(connection))
      throw new ConfigFileError({ path, message: `Provider ${name} must be an object` })
    const record = connection as Record<string, unknown>
    if ("apiKey" in record) throw new ConfigFileError({ path, message: `Provider ${name} apiKey is environment-only` })
    if (record.baseUrl !== undefined && typeof record.baseUrl !== "string")
      throw new ConfigFileError({ path, message: `Provider ${name} baseUrl must be a string` })
  }
  for (const [name, alias] of Object.entries((input.models ?? {}) as Record<string, unknown>)) {
    const record = alias as Record<string, unknown>
    if (
      alias === null ||
      typeof alias !== "object" ||
      typeof record.provider !== "string" ||
      typeof record.model !== "string"
    )
      throw new ConfigFileError({ path, message: `Model alias ${name} requires string provider and model` })
  }
  return input as SettingsInput
}

export const defaults: Settings = {
  providers: {},
  models: {
    terra: { provider: "openrouter", model: "openai/gpt-5.6-terra" },
    luna: { provider: "openrouter", model: "openai/gpt-5.6-luna" },
    sol: { provider: "openrouter", model: "openai/gpt-5.6-sol" },
    fable: { provider: "openrouter", model: "anthropic/claude-fable-5" },
  },
  modes: {
    low: { model: "terra", oracleModel: "sol", reasoning: "low", budget: 32 },
    medium: { model: "luna", oracleModel: "sol", reasoning: "medium", budget: 64 },
    high: { model: "sol", oracleModel: "fable", reasoning: "high", budget: 128 },
    ultra: { model: "fable", oracleModel: "fable", reasoning: "high", budget: 256 },
  },
  keymap: { mode: "ctrl+s", palette: "ctrl+p", submit: "enter", newline: "shift+enter", interrupt: "escape" },
  permissions: { read: "allow", search: "allow", write: "allow", shell: "allow", external: "allow" },
  extensionRoots: ["~/.config/rika/extensions", ".rika/extensions"],
  mcp: {},
  notifications: { enabled: true },
  logging: { level: "info" },
}

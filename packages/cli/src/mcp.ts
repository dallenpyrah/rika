import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname } from "node:path"
import { SkillRegistry } from "@rika/agent"
import { Settings } from "@rika/core"
import { BuiltInTools, McpClient } from "@rika/tools"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as Args from "./args"
import * as Output from "./output"

export class McpError extends Schema.TaggedErrorClass<McpError>()("McpError", {
  message: Schema.String,
  action: Args.McpAction,
  path: Schema.optional(Schema.String),
}) {}

export type RunError = McpClient.RunError | McpError

export interface Input {
  readonly env: Record<string, string | undefined>
  readonly cwd: string
  readonly home?: string
  readonly system?: System
}

export interface System {
  readonly readText: (path: string) => Effect.Effect<string, unknown>
  readonly writeText: (path: string, content: string) => Effect.Effect<void, unknown>
  readonly makeDirectory: (path: string) => Effect.Effect<void, unknown>
}

export interface Interface {
  readonly executeCommand: (command: Args.McpCommand) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Mcp") {}

export const layerFromInput = (input: Input) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const output = yield* Output.Service
      const mcp = yield* McpClient.Service
      const skillRegistry = Option.getOrUndefined(yield* Effect.serviceOption(SkillRegistry.Service))
      const system = input.system ?? liveSystem

      return Service.of({
        executeCommand: Effect.fn("Cli.Mcp.executeCommand")(function* (command: Args.McpCommand) {
          switch (command.action) {
            case "list": {
              const servers = yield* managementSources(mcp, skillRegistry, command.action).pipe(
                Effect.flatMap((sources) => mcp.serversForSources(sources)),
              )
              yield* output.stdout(formatJson(servers))
              return 0
            }
            case "add": {
              const result = yield* addServer(input, system, command)
              yield* output.stdout(formatJson(result))
              return 0
            }
            case "remove": {
              const result = yield* removeServer(input, system, command)
              yield* output.stdout(formatJson(result))
              return 0
            }
            case "doctor": {
              const results = yield* managementSources(mcp, skillRegistry, command.action).pipe(
                Effect.flatMap((sources) => mcp.doctorForSources(sources)),
              )
              yield* output.stdout(formatJson(results))
              return 0
            }
            case "approve": {
              const serverName = yield* requireServerName(command)
              const approval = yield* managementSources(mcp, skillRegistry, command.action).pipe(
                Effect.flatMap((sources) => mcp.approveForSources(serverName, sources)),
              )
              yield* output.stdout(formatJson(approval))
              return 0
            }
          }
          return yield* new McpError({ message: "Unsupported MCP action", action: command.action })
        }),
      })
    }),
  )

export const layer = layerFromInput({ env: process.env, cwd: process.cwd() })

export const executeCommand = Effect.fn("Cli.Mcp.executeCommand.call")(function* (command: Args.McpCommand) {
  const service = yield* Service
  return yield* service.executeCommand(command)
})

export const formatError = (error: RunError) => {
  if (error instanceof McpError) return error.message
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const requireServerName = (command: Args.McpCommand) =>
  command.server_name === undefined
    ? Effect.fail(new McpError({ message: `Server name is required for ${command.action}`, action: command.action }))
    : Effect.succeed(command.server_name)

const managementSources = (
  mcp: McpClient.Interface,
  skillRegistry: SkillRegistry.Interface | undefined,
  action: Args.McpAction,
): Effect.Effect<ReadonlyArray<McpClient.SettingsSource>, RunError> =>
  Effect.gen(function* () {
    const settingsSources = yield* mcp.settingsSources
    const sources = yield* skillMcpSources(skillRegistry, action)
    return [...sources, ...settingsSources]
  })

const skillMcpSources = (
  skillRegistry: SkillRegistry.Interface | undefined,
  action: Args.McpAction,
): Effect.Effect<ReadonlyArray<McpClient.SettingsSource>, McpError> =>
  Effect.gen(function* () {
    if (skillRegistry === undefined) return []
    const summaries = yield* skillRegistry
      .list()
      .pipe(Effect.mapError((error) => new McpError({ message: error.message, action })))
    const skills = yield* Effect.forEach(
      summaries,
      (summary) =>
        skillRegistry
          .inspect(summary.name)
          .pipe(Effect.mapError((error) => new McpError({ message: error.message, action }))),
      { concurrency: 1 },
    )
    return BuiltInTools.skillMcpSources(skills)
  })

const addServer = (input: Input, system: System, command: Args.McpCommand) =>
  Effect.gen(function* () {
    const name = yield* requireServerName(command)
    const config = yield* serverConfigFromCommand(command)
    const target = targetSettings(command, input)
    const settings = yield* readSettingsObject(system, target.path, command.action)
    const servers = yield* readServerMap(settings, target.path, command.action)
    settings[McpClient.settingsKey] = { ...servers, [name]: config }
    delete settings.mcpServers
    yield* writeSettingsObject(system, target.path, settings, command.action)
    return { action: "add", name, source: target.source, path: target.path, config }
  })

const removeServer = (input: Input, system: System, command: Args.McpCommand) =>
  Effect.gen(function* () {
    const name = yield* requireServerName(command)
    const target = targetSettings(command, input)
    const settings = yield* readSettingsObject(system, target.path, command.action)
    const servers = { ...(yield* readServerMap(settings, target.path, command.action)) }
    delete servers[name]
    if (Object.keys(servers).length === 0) delete settings[McpClient.settingsKey]
    else settings[McpClient.settingsKey] = servers
    delete settings.mcpServers
    yield* writeSettingsObject(system, target.path, settings, command.action)
    return { action: "remove", name, source: target.source, path: target.path }
  })

const serverConfigFromCommand = (command: Args.McpCommand): Effect.Effect<McpClient.ServerConfig, McpError> => {
  const raw =
    command.url === undefined
      ? command.command === undefined || command.command.length === 0
        ? undefined
        : {
            command: command.command,
            ...(command.args === undefined || command.args.length === 0 ? {} : { args: command.args }),
          }
      : { url: command.url }
  if (raw === undefined) {
    return Effect.fail(new McpError({ message: "MCP server config is required", action: command.action }))
  }
  const decoded = Schema.decodeUnknownOption(McpClient.ServerConfig)(raw)
  if (decoded._tag === "Some") return Effect.succeed(decoded.value)
  return Effect.fail(new McpError({ message: "Invalid MCP server config", action: command.action }))
}

const targetSettings = (command: Args.McpCommand, input: Input) => {
  const source = command.global === true ? "user" : "workspace"
  const path =
    source === "workspace"
      ? Settings.workspaceSettingsPath(input.env.RIKA_WORKSPACE_ROOT ?? input.cwd)
      : Settings.userSettingsPath(input.home ?? input.env.HOME ?? homedir())
  return { source, path } as const
}

const readSettingsObject = (
  system: System,
  path: string,
  action: Args.McpAction,
): Effect.Effect<Record<string, unknown>, McpError> =>
  system.readText(path).pipe(
    Effect.matchEffect({
      onFailure: (cause) => (isNotFound(cause) ? Effect.succeed({}) : Effect.fail(commandError(cause, action, path))),
      onSuccess: (content) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => JSON.parse(content) as unknown,
            catch: (cause) => commandError(cause, action, path),
          })
          if (isRecord(parsed)) return { ...parsed }
          return yield* new McpError({ message: "Settings file must contain a JSON object", action, path })
        }),
    }),
  )

const readServerMap = (
  settings: Record<string, unknown>,
  path: string,
  action: Args.McpAction,
): Effect.Effect<Readonly<Record<string, McpClient.ServerConfig>>, McpError> => {
  const raw = settings[McpClient.settingsKey] ?? settings.mcpServers ?? {}
  const decoded = Schema.decodeUnknownOption(Schema.Record(Schema.String, McpClient.ServerConfig))(raw)
  if (decoded._tag === "Some") return Effect.succeed(decoded.value)
  return Effect.fail(new McpError({ message: `Invalid MCP settings in ${path}`, action, path }))
}

const writeSettingsObject = (
  system: System,
  path: string,
  settings: Record<string, unknown>,
  action: Args.McpAction,
): Effect.Effect<void, McpError> =>
  Effect.gen(function* () {
    yield* system.makeDirectory(dirname(path)).pipe(Effect.mapError((cause) => commandError(cause, action, path)))
    yield* system
      .writeText(path, `${JSON.stringify(settings, null, 2)}\n`)
      .pipe(Effect.mapError((cause) => commandError(cause, action, path)))
  })

const formatJson = (value: unknown) => JSON.stringify(value)

const liveSystem: System = {
  readText: (path) =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => cause,
    }),
  writeText: (path, content) =>
    Effect.tryPromise({
      try: () => writeFile(path, content),
      catch: (cause) => cause,
    }),
  makeDirectory: (path) =>
    Effect.tryPromise({
      try: () => mkdir(path, { recursive: true }),
      catch: (cause) => cause,
    }),
}

const commandError = (cause: unknown, action: Args.McpAction, path?: string) =>
  new McpError({ message: errorMessage(cause), action, ...(path === undefined ? {} : { path }) })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isNotFound = (cause: unknown) => cause instanceof Error && "code" in cause && cause.code === "ENOENT"

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

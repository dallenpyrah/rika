import {
  CheckRegistry,
  ReviewService,
  SkillRegistry,
  ThreadMemory,
  ThreadMemoryIndexer,
  WorkspaceIdentity,
} from "@rika/agent"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Settings, Time } from "@rika/core"
import { Embeddings } from "@rika/llm"
import {
  ArtifactStore,
  Database,
  McpApprovalStore,
  Migration,
  ThreadEventLog,
  ThreadMemoryStore,
  ThreadProjection,
} from "@rika/persistence"
import { PluginHost, PluginUi, SelfExtension } from "@rika/plugin"
import { Event, Ids, Message } from "@rika/schema"
import { LocalHost, ThreadClient, ThreadDirectory } from "@rika/rivet-host"
import { BaseServiceLayer, McpClient } from "@rika/tools"
import { Effect, Layer, Stream } from "effect"
import * as Args from "./args"
import * as CliConfig from "./config"
import * as Doctor from "./doctor"
import * as Execute from "./execute"
import * as Extensions from "./extensions"
import * as Help from "./help"
import * as Input from "./input"
import * as Mcp from "./mcp"
import * as Memory from "./memory"
import * as Output from "./output"
import * as Review from "./review"
import * as RuntimeEnv from "./runtime-env"
import * as SkillInstaller from "./skill-installer"
import * as Skills from "./skills"
import * as Threads from "./threads"
import * as Version from "./version"

export interface ProcessInput {
  readonly argv: ReadonlyArray<string>
  readonly env: Record<string, string | undefined>
  readonly cwd: string
}

export const runProcess: (input: ProcessInput) => Effect.Effect<number, never, Output.Service> = Effect.fn(
  "Cli.Runtime.runProcess",
)((input) =>
  RuntimeEnv.load(input).pipe(
    Effect.matchEffect({
      onFailure: (error) => Output.stderr(RuntimeEnv.formatError(error)).pipe(Effect.as(1)),
      onSuccess: (env) =>
        Args.parse(input.argv).pipe(
          Effect.matchEffect({
            onFailure: (error: Args.ArgsError) =>
              Output.stderr(Execute.formatError(error)).pipe(Effect.as(error.exit_code)),
            onSuccess: (command) =>
              routeCommand(command, env, input.cwd).pipe(
                Effect.matchEffect({
                  onFailure: (error) =>
                    Output.stderr(formatRuntimeError(error)).pipe(Effect.as(runtimeExitCode(error))),
                  onSuccess: (code) => Effect.succeed(code),
                }),
              ),
          }),
        ),
    }),
  ),
)

const routeCommand = (
  command: Args.ParsedCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Effect.Effect<number, unknown, Output.Service> => {
  switch (command.type) {
    case "invalid_execute_alias":
      return Output.stderrRaw(Args.invalidExecuteAliasErrorText).pipe(Effect.as(1))
    case "help":
      return Help.executeCommand(command)
    case "version":
      return Version.executeCommand(command)
    case "tui":
      return Effect.promise(() => Promise.all([import("./tui"), import("@rika/tui")])).pipe(
        Effect.flatMap(([tuiModule, tuiPackage]) =>
          tuiModule
            .executeCommand(command)
            .pipe(Effect.provide(tuiLiveLayer(command, env, cwd, tuiModule, tuiPackage))),
        ),
      )
    case "execute":
      return Execute.executeCommand(command).pipe(Effect.provide(executeLiveLayer(command, env, cwd)))
    case "threads":
      return Threads.executeCommand(command).pipe(Effect.provide(threadsLiveLayer(command, env, cwd)))
    case "skills":
      return Skills.executeCommand(command).pipe(Effect.provide(skillsLiveLayer(env, cwd)))
    case "mcp":
      return Mcp.executeCommand(command).pipe(Effect.provide(mcpLiveLayer(env, cwd)))
    case "config":
      return CliConfig.executeCommand(command).pipe(Effect.provide(configLiveLayer(env, cwd)))
    case "review":
      return Review.executeCommand(command).pipe(Effect.provide(reviewLiveLayer(command, env, cwd)))
    case "extensions":
      return Extensions.executeCommand(command).pipe(Effect.provide(extensionsLiveLayer(env, cwd)))
    case "memory":
      return Memory.executeCommand(command).pipe(Effect.provide(memoryLiveLayer(command, env, cwd)))
    case "doctor":
      return Doctor.executeCommand(command).pipe(Effect.provide(doctorLiveLayer(env, cwd)))
  }
}

const runtimeConfigLayer = (env: Record<string, string | undefined>, workspaceRoot: string) =>
  Config.layerFromEnv(envForWorkspaceRoot(env, workspaceRoot), workspaceRoot)

const secretRedactorLayer = (env: Record<string, string | undefined>) => SecretRedactor.layerFromEnv(env)

const baseLayers = (
  env: Record<string, string | undefined>,
  workspaceRoot: string,
  databaseMode: BaseServiceLayer.DatabaseMode = "live",
) => {
  const runtimeEnv = envForWorkspaceRoot(env, workspaceRoot)
  const configLayer = runtimeConfigLayer(runtimeEnv, workspaceRoot)
  const redactorLayer = secretRedactorLayer(runtimeEnv)
  return BaseServiceLayer.fromEnv({
    env: runtimeEnv,
    workspaceRoot,
    configLayer,
    redactorLayer,
    databaseMode,
  })
}

const rivetLayers = (env: Record<string, string | undefined>, workspaceRoot: string, cwd: string) => {
  const runtimeEnv = envForWorkspaceRoot(env, workspaceRoot)
  const hostLayer = LocalHost.managedLayerFromEnv(runtimeEnv, workspaceRoot, { databaseMode: "memory" })
  const clientLayer = LocalHost.threadClientLayerFromEnv(runtimeEnv)
  const directoryLayer = LocalHost.threadDirectoryLiveLayerFromEnv(runtimeEnv)
  void cwd
  return { hostLayer, clientLayer, directoryLayer }
}

const executeLiveLayer = (command: Args.ExecuteCommand, env: Record<string, string | undefined>, cwd: string) => {
  const workspaceRoot = command.workspace_root ?? env.RIKA_WORKSPACE_ROOT ?? cwd
  const services = baseLayers(env, workspaceRoot, command.ephemeral ? "memory" : "live")
  const rivet = rivetLayers(env, workspaceRoot, cwd)
  return Execute.layer.pipe(
    Layer.provideMerge(Output.layer),
    Layer.provideMerge(Input.layer),
    Layer.provideMerge(services.baseLayer),
    Layer.provideMerge(rivet.clientLayer),
    Layer.provideMerge(rivet.hostLayer),
  )
}

const tuiLiveLayer = (
  command: Args.TuiCommand,
  env: Record<string, string | undefined>,
  cwd: string,
  tuiModule: typeof import("./tui"),
  tuiPackage: typeof import("@rika/tui"),
) => {
  const workspaceRoot = command.workspace_root ?? env.RIKA_WORKSPACE_ROOT ?? cwd
  const services = baseLayers(env, workspaceRoot, command.ephemeral ? "memory" : "live")
  const rivet = rivetLayers(env, workspaceRoot, cwd)
  return tuiModule.layer.pipe(
    Layer.provideMerge(tuiPackage.Adapter.layer),
    Layer.provideMerge(tuiPackage.Ticker.layer),
    Layer.provideMerge(services.baseLayer),
    Layer.provideMerge(rivet.clientLayer),
    Layer.provideMerge(rivet.directoryLayer),
    Layer.provideMerge(rivet.hostLayer),
  )
}

const threadsLiveLayer = (command: Args.ThreadCommand, env: Record<string, string | undefined>, cwd: string) => {
  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
  const services = baseLayers(env, workspaceRoot)
  const rivet = rivetLayers(env, workspaceRoot, cwd)
  void command
  return Threads.layer.pipe(
    Layer.provideMerge(Output.layer),
    Layer.provideMerge(Input.layer),
    Layer.provideMerge(services.baseLayer),
    Layer.provideMerge(rivet.clientLayer),
    Layer.provideMerge(rivet.directoryLayer),
    Layer.provideMerge(rivet.hostLayer),
  )
}

const skillsLiveLayer = (env: Record<string, string | undefined>, cwd: string) => {
  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
  const services = baseLayers(env, workspaceRoot)
  const installerLayer = SkillInstaller.liveLayer.pipe(Layer.provideMerge(services.baseLayer))
  return Skills.layer.pipe(
    Layer.provideMerge(Output.layer),
    Layer.provideMerge(services.baseLayer),
    Layer.provideMerge(installerLayer),
  )
}

const mcpLiveLayer = (env: Record<string, string | undefined>, cwd: string) => {
  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
  const services = baseLayers(env, workspaceRoot)
  const mcpClientLayer = McpClient.layer.pipe(Layer.provideMerge(services.migratedStorageLayer))
  return Mcp.layerFromInput({ env: envForWorkspaceRoot(env, workspaceRoot), cwd: workspaceRoot }).pipe(
    Layer.provideMerge(Output.layer),
    Layer.provideMerge(services.baseLayer),
    Layer.provideMerge(mcpClientLayer),
  )
}

const configLiveLayer = (env: Record<string, string | undefined>, cwd: string) =>
  CliConfig.layerFromInput({ env, cwd }).pipe(Layer.provideMerge(Output.layer))

const reviewLiveLayer = (command: Args.ReviewCommand, env: Record<string, string | undefined>, cwd: string) => {
  const workspaceRoot = command.workspace_root ?? env.RIKA_WORKSPACE_ROOT ?? cwd
  const services = baseLayers(env, workspaceRoot, command.ephemeral ? "memory" : "live")
  const reviewServiceLayer = ReviewService.layer.pipe(
    Layer.provideMerge(services.baseLayer),
    Layer.provideMerge(CheckRegistry.layer.pipe(Layer.provideMerge(services.configLayer))),
  )
  return Review.layer.pipe(
    Layer.provideMerge(Output.layer),
    Layer.provideMerge(services.baseLayer),
    Layer.provideMerge(reviewServiceLayer),
  )
}

const extensionsLiveLayer = (env: Record<string, string | undefined>, cwd: string) => {
  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
  const services = baseLayers(env, workspaceRoot)
  const extensionLayer = SelfExtension.layer.pipe(Layer.provideMerge(services.migratedStorageLayer))
  return Extensions.layer.pipe(
    Layer.provideMerge(Output.layer),
    Layer.provideMerge(services.baseLayer),
    Layer.provideMerge(extensionLayer),
  )
}

const memoryLiveLayer = (command: Args.MemoryCommand, env: Record<string, string | undefined>, cwd: string) => {
  const workspaceRoot = command.workspace_root ?? env.RIKA_WORKSPACE_ROOT ?? cwd
  const services = baseLayers(env, workspaceRoot)
  const indexerLayer = ThreadMemoryIndexer.layer.pipe(
    Layer.provideMerge(services.migratedStorageLayer),
    Layer.provideMerge(services.embeddingsLayer),
    Layer.provideMerge(services.diagnosticsLayer),
  )
  return Memory.layer.pipe(
    Layer.provideMerge(Output.layer),
    Layer.provideMerge(services.baseLayer),
    Layer.provideMerge(indexerLayer),
  )
}

const doctorLiveLayer = (env: Record<string, string | undefined>, cwd: string) =>
  Doctor.layerFromInput({ env, cwd }).pipe(Layer.provideMerge(Output.layer))

export const envForWorkspaceRoot = (env: Record<string, string | undefined>, workspaceRoot: string) => ({
  ...env,
  RIKA_WORKSPACE_ROOT: workspaceRoot,
})

const formatRuntimeError = (error: unknown) => {
  if (error instanceof Args.ArgsError) return Execute.formatError(error)
  if (error instanceof Execute.ExecuteError) return Execute.formatError(error)
  if (error instanceof Threads.ThreadsError) return Threads.formatError(error)
  if (error instanceof Skills.SkillsError) return Skills.formatError(error)
  if (error instanceof Mcp.McpError) return Mcp.formatError(error)
  if (error instanceof CliConfig.ConfigCommandError) return CliConfig.formatError(error)
  if (error instanceof Review.ReviewError) return Review.formatError(error)
  if (error instanceof Extensions.ExtensionsError) return Extensions.formatError(error)
  if (error instanceof Doctor.DoctorError) return Doctor.formatError(error)
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const runtimeExitCode = (error: unknown) =>
  error instanceof Args.ArgsError || error instanceof Execute.ExecuteError ? error.exit_code : 1

export const localRivetSetup = (env: Record<string, string | undefined>, cwd: string) => {
  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
  const values = Config.valuesFromEnv(envForWorkspaceRoot(env, workspaceRoot), workspaceRoot)
  return values.pipe(
    Effect.map((config) => {
      const storagePath = env.RIVETKIT_STORAGE_PATH ?? `${config.data_dir}/rivetkit`
      return {
        endpoint: env.RIKA_RIVET_ENDPOINT ?? LocalHost.defaultEndpoint,
        storage_path: storagePath,
        engine_file_system_path: env.RIVET__FILE_SYSTEM__PATH ?? `${storagePath}/.rivetkit/var/engine/db`,
        foundationdb: "not-used",
      }
    }),
  )
}

export const runThreadTurnForTui = (
  threadClient: ThreadClient.Interface,
  input: {
    readonly thread_id: Ids.ThreadId
    readonly workspace_id: Ids.WorkspaceId
    readonly content: string
    readonly content_parts?: ReadonlyArray<Message.ContentPart>
    readonly mode?: Config.Mode
  },
) =>
  Stream.unwrap(
    threadClient
      .startTurn(input)
      .pipe(Effect.as(threadClient.subscribeEvents({ thread_id: input.thread_id, after_sequence: 0 }))),
  )

export type LocalRuntimeLayerOutput =
  | ArtifactStore.Service
  | Config.Service
  | Database.Service
  | Diagnostics.Service
  | Embeddings.Service
  | IdGenerator.Service
  | Input.Service
  | McpApprovalStore.Service
  | Migration.Service
  | Output.Service
  | PluginHost.Service
  | PluginUi.Service
  | SecretRedactor.Service
  | Settings.Service
  | SkillRegistry.Service
  | ThreadClient.Service
  | ThreadDirectory.Service
  | ThreadEventLog.Service
  | ThreadMemory.Service
  | ThreadMemoryIndexer.Service
  | ThreadMemoryStore.Service
  | ThreadProjection.Service
  | Time.Service

export const workspaceIdForRoot = (workspaceRoot: string) =>
  WorkspaceIdentity.resolveWorkspaceId({ workspace_root: workspaceRoot })

export const encodeEvent = (event: Event.Event) => Execute.encodeEvent(event)

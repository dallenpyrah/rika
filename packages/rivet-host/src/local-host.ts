import { BaseServiceLayer } from "@rika/tools"
import { CompactionService, WorkspaceAccess } from "@rika/agent"
import { Config, SecretRedactor } from "@rika/core"
import { Client, Logger, Registry } from "@rivetkit/effect"
import { Context, Effect, Layer, Scope } from "effect"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import type { setup as setupType } from "rivetkit"
import * as HostConfig from "./host-config"
import * as ThreadDirectory from "./thread-directory"
import * as ThreadClient from "./thread-client"
import { layer as threadActorLayer } from "./thread-live"

export interface MetadataReadinessOptions {
  readonly attempts?: number
  readonly delayMillis?: number
}

export interface RawRegistry {
  readonly start: () => void
  readonly shutdown: () => Promise<void>
  readonly parseConfig: () => {
    readonly endpoint?: string
    readonly namespace?: string
    readonly token?: string
  }
}

export type SetupRegistry = (options: Parameters<typeof setupType>[0]) => RawRegistry

export interface ProcessListing {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

export type ProcessListingRunner = (listing: ProcessListing) => Promise<string | undefined>

export interface Options extends HostConfig.ResolveOptions {
  readonly workspaceAccessLayer?: Layer.Layer<WorkspaceAccess.Service, unknown>
  readonly databaseMode?: BaseServiceLayer.DatabaseMode
  readonly setupRegistry?: SetupRegistry
  readonly metadataReadiness?: MetadataReadinessOptions
  readonly processListingRunner?: ProcessListingRunner
}

export const defaultEndpoint = HostConfig.defaultLocalEndpoint

export const endpointFromEnv = (env: Record<string, string | undefined> = process.env) =>
  env.RIKA_RIVET_ENDPOINT ?? defaultEndpoint

export const installedEngineBinaryPath = (executablePath = process.execPath) =>
  join(
    dirname(executablePath),
    "..",
    "share",
    "rika",
    "bin",
    process.platform === "win32" ? "rivet-engine.exe" : "rivet-engine",
  )

export const installedRivetHostNodeModulesPath = (executablePath = process.execPath) =>
  join(dirname(executablePath), "..", "share", "rika", "rivet-host", "node_modules")

export const engineBinaryPathFromEnv = (
  env: Record<string, string | undefined> = process.env,
  executablePath = process.execPath,
  exists: (path: string) => boolean = existsSync,
) => {
  const configured = env.RIVET_ENGINE_BINARY?.trim()
  if (configured !== undefined && configured.length > 0) return configured
  const installed = installedEngineBinaryPath(executablePath)
  return exists(installed) ? installed : undefined
}

type ServiceLayerOutput = BaseServiceLayer.CommonOutput

type ServiceLayerError = BaseServiceLayer.Error

export const serviceLayerFromEnv = (
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
  options: Pick<Options, "databaseMode"> = {},
): Layer.Layer<ServiceLayerOutput, ServiceLayerError> => {
  const configLayer = Config.layerFromEnv(env, cwd)
  const redactorLayer = SecretRedactor.layerFromEnv(env)

  return BaseServiceLayer.fromEnv({
    env,
    workspaceRoot: cwd,
    configLayer,
    redactorLayer,
    databaseMode: options.databaseMode ?? "memory",
  }).agentLoopLayer
}

export const serviceLayer: Layer.Layer<ServiceLayerOutput, ServiceLayerError> = serviceLayerFromEnv()

export const supportLayer: Layer.Layer<ServiceLayerOutput, ServiceLayerError> = serviceLayer

export const supportLayerFromEnv = (
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
  options: Pick<Options, "databaseMode"> = {},
): Layer.Layer<ServiceLayerOutput, ServiceLayerError> => serviceLayerFromEnv(env, cwd, options)

const actorSupportLayerFromEnv = (
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
  options: Options = {},
) => {
  const support = supportLayerFromEnv(env, cwd, options)
  const compaction = CompactionService.layer.pipe(Layer.provideMerge(support))
  return options.workspaceAccessLayer === undefined
    ? Layer.mergeAll(support, compaction)
    : Layer.mergeAll(support, compaction, options.workspaceAccessLayer)
}

export const actorsLayerFromEnv = (
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
  options: Options = {},
) =>
  Layer.mergeAll(
    threadActorLayer.pipe(
      Layer.provideMerge(ThreadDirectory.liveLayer.pipe(Layer.provideMerge(clientLayerFromEnv(env, options)))),
    ),
    ThreadDirectory.actorLayer,
  ).pipe(Layer.provide(actorSupportLayerFromEnv(env, cwd, options)))

export const actorsLayer = () => actorsLayerFromEnv()

export const clientLayer = (options: Options = {}) =>
  Layer.unwrap(
    HostConfig.resolveOptions(options).pipe(Effect.map((host) => Client.layer(HostConfig.toClientOptions(host)))),
  )

export const clientLayerFromEnv = (env: Record<string, string | undefined> = process.env, options: Options = {}) =>
  Layer.unwrap(
    HostConfig.resolveOptions(options, env).pipe(Effect.map((host) => Client.layer(HostConfig.toClientOptions(host)))),
  )

export const threadClientLayer = (options: Options = {}) =>
  ThreadClient.layer.pipe(
    Layer.provideMerge(clientLayer(options)),
    Layer.provideMerge(ThreadClient.liveConnectionLayer(options)),
  )

export const threadClientLayerFromEnv = (
  env: Record<string, string | undefined> = process.env,
  options: Options = {},
) =>
  ThreadClient.layer.pipe(
    Layer.provideMerge(clientLayerFromEnv(env, options)),
    Layer.provideMerge(ThreadClient.liveConnectionLayerFromEnv(env, options)),
  )

export const threadDirectoryLiveLayerFromEnv = (
  env: Record<string, string | undefined> = process.env,
  options: Options = {},
) => ThreadDirectory.liveLayer.pipe(Layer.provideMerge(clientLayerFromEnv(env, options)))

export const layerFromEnv = (
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
  options: Options = {},
) =>
  Layer.unwrap(
    HostConfig.resolveOptions(options, env).pipe(
      Effect.map((host) =>
        Registry.serve(actorsLayerFromEnv(env, cwd, options)).pipe(
          Layer.provide(Registry.layer(HostConfig.toRegistryOptions(host))),
        ),
      ),
    ),
  )

export const managedLayerFromEnv = (
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
  options: Options = {},
) =>
  Layer.fromBuild((_memoMap, scope) =>
    Effect.gen(function* () {
      const host = yield* HostConfig.resolveOptions(options, env)
      const registryLayer = Registry.layer(HostConfig.toRegistryOptions(host))
      const registryContext = yield* registryLayer.pipe(Layer.buildWithScope(scope))
      const registry = Context.get(registryContext, Registry.Registry)
      yield* actorsLayerFromEnv(env, cwd, options)
        .pipe(
          Layer.provideMerge(Logger.layerPino(registry.baseLogger)),
          Layer.provideMerge(Layer.succeed(Registry.Registry, registry)),
          Layer.buildWithScope(scope),
        )
        .pipe(Effect.asVoid)
      const processListingRunner = options.processListingRunner ?? runProcessListing
      const enginePort = localEnginePort(host)
      let readyEnginePids = new Set<number>()
      const engineBinary = engineBinaryPathFromEnv(env)
      const previousEngineBinary = process.env.RIVET_ENGINE_BINARY
      const shouldRestoreEngineBinary = engineBinary !== undefined && previousEngineBinary !== engineBinary
      if (shouldRestoreEngineBinary) {
        process.env.RIVET_ENGINE_BINARY = engineBinary
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            if (previousEngineBinary === undefined) {
              delete process.env.RIVET_ENGINE_BINARY
            } else {
              process.env.RIVET_ENGINE_BINARY = previousEngineBinary
            }
          }),
        )
      }
      yield* withTemporaryProcessEnv(localStorageEnv(env, cwd), scope)
      const setupRegistry =
        options.setupRegistry ?? (yield* Effect.promise(() => import("rivetkit").then((module) => module.setup)))
      const configureBaseLogger = yield* Effect.promise(() =>
        import("rivetkit/log").then((module) => module.configureBaseLogger),
      )
      configureBaseLogger(registry.baseLogger)
      const enginePidsBefore = yield* Effect.promise(() => rivetEnginePidsForPort(enginePort, processListingRunner))
      const rawRegistry = setupRegistry({
        use: Object.fromEntries(registry.rivetkitActors),
        ...registrySetupOptions(host),
        ...localEngineOptions(host),
        logging: { baseLogger: registry.baseLogger },
      })
      yield* Effect.sync(() => rawRegistry.start())
      yield* Scope.addFinalizer(
        scope,
        Effect.promise(async () => {
          try {
            await rawRegistry.shutdown()
          } finally {
            await terminateNewRivetEnginePids(enginePort, enginePidsBefore, readyEnginePids, processListingRunner)
          }
        }).pipe(Effect.ignore),
      )
      const rawConfig = rawRegistry.parseConfig()
      if (rawConfig.endpoint !== undefined) {
        yield* waitForMetadataEndpoint({
          endpoint: rawConfig.endpoint,
          ...(options.metadataReadiness?.attempts === undefined
            ? {}
            : { attempts: options.metadataReadiness.attempts }),
          ...(options.metadataReadiness?.delayMillis === undefined
            ? {}
            : { delayMillis: options.metadataReadiness.delayMillis }),
        })
        readyEnginePids = yield* Effect.promise(() => rivetEnginePidsForPort(enginePort, processListingRunner))
      }
      return Context.empty()
    }),
  )

export const layer = (options: Options = {}) => layerFromEnv(process.env, process.cwd(), options)

export const waitForMetadataEndpoint = Effect.fn("LocalHost.waitForMetadataEndpoint")(function* (input: {
  readonly endpoint: string
  readonly attempts?: number
  readonly delayMillis?: number
}) {
  yield* Effect.promise(async () => {
    const attempts = input.attempts ?? 120
    const delayMillis = input.delayMillis ?? 250
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const url = new URL(`${input.endpoint.replace(/\/$/, "")}/metadata`)
        const response = await fetch(url)
        if (response.ok) return
        lastError = new Error(`metadata readiness failed with status ${response.status}`)
      } catch (error) {
        lastError = error
      }
      await Bun.sleep(delayMillis)
    }
    if (lastError instanceof Error) throw lastError
    throw new Error("metadata readiness timed out")
  })
})

const terminateNewRivetEnginePids = async (
  port: number,
  before: ReadonlySet<number>,
  ready: ReadonlySet<number>,
  processListingRunner: ProcessListingRunner,
) => {
  const after = await rivetEnginePidsForPort(port, processListingRunner)
  const targets = [...enginePidsToTerminate(before, ready, after)]
  for (const pid of targets) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const remaining = await remainingPids(port, targets, processListingRunner)
    if (remaining.length === 0) return
    await Bun.sleep(100)
  }
  for (const pid of await remainingPids(port, targets, processListingRunner)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
}

export const enginePidsToTerminate = (
  before: ReadonlySet<number>,
  ready: ReadonlySet<number>,
  after: ReadonlySet<number>,
) => new Set([...ready, ...after].filter((pid) => !before.has(pid)))

const remainingPids = async (
  port: number,
  targets: ReadonlyArray<number>,
  processListingRunner: ProcessListingRunner,
) => {
  const current = await rivetEnginePidsForPort(port, processListingRunner)
  return targets.filter((pid) => current.has(pid))
}

export const rivetEnginePidsForPort = async (port: number, processListingRunner: ProcessListingRunner) => {
  const enginePids = await rivetEnginePids(processListingRunner)
  const portPids = await listeningPidsForTcpPort(port, processListingRunner)
  return new Set([...enginePids].filter((pid) => portPids.has(pid)))
}

const rivetEnginePids = async (processListingRunner: ProcessListingRunner) => {
  const output = await processListingRunner({ command: "ps", args: ["-axo", "pid=,command="] })
  const pids = new Set<number>()
  if (output === undefined) return pids
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    const command = match[2]
    if (!Number.isFinite(pid) || command === undefined) continue
    if (command.includes("rivet-engine start")) pids.add(pid)
  }
  return pids
}

const listeningPidsForTcpPort = async (port: number, processListingRunner: ProcessListingRunner) => {
  const output = await processListingRunner({
    command: "lsof",
    args: ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
  })
  const pids = new Set<number>()
  if (output === undefined) return pids
  for (const line of output.split(/\r?\n/)) {
    const pid = Number(line.trim())
    if (Number.isFinite(pid)) pids.add(pid)
  }
  return pids
}

const runProcessListing: ProcessListingRunner = async (listing) => {
  try {
    const processList = Bun.spawn([listing.command, ...listing.args], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const output = await new Response(processList.stdout).text()
    await processList.exited
    return output
  } catch {
    return undefined
  }
}

const registrySetupOptions = (host: HostConfig.Resolved): Registry.Options => {
  return {
    noWelcome: host.no_welcome,
  }
}

const localEngineOptions = (host: HostConfig.Resolved) => {
  const endpoint = new URL(host.endpoint)
  return {
    startEngine: true,
    engineHost: endpoint.hostname,
    enginePort: localEnginePort(host),
    noWelcome: host.no_welcome,
  }
}

const localEnginePort = (host: HostConfig.Resolved) => {
  const endpoint = new URL(host.endpoint)
  return endpoint.port === "" ? 6420 : Number(endpoint.port)
}

const localStorageEnv = (env: Record<string, string | undefined>, cwd: string) => {
  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
  const dataDir = env.RIKA_DATA_DIR ?? join(env.HOME ?? homedir(), ".rika")
  const storagePath = env.RIVETKIT_STORAGE_PATH ?? join(dataDir, "rivetkit")
  const sidecarNodeModulesPath = installedRivetHostNodeModulesPath()
  const localEnv: Record<string, string> = {
    RIKA_WORKSPACE_ROOT: workspaceRoot,
    RIKA_DATA_DIR: dataDir,
    RIVETKIT_STORAGE_PATH: storagePath,
  }
  if (env.RIVET__FILE_SYSTEM__PATH !== undefined) localEnv.RIVET__FILE_SYSTEM__PATH = env.RIVET__FILE_SYSTEM__PATH
  if (existsSync(sidecarNodeModulesPath)) localEnv.NODE_PATH = withNodePath(env.NODE_PATH, sidecarNodeModulesPath)
  return localEnv
}

const withNodePath = (current: string | undefined, sidecar: string) =>
  current === undefined || current.length === 0 ? sidecar : `${sidecar}${delimiter}${current}`

const withTemporaryProcessEnv = (env: Record<string, string>, scope: Scope.Scope) =>
  Effect.gen(function* () {
    const previous = new Map<string, string | undefined>()
    for (const [key, value] of Object.entries(env)) {
      previous.set(key, process.env[key])
      process.env[key] = value
    }
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
    )
  })

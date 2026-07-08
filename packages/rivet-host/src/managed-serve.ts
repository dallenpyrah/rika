import { PresenceHub, WorkspaceAccess } from "@rika/agent"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Settings, Time } from "@rika/core"
import { IdeBridge } from "@rika/ide"
import { OrbActivity, OrbChanges, OrbFiles, OrbManager, OrbPty, SandboxClient } from "@rika/orb"
import {
  ArtifactStore,
  Database,
  McpApprovalStore,
  Migration,
  OrbStore,
  ProjectStore,
  ThreadEventLog,
  ThreadProjection,
  WorkspaceStore,
} from "@rika/persistence"
import { Ids } from "@rika/schema"
import { Effect, Fiber, Layer, ManagedRuntime, Schedule } from "effect"
import * as LocalHost from "./local-host"
import * as NativeEdge from "./native-edge"
import * as OrbMirror from "./orb-mirror"
import * as ThreadClient from "./thread-client"
import * as ThreadDirectory from "./thread-directory"

export interface ManagedServeInput {
  readonly env?: Record<string, string | undefined>
  readonly cwd?: string
  readonly hostname?: string
  readonly port?: number
  readonly token?: string
  readonly workspace_root?: string
  readonly orb?: boolean
  readonly base_commit?: string
  readonly ephemeral?: boolean
}

export interface ManagedServedEdge {
  readonly url: string
  readonly close: () => Promise<void>
}

export const waitForThreadActors = (
  env: Record<string, string | undefined> = process.env,
  threadIds: ReadonlyArray<Ids.ThreadId> = defaultReadyThreadIds(),
) =>
  Effect.forEach(
    threadIds,
    (thread_id) => ThreadClient.getEvents({ thread_id, after_sequence: 0 }),
    { concurrency: 1, discard: true },
  ).pipe(Effect.provide(LocalHost.threadClientLayerFromEnv(env)))

export const serveManaged = async (input: ManagedServeInput = {}): Promise<ManagedServedEdge> => {
  const env = input.env ?? process.env
  const cwd = input.cwd ?? process.cwd()
  const workspaceRoot = input.workspace_root ?? env.RIKA_WORKSPACE_ROOT ?? cwd
  const ephemeral = input.ephemeral === true
  const layer = managedRuntimeLayer(env, cwd, workspaceRoot, ephemeral, input) as Layer.Layer<
    never,
    unknown,
    never
  >
  const runtime = ManagedRuntime.make(layer)
  try {
    const handle = await runtime.runPromise(
      waitForThreadActors(env).pipe(
        Effect.andThen(OrbMirror.syncRunning().pipe(Effect.catch(() => Effect.void))),
        Effect.andThen(
          NativeEdge.serve({
            ...(input.hostname === undefined ? {} : { hostname: input.hostname }),
            ...(input.port === undefined ? {} : { port: input.port }),
            ...(input.token === undefined ? {} : { token: input.token }),
            ...(input.orb === undefined ? {} : { orb: input.orb }),
            ...(input.base_commit === undefined ? {} : { base_commit: input.base_commit }),
            workspace_root: workspaceRoot,
          }),
        ),
      ),
    )
    const mirrorFiber = runtime.runFork(
      Effect.repeat(OrbMirror.syncRunning().pipe(Effect.catch(() => Effect.void)), Schedule.spaced("5 seconds")),
    )
    return {
      url: handle.url,
      close: async () => {
        await runtime.runPromise(Fiber.interrupt(mirrorFiber).pipe(Effect.andThen(handle.close()), Effect.asVoid))
        await runtime.dispose()
      },
    }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

const managedRuntimeLayer = (
  env: Record<string, string | undefined>,
  cwd: string,
  workspaceRoot: string,
  ephemeral: boolean,
  serveInput: ManagedServeInput,
) => {
  const rivetEnv = { ...env, RIKA_WORKSPACE_ROOT: workspaceRoot }
  const configLayer = Config.layerFromEnv(rivetEnv, workspaceRoot)
  const redactorLayer = SecretRedactor.layerFromEnv(rivetEnv)
  const diagnosticsLayer = Layer.mergeAll(
    configLayer,
    redactorLayer,
    Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer)),
  )
  const databaseLayer = ephemeral ? Database.memoryLayer : Database.layer.pipe(Layer.provideMerge(configLayer))
  const migrationLayer = Migration.layer.pipe(Layer.provideMerge(databaseLayer))
  const eventLogLayer = ThreadEventLog.layer.pipe(Layer.provideMerge(redactorLayer))
  const projectionLayer = ThreadProjection.layer.pipe(Layer.provideMerge(databaseLayer))
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const workspaceStoreLayer = WorkspaceStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const settingsLayer = Settings.layerFromEnv(rivetEnv, workspaceRoot)
  const timeLayer = Time.layer
  const mcpApprovalLayer = McpApprovalStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer))
  const orbStoreLayer = OrbStore.layer.pipe(
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(IdGenerator.layer),
  )
  const projectStoreLayer = ProjectStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(IdGenerator.layer),
  )
  const sandboxLayer = SandboxClient.layer.pipe(Layer.provideMerge(configLayer))
  const storageLayer = Layer.mergeAll(
    databaseLayer,
    migrationLayer,
    redactorLayer,
    eventLogLayer,
    projectionLayer,
    artifactLayer,
    workspaceStoreLayer,
    settingsLayer,
    mcpApprovalLayer,
    orbStoreLayer,
    projectStoreLayer,
  )
  const migratedStorageLayer = Layer.effectDiscard(
    Migration.migrate().pipe(Effect.andThen(OrbStore.repairUsageIntervals())),
  ).pipe(Layer.provideMerge(storageLayer))
  const workspaceAccessLayer = WorkspaceAccess.layer.pipe(
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(projectionLayer),
    Layer.provideMerge(workspaceStoreLayer),
    Layer.provideMerge(timeLayer),
  )
  const managerLayer = OrbManager.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const rivetHostLayer = LocalHost.managedLayerFromEnv(rivetEnv, workspaceRoot, {
    workspaceAccessLayer,
    databaseMode: "memory",
  })
  const threadClientLayer = LocalHost.threadClientLayerFromEnv(rivetEnv)
  const orbActivityLayer = OrbActivity.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(timeLayer),
  )
  const orbMirrorLayer = OrbMirror.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(threadClientLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(orbActivityLayer),
    Layer.provideMerge(redactorLayer),
  )
  const edgeLayer = NativeEdge.layer({
    ...(serveInput.token === undefined ? {} : { token: serveInput.token }),
    ...(serveInput.orb === undefined ? {} : { orb: serveInput.orb }),
    ...(serveInput.base_commit === undefined ? {} : { base_commit: serveInput.base_commit }),
    workspace_root: workspaceRoot,
  }).pipe(
    Layer.provideMerge(threadClientLayer),
    Layer.provideMerge(OrbChanges.layer),
    Layer.provideMerge(OrbFiles.layer),
    Layer.provideMerge(OrbPty.layerFromEnv(rivetEnv).pipe(Layer.provideMerge(diagnosticsLayer))),
    Layer.provideMerge(managerLayer),
    Layer.provideMerge(IdeBridge.layer),
    Layer.provideMerge(ThreadDirectory.liveLayer),
    Layer.provideMerge(PresenceHub.layer.pipe(Layer.provideMerge(timeLayer))),
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(workspaceAccessLayer),
    Layer.provideMerge(configLayer),
    Layer.provideMerge(IdGenerator.layer),
    Layer.provideMerge(diagnosticsLayer),
    Layer.provideMerge(rivetHostLayer),
  )
  return Layer.mergeAll(edgeLayer, orbMirrorLayer)
}

const defaultReadyThreadIds = () => [
  Ids.ThreadId.make(`thread_native_rivet_ready_${process.pid}_1`),
  Ids.ThreadId.make(`thread_native_rivet_ready_${process.pid}_2`),
  Ids.ThreadId.make(`thread_native_rivet_ready_${process.pid}_3`),
]

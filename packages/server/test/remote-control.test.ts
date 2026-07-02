import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentLoop, ContextResolver, SkillRegistry, ThreadService, ToolExecutor, WorkspaceAccess } from "@rika/agent"
import { Config, Diagnostics, IdGenerator, Time } from "@rika/core"
import { IdeBridge } from "@rika/ide"
import { OrbManager } from "@rika/orb"
import { Provider, Router } from "@rika/llm"
import {
  ArtifactStore,
  Database,
  Migration,
  OrbStore,
  ProjectStore,
  ThreadEventLog,
  ThreadProjection,
  WorkspaceStore,
} from "@rika/persistence"
import { Client } from "@rika/sdk"
import { Artifact, Common, Event, Ide, Ids, Orb, Remote } from "@rika/schema"
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect"
import { HttpServer, OrbMirror, RemoteControl } from "../src/index"

const threadId = Ids.ThreadId.make("thread_remote_contract")
const ideThreadId = Ids.ThreadId.make("thread_remote_ide")
const workspaceId = Ids.WorkspaceId.make("workspace_remote_contract")
const projectId = Ids.ProjectId.make("project_remote_contract")
const projectWorkspaceId = Ids.WorkspaceId.make("project:project_remote_contract")
const artifactId = Ids.ArtifactId.make("artifact_remote_contract")
const orbId = Ids.OrbId.make("orb_remote_contract")
const orbThreadId = Ids.ThreadId.make("thread_remote_orb_contract")
const orphanedThreadId = Ids.ThreadId.make("thread_remote_orphaned_turn")
const orphanedTurnId = Ids.TurnId.make("turn_remote_orphaned")
const ideClientId = Ids.IdeClientId.make("ide_remote_contract")
const ownerId = Ids.UserId.make("user_remote_owner")
const outsiderId = Ids.UserId.make("user_remote_outsider")
const now = Common.TimestampMillis.make(2_000_000_000_000)
const ideContext: Ide.ContextSnapshot = {
  workspace_roots: ["/workspace/rika-remote"],
  active_file: {
    path: "packages/server/src/remote-control.ts",
    language_id: "typescript",
    selection: { range: { start_line: 30, end_line: 35 }, selected_text: "readonly connectIde" },
  },
  diagnostics: [
    {
      path: "packages/server/src/remote-control.ts",
      severity: "information",
      message: "IDE seam is active",
      range: { start_line: 30, end_line: 30 },
      source: "mock-ide",
    },
  ],
}

const configLayer = Config.layerFromValues({
  workspace_root: "/workspace/rika-remote",
  data_dir: "/workspace/rika-remote/.rika",
  default_mode: "smart",
})

const configLayerForDataDir = (dataDir: string) =>
  Config.layerFromValues({
    workspace_root: "/workspace/rika-remote",
    data_dir: dataDir,
    default_mode: "smart",
  })

const defaultContextLayer = ContextResolver.fakeLayer({ entries: [], rendered: "", total_chars: 0 })

const ideAwareContextLayer = Layer.succeed(
  ContextResolver.Service,
  ContextResolver.Service.of({
    resolve: Effect.fn("ServerTest.ContextResolver.resolve")(function* (input: ContextResolver.ResolveInput) {
      const entries = input.ide_context === undefined ? [] : IdeBridge.contextEntries(input.ide_context)
      const rendered = entries.map((entry) => `${entry.source}:${entry.path ?? entry.reason}`).join("\n")
      return {
        entries,
        rendered,
        total_chars: rendered.length,
        metadata: { ide_context: input.ide_context !== undefined },
      }
    }),
  }),
)

const makeLayer = (
  contextLayer = defaultContextLayer,
  orbManagerLayer: Layer.Layer<OrbManager.Service, never, OrbStore.Service> = fakeOrbManagerLayer(),
  orbMirrorLayer: Layer.Layer<OrbMirror.Service> = fakeOrbMirrorLayer(),
  options: { readonly dataDir?: string } = {},
) => {
  const runtimeConfigLayer = options.dataDir === undefined ? configLayer : configLayerForDataDir(options.dataDir)
  const databaseLayer =
    options.dataDir === undefined ? Database.memoryLayer : Database.layer.pipe(Layer.provideMerge(runtimeConfigLayer))
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const workspaceStoreLayer = WorkspaceStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const storageLayer = Layer.mergeAll(
    runtimeConfigLayer,
    databaseLayer,
    artifactLayer,
    workspaceStoreLayer,
    Migration.layer,
    OrbStore.layer.pipe(
      Layer.provideMerge(databaseLayer),
      Layer.provideMerge(Time.fixedLayer(now)),
      Layer.provideMerge(IdGenerator.sequenceLayer(1)),
    ),
    ThreadEventLog.layer,
    ThreadProjection.layer,
    Time.fixedLayer(now),
    IdGenerator.sequenceLayer(1),
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const projectStoreLayer = ProjectStore.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const threadLayer = ThreadService.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const workspaceAccessLayer = WorkspaceAccess.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const providedOrbManagerLayer = orbManagerLayer.pipe(Layer.provideMerge(migratedStorageLayer))
  const llmLayer = Router.layer.pipe(
    Layer.provideMerge(runtimeConfigLayer),
    Layer.provideMerge(
      Provider.fakeRegistryLayer([
        { name: "anthropic", responses: ["remote hello"] },
        { name: "openai", responses: ["remote hello"] },
      ]),
    ),
  )
  const agentBase = Layer.mergeAll(
    migratedStorageLayer,
    projectStoreLayer,
    threadLayer,
    workspaceAccessLayer,
    contextLayer,
    SkillRegistry.emptyLayer,
    ToolExecutor.fakeLayer({}),
    Diagnostics.memoryLayer([]),
    llmLayer,
    IdeBridge.layer,
    providedOrbManagerLayer,
    orbMirrorLayer,
  )
  const agentLayer = AgentLoop.layer.pipe(Layer.provideMerge(agentBase))
  const remoteLayer = RemoteControl.layer.pipe(Layer.provideMerge(agentLayer), Layer.provideMerge(agentBase))
  const httpLayer = HttpServer.layer.pipe(Layer.provideMerge(remoteLayer))

  return Layer.mergeAll(agentBase, agentLayer, remoteLayer, httpLayer)
}

const makeThreadStorageLayer = (dataDir: string) => {
  const runtimeConfigLayer = configLayerForDataDir(dataDir)
  const databaseLayer = Database.layer.pipe(Layer.provideMerge(runtimeConfigLayer))
  return Layer.mergeAll(
    runtimeConfigLayer,
    databaseLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
  )
}

const fakeOrbManagerLayer = (
  onProvision: (input: OrbManager.ProvisionInput) => void = () => {},
): Layer.Layer<OrbManager.Service> =>
  Layer.succeed(
    OrbManager.Service,
    OrbManager.Service.of({
      provisionForThread: (input) =>
        Effect.sync(() => {
          onProvision(input)
          return orbRecord(input.thread_id, input.project_id, "running")
        }),
      pause: (id) => Effect.succeed(orbRecord(orbThreadId, projectId, "paused", id)),
      resume: (id) => Effect.succeed(orbRecord(orbThreadId, projectId, "running", id)),
      kill: (id) => Effect.succeed(orbRecord(orbThreadId, projectId, "killed", id)),
    }),
  )

const fakeOrbMirrorLayer = (onMirror: (mirroredOrbId: Ids.OrbId) => void = () => {}): Layer.Layer<OrbMirror.Service> =>
  Layer.succeed(
    OrbMirror.Service,
    OrbMirror.Service.of({
      mirror: (mirroredOrbId) => Effect.sync(() => onMirror(mirroredOrbId)),
      mirrorRunningOrbsOnce: () => Effect.void,
      syncRunning: () => Effect.void,
    }),
  )

const orbManagerLayerWithStoredResume = (
  onResume: (orbId: Ids.OrbId) => void,
): Layer.Layer<OrbManager.Service, never, OrbStore.Service> =>
  Layer.effect(
    OrbManager.Service,
    Effect.map(OrbStore.Service, (orbs) =>
      OrbManager.Service.of({
        provisionForThread: (input) =>
          Effect.sync(() => {
            return orbRecord(input.thread_id, input.project_id, "running")
          }),
        pause: (id) => orbManagerStoreStep("pause", id, orbs.setStatus(id, "paused")),
        resume: (id) =>
          Effect.sync(() => {
            onResume(id)
          }).pipe(Effect.andThen(orbManagerStoreStep("resume", id, orbs.setStatus(id, "running")))),
        kill: (id) => orbManagerStoreStep("kill", id, orbs.setStatus(id, "killed")),
      }),
    ),
  )

const orbManagerStoreStep = (
  step: string,
  recordOrbId: Ids.OrbId,
  effect: Effect.Effect<Orb.OrbRecord, unknown>,
): Effect.Effect<Orb.OrbRecord, OrbManager.OrbProvisionError> =>
  effect.pipe(
    Effect.mapError(
      (error) =>
        new OrbManager.OrbProvisionError({
          message: error instanceof Error ? error.message : String(error),
          step,
          orb_id: recordOrbId,
        }),
    ),
  )

const orbRecord = (
  recordThreadId: Ids.ThreadId,
  recordProjectId: Ids.ProjectId,
  status: Orb.OrbStatus,
  recordOrbId = orbId,
): Orb.OrbRecord => ({
  orb_id: recordOrbId,
  thread_id: recordThreadId,
  project_id: recordProjectId,
  sandbox_id: "sandbox_remote_contract",
  status,
  base_commit: "abc123",
  endpoint_url: "https://orb.remote-contract.test",
  created_at: now,
  last_active_at: now,
})

const createRunningOrbRecord = (recordThreadId: Ids.ThreadId) =>
  Effect.gen(function* () {
    const created = yield* OrbStore.create({
      thread_id: recordThreadId,
      project_id: projectId,
    })
    yield* OrbStore.setSandbox(created.orb_id, "sandbox_remote_contract")
    yield* OrbStore.setEndpoint(created.orb_id, {
      endpoint_url: "https://orb.remote-contract.test",
      token: "orb-token",
    })
    yield* OrbStore.setStatus(created.orb_id, "running")
  })

const createPausedOrbRecord = (recordThreadId: Ids.ThreadId) =>
  Effect.gen(function* () {
    const created = yield* OrbStore.create({
      thread_id: recordThreadId,
      project_id: projectId,
    })
    yield* OrbStore.setSandbox(created.orb_id, "sandbox_remote_contract")
    yield* OrbStore.setEndpoint(created.orb_id, {
      endpoint_url: "https://orb.remote-contract.test",
      token: "orb-token",
    })
    yield* OrbStore.setStatus(created.orb_id, "running")
    return yield* OrbStore.setStatus(created.orb_id, "paused")
  })

const appendProjected = (event: Event.Event) =>
  Effect.gen(function* () {
    const appended = yield* ThreadEventLog.append(event)
    yield* ThreadProjection.apply(appended)
  })

const orphanedThreadCreated = (): Event.ThreadCreated => ({
  id: Ids.EventId.make("event_remote_orphaned_thread_created"),
  thread_id: orphanedThreadId,
  sequence: 1,
  version: 1,
  created_at: now,
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

const orphanedTurnStarted = (): Event.TurnStarted => ({
  id: Ids.EventId.make("event_remote_orphaned_turn_started"),
  thread_id: orphanedThreadId,
  turn_id: orphanedTurnId,
  sequence: 2,
  version: 1,
  created_at: now,
  type: "turn.started",
  data: {},
})

const makeClient = (handle: (request: Request) => Promise<Response>) =>
  Client.make(
    Client.fetchTransport({
      base_url: "http://rika.test",
      fetch: (input, init) =>
        handle(input instanceof Request ? new Request(input, init) : new Request(String(input), init)),
    }),
  )

describe("remote control API and SDK", () => {
  test("SDK starts a thread, sends a turn, streams events, interrupts, and reads artifacts", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    const created = await Effect.runPromise(client.createThread({ thread_id: threadId, workspace_id: workspaceId }))
    expect(created).toMatchObject({ thread_id: threadId, workspace_id: workspaceId, archived: false })

    const firstSubscriber = Effect.runPromise(
      client.subscribeThreadEvents({ thread_id: threadId, after_sequence: 1 }).pipe(
        Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.failed"),
        Stream.runCollect,
      ),
    )
    const secondSubscriber = Effect.runPromise(
      client.subscribeThreadEvents({ thread_id: threadId, after_sequence: 1 }).pipe(
        Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.failed"),
        Stream.runCollect,
      ),
    )
    const accepted = await Effect.runPromise(
      client.startTurn({ thread_id: threadId, workspace_id: workspaceId, content: "say hello", mode: "smart" }),
    )
    const [streamed, mirrored] = await Promise.all([firstSubscriber, secondSubscriber])

    expect(accepted).toEqual({ thread_id: threadId, accepted: true })
    expect(mirrored.map((event) => event.type)).toEqual(streamed.map((event) => event.type))
    expect(streamed.map((event) => event.type)).toContain("message.added")
    expect(streamed.at(-1)).toMatchObject({ type: "turn.completed" })

    const turnId = streamed.find((event) => event.type === "turn.started")?.turn_id
    expect(turnId).toBeDefined()
    const interrupted = await Effect.runPromise(
      client.interruptTurn({ thread_id: threadId, turn_id: turnId ?? Ids.TurnId.make("missing"), reason: "SDK test" }),
    )
    expect(interrupted).toMatchObject({ type: "turn.failed", data: { error: { kind: "cancelled" } } })

    const opened = await Effect.runPromise(client.openThread(threadId))
    expect(opened.events.map((event) => event.type)).toContain("turn.failed")
    const preview = await Effect.runPromise(client.previewThread(threadId, { limit: 2 }))
    expect(preview.summary.thread_id).toBe(threadId)
    expect(preview.events.map((event) => event.type)).toEqual(["turn.completed", "turn.failed"])
    const metadataEvents = Effect.runPromise(
      client
        .subscribeThreadEvents({ thread_id: threadId, after_sequence: preview.events.at(-1)?.sequence })
        .pipe(Stream.take(2), Stream.runCollect),
    )
    const archived = await Effect.runPromise(client.archiveThread(threadId))
    const unarchived = await Effect.runPromise(client.unarchiveThread(threadId))
    const subscribed = await metadataEvents
    expect(subscribed.map((event) => event.type)).toEqual(["thread.archived", "thread.unarchived"])
    expect(archived.archived).toBe(true)
    expect(unarchived.archived).toBe(false)

    const artifact: Artifact.Artifact = {
      id: artifactId,
      thread_id: threadId,
      kind: "research",
      title: "Remote contract",
      content: { ok: true },
      created_at: now,
    }
    await runtime.runPromise(ArtifactStore.put(artifact))
    const artifacts = await Effect.runPromise(client.listArtifacts({ thread_id: threadId, kind: "research" }))
    const fetched = await Effect.runPromise(client.getArtifact(artifactId))
    expect(artifacts.map((item) => item.id)).toEqual([artifactId])
    expect(fetched).toEqual(artifact)
  })

  test("uses project identity when remote requests omit workspace id", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))
    const projectThreadId = Ids.ThreadId.make("thread_project_workspace")

    const created = await Effect.runPromise(client.createThread({ thread_id: projectThreadId, project_id: projectId }))
    const streamedPromise = Effect.runPromise(
      client.subscribeThreadEvents({ thread_id: projectThreadId }).pipe(
        Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.failed"),
        Stream.runCollect,
      ),
    )
    await Effect.runPromise(
      client.startTurn({ thread_id: projectThreadId, project_id: projectId, content: "same repo" }),
    )
    const streamed = await streamedPromise
    const opened = await Effect.runPromise(client.openThread(projectThreadId))

    expect(created.workspace_id).toBe(projectWorkspaceId)
    expect(opened.summary.workspace_id).toBe(projectWorkspaceId)
    expect(streamed.find((event) => event.type === "thread.created")).toMatchObject({
      data: { workspace_id: projectWorkspaceId },
    })
  })

  test("remote thread summaries include orb status across read paths", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    await Effect.runPromise(client.createThread({ thread_id: threadId, workspace_id: workspaceId }))
    await runtime.runPromise(createRunningOrbRecord(threadId))

    const listed = await Effect.runPromise(client.listThreads())
    const opened = await Effect.runPromise(client.openThread(threadId))
    const preview = await Effect.runPromise(client.previewThread(threadId))
    const searched = await Effect.runPromise(client.searchThreads({ query: "" }))
    const shared = await Effect.runPromise(client.shareThread(threadId))
    const archived = await Effect.runPromise(client.archiveThread(threadId))
    const unarchived = await Effect.runPromise(client.unarchiveThread(threadId))

    expect(listed.find((summary) => summary.thread_id === threadId)?.orb_status).toBe("running")
    expect(opened.summary.orb_status).toBe("running")
    expect(preview.summary.orb_status).toBe("running")
    expect(searched.find((result) => result.summary.thread_id === threadId)?.summary.orb_status).toBe("running")
    expect(shared.summary.orb_status).toBe("running")
    expect(archived.orb_status).toBe("running")
    expect(unarchived.orb_status).toBe("running")
  })

  test("creates projects and provisions orb-backed threads over the remote API", async () => {
    const provisioned: Array<OrbManager.ProvisionInput> = []
    const runtime = ManagedRuntime.make(
      makeLayer(
        defaultContextLayer,
        fakeOrbManagerLayer((input) => provisioned.push(input)),
      ),
    )
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    const project = await Effect.runPromise(
      client.createProject({ name: "demo", repo_origin: "https://github.com/example/rika.git" }),
    )
    const projects = await Effect.runPromise(client.listProjects())
    const summary = await Effect.runPromise(
      client.createOrbThread({ project_id: project.project_id, thread_id: orbThreadId, mode: "smart" }),
    )

    expect(project).toMatchObject({
      name: "demo",
      repo_origin: "https://github.com/example/rika.git",
      default_branch: "main",
    })
    expect(projects.map((item) => item.project_id)).toEqual([project.project_id])
    expect(provisioned).toEqual([
      {
        thread_id: orbThreadId,
        project_id: project.project_id,
        workspace_root: "/workspace/rika-remote",
      },
    ])
    expect(summary).toMatchObject({
      thread_id: orbThreadId,
      workspace_id: Ids.WorkspaceId.make(`project:${project.project_id}`),
      orb_status: "running",
      archived: false,
    })
  })

  test("startTurn resumes a paused orb and restarts mirroring before the turn runs", async () => {
    const calls: Array<string> = []
    const runtime = ManagedRuntime.make(
      makeLayer(
        defaultContextLayer,
        orbManagerLayerWithStoredResume((id) => calls.push(`resume:${id}`)),
        fakeOrbMirrorLayer((id) => calls.push(`mirror:${id}`)),
      ),
    )
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    await Effect.runPromise(client.createThread({ thread_id: orbThreadId, project_id: projectId }))
    const paused = await runtime.runPromise(createPausedOrbRecord(orbThreadId))
    const streamedPromise = Effect.runPromise(
      client.subscribeThreadEvents({ thread_id: orbThreadId }).pipe(
        Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.failed"),
        Stream.runCollect,
      ),
    )
    const accepted = await Effect.runPromise(
      client.startTurn({ thread_id: orbThreadId, project_id: projectId, content: "resume before turn" }),
    )
    const streamed = await streamedPromise
    const stored = await runtime.runPromise(OrbStore.get(paused.orb_id))

    expect(accepted).toEqual({ thread_id: orbThreadId, accepted: true })
    expect(calls).toEqual([`resume:${paused.orb_id}`, `mirror:${paused.orb_id}`])
    expect(streamed.at(-1)).toMatchObject({ type: "turn.completed" })
    expect(stored?.status).toBe("running")
  })

  test("startup reconciliation fails orphaned active turns and allows a new turn", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-remote-orphaned-turn-"))
    const storageRuntime = ManagedRuntime.make(makeThreadStorageLayer(dataDir))

    try {
      await storageRuntime.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          yield* appendProjected(orphanedThreadCreated())
          yield* appendProjected(orphanedTurnStarted())
        }),
      )
    } finally {
      await storageRuntime.dispose()
    }

    const runtime = ManagedRuntime.make(
      makeLayer(defaultContextLayer, fakeOrbManagerLayer(), fakeOrbMirrorLayer(), { dataDir }),
    )
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    try {
      await runtime.runPromise(RemoteControl.backendHealth("http://rika.test"))
      const replay = await runtime.runPromise(ThreadEventLog.readThread({ thread_id: orphanedThreadId }))
      const projection = await runtime.runPromise(ThreadProjection.getThread(orphanedThreadId))
      const streamedPromise = Effect.runPromise(
        client.subscribeThreadEvents({ thread_id: orphanedThreadId, after_sequence: replay.at(-1)?.sequence }).pipe(
          Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.failed"),
          Stream.runCollect,
        ),
      )
      const accepted = await Effect.runPromise(
        client.startTurn({ thread_id: orphanedThreadId, workspace_id: workspaceId, content: "after restart" }),
      )
      const streamed = await streamedPromise
      const failed = replay.filter((event): event is Event.TurnFailed => event.type === "turn.failed")

      expect(replay.map((event) => event.type)).toEqual(["thread.created", "turn.started", "turn.failed"])
      expect(failed).toHaveLength(1)
      expect(failed[0]).toMatchObject({
        thread_id: orphanedThreadId,
        turn_id: orphanedTurnId,
        sequence: 3,
        data: { error: { kind: "unknown", message: "turn interrupted by backend restart" } },
      })
      expect(projection).toMatchObject({
        thread_id: orphanedThreadId,
        active_turn_id: orphanedTurnId,
        active_turn_status: "failed",
      })
      expect(accepted).toEqual({ thread_id: orphanedThreadId, accepted: true })
      expect(streamed.at(-1)).toMatchObject({ type: "turn.completed" })
    } finally {
      await runtime.dispose()
      await rm(dataDir, { force: true, recursive: true })
    }
  })

  test("project remote API returns redacted summaries", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    const created = await Effect.runPromise(
      client.createProject({
        name: "credentialed",
        repo_origin:
          "https://x-access-token:leaky-token-123@github.com/example/private.git?token=query-leak-123#fragment-leak-123",
      }),
    )
    await runtime.runPromise(ProjectStore.setEnv(created.project_id, "TOKEN", "env-secret-123"))
    const stored = await runtime.runPromise(ProjectStore.get(created.project_id))
    const projects = await Effect.runPromise(client.listProjects())
    const payload = JSON.stringify({ created, projects })

    expect(created).toMatchObject({
      name: "credentialed",
      repo_origin: "https://github.com/example/private.git",
      env_keys: [],
      secret_names: [],
    })
    expect(stored?.repo_origin).toBe("https://github.com/example/private.git")
    expect(projects).toEqual([
      {
        ...created,
        env_keys: ["TOKEN"],
        updated_at: now,
      },
    ])
    expect(payload).not.toContain("leaky-token-123")
    expect(payload).not.toContain("query-leak-123")
    expect(payload).not.toContain("fragment-leak-123")
    expect(payload).not.toContain("env-secret-123")
    expect(payload).not.toContain('"env"')
  })

  test("local token auth blocks unauthorized HTTP calls", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const handle = await runtime.runPromise(HttpServer.serve({ port: 0, token: "secret" }))
    const client = Client.make(Client.fetchTransport({ base_url: handle.url, token: "secret" }))
    try {
      const unauthorized = await fetch(`${handle.url}/v1/threads`)
      const unauthorizedHealth = await fetch(`${handle.url}/health`)
      const authorized = await fetch(`${handle.url}/v1/threads`, {
        headers: { authorization: "Bearer secret" },
      })
      const authorizedHealth = await fetch(`${handle.url}/health`, {
        headers: { authorization: "Bearer secret" },
      })
      const sdkHealth = await Effect.runPromise(client.backendHealth())

      expect(unauthorized.status).toBe(401)
      expect(unauthorizedHealth.status).toBe(200)
      expect(await unauthorized.json()).toEqual({ error: { message: "Unauthorized", code: "unauthorized" } })
      expect(await unauthorizedHealth.json()).toEqual({ status: "ok" })
      expect(authorized.status).toBe(200)
      expect(authorizedHealth.status).toBe(200)
      expect(await authorized.json()).toEqual([])
      expect(await authorizedHealth.json()).toMatchObject({
        status: "healthy",
        workspace_root: "/workspace/rika-remote",
        data_dir: "/workspace/rika-remote/.rika",
      })
      expect(sdkHealth).toMatchObject({ status: "healthy", workspace_root: "/workspace/rika-remote" })
    } finally {
      await runtime.runPromise(handle.close())
    }
  })

  test("local token auth protects every non-health route", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const handle = await runtime.runPromise(HttpServer.serve({ port: 0, token: "secret" }))
    const routes: ReadonlyArray<{ readonly method: "GET" | "POST"; readonly path: string }> = [
      { method: "GET", path: "/v1/threads" },
      { method: "POST", path: "/v1/threads" },
      { method: "POST", path: "/v1/orbs" },
      { method: "GET", path: "/v1/projects" },
      { method: "POST", path: "/v1/projects" },
      { method: "GET", path: "/v1/threads/search" },
      { method: "GET", path: `/v1/threads/${threadId}` },
      { method: "GET", path: `/v1/threads/${threadId}/preview` },
      { method: "POST", path: `/v1/threads/${threadId}/archive` },
      { method: "POST", path: `/v1/threads/${threadId}/unarchive` },
      { method: "GET", path: `/v1/threads/${threadId}/share` },
      { method: "GET", path: `/v1/threads/${threadId}/reference` },
      { method: "GET", path: `/v1/threads/${threadId}/events` },
      { method: "POST", path: "/v1/turns" },
      { method: "POST", path: "/v1/turns/interrupt" },
      { method: "GET", path: "/v1/artifacts" },
      { method: "GET", path: `/v1/artifacts/${artifactId}` },
      { method: "GET", path: "/v1/ide/status" },
      { method: "POST", path: "/v1/ide/connect" },
      { method: "POST", path: "/v1/ide/disconnect" },
      { method: "POST", path: "/v1/ide/context" },
      { method: "POST", path: "/v1/ide/open-file" },
      { method: "GET", path: "/v1/ide/navigation-requests" },
    ]

    try {
      const responses = await Promise.all(
        routes.map(async (route) => ({
          route,
          response: await fetch(`${handle.url}${route.path}`, { method: route.method }),
        })),
      )

      expect(
        responses.map(({ route, response }) => ({ method: route.method, path: route.path, status: response.status })),
      ).toEqual(routes.map((route) => ({ ...route, status: 401 })))
    } finally {
      await runtime.runPromise(handle.close())
    }
  })

  test("serves orb changes only when the HTTP server is in orb mode", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rika-orb-changes-http-"))
    await runGit(workspace, ["init", "-b", "main"])
    await runGit(workspace, ["config", "user.email", "rika@example.test"])
    await runGit(workspace, ["config", "user.name", "Rika Test"])
    await writeFile(join(workspace, "README.md"), "before\n")
    await runGit(workspace, ["add", "README.md"])
    await runGit(workspace, ["commit", "-m", "init"])
    const baseCommit = (await runGit(workspace, ["rev-parse", "HEAD"])).trim()
    await writeFile(join(workspace, "README.md"), "after\n")

    const runtime = ManagedRuntime.make(makeLayer())

    try {
      const disabled = await runtime.runPromise(HttpServer.handle(new Request("http://rika.test/v1/orb/changes")))
      const handle = await runtime.runPromise(
        HttpServer.serve({
          port: 0,
          token: "secret",
          orb: true,
          base_commit: baseCommit,
          workspace_root: workspace,
        }),
      )
      try {
        const unauthorized = await fetch(`${handle.url}/v1/orb/changes`)
        const enabled = await fetch(`${handle.url}/v1/orb/changes`, {
          headers: { authorization: "Bearer secret" },
        })
        const body = Schema.decodeUnknownSync(Remote.OrbChangesResponse)(await enabled.json())

        expect(disabled.status).toBe(404)
        expect(unauthorized.status).toBe(401)
        expect(enabled.status).toBe(200)
        expect(body).toMatchObject({
          base_commit: baseCommit,
          head_commit: baseCommit,
          dirty: true,
        })
        expect(body.diff).toContain("diff --git a/README.md b/README.md")
        expect(body.diff).toContain("+after")
      } finally {
        await runtime.runPromise(handle.close())
      }
    } finally {
      await rm(workspace, { force: true, recursive: true })
    }
  })

  test("client-supplied auth marker cannot unlock health details", async () => {
    const runtime = ManagedRuntime.make(makeLayer())

    const response = await runtime.runPromise(
      HttpServer.handle(
        new Request("http://rika.test/health", {
          headers: {
            "x-rika-required-token": "fake",
            authorization: "Bearer fake",
          },
        }),
      ),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })
  })

  test("non-loopback server binds require a token", async () => {
    const runtime = ManagedRuntime.make(makeLayer())

    const error = await runtime.runPromise(HttpServer.serve({ host: "0.0.0.0", port: 0 }).pipe(Effect.flip))
    const handle = await runtime.runPromise(HttpServer.serve({ host: "0.0.0.0", port: 0, token: "secret" }))

    try {
      expect(error).toBeInstanceOf(HttpServer.HttpServerError)
      if (!(error instanceof HttpServer.HttpServerError)) throw new Error("expected HttpServerError")
      expect(error.message).toBe("refusing to bind non-loopback host without --token")
      expect(handle.url).toStartWith("http://0.0.0.0:")
    } finally {
      await runtime.runPromise(handle.close())
    }
  })

  test("remote user requests are scoped to workspace membership", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    const created = await Effect.runPromise(
      client.createThread({ thread_id: threadId, workspace_id: workspaceId, user_id: ownerId }),
    )
    const ownerThreads = await Effect.runPromise(client.listThreads({ user_id: ownerId }))
    const outsiderThreads = await Effect.runPromise(client.listThreads({ user_id: outsiderId }))
    const outsiderOpen = await Effect.runPromise(client.openThread(threadId, outsiderId).pipe(Effect.flip))
    const outsiderPreview = await Effect.runPromise(
      client.previewThread(threadId, { user_id: outsiderId }).pipe(Effect.flip),
    )
    const outsiderTurn = await Effect.runPromise(
      client
        .startTurn({ thread_id: threadId, workspace_id: workspaceId, user_id: outsiderId, content: "break in" })
        .pipe(Effect.flip),
    )

    expect(created).toMatchObject({ thread_id: threadId, workspace_id: workspaceId, user_id: ownerId })
    expect(ownerThreads.map((summary) => summary.thread_id)).toEqual([threadId])
    expect(outsiderThreads).toEqual([])
    expect(outsiderOpen).toMatchObject({ status: 403 })
    expect(outsiderPreview).toMatchObject({ status: 403 })
    expect(outsiderTurn).toMatchObject({ status: 403 })
  })

  test("IDE clients can provide turn context and receive navigation requests", async () => {
    const runtime = ManagedRuntime.make(makeLayer(ideAwareContextLayer))
    const client = makeClient((request) => runtime.runPromise(HttpServer.handle(request)))

    const connected = await Effect.runPromise(
      client.connectIde({
        client_id: ideClientId,
        name: "Mock IDE",
        workspace_roots: ["/workspace/rika-remote"],
        capabilities: ["active-context", "diagnostics", "navigation"],
        initial_context: ideContext,
      }),
    )
    const status = await Effect.runPromise(client.ideStatus())
    const streamedPromise = Effect.runPromise(
      client.subscribeThreadEvents({ thread_id: ideThreadId }).pipe(
        Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.failed"),
        Stream.runCollect,
      ),
    )
    await Effect.runPromise(
      client.startTurn({ thread_id: ideThreadId, workspace_id: workspaceId, content: "use my editor context" }),
    )
    const streamed = await streamedPromise
    const navigationRequest: Ide.OpenFileRequest = {
      path: "packages/server/src/remote-control.ts",
      range: { start_line: 30, end_line: 35 },
      reason: "Show the IDE seam",
      thread_id: ideThreadId,
    }
    const navigation = await Effect.runPromise(client.openIdeFile(navigationRequest))
    const requests = await Effect.runPromise(client.ideNavigationRequests())

    expect(connected).toEqual({
      client_id: ideClientId,
      connected: true,
      capabilities: ["active-context", "diagnostics", "navigation"],
    })
    expect(status).toMatchObject({ connected: true, client_id: ideClientId, context: ideContext })
    expect(streamed.find((event) => event.type === "context.resolved")).toMatchObject({
      data: {
        entries: [
          expect.objectContaining({ source: "ide:active-file", path: "packages/server/src/remote-control.ts" }),
          expect.objectContaining({ source: "ide:diagnostics", content: expect.stringContaining("mock-ide") }),
        ],
        metadata: { ide_context: true },
      },
    })
    expect(navigation).toEqual({ accepted: true })
    expect(requests).toEqual([navigationRequest])
  })
})

const runGit = async (cwd: string, args: ReadonlyArray<string>) => {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
  return stdout
}

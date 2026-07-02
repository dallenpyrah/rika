import { describe, expect, test } from "bun:test"
import { AgentLoop, ContextResolver, SkillRegistry, ThreadService, ToolExecutor, WorkspaceAccess } from "@rika/agent"
import { Config, Diagnostics, IdGenerator, Time } from "@rika/core"
import { IdeBridge } from "@rika/ide"
import { Provider, Router } from "@rika/llm"
import { OrbManager } from "@rika/orb"
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
import { Common, Ids } from "@rika/schema"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { HttpServer, OrbMirror, RemoteControl } from "@rika/server"
import { ChangedDraft, SubmittedDraft, eventRows, init, subscriptions, update } from "../src/app"
import type { AppCommand, AppMessage, Model } from "../src/app"

const threadId = Ids.ThreadId.make("thread_web_e2e_sync")
const workspaceId = Ids.WorkspaceId.make("workspace_web_e2e_sync")
const now = Common.TimestampMillis.make(2_000_000_000_000)

describe("web local sync e2e", () => {
  test("one submitted turn updates two remote clients and the Foldkit web app over the real HTTP server", async () => {
    const runtime = ManagedRuntime.make(makeLayer())
    const handle = await runtime.runPromise(HttpServer.serve({ host: "127.0.0.1", port: 0 }))
    try {
      const firstTerminal = client(handle.url)
      const secondTerminal = client(handle.url)
      const webApiBaseUrl = handle.url

      await Effect.runPromise(firstTerminal.createThread({ thread_id: threadId, workspace_id: workspaceId }))
      let webModel = await openWebModel(webApiBaseUrl)
      expect(webModel.last_sequence).toBe(1)

      const terminalOneEvents = collectTurn(firstTerminal, webModel.last_sequence)
      const terminalTwoEvents = collectTurn(secondTerminal, webModel.last_sequence)
      const webMessages = collectWebMessages(webModel)

      const accepted = await Effect.runPromise(
        firstTerminal.startTurn({ thread_id: threadId, workspace_id: workspaceId, content: "sync every client" }),
      )
      const [firstEvents, secondEvents, messages] = await Promise.all([
        terminalOneEvents,
        terminalTwoEvents,
        webMessages,
      ])

      for (const message of messages) {
        ;[webModel] = update(webModel, message)
      }

      const firstTypes = firstEvents.map((event) => event.type)
      const secondTypes = secondEvents.map((event) => event.type)
      const webEvents = webModel.events.filter((event) => event.sequence > 1)

      expect(accepted).toEqual({ thread_id: threadId, accepted: true })
      expect(firstTypes).toEqual(secondTypes)
      expect(webEvents.map((event) => event.type)).toEqual(firstTypes)
      expect(webEvents.map((event) => event.sequence)).toEqual(firstEvents.map((event) => event.sequence))
      expect(firstTypes).toContain("message.added")
      expect(firstEvents.at(-1)).toMatchObject({ type: "turn.completed" })
      expect(webModel.pending_turn).toBe(false)
      expect(
        eventRows(webModel.events)
          .map((row) => row.body)
          .join("\n"),
      ).toContain("remote hello")

      const beforeSubmitSequences = webModel.events.map((event) => event.sequence)
      ;[webModel] = update(webModel, ChangedDraft({ value: "submitted from web" }))
      const [submittedModel, commands] = update(webModel, SubmittedDraft())

      expect(submittedModel.events.map((event) => event.sequence)).toEqual(beforeSubmitSequences)
      expect(submittedModel.pending_turn).toBe(true)
      expect(commands.map((command) => command.name)).toEqual(["StartTurn"])
    } finally {
      await Effect.runPromise(handle.close())
      await runtime.dispose()
    }
  })
})

const makeLayer = () => {
  const configLayer = Config.layerFromValues({
    workspace_root: "/workspace/rika-web-e2e",
    data_dir: "/workspace/rika-web-e2e/.rika",
    default_mode: "smart",
  })
  const databaseLayer = Database.memoryLayer
  const timeLayer = Time.fixedLayer(now)
  const idLayer = IdGenerator.sequenceLayer(1)
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const workspaceStoreLayer = WorkspaceStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const projectStoreLayer = ProjectStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(idLayer),
  )
  const orbStoreLayer = OrbStore.layer.pipe(
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(idLayer),
  )
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    artifactLayer,
    workspaceStoreLayer,
    projectStoreLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    timeLayer,
    idLayer,
    orbStoreLayer,
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const threadLayer = ThreadService.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const workspaceAccessLayer = WorkspaceAccess.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const llmLayer = Router.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(
      Provider.fakeRegistryLayer([
        { name: "anthropic", responses: ["remote hello", "web hello"] },
        { name: "openai", responses: ["remote hello", "web hello"] },
      ]),
    ),
  )
  const agentBase = Layer.mergeAll(
    migratedStorageLayer,
    threadLayer,
    workspaceAccessLayer,
    ContextResolver.fakeLayer({ entries: [], rendered: "", total_chars: 0 }),
    SkillRegistry.emptyLayer,
    ToolExecutor.fakeLayer({}),
    Diagnostics.memoryLayer([]),
    llmLayer,
    IdeBridge.layer,
    fakeOrbManagerLayer(),
    fakeOrbMirrorLayer(),
  )
  const agentLayer = AgentLoop.layer.pipe(Layer.provideMerge(agentBase))
  const remoteLayer = RemoteControl.layer.pipe(Layer.provideMerge(agentLayer), Layer.provideMerge(agentBase))
  const httpLayer = HttpServer.layer.pipe(Layer.provideMerge(remoteLayer))
  return Layer.mergeAll(agentBase, agentLayer, remoteLayer, httpLayer)
}

const fakeOrbManagerLayer = () =>
  Layer.succeed(
    OrbManager.Service,
    OrbManager.Service.of({
      provisionForThread: (input) =>
        Effect.succeed({
          orb_id: Ids.OrbId.make("orb_web_e2e_sync"),
          thread_id: input.thread_id,
          project_id: input.project_id,
          sandbox_id: null,
          status: "running",
          base_commit: null,
          endpoint_url: null,
          created_at: now,
          last_active_at: now,
        }),
      pause: () => Effect.never,
      resume: () => Effect.never,
      kill: () => Effect.never,
    }),
  )

const fakeOrbMirrorLayer = () =>
  Layer.succeed(
    OrbMirror.Service,
    OrbMirror.Service.of({
      mirror: () => Effect.void,
      mirrorRunningOrbsOnce: () => Effect.void,
      syncRunning: () => Effect.void,
    }),
  )

const client = (baseUrl: string) => Client.make(Client.fetchTransport({ base_url: baseUrl }))

const openWebModel = async (apiBaseUrl: string): Promise<Model> => {
  let [model, commands] = init({ api_base_url: apiBaseUrl, thread_id: threadId })
  for (const command of commands) {
    model = await runCommand(model, command)
  }
  return model
}

const runCommand = async (model: Model, command: AppCommand): Promise<Model> => {
  const message = await Effect.runPromise(command.effect)
  const [next] = update(model, message)
  return next
}

const collectTurn = (sdk: Client.Interface, afterSequence: number) =>
  Effect.runPromise(
    sdk.subscribeThreadEvents({ thread_id: threadId, after_sequence: afterSequence }).pipe(
      Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.failed"),
      Stream.runCollect,
      Effect.timeout("5 seconds"),
    ),
  )

const collectWebMessages = (model: Model) => {
  const threadEvents = subscriptions.threadEvents
  return Effect.runPromise(
    threadEvents.dependenciesToStream(threadEvents.modelToDependencies(model)).pipe(
      Stream.takeUntil((message) => isTerminalTurnMessage(message)),
      Stream.runCollect,
      Effect.timeout("5 seconds"),
    ),
  )
}

const isTerminalTurnMessage = (message: AppMessage) =>
  message._tag === "ReceivedThreadEvent" &&
  (message.event.type === "turn.completed" || message.event.type === "turn.failed")

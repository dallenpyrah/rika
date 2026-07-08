import { describe, expect, test } from "bun:test"
import { Config, IdGenerator, SecretRedactor, Time } from "@rika/core"
import { OrbActivity, SandboxClientFake } from "@rika/orb"
import { Database, Migration, OrbStore, ProjectStore } from "@rika/persistence"
import { Client } from "@rika/sdk"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { OrbMirror, ThreadActor, ThreadClient } from "../src/index"

const threadId = Ids.ThreadId.make("rivet_orb_mirror_thread")
const workspaceId = Ids.WorkspaceId.make("project:rivet_orb_mirror_project")
const now = Common.TimestampMillis.make(2_020_000_000_000)

describe("Rivet OrbMirror", () => {
  test("mirrors running orb events through ThreadClient from the actor-owned cursor", async () => {
    const subscriptions: Array<number | undefined> = []
    const appended: Array<ThreadActor.AppendMirroredEventsPayload> = []
    const actorEvents: Array<Event.Event> = [threadCreated(1)]
    const runtime = ManagedRuntime.make(
      makeLayer(
        (_endpointUrl, _token) =>
          Client.make({
            requestJson: () => Effect.never,
            streamJson: (input) => {
              const url = new URL(input.path, "http://orb.test")
              const afterSequence = Number(url.searchParams.get("after_sequence") ?? "0")
              subscriptions.push(afterSequence)
              return afterSequence < 2 ? Stream.make(messageAdded(2, "mirrored actor-secret-value")) : Stream.empty
            },
          }),
        actorEvents,
        appended,
      ),
    )

    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          const project = yield* ProjectStore.create({
            name: "demo",
            repo_origin: "https://github.com/example/rika.git",
          })
          yield* ProjectStore.setSecret(project.project_id, "ACTOR_SECRET", "actor-secret-value")
          yield* createRunningOrb(project.project_id)
          yield* OrbMirror.mirrorRunningOrbsOnce()
          yield* OrbMirror.mirrorRunningOrbsOnce()
        }),
      )

      expect(subscriptions).toEqual([1, 2])
      expect(appended.map((payload) => payload.events.map((event) => event.sequence))).toEqual([[2]])
      expect(actorEvents.map((event) => event.sequence)).toEqual([1, 2])
      expect(JSON.stringify(actorEvents)).toContain("[REDACTED:ACTOR_SECRET]")
      expect(JSON.stringify(actorEvents)).not.toContain("actor-secret-value")
    } finally {
      await runtime.dispose()
    }
  })
})

const makeLayer = (
  clientFactory: OrbMirror.ClientFactory,
  actorEvents: Array<Event.Event>,
  appended: Array<ThreadActor.AppendMirroredEventsPayload>,
) => {
  const configLayer = Config.layerFromValues({
    workspace_root: "/workspace/rika-rivet-orb-mirror",
    data_dir: "/tmp/rika-rivet-orb-mirror/.rika",
    default_mode: "smart",
  })
  const databaseLayer = Database.memoryLayer
  const timeLayer = Time.fixedLayer(now)
  const idLayer = IdGenerator.sequenceLayer(1)
  const redactorLayer = SecretRedactor.layer
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    Migration.layer,
    redactorLayer,
    ProjectStore.layer.pipe(
      Layer.provideMerge(configLayer),
      Layer.provideMerge(databaseLayer),
      Layer.provideMerge(timeLayer),
      Layer.provideMerge(idLayer),
    ),
    OrbStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer), Layer.provideMerge(idLayer)),
  )
  const threadClientLayer = threadClientFakeLayer(actorEvents, appended).pipe(Layer.provideMerge(redactorLayer))
  const activityLayer = OrbActivity.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(storageLayer),
    Layer.provideMerge(SandboxClientFake.layer(makeRunningSandboxState())),
    Layer.provideMerge(timeLayer),
  )
  const mirrorLayer = OrbMirror.layerWithClientFactory(clientFactory).pipe(
    Layer.provideMerge(storageLayer),
    Layer.provideMerge(activityLayer),
    Layer.provideMerge(SandboxClientFake.layer(makeRunningSandboxState())),
    Layer.provideMerge(threadClientLayer),
  )
  return Layer.mergeAll(storageLayer, activityLayer, mirrorLayer, threadClientLayer)
}

const threadClientFakeLayer = (
  actorEvents: Array<Event.Event>,
  appended: Array<ThreadActor.AppendMirroredEventsPayload>,
) =>
  Layer.effect(
    ThreadClient.Service,
    Effect.gen(function* () {
      const redactor = yield* SecretRedactor.Service
      return ThreadClient.Service.of({
        ensureThread: () => Effect.never,
        startTurn: () => Effect.never,
        getEvents: (input) =>
          Effect.succeed(actorEvents.filter((event) => event.sequence > (input.after_sequence ?? 0))),
        appendMirroredEvents: (input) =>
          Effect.sync(() => {
            appended.push(input)
            const inserted: Array<Event.Event> = []
            let skippedCount = 0
            for (const event of input.events.map((current) => redactEvent(redactor, current))) {
              if (actorEvents.some((current) => current.id === event.id || current.sequence === event.sequence)) {
                skippedCount += 1
              } else {
                actorEvents.push(event)
                inserted.push(event)
              }
            }
            return { inserted_events: inserted, skipped_count: skippedCount }
          }),
        subscribeEvents: () => Stream.never,
        replayThread: () => Effect.never,
        getSnapshot: () => Effect.never,
        setVisibility: () => Effect.never,
        forkThread: () => Effect.never,
        archiveThread: () => Effect.never,
        unarchiveThread: () => Effect.never,
        compactThread: () => Effect.never,
        interruptTurn: () => Effect.never,
      })
    }),
  )

const redactEvent = (redactor: SecretRedactor.Interface, event: Event.Event): Event.Event =>
  event.type === "message.added"
    ? {
        ...event,
        data: { message: { ...event.data.message, content: event.data.message.content.map(redactPart(redactor)) } },
      }
    : event

const redactPart =
  (redactor: SecretRedactor.Interface) =>
  (part: Message.ContentPart): Message.ContentPart =>
    part.type === "text" ? { ...part, text: redactor.redact(part.text) } : part

const makeRunningSandboxState = () => {
  const state = SandboxClientFake.makeState()
  state.sandboxes.set("sandbox_rivet_orb_mirror", {
    sandboxId: "sandbox_rivet_orb_mirror",
    templateId: "template_rivet_orb_mirror",
    metadata: {
      thread_id: threadId,
      project_id: Ids.ProjectId.make("project_rivet_orb_mirror"),
    },
    state: "running",
  })
  return state
}

const createRunningOrb = (projectId: Ids.ProjectId) =>
  Effect.gen(function* () {
    const created = yield* OrbStore.create({
      thread_id: threadId,
      project_id: projectId,
    })
    yield* OrbStore.setSandbox(created.orb_id, "sandbox_rivet_orb_mirror")
    yield* OrbStore.setEndpoint(created.orb_id, {
      endpoint_url: "https://sandbox_rivet_orb_mirror.fake.rika.local",
      token: "orb-token",
    })
    yield* OrbStore.setStatus(created.orb_id, "running")
    return created.orb_id
  })

const threadCreated = (sequence: number): Event.ThreadCreated => ({
  id: Ids.EventId.make(`event_rivet_orb_mirror_created_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: now,
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

const messageAdded = (sequence: number, content: string): Event.MessageAdded => ({
  id: Ids.EventId.make(`event_rivet_orb_mirror_message_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: now,
  type: "message.added",
  data: {
    message: Message.assistant({
      id: Ids.MessageId.make(`message_rivet_orb_mirror_${sequence}`),
      thread_id: threadId,
      content: [Message.text(content)],
      created_at: now,
    }),
  },
})

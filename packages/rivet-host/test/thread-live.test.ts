import { describe, expect, test } from "bun:test"
import { AgentLoop, ContextResolver, SkillRegistry, ToolExecutor, WorkspaceAccess } from "@rika/agent"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Time } from "@rika/core"
import { Provider, Router } from "@rika/llm"
import { Database, Migration, ThreadEventLog, ThreadProjection, WorkspaceStore } from "@rika/persistence"
import { Common, Event, Ids, Message, Workspace } from "@rika/schema"
import { Registry } from "@rivetkit/effect"
import { Effect, Exit, Layer, Option, Stream } from "effect"
import { ThreadLive } from "../src/index"

const threadId = Ids.ThreadId.make("thread_actor_smoke")
const workspaceId = Ids.WorkspaceId.make("workspace_actor_smoke")
const otherWorkspaceId = Ids.WorkspaceId.make("workspace_actor_other")
const securedThreadId = Ids.ThreadId.make("thread_actor_secured")
const securedWorkspaceId = Ids.WorkspaceId.make("workspace_actor_secured")
const securedOwnerId = Ids.UserId.make("user_actor_secured_owner")
const securedOutsiderId = Ids.UserId.make("user_actor_secured_outsider")
const securedNow = Common.TimestampMillis.make(1_800_000_000_000)
const agentLoopThreadId = Ids.ThreadId.make("thread_actor_agent_loop")
const agentLoopWorkspaceId = Ids.WorkspaceId.make("workspace_actor_agent_loop")
const agentLoopTurnId = Ids.TurnId.make("turn_actor_agent_loop")

const configLayer = Config.layerFromValues({
  workspace_root: "/workspace/rika-actor-test",
  data_dir: "/workspace/rika-actor-test/.rika",
  default_mode: "smart",
})
const redactorLayer = SecretRedactor.layer
const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
const llmLayer = Router.layer.pipe(
  Layer.provideMerge(
    Provider.fakeRegistryLayer([
      { name: "anthropic", responses: ["actor loop response"] },
      { name: "openai", responses: ["actor loop response"] },
    ]),
  ),
  Layer.provideMerge(configLayer),
  Layer.provideMerge(diagnosticsLayer),
)
const toolLayer = ToolExecutor.emptyLayer.pipe(Layer.provideMerge(diagnosticsLayer))

const baseServiceLayer = Layer.mergeAll(
  configLayer,
  Database.memoryLayer,
  Migration.layer,
  ThreadEventLog.layer,
  ThreadProjection.layer,
  WorkspaceStore.layer.pipe(Layer.provideMerge(Database.memoryLayer)),
  Time.fixedLayer(Common.TimestampMillis.make(1_800_000_000_000)),
  IdGenerator.sequenceLayer(1),
  redactorLayer,
  diagnosticsLayer,
  ContextResolver.emptyLayer,
  SkillRegistry.emptyLayer,
  toolLayer,
  llmLayer,
)

const serviceLayer = AgentLoop.layer.pipe(Layer.provideMerge(baseServiceLayer))

const supportLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(serviceLayer))
const workspaceAccessLayer = WorkspaceAccess.layer.pipe(Layer.provideMerge(supportLayer))
const fallbackSupportLayer = Layer.mergeAll(
  IdGenerator.sequenceLayer(500),
  Time.fixedLayer(Common.TimestampMillis.make(1_800_000_000_500)),
)

const registryLayer = ThreadLive.layer.pipe(
  Layer.provideMerge(supportLayer),
  Layer.provideMerge(workspaceAccessLayer),
  Layer.provideMerge(Registry.layer({ noWelcome: true })),
)

describe("ThreadActorLive", () => {
  test("registers the ThreadActor with the local Rivet serverless host", async () => {
    const { handler, dispose } = Registry.toWebHandler(registryLayer)

    try {
      const response = await handler(new Request("http://runner.test/api/rivet/metadata"))
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(hasThreadActorMetadata(body)).toBe(true)
    } finally {
      await dispose()
    }
  })

  test("replays a persisted thread without relying on hot actor state", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ThreadEventLog.append(threadCreated(1))
        yield* ThreadEventLog.append(turnStarted(2))
        yield* ThreadEventLog.append(messageAdded(3, "hello actor"))

        const replayed = yield* ThreadLive.replaySnapshot(threadId)
        const events = yield* ThreadEventLog.readThread({ thread_id: threadId })
        return { replayed, events }
      }).pipe(Effect.provide(workspaceAccessLayer)),
    )

    expect(result.replayed).toMatchObject({
      thread_id: threadId,
      last_sequence: 3,
      message_count: 1,
      active_turn_status: "active",
      latest_message_text: "hello actor",
    })
    expect(result.events.map((event) => event.type)).toEqual(["thread.created", "turn.started", "message.added"])
  })

  test("denies replayed snapshots to non-members with verified hosted identity", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* WorkspaceStore.putMembership(membership(securedOwnerId, "owner", securedWorkspaceId))
        yield* ThreadEventLog.appendAndProject(securedThreadCreated(1))
        yield* ThreadEventLog.appendAndProject(securedThreadVisibilitySet(2))
        yield* ThreadEventLog.appendAndProject(securedMessageAdded(3, "hosted secret"))

        const snapshotExit = yield* ThreadLive.replaySnapshot(
          securedThreadId,
          verifiedIdentity(securedOutsiderId),
        ).pipe(Effect.exit)
        return Option.getOrUndefined(Exit.findErrorOption(snapshotExit))
      }).pipe(Effect.provide(workspaceAccessLayer)),
    )

    expect(result).toMatchObject({
      _tag: "WorkspaceAccessDenied",
      action: "read",
      workspace_id: securedWorkspaceId,
      user_id: securedOutsiderId,
    })
  })

  test("mirrors AgentLoop stream events through the actor append path", async () => {
    const calls: Array<AgentLoop.RunTurnInput> = []
    const appended: Array<Event.Event> = []

    await Effect.runPromise(
      ThreadLive.runAgentLoopTurn(
        {
          thread_id: agentLoopThreadId,
          workspace_id: agentLoopWorkspaceId,
          content: "Reply with READY",
          mode: "rush",
        },
        (event) =>
          Effect.sync(() => {
            appended.push(event)
            return event
          }),
      ).pipe(Effect.provide(agentLoopLayer(calls))),
    )

    expect(calls).toEqual([
      {
        thread_id: agentLoopThreadId,
        workspace_id: agentLoopWorkspaceId,
        content: "Reply with READY",
        mode: "rush",
      },
    ])
    expect(appended.map((event) => event.type)).toEqual(agentLoopEvents().map((event) => event.type))
  })

  test("hydrates the AgentLoop working log from actor events before streaming", async () => {
    const hydratedThreadId = Ids.ThreadId.make("thread_actor_hydrated_agent_loop")
    const appended: Array<Event.Event> = []

    await Effect.runPromise(
      ThreadLive.runAgentLoopTurn(
        {
          thread_id: hydratedThreadId,
          workspace_id: workspaceId,
          content: "Continue",
          mode: "rush",
        },
        (event) =>
          Effect.sync(() => {
            appended.push(event)
            return event
          }),
        [threadCreatedFor(hydratedThreadId, 1)],
      ).pipe(Effect.provide(supportLayer)),
    )

    expect(appended[0]?.type).toBe("turn.started")
    expect(appended.some((event) => event.type === "thread.created")).toBe(false)
  })

  test("uses actor-owned workspace when hydrating AgentLoop from existing events", async () => {
    const hydratedThreadId = Ids.ThreadId.make("thread_actor_hydrated_workspace")
    const calls: Array<AgentLoop.RunTurnInput> = []
    const appended: Array<Event.Event> = []

    await Effect.runPromise(
      ThreadLive.runAgentLoopTurn(
        {
          thread_id: hydratedThreadId,
          workspace_id: otherWorkspaceId,
          content: "Continue",
          mode: "rush",
        },
        (event) =>
          Effect.sync(() => {
            appended.push(event)
            return event
          }),
        [threadCreatedFor(hydratedThreadId, 1)],
      ).pipe(Effect.provide(agentLoopLayer(calls))),
    )

    expect(calls[0]?.workspace_id).toBe(workspaceId)
    expect(appended.map((event) => event.type)).toEqual(agentLoopEvents().map((event) => event.type))
  })

  test("rejects a new turn when hot actor state is already active before c.db catches up", async () => {
    const active = ThreadLive.activeTurnFromState({
      thread_id: threadId,
      last_sequence: 1,
      message_count: 0,
      archived: false,
      visibility: "private",
      active_turn_id: turnId,
      active_turn_status: "active",
      active_user_id: securedOwnerId,
    })

    expect(active).toMatchObject({
      _tag: "ThreadActorActiveTurn",
      thread_id: threadId,
      active_user_id: securedOwnerId,
    })
  })

  test("preserves a hot active reservation when replay sees stale durable idle state", () => {
    const next = ThreadLive.mergeReplayWithHotState(
      {
        thread_id: threadId,
        workspace_id: workspaceId,
        user_id: securedOwnerId,
        created_at: 1,
        last_sequence: 1,
        message_count: 0,
        archived: false,
        visibility: "private",
        active_turn_status: "active",
        active_user_id: securedOwnerId,
      },
      {
        thread_id: threadId,
        last_sequence: 1,
        message_count: 0,
        archived: false,
        visibility: "private",
        active_turn_status: "idle",
      },
      threadId,
    )

    expect(next).toMatchObject({
      thread_id: threadId,
      workspace_id: workspaceId,
      user_id: securedOwnerId,
      created_at: 1,
      last_sequence: 1,
      active_turn_status: "active",
      active_user_id: securedOwnerId,
    })
  })

  test("preserves a hot active reservation while applying a visibility replay", () => {
    const next = ThreadLive.mergeReplayWithHotState(
      {
        thread_id: threadId,
        workspace_id: workspaceId,
        user_id: securedOwnerId,
        created_at: 1,
        last_sequence: 1,
        message_count: 0,
        archived: false,
        visibility: "private",
        active_turn_status: "active",
        active_user_id: securedOwnerId,
      },
      {
        thread_id: threadId,
        workspace_id: workspaceId,
        user_id: securedOwnerId,
        created_at: 1,
        last_sequence: 2,
        message_count: 0,
        archived: false,
        visibility: "unlisted",
        active_turn_status: "idle",
      },
      threadId,
    )

    expect(next).toMatchObject({
      thread_id: threadId,
      last_sequence: 2,
      visibility: "unlisted",
      active_turn_status: "active",
      active_user_id: securedOwnerId,
    })
  })

  test("preserves a new hot reservation over stale durable terminal state", () => {
    const next = ThreadLive.mergeReplayWithHotState(
      {
        thread_id: threadId,
        workspace_id: workspaceId,
        user_id: securedOwnerId,
        created_at: 1,
        last_sequence: 3,
        message_count: 1,
        archived: false,
        visibility: "private",
        active_turn_status: "active",
        active_user_id: securedOwnerId,
      },
      {
        thread_id: threadId,
        workspace_id: workspaceId,
        user_id: securedOwnerId,
        created_at: 1,
        last_sequence: 3,
        message_count: 1,
        archived: false,
        visibility: "unlisted",
        active_turn_id: turnId,
        active_turn_status: "completed",
      },
      threadId,
    )

    expect(next).toMatchObject({
      thread_id: threadId,
      last_sequence: 3,
      visibility: "unlisted",
      active_turn_status: "active",
      active_user_id: securedOwnerId,
    })
    expect(next.active_turn_id).toBeUndefined()
  })

  test("does not preserve a hot reservation after durable replay reaches a terminal turn", () => {
    const next = ThreadLive.mergeReplayWithHotState(
      {
        thread_id: threadId,
        last_sequence: 1,
        message_count: 0,
        archived: false,
        visibility: "private",
        active_turn_id: turnId,
        active_turn_status: "active",
        active_user_id: securedOwnerId,
      },
      {
        thread_id: threadId,
        last_sequence: 2,
        message_count: 0,
        archived: false,
        visibility: "private",
        active_turn_id: turnId,
        active_turn_status: "completed",
      },
      threadId,
    )

    expect(next).toMatchObject({
      thread_id: threadId,
      last_sequence: 2,
      active_turn_id: turnId,
      active_turn_status: "completed",
    })
    expect("active_user_id" in next).toBe(false)
  })

  test("releases a hot reservation when a stream fails before turn.started is durable", () => {
    const next = ThreadLive.mergeReplayAfterTurnFailure(
      {
        thread_id: threadId,
        last_sequence: 1,
        message_count: 0,
        archived: false,
        visibility: "private",
        active_turn_status: "active",
        active_user_id: securedOwnerId,
      },
      {
        thread_id: threadId,
        last_sequence: 1,
        message_count: 0,
        archived: false,
        visibility: "private",
        active_turn_status: "idle",
      },
      threadId,
      false,
    )

    expect(next).toMatchObject({
      thread_id: threadId,
      last_sequence: 1,
      active_turn_status: "idle",
    })
    expect("active_user_id" in next).toBe(false)
  })

  test("appends an actor-owned turn.failed fallback when the stream mirror fails after turn.started", async () => {
    const appended: Array<Event.Event> = []

    const fallbackAppended = await Effect.runPromise(
      ThreadLive.appendFailureIfActive(
        {
          thread_id: agentLoopThreadId,
          workspace_id: agentLoopWorkspaceId,
          content: "Reply with READY",
          mode: "rush",
        },
        new Error("append failed"),
        [agentThreadCreated(1), agentTurnStarted(2)],
        (event) =>
          Effect.sync(() => {
            appended.push(event)
            return event
          }),
      ).pipe(Effect.provide(fallbackSupportLayer)),
    )

    expect(fallbackAppended).toBe(true)
    expect(appended).toHaveLength(1)
    expect(appended[0]).toMatchObject({
      thread_id: agentLoopThreadId,
      turn_id: agentLoopTurnId,
      type: "turn.failed",
      data: { error: { kind: "unknown", code: "ThreadActor.streamTurn" } },
    })
  })

  test("does not append a turn.failed fallback before turn.started is durable", async () => {
    const appended: Array<Event.Event> = []

    const fallbackAppended = await Effect.runPromise(
      ThreadLive.appendFailureIfActive(
        {
          thread_id: agentLoopThreadId,
          workspace_id: agentLoopWorkspaceId,
          content: "Reply with READY",
          mode: "rush",
        },
        new Error("append failed"),
        [agentThreadCreated(1)],
        (event) =>
          Effect.sync(() => {
            appended.push(event)
            return event
          }),
      ).pipe(Effect.provide(fallbackSupportLayer)),
    )

    expect(fallbackAppended).toBe(false)
    expect(appended).toHaveLength(0)
  })
})

const turnId = Ids.TurnId.make("turn_actor_smoke")

const hasThreadActorMetadata = (body: unknown) => {
  if (typeof body !== "object" || body === null || !("actorNames" in body)) return false
  const actorNames = body.actorNames
  return typeof actorNames === "object" && actorNames !== null && "ThreadActor" in actorNames
}

const threadCreated = (sequence: number): Event.ThreadCreated => ({
  id: Ids.EventId.make(`actor_event_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

const threadCreatedFor = (targetThreadId: Ids.ThreadId, sequence: number): Event.ThreadCreated => ({
  id: Ids.EventId.make(`actor_event_${targetThreadId}_${sequence}`),
  thread_id: targetThreadId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

const turnStarted = (sequence: number): Event.TurnStarted => ({
  id: Ids.EventId.make(`actor_event_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "turn.started",
  data: {},
})

const messageAdded = (sequence: number, content: string): Event.MessageAdded => ({
  id: Ids.EventId.make(`actor_event_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make("actor_message_1"),
      thread_id: threadId,
      turn_id: turnId,
      content,
      created_at: sequence,
    }),
  },
})

const membership = (
  userId: Ids.UserId,
  role: Workspace.MembershipRole,
  workspaceIdValue: Ids.WorkspaceId,
): Workspace.Membership => ({
  workspace_id: workspaceIdValue,
  user_id: userId,
  role,
  created_at: securedNow,
})

const verifiedIdentity = (userId: Ids.UserId) => ({
  _tag: "VerifiedUserIdentity" as const,
  user_id: userId,
})

const securedThreadCreated = (sequence: number): Event.ThreadCreated => ({
  id: Ids.EventId.make(`secured_actor_event_${sequence}`),
  thread_id: securedThreadId,
  sequence,
  version: 1,
  created_at: securedNow,
  type: "thread.created",
  data: { workspace_id: securedWorkspaceId, user_id: securedOwnerId },
})

const securedThreadVisibilitySet = (sequence: number): Event.Event =>
  ({
    id: Ids.EventId.make(`secured_actor_event_${sequence}`),
    thread_id: securedThreadId,
    sequence,
    version: 1,
    created_at: securedNow,
    type: "thread.visibility.set",
    data: { visibility: "workspace" },
  }) as Event.Event

const securedMessageAdded = (sequence: number, content: string): Event.MessageAdded => ({
  id: Ids.EventId.make(`secured_actor_event_${sequence}`),
  thread_id: securedThreadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: securedNow,
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make("secured_actor_message_1"),
      thread_id: securedThreadId,
      turn_id: turnId,
      content,
      created_at: securedNow,
    }),
  },
})

const agentLoopLayer = (calls: Array<AgentLoop.RunTurnInput>) =>
  Layer.succeed(
    AgentLoop.Service,
    AgentLoop.Service.of({
      runTurn: Effect.fn("ThreadActorLive.test.runTurn")(function* (input: AgentLoop.RunTurnInput) {
        calls.push(input)
        const events = agentLoopEvents()
        return { thread_id: input.thread_id, turn_id: agentLoopTurnId, status: "completed" as const, events }
      }),
      streamTurn: (input) =>
        Stream.suspend(() => {
          calls.push(input)
          return Stream.fromIterable(agentLoopEvents())
        }),
      cancelTurn: Effect.fn("ThreadActorLive.test.cancelTurn")(function* (input: AgentLoop.CancelTurnInput) {
        return {
          status: "inserted" as const,
          event: agentTurnFailed(1, input.thread_id, input.turn_id),
        }
      }),
    }),
  )

const agentLoopEvents = (): ReadonlyArray<Event.Event> => [
  agentThreadCreated(1),
  agentTurnStarted(2),
  agentMessageAdded(3, "user", "Reply with READY"),
  agentModelStreamChunk(4),
  agentMessageAdded(5, "assistant", "agent loop actor response"),
  agentTurnCompleted(6),
]

const agentThreadCreated = (sequence: number): Event.ThreadCreated => ({
  id: Ids.EventId.make(`agent_loop_event_${sequence}`),
  thread_id: agentLoopThreadId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "thread.created",
  data: { workspace_id: agentLoopWorkspaceId },
})

const agentTurnStarted = (sequence: number): Event.TurnStarted => ({
  id: Ids.EventId.make(`agent_loop_event_${sequence}`),
  thread_id: agentLoopThreadId,
  turn_id: agentLoopTurnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "turn.started",
  data: { mode: "rush" },
})

const agentMessageAdded = (sequence: number, role: "user" | "assistant", content: string): Event.MessageAdded => ({
  id: Ids.EventId.make(`agent_loop_event_${sequence}`),
  thread_id: agentLoopThreadId,
  turn_id: agentLoopTurnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "message.added",
  data: {
    message:
      role === "user"
        ? Message.user({
            id: Ids.MessageId.make(`agent_loop_message_${sequence}`),
            thread_id: agentLoopThreadId,
            turn_id: agentLoopTurnId,
            content,
            created_at: sequence,
          })
        : Message.assistant({
            id: Ids.MessageId.make(`agent_loop_message_${sequence}`),
            thread_id: agentLoopThreadId,
            turn_id: agentLoopTurnId,
            content: [Message.text(content)],
            created_at: sequence,
          }),
  },
})

const agentModelStreamChunk = (sequence: number): Event.Event =>
  ({
    id: Ids.EventId.make(`agent_loop_event_${sequence}`),
    thread_id: agentLoopThreadId,
    turn_id: agentLoopTurnId,
    sequence,
    version: 1,
    created_at: sequence,
    type: "model.stream.chunk",
    data: { text: "agent loop actor response", provider: "test", model: "test" },
  }) as Event.Event

const agentTurnCompleted = (sequence: number): Event.TurnCompleted => ({
  id: Ids.EventId.make(`agent_loop_event_${sequence}`),
  thread_id: agentLoopThreadId,
  turn_id: agentLoopTurnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "turn.completed",
  data: { provider: "test", model: "test" },
})

const agentTurnFailed = (sequence: number, thread: Ids.ThreadId, turn: Ids.TurnId): Event.TurnFailed => ({
  id: Ids.EventId.make(`agent_loop_failed_${sequence}`),
  thread_id: thread,
  turn_id: turn,
  sequence,
  version: 1,
  created_at: sequence,
  type: "turn.failed",
  data: { error: { kind: "cancelled", message: "cancelled" } },
})

import { describe, expect, test } from "bun:test"
import { Config, IdGenerator, Time } from "@rika/core"
import { Provider, Router } from "@rika/llm"
import { Database, Migration, ThreadEventLog, ThreadProjection } from "@rika/persistence"
import { Common, Ids } from "@rika/schema"
import { Effect, Layer, Stream } from "effect"
import { AgentLoop, ContextResolver, PermissionPolicy, SkillRegistry, ToolExecutor, ToolRegistry } from "../src/index"

const threadId = Ids.ThreadId.make("thread_agent_loop")
const workspaceId = Ids.WorkspaceId.make("workspace_agent_loop")

const configLayer = Config.layerFromValues({
  workspace_root: "/workspace/rika-test",
  data_dir: "/workspace/rika-test/.rika",
  default_mode: "smart",
})

const defaultToolLayer = ToolExecutor.fakeLayer({
  "fake.echo": (call) => Effect.succeed({ echoed: call.input }),
})

const makeLayer = (
  responses: ReadonlyArray<Provider.FakeResponse>,
  toolLayer = defaultToolLayer,
  skillLayer = SkillRegistry.emptyLayer,
  providerLayer = Provider.fakeLayer(responses),
) => {
  const llmLayer = Router.layer.pipe(Layer.provideMerge(configLayer), Layer.provideMerge(providerLayer))
  const services = Layer.mergeAll(
    configLayer,
    Database.memoryLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    Time.fixedLayer(Common.TimestampMillis.make(1_900_000_000_000)),
    IdGenerator.sequenceLayer(1),
    ContextResolver.fakeLayer({
      entries: [
        {
          kind: "guidance",
          source: "test",
          reason: "agent loop test",
          trusted: false,
          path: "AGENTS.md",
          content: "Test guidance",
        },
      ],
      rendered: "<rika_context>Test guidance</rika_context>",
      total_chars: 41,
    }),
    skillLayer,
    toolLayer,
    llmLayer,
  )

  return AgentLoop.layer.pipe(Layer.provideMerge(services))
}

describe("AgentLoop", () => {
  test("runs a fake model requested fake tool in one persisted turn", async () => {
    const layer = makeLayer([
      JSON.stringify({ tool_call: { name: "fake.echo", input: { text: "hello" } } }),
      "tool saw hello",
    ])

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const turn = yield* AgentLoop.runTurn({
          thread_id: threadId,
          workspace_id: workspaceId,
          content: "please echo hello",
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: threadId })
        const summary = yield* ThreadProjection.getThread(threadId)
        return { turn, events, summary }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.turn.status).toBe("completed")
    expect(result.events.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "context.resolved",
      "model.stream.chunk",
      "tool.call.requested",
      "tool.call.completed",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
    ])
    expect(result.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(result.events.find((event) => event.type === "context.resolved")).toMatchObject({
      data: { rendered: "<rika_context>Test guidance</rika_context>" },
    })
    expect(result.events.find((event) => event.type === "tool.call.completed")).toMatchObject({
      data: { result: { status: "success", output: { echoed: { text: "hello" } } } },
    })
    expect(result.summary).toMatchObject({
      thread_id: threadId,
      latest_message_text: "tool saw hello",
      active_turn_status: "completed",
    })
  })

  test("emits the same persisted events as a stream for UI consumers", async () => {
    const layer = makeLayer(["streamed response"])

    const eventTypes = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const events = yield* AgentLoop.streamTurn({
          thread_id: Ids.ThreadId.make("thread_agent_stream"),
          workspace_id: workspaceId,
          content: "stream it",
        }).pipe(Stream.runCollect)
        return Array.from(events).map((event) => event.type)
      }).pipe(Effect.provide(layer)),
    )

    expect(eventTypes).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "context.resolved",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
    ])
  })

  test("records permission-blocked tool calls as structured tool results", async () => {
    const toolLayer = ToolExecutor.layer.pipe(
      Layer.provideMerge(ToolRegistry.fakeLayer({ "fake.echo": (call) => Effect.succeed({ echoed: call.input }) })),
      Layer.provideMerge(PermissionPolicy.rejectLayer("policy denied fake.echo")),
    )
    const layer = makeLayer(
      [JSON.stringify({ tool_call: { name: "fake.echo", input: { text: "blocked" } } }), "continued after block"],
      toolLayer,
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const turn = yield* AgentLoop.runTurn({
          thread_id: Ids.ThreadId.make("thread_agent_blocked_tool"),
          workspace_id: workspaceId,
          content: "please call a blocked tool",
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: Ids.ThreadId.make("thread_agent_blocked_tool") })
        return { turn, events }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.turn.status).toBe("completed")
    expect(result.events.find((event) => event.type === "tool.call.completed")).toMatchObject({
      data: { result: { status: "error", error: { kind: "permission", message: "policy denied fake.echo" } } },
    })
    expect(result.events.at(-1)).toMatchObject({ type: "turn.completed" })
  })

  test("loads explicitly selected skills into the model prompt and event log", async () => {
    const captured: Array<Provider.GenerateRequest> = []
    const providerLayer = Layer.succeed(
      Provider.Service,
      Provider.Service.of({
        name: "openai",
        complete: Effect.fn("AgentLoop.test.provider.complete")(function* (request: Provider.GenerateRequest) {
          captured.push(request)
          return fakeResponse(request, "skill response")
        }),
        stream: (request: Provider.GenerateRequest) => {
          captured.push(request)
          return Stream.fromIterable(Provider.streamEventsFromResponse(fakeResponse(request, "skill response")))
        },
      }),
    )
    const layer = makeLayer(
      [],
      defaultToolLayer,
      SkillRegistry.fakeLayer([
        skill("deploy", "Deploy safely", "Deploy instructions only when loaded"),
        skill("review", "Review code", "Review instructions must stay unloaded"),
      ]),
      providerLayer,
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const turn = yield* AgentLoop.runTurn({
          thread_id: Ids.ThreadId.make("thread_agent_skill"),
          workspace_id: workspaceId,
          content: "Use skill deploy for this release",
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: Ids.ThreadId.make("thread_agent_skill") })
        return { turn, events }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.turn.status).toBe("completed")
    expect(result.events.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "context.resolved",
      "skill.loaded",
      "model.stream.chunk",
      "message.added",
      "turn.completed",
    ])
    expect(result.events.find((event) => event.type === "skill.loaded")).toMatchObject({
      data: { name: "deploy", resource_paths: ["templates/deploy.md"] },
    })
    const system = captured[0]?.messages[0]?.content ?? ""
    expect(system).toContain("- deploy: Deploy safely")
    expect(system).toContain("- review: Review code")
    expect(system).toContain("Deploy instructions only when loaded")
    expect(system).not.toContain("Review instructions must stay unloaded")
  })

  test("records cancellation as a replayable turn failure", async () => {
    const layer = makeLayer(["this response is never used"])

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const turn = yield* AgentLoop.runTurn({
          thread_id: Ids.ThreadId.make("thread_agent_cancel"),
          workspace_id: workspaceId,
          content: "stop before model",
          cancelled: true,
        })
        const events = yield* ThreadEventLog.readThread({ thread_id: Ids.ThreadId.make("thread_agent_cancel") })
        return { turn, events }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.turn.status).toBe("cancelled")
    expect(result.events.map((event) => event.type)).toEqual([
      "thread.created",
      "turn.started",
      "message.added",
      "context.resolved",
      "turn.failed",
    ])
    expect(result.events.at(-1)).toMatchObject({ type: "turn.failed", data: { error: { kind: "cancelled" } } })
  })

  test("queues follow-up turns through the service boundary without module-level state", async () => {
    const layer = makeLayer(["queued later"])

    const queued = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* AgentLoop.queueTurn({ thread_id: threadId, workspace_id: workspaceId, content: "next" })
      }).pipe(Effect.provide(layer)),
    )

    expect(queued).toEqual({ thread_id: threadId, position: 1 })
  })
})

const fakeResponse = (request: Provider.GenerateRequest, content: string): Provider.GenerateResponse => ({
  provider: request.provider,
  model: request.model,
  content,
})

const skill = (name: string, description: string, instructions: string): SkillRegistry.Skill => ({
  summary: {
    name,
    description,
    source: "project",
    directory: `/skills/${name}`,
    skill_file: `/skills/${name}/SKILL.md`,
  },
  instructions,
  resources: [{ path: `/skills/${name}/templates/deploy.md`, relative_path: "templates/deploy.md" }],
})

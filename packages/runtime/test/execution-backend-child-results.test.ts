import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { TurnPolicy } from "@batonfx/core"
import { ChildFanOutHost, Client, Content, Execution, Ids, WorkflowDefinitionHost } from "@relayfx/sdk"
import { ThreadTools } from "@rika/tools"
import { Effect, Layer, Ref, Stream } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"
import { start } from "./current-execution-route"

const MockEffect = vi.hoisted(() => (require("effect") as typeof import("effect")).Effect)

const native = vi.hoisted(() => ({
  client: undefined as Client.Interface | undefined,
  databaseAcquisitions: 0,
  runtimeGraphs: 0,
}))

vi.mock("@relayfx/sdk", (importOriginal) =>
  MockEffect.runPromise(
    MockEffect.gen(function* () {
      const actual = yield* MockEffect.tryPromise(() => importOriginal<typeof import("@relayfx/sdk")>())
      const { Layer: EffectLayer } = yield* MockEffect.tryPromise(() => import("effect"))
      return {
        ...actual,
        Client: {
          ...actual.Client,
          layerFromRuntime: EffectLayer.suspend(() => EffectLayer.succeed(actual.Client.Service, native.client!)),
        },
        Runtime: {
          ...actual.Runtime,
          layerEmbedded: (options: {
            readonly childFanOutHostLayer: Layer.Layer<ChildFanOutHost.Service>
            readonly workflowDefinitionHostLayer: Layer.Layer<WorkflowDefinitionHost.Service>
          }) => {
            native.runtimeGraphs += 1
            return EffectLayer.merge(options.childFanOutHostLayer, options.workflowDefinitionHostLayer).pipe(
              EffectLayer.provideMerge(EffectLayer.succeed(actual.Client.Service, native.client!)),
            )
          },
        },
      }
    }),
  ),
)

vi.mock("@relayfx/sdk/sqlite", () => ({
  SQLite: {
    database: () => {
      native.databaseAcquisitions += 1
      return {}
    },
  },
}))

const selection = { provider: "test", model: "model" }
const unused = () => Effect.die("unused client method")
const clientFailure = (message: string) => Client.ClientError.make({ message })
const relayEvent = (
  type: Execution.ExecutionEvent["type"],
  sequence: number,
  content?: Execution.ExecutionEvent["content"],
  data?: Execution.ExecutionEvent["data"],
): Execution.ExecutionEvent => ({
  id: Ids.EventId.make(`event:${sequence}`),
  execution_id: Ids.ExecutionId.make("execution:turn-a"),
  type,
  sequence,
  cursor: `cursor-${sequence}`,
  ...(content === undefined ? {} : { content }),
  ...(data === undefined ? {} : { data }),
  created_at: sequence * 10,
})

const makeClient = Effect.fn("ExecutionBackendTest.makeClient")(function* (options?: {
  readonly startStatus?: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled"
  readonly existingStatus?: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled"
  readonly streamEvents?: ReadonlyArray<Execution.ExecutionEvent>
  readonly streamFailure?: string
  readonly replayEvents?: ReadonlyArray<Execution.ExecutionEvent>
  readonly pageEvents?: ReadonlyArray<Execution.ExecutionEvent>
  readonly openWaitIds?: ReadonlyArray<string>
  readonly cancelStatus?: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled"
  readonly unavailableLookups?: number
  readonly fail?: "register" | "start" | "lookup" | "replay" | "cancel"
}) {
  const registrations = yield* Ref.make<
    ReadonlyArray<{
      readonly id?: unknown
      readonly address?: unknown
      readonly agent?: unknown
      readonly metadata?: Readonly<Record<string, unknown>>
      readonly permissions?: unknown
      readonly handoff_targets?: unknown
      readonly max_wait_turns?: unknown
    }>
  >([])
  const starts = yield* Ref.make<
    ReadonlyArray<Parameters<Client.Interface["executions"]["startByAgentDefinition"]>[0]>
  >([])
  const lookups = yield* Ref.make<ReadonlyArray<Parameters<Client.Interface["executions"]["get"]>[0]>>([])
  const replays = yield* Ref.make<ReadonlyArray<Parameters<Client.Interface["executions"]["replay"]>[0]>>([])
  const pages = yield* Ref.make<ReadonlyArray<Parameters<Client.Interface["executions"]["pageEvents"]>[0]>>([])
  const cancellations = yield* Ref.make<ReadonlyArray<Parameters<Client.Interface["executions"]["cancel"]>[0]>>([])
  const nextRevision = yield* Ref.make(40)
  const flat = {
    registerAgent: <Tools extends Record<string, import("effect/unstable/ai").Tool.Any>, Requirements>(
      input: Client.RegisterAgentInput<Tools, Requirements>,
    ) =>
      Ref.update(registrations, (values) => [...values, input]).pipe(
        Effect.andThen(Ref.getAndUpdate(nextRevision, (revision) => revision + 1)),
        Effect.flatMap((revision) =>
          options?.fail === "register"
            ? Effect.fail(clientFailure("register failed"))
            : Effect.succeed({
                record: {
                  id: input.id,
                  current_revision: revision,
                  definition: { name: "rika", model: selection, tool_names: [], permissions: [] },
                  created_at: 0,
                  updated_at: 0,
                },
              }),
        ),
      ),
    registerAgentDefinition: unused,
    getAgentDefinition: unused,
    listAgentDefinitions: unused,
    listAgentDefinitionRevisions: unused,
    getSkillDefinition: unused,
    listSkillDefinitions: unused,
    listSkillDefinitionRevisions: unused,
    registerAddressBookRoute: unused,
    getAddressBookRoute: unused,
    listAddressBookRoutes: unused,
    startExecution: unused,
    startExecutionByAddress: unused,
    startExecutionByAgentDefinition: (input: Parameters<Client.Interface["executions"]["startByAgentDefinition"]>[0]) =>
      Ref.update(starts, (values) => [...values, input]).pipe(
        Effect.andThen(
          options?.fail === "start"
            ? Effect.fail(clientFailure("start failed"))
            : Effect.succeed({
                execution_id: input.execution_id ?? Ids.ExecutionId.make("execution:fallback"),
                status: options?.startStatus ?? "running",
              }),
        ),
      ),
    cancelExecution: (input: Parameters<Client.Interface["executions"]["cancel"]>[0]) =>
      Ref.update(cancellations, (values) => [...values, input]).pipe(
        Effect.andThen(
          options?.fail === "cancel"
            ? Effect.fail(clientFailure("cancel failed"))
            : Effect.succeed({ execution_id: input.execution_id, status: options?.cancelStatus ?? "running" }),
        ),
      ),
    steer: unused,
    getExecution: (input: Parameters<Client.Interface["executions"]["get"]>[0]) =>
      Ref.update(lookups, (values) => [...values, input]).pipe(
        Effect.andThen(Ref.get(lookups)),
        Effect.flatMap((values) =>
          options?.fail === "lookup"
            ? Effect.fail(clientFailure("lookup failed"))
            : Effect.succeed(
                options?.existingStatus === undefined || values.length <= (options.unavailableLookups ?? 0)
                  ? undefined
                  : {
                      id: Ids.ExecutionId.make("execution:turn-a"),
                      root_address_id: Ids.AddressId.make("address:rika"),
                      status: options.existingStatus,
                      created_at: 1,
                      updated_at: 1,
                    },
              ),
        ),
      ),
    inspectExecution: () =>
      Effect.succeed({
        execution_id: Ids.ExecutionId.make("execution:turn-a"),
        status: options?.openWaitIds === undefined || options.openWaitIds.length === 0 ? "running" : "waiting",
        waiting_on: (options?.openWaitIds ?? []).map((waitId) => ({
          wait_id: Ids.WaitId.make(waitId),
          execution_id: Ids.ExecutionId.make("execution:turn-a"),
          mode: "reply" as const,
          state: "open" as const,
          metadata: {},
          created_at: 1,
        })),
        pending_tool_calls: [],
        child_runs: [],
      }),
    listExecutions: unused,
    listSessions: unused,
    getSession: unused,
    listWaits: unused,
    replayExecution: (input: Parameters<Client.Interface["executions"]["replay"]>[0]) =>
      Ref.update(replays, (values) => [...values, input]).pipe(
        Effect.andThen(
          options?.fail === "replay"
            ? Effect.fail(clientFailure("replay failed"))
            : Effect.succeed({ events: options?.replayEvents ?? [] }),
        ),
      ),
    pageExecutionEvents: (input: Parameters<Client.Interface["executions"]["pageEvents"]>[0]) =>
      Ref.update(pages, (values) => [...values, input]).pipe(
        Effect.as({
          events: options?.pageEvents ?? [],
          has_more: true,
          oldest_cursor: "oldest",
          newest_cursor: "newest",
        }),
      ),
    listRunners: unused,
    routeExecution: unused,
    send: unused,
    streamExecution: () =>
      options?.streamFailure === undefined
        ? Stream.fromIterable(options?.streamEvents ?? [])
        : Stream.concat(
            Stream.fromIterable(options.streamEvents ?? []),
            Stream.fail(clientFailure(options.streamFailure)),
          ),
    followExecution: () =>
      Stream.fromIterable(
        (options?.streamFailure === undefined
          ? options?.streamEvents
          : (options?.replayEvents ?? options?.streamEvents ?? [])
        )?.map((event) => ({ _tag: "event" as const, event })) ?? [],
      ),
    wake: unused,
    listPendingApprovals: unused,
    resolveToolApproval: unused,
    resolvePermission: unused,
    listPendingToolCalls: unused,
    fulfillToolCall: unused,
    claimToolWork: unused,
    completeToolWork: unused,
    releaseToolWork: unused,
    listToolAttempts: unused,
    submitInboundEnvelope: unused,
    spawnChildRun: unused,
    createChildFanOut: unused,
    inspectChildFanOut: unused,
    cancelChildFanOut: unused,
    registerWorkflowDefinition: unused,
    getWorkflowDefinitionRevision: unused,
    listWorkflowDefinitionRevisions: unused,
    startWorkflowRun: unused,
    inspectWorkflowRun: unused,
    replayWorkflowRun: unused,
    cancelWorkflowRun: unused,
    claimEnvelopeReady: unused,
    ackEnvelopeReady: unused,
    releaseEnvelopeReady: unused,
    createSchedule: unused,
    cancelSchedule: unused,
    listSchedules: unused,
    registerEntityKind: unused,
    getOrCreateEntity: unused,
    getEntity: unused,
    destroyEntity: unused,
    listEntities: unused,
    getEntityState: unused,
    putEntityState: unused,
    deleteEntityState: unused,
    listEntityState: unused,
    listInboxMessages: unused,
    askEntity: unused,
    awaitWait: unused,
    subscribeTopic: unused,
    unsubscribeTopic: unused,
    publishTopic: unused,
    listTopicSubscriptions: unused,
    getPresence: unused,
    streamSession: () => Stream.empty,
    watchExecutions: () => Stream.empty,
    watchPresence: () => Stream.empty,
  }
  const implementation = {
    agents: { register: flat.registerAgent },
    executions: {
      startByAgentDefinition: flat.startExecutionByAgentDefinition,
      cancel: flat.cancelExecution,
      steer: flat.steer,
      get: flat.getExecution,
      inspect: flat.inspectExecution,
      replay: flat.replayExecution,
      pageEvents: flat.pageExecutionEvents,
      stream: flat.streamExecution,
      follow: flat.followExecution,
    },
    tools: {
      listPendingApprovals: flat.listPendingApprovals,
      resolveApproval: flat.resolveToolApproval,
      resolvePermission: flat.resolvePermission,
    },
    childRuns: {
      spawn: flat.spawnChildRun,
      createFanOut: flat.createChildFanOut,
      inspectFanOut: flat.inspectChildFanOut,
      cancelFanOut: flat.cancelChildFanOut,
    },
    workflows: {
      registerDefinition: flat.registerWorkflowDefinition,
      startRun: flat.startWorkflowRun,
      inspectRun: flat.inspectWorkflowRun,
      cancelRun: flat.cancelWorkflowRun,
    },
    residents: {
      registerKind: flat.registerEntityKind,
      spawn: flat.getOrCreateEntity,
      get: flat.getEntity,
      destroy: flat.destroyEntity,
    },
    envelopes: { send: flat.send },
  } as unknown as Client.Interface
  return { implementation, registrations, starts, lookups, replays, pages, cancellations }
})

const provideBackendWithThreadTools = (implementation: Client.Interface) => {
  const contextLayer = RelayExecutionBackend.layerFromClient({
    selection,
    additionalToolkit: ThreadTools.toolkit,
  }).pipe(Layer.provide(Layer.succeed(Client.Service, implementation)))
  return <A, E>(effect: Effect.Effect<A, E, ExecutionBackend.Service>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(contextLayer)
      return yield* Effect.provide(effect, context)
    })
}

describe("ExecutionBackend Relay client adapter", () => {
  it("returns a completed final child response despite an internal tool failure terminal", () => {
    const events = [
      relayEvent("tool.call.requested", 1),
      relayEvent("tool.result.received", 2),
      relayEvent("model.output.completed", 3, [Content.text("Usable final response")]),
      relayEvent("execution.failed", 4, [], { message: "internal tool failed" }),
    ]

    expect(RelayExecutionBackend.resolveChildResult(events)).toEqual({
      status: "completed",
      output: [Content.text("Usable final response")],
    })
  })

  it("does not recover a stale final response before later tool activity", () => {
    const events = [
      relayEvent("model.output.completed", 1, [Content.text("Stale response")]),
      relayEvent("tool.call.requested", 2),
      relayEvent("tool.result.received", 3),
      relayEvent("execution.failed", 4, [], { message: "internal tool failed" }),
    ]

    expect(RelayExecutionBackend.resolveChildResult(events)).toEqual({
      status: "failed",
      output: [{ type: "text", text: "Subagent execution failed: internal tool failed" }],
    })
  })

  it("keeps cancellation authoritative after a completed final response", () => {
    const events = [
      relayEvent("model.output.completed", 1, [Content.text("Completed response")]),
      relayEvent("execution.cancelled", 2, [], { message: "cancelled" }),
    ]

    expect(RelayExecutionBackend.resolveChildResult(events)).toEqual({
      status: "cancelled",
      output: [Content.text("Completed response")],
    })
  })

  it.each([
    ["execution.failed", "failed", "Subagent execution failed: terminal reason"],
    ["execution.cancelled", "cancelled", "Subagent execution was cancelled: terminal reason"],
  ] as const)("preserves %s when a child has no completed final response", (terminal, status, failureText) => {
    const events = [
      relayEvent("model.output.delta", 1, [Content.text("partial")]),
      relayEvent(terminal, 2, [], { message: "terminal reason" }),
    ]

    expect(RelayExecutionBackend.resolveChildResult(events)).toEqual({
      status,
      output: [{ type: "text", text: failureText }],
    })
  })

  it("keeps preset inheritance separate from explicit child-run overrides", () => {
    const base = {
      child_execution_id: Ids.ChildExecutionId.make("child:one"),
      address_id: Ids.AddressId.make("address:rika"),
      input: [Content.text("Explore the runtime")],
    }
    const inherited = RelayExecutionBackend.buildChildRunInput(base, {
      _tag: "preset",
      presetName: "Task",
    })
    const explicit = RelayExecutionBackend.buildChildRunInput(base, {
      _tag: "override",
      definition: {
        instructions: "Complete the task",
        model: { provider: "test", model: "gpt-5.6-luna", registration_key: "luna-low" },
        tool_names: ["read"],
        permissions: ["workspace.read"],
        output_schema_ref: "rika.agent.task.v1",
        metadata: { product_profile: "Task", rika_reasoning_effort: "low" },
      },
    })

    expect(inherited).toEqual({ ...base, preset_name: "Task" })
    expect(Object.keys(inherited).toSorted()).toEqual(["address_id", "child_execution_id", "input", "preset_name"])
    expect(explicit).toEqual({
      ...base,
      instructions: "Complete the task",
      model: { provider: "test", model: "gpt-5.6-luna", registration_key: "luna-low" },
      tool_names: ["read"],
      permissions: ["workspace.read"],
      output_schema_ref: "rika.agent.task.v1",
      metadata: { product_profile: "Task", rika_reasoning_effort: "low" },
    })
    expect(explicit).not.toHaveProperty("preset_name")
  })

  it.effect("registers the deterministic agent, starts the deterministic execution, and converts text events", () =>
    Effect.gen(function* () {
      const streamEvents = [
        relayEvent("model.output.delta", 1, [
          Content.text("hello "),
          { type: "structured", value: { n: 1 } },
          Content.text("world"),
        ]),
        relayEvent("model.output.delta", 2, []),
        relayEvent("execution.completed", 3),
        relayEvent("model.output.delta", 4, [Content.text("ignored")]),
      ]
      const fixture = yield* makeClient({ startStatus: "queued", streamEvents })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 100 })
      }).pipe(provideBackendWithThreadTools(fixture.implementation))
      const registrations = yield* Ref.get(fixture.registrations)
      const starts = yield* Ref.get(fixture.starts)
      expect(yield* Ref.get(fixture.lookups)).toEqual([])
      expect(registrations[0]?.id).toBe("agent:rika")
      expect(registrations[0]?.address).toBe("address:rika")
      expect((starts[0] as { agent_revision?: number }).agent_revision).toBe(40)
      const registration = registrations[0]
      if (registration === undefined || !("agent" in registration)) return yield* Effect.die("Missing Baton agent")
      expect(registration.agent).toMatchObject({
        policy: TurnPolicy.forever,
        toolExecution: { concurrency: 4 },
      })
      const agent = registration.agent as { readonly instructions: string }
      expect(agent.instructions).toContain("Consult Oracle frequently for complex or difficult tasks")
      expect(agent.instructions).toContain("tell the user that you are consulting it")
      expect(agent.instructions).toContain("after consulting Oracle, state that you did")
      expect(agent.instructions).toContain("remaining responsible for the implementation and conclusion")
      expect(registration.metadata).toMatchObject({ rika_agent_depth: 0 })
      expect(registration.metadata?.multi_agent_enabled).toBeUndefined()
      expect(registration.permissions).not.toContainEqual({ name: "relay.child_run.spawn", value: true })
      expect(registration.handoff_targets).toBeUndefined()
      expect(starts[0]).toMatchObject({
        root_address_id: "address:rika",
        session_id: "session:thread-a",
        agent_id: "agent:rika",
        idempotency_key: "turn-a",
        execution_id: "execution:turn-a",
        started_at: 100,
        completed_at: 100,
        input: [Content.text("prompt")],
      })
      expect(result.status).toBe("completed")
      expect(result.events).toEqual([
        {
          cursor: "cursor-1",
          sequence: 1,
          type: "model.output.delta",
          createdAt: 10,
          text: "hello world",
          content: [Content.text("hello "), { type: "structured", value: { n: 1 } }, Content.text("world")],
        },
        { cursor: "cursor-2", sequence: 2, type: "model.output.delta", createdAt: 20, content: [] },
        { cursor: "cursor-3", sequence: 3, type: "execution.completed", createdAt: 30 },
      ])
    }),
  )

  it.effect("maps distinct top-level Turn identities to distinct deterministic Relay identities", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
        streamEvents: [relayEvent("execution.completed", 1)],
        existingStatus: "running",
      })
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "first", startedAt: 1 })
        yield* start(backend, {
          threadId: "session:thread-a",
          turnId: "execution:turn-a",
          prompt: "second",
          startedAt: 2,
        })
        yield* backend.inspect("execution:turn-a")
        yield* backend.replay("execution:turn-a")
        if (backend.pageEvents === undefined) return yield* Effect.die("Missing event paging")
        yield* backend.pageEvents("execution:turn-a", "forward")
        yield* backend.cancel("execution:turn-a", 3)
      }).pipe(provideBackendWithThreadTools(fixture.implementation))

      expect(yield* Ref.get(fixture.starts)).toMatchObject([
        {
          session_id: "session:thread-a",
          idempotency_key: "turn-a",
          execution_id: "execution:turn-a",
        },
        {
          session_id: "session:session:thread-a",
          idempotency_key: "execution:turn-a",
          execution_id: "execution:execution:turn-a",
        },
      ])
      expect(yield* Ref.get(fixture.lookups)).toEqual(["execution:execution:turn-a", "execution:execution:turn-a"])
      expect((yield* Ref.get(fixture.replays)).map((input) => input.execution_id)).toEqual([
        "execution:execution:turn-a",
        "execution:execution:turn-a",
      ])
      expect((yield* Ref.get(fixture.pages)).map((input) => input.execution_id)).toEqual(["execution:execution:turn-a"])
      expect((yield* Ref.get(fixture.cancellations)).map((input) => input.execution_id)).toEqual([
        "execution:execution:turn-a",
      ])
    }),
  )
})

import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { ChildFanOutHost, Client, Execution, Ids, WorkflowDefinitionHost } from "@relayfx/sdk"
import { Effect, Layer, Ref, Stream } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"
import { createFanOut, currentExecutionRoute } from "./current-execution-route"

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

const provideConfiguredBackend = (
  implementation: Client.Interface,
  options: Parameters<typeof RelayExecutionBackend.layerFromClient>[0],
  additionalLayer: Layer.Layer<never> = Layer.empty,
) => {
  const contextLayer = Layer.merge(
    RelayExecutionBackend.layerFromClient(options).pipe(Layer.provide(Layer.succeed(Client.Service, implementation))),
    additionalLayer,
  )
  return <A, E>(effect: Effect.Effect<A, E, ExecutionBackend.Service>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(contextLayer)
      return yield* Effect.provide(effect, context)
    })
}

const provideBackend = (implementation: Client.Interface) => provideConfiguredBackend(implementation, { selection })

describe("ExecutionBackend Relay client adapter", () => {
  it.effect("adapts fan-out, workflow, child, inspection, steering, and approval operations", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient()
      const calls: Array<[string, unknown]> = []
      const fanOut = {
        fan_out_id: "fan-1",
        parent_execution_id: "execution:parent-1",
        state: "running",
        max_concurrency: 2,
        join: { _tag: "quorum", count: 1 },
        members: [
          { child_execution_id: "child:one", ordinal: 0, state: "completed", output: "done" },
          { child_execution_id: "child:two", ordinal: 1, state: "failed", error: "bad" },
        ],
      }
      const workflow = {
        execution_id: "workflow:run-1",
        pin: {
          workflow_definition_id: "rika:delivery:v1",
          workflow_definition_revision: 2,
          workflow_definition_digest: "digest",
        },
        status: "running",
        created_at: 10,
        updated_at: 20,
      }
      Object.assign(fixture.implementation.childRuns, {
        createFanOut: (input: unknown) => (calls.push(["createFanOut", input]), Effect.succeed(fanOut)),
        inspectFanOut: (input: unknown) => (calls.push(["inspectFanOut", input]), Effect.succeed({ fan_out: fanOut })),
        cancelFanOut: (input: unknown) => (calls.push(["cancelFanOut", input]), Effect.succeed({ fan_out: fanOut })),
        spawn: (input: unknown) => (calls.push(["child", input]), Effect.succeed({})),
      })
      Object.assign(fixture.implementation.workflows, {
        registerDefinition: (input: { definition: { name: string } }) =>
          Effect.succeed({
            record: { definition: input.definition, revision: 1, digest: `digest-${input.definition.name}` },
          }),
        startRun: (input: unknown) => (calls.push(["startWorkflow", input]), Effect.succeed(workflow)),
        inspectRun: (input: unknown) => (calls.push(["inspectWorkflow", input]), Effect.succeed(workflow)),
        cancelRun: (input: unknown) => (calls.push(["cancelWorkflow", input]), Effect.succeed(workflow)),
      })
      Object.assign(fixture.implementation.executions, {
        get: () =>
          Effect.succeed({
            status: "waiting",
            agent_snapshot: {
              model: { provider: "test", model: "scripted", registration_key: "fixed" },
              metadata: { rika_execution_route: currentExecutionRoute() },
            },
          }),
        inspect: () =>
          Effect.succeed({
            status: "waiting",
            last_event_cursor: "last",
            waiting_on: [{ wait_id: "wait-1", mode: "external", created_at: 1 }],
            pending_tool_calls: [
              { tool_call_id: "call-1", tool_name: "bash", input: { command: "pwd" }, requested_at: 2 },
            ],
            child_runs: [{ child_execution_id: "child:one", status: "completed" }],
          }),
        steer: (input: unknown) => (calls.push(["steer", input]), Effect.succeed({})),
      })
      Object.assign(fixture.implementation.tools, {
        listPendingApprovals: () =>
          Effect.succeed({
            approvals: [{ wait_id: "wait-1", tool_call_id: "call-1", tool_name: "bash", input: {}, requested_at: 3 }],
          }),
        resolveApproval: (input: unknown) => (calls.push(["approval", input]), Effect.succeed({})),
        resolvePermission: (input: unknown) => (calls.push(["permission", input]), Effect.succeed({})),
      })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return {
          fan: yield* createFanOut(backend, {
            fanOutId: "fan-1",
            parentTurnId: "parent-1",
            children: [
              { childId: "one", prompt: "a", profile: "Oracle" },
              { childId: "two", prompt: "b" },
            ],
            maxConcurrency: 2,
            join: "quorum",
            quorum: 1,
            createdAt: 1,
          }),
          inspectedFan: yield* backend.inspectFanOut("fan-1"),
          cancelledFan: yield* backend.cancelFanOut("fan-1", 4, "stop"),
          registrations: yield* backend.registerWorkflows(),
          startedWorkflow: yield* backend.startWorkflow("delivery", "run-1", 2),
          inspectedWorkflow: yield* backend.inspectWorkflow("run-1"),
          cancelledWorkflow: yield* backend.cancelWorkflow("run-1"),
          child: yield* backend.invokeChild({
            parentTurnId: "parent-1",
            childId: "one",
            profile: "Task",
            prompt: "work",
          }),
          inspection: yield* backend.inspect("parent-1"),
          approvals: yield* backend.listApprovals("parent-1"),
          steer: yield* backend.steer("parent-1", "continue", 5),
          approval: yield* backend.resolveToolApproval("wait-1", true, 6, "ok"),
          permission: yield* backend.resolvePermission("wait-1", "Approved", 7, "safe"),
        }
      }).pipe(provideBackend(fixture.implementation))
      expect(result.fan).toMatchObject({ fanOutId: "fan-1", parentTurnId: "parent-1", join: "quorum" })
      expect(result.fan.members).toEqual([
        { childId: "one", ordinal: 0, state: "completed", output: "done" },
        { childId: "two", ordinal: 1, state: "failed", error: "bad" },
      ])
      expect(result.registrations.map((value) => value.name)).toEqual(["delivery", "research-synthesis"])
      expect(result.startedWorkflow).toMatchObject({ runId: "run-1", workflow: "delivery", revision: 2 })
      expect(result.child).toEqual({ parentTurnId: "parent-1", childId: "one", profile: "Task", type: "accepted" })
      expect(result.inspection).toMatchObject({ status: "waiting", lastCursor: "last" })
      expect(result.approvals[0]).toMatchObject({ waitId: "wait-1", callId: "call-1" })
      expect(calls).toHaveLength(10)
    }),
  )

  it.effect("covers absent optional adapter results and payload fields", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient()
      const calls: Array<unknown> = []
      Object.assign(fixture.implementation.childRuns, {
        inspectFanOut: () => Effect.succeed({ fan_out: null }),
        cancelFanOut: (input: unknown) => {
          calls.push(input)
          return Effect.succeed({
            fan_out: {
              fan_out_id: "fan",
              parent_execution_id: "child:parent",
              state: "cancelled",
              max_concurrency: 1,
              join: { _tag: "all" },
              members: [],
            },
          })
        },
      })
      Object.assign(fixture.implementation.workflows, {
        inspectRun: () => Effect.void,
        cancelRun: () => Effect.void,
        startRun: (input: unknown) => {
          calls.push(input)
          return Effect.succeed({
            execution_id: "workflow:r",
            pin: {
              workflow_definition_id: "rika:research-synthesis:v1",
              workflow_definition_revision: 1,
              workflow_definition_digest: "d",
            },
            status: "queued",
            created_at: 1,
            updated_at: 1,
          })
        },
      })
      Object.assign(fixture.implementation.executions, { get: () => Effect.void })
      Object.assign(fixture.implementation.tools, {
        resolveApproval: (input: unknown) => (calls.push(input), Effect.succeed({})),
        resolvePermission: (input: unknown) => (calls.push(input), Effect.succeed({})),
      })
      const values = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return [
          yield* backend.inspectFanOut("missing"),
          yield* backend.cancelFanOut("fan", 1),
          yield* backend.startWorkflow("research-synthesis", "r"),
          yield* backend.inspectWorkflow("r"),
          yield* backend.cancelWorkflow("r"),
          yield* backend.inspect("missing"),
          yield* backend.resolveToolApproval("wait", false, 2),
          yield* backend.resolvePermission("wait", "Denied", 3),
        ]
      }).pipe(provideBackend(fixture.implementation))
      expect(values[0]).toBeUndefined()
      expect(values[1]).toMatchObject({ parentTurnId: "child:parent", join: "all" })
      expect(values[3]).toBeUndefined()
      expect(values[4]).toBeUndefined()
      expect(values[5]).toBeUndefined()
      expect(calls).toContainEqual({ fan_out_id: "fan", cancelled_at: 1 })
      expect(calls).toContainEqual({ wait_id: "wait", approved: false, resolved_at: 2 })
      expect(calls).toContainEqual({ wait_id: "wait", answer: "Denied", resolved_at: 3 })
    }),
  )
})

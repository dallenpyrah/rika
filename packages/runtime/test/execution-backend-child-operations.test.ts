import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { ChildFanOutHost, Client, Execution, Ids, WorkflowDefinitionHost } from "@relayfx/sdk"
import { Effect, Layer, Ref, Stream } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"
import { createFanOut } from "./current-execution-route"

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
  it.effect("covers every join payload and child-prefixed execution identifiers", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
        replayEvents: [relayEvent("model.output.delta", 1, [{ type: "text", text: "" }])],
      })
      const inputs: Array<unknown> = []
      Object.assign(fixture.implementation.childRuns, {
        createFanOut: (input: unknown) => {
          inputs.push(input)
          return Effect.succeed({
            fan_out_id: "fan",
            parent_execution_id: "execution:p",
            state: "running",
            max_concurrency: 1,
            join: { _tag: "all" },
            members: [],
          })
        },
      })
      Object.assign(fixture.implementation.executions, {
        get: () => Effect.succeed({ status: "running" }),
        inspect: () => Effect.succeed({ status: "running", waiting_on: [], pending_tool_calls: [], child_runs: [] }),
      })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        for (const join of ["all", "first-success", "best-effort"] as const) {
          yield* createFanOut(backend, {
            fanOutId: `fan-${join}`,
            parentTurnId: "p",
            children: [],
            maxConcurrency: 1,
            join,
            createdAt: 1,
          })
        }
        yield* createFanOut(backend, {
          fanOutId: "fan-quorum-default",
          parentTurnId: "p",
          children: [],
          maxConcurrency: 1,
          join: "quorum",
          createdAt: 1,
        })
        return {
          replay: yield* backend.replay("child:already-prefixed", undefined, ExecutionBackend.executionReference),
          inspection: yield* backend.inspect("p"),
        }
      }).pipe(provideBackend(fixture.implementation))
      expect(inputs).toHaveLength(4)
      expect(result.replay.events[0]).not.toHaveProperty("text")
      expect(result.inspection).not.toHaveProperty("lastCursor")
    }),
  )

  it.effect("round-trips every inspected child execution identifier through execution operations", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ cancelStatus: "cancelled" })
      const childExecutionId = Ids.ChildExecutionId.make("execution:parent:child:Review:call-review")
      Object.assign(fixture.implementation.executions, {
        get: () => Effect.succeed({ status: "running" }),
        inspect: () =>
          Effect.succeed({
            status: "running",
            waiting_on: [],
            pending_tool_calls: [],
            child_runs: [{ child_execution_id: childExecutionId, status: "running" }],
          }),
      })
      const inspectedChildId = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const inspection = yield* backend.inspect("parent")
        const childId = inspection?.children[0]?.executionId
        if (childId === undefined) return yield* Effect.die("Missing inspected child")
        yield* backend.replay(childId, undefined, ExecutionBackend.executionReference)
        if (backend.pageEvents === undefined) return yield* Effect.die("Missing event paging")
        yield* backend.pageEvents(childId, "forward", undefined, undefined, ExecutionBackend.executionReference)
        yield* backend.cancel(childId, 10, ExecutionBackend.executionReference)
        return childId
      }).pipe(provideBackend(fixture.implementation))

      expect(inspectedChildId).toBe(childExecutionId)
      expect((yield* Ref.get(fixture.replays)).map((input) => input.execution_id)).toEqual([
        childExecutionId,
        childExecutionId,
      ])
      expect((yield* Ref.get(fixture.pages)).map((input) => input.execution_id)).toEqual([childExecutionId])
      expect((yield* Ref.get(fixture.cancellations)).map((input) => input.execution_id)).toEqual([childExecutionId])
    }),
  )

  it.effect("surfaces nested child permission asks and approvals through the parent execution", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient()
      const rootExecutionId = Ids.ExecutionId.make("execution:parent")
      const childExecutionId = Ids.ChildExecutionId.make("execution:parent:child:Review:call-review")
      const spawned = {
        ...relayEvent("child_run.spawned", 1, undefined, { child_execution_id: childExecutionId }),
        execution_id: rootExecutionId,
        child_execution_id: childExecutionId,
      }
      const requested = {
        ...relayEvent("permission.ask.requested", 1, undefined, {
          wait_id: "wait-child",
          tool_call_id: "call-child",
          tool_name: "read",
        }),
        execution_id: Ids.ExecutionId.make(childExecutionId),
      }
      Object.assign(fixture.implementation.executions, {
        inspect: (id: Ids.ExecutionId) =>
          Effect.succeed(
            id === rootExecutionId
              ? {
                  status: "waiting",
                  waiting_on: [],
                  pending_tool_calls: [],
                  child_runs: [{ child_execution_id: childExecutionId, status: "waiting" }],
                }
              : {
                  status: "waiting",
                  waiting_on: [
                    {
                      wait_id: "wait-child",
                      execution_id: childExecutionId,
                      mode: "reply",
                      state: "open",
                      metadata: {},
                      created_at: 2,
                    },
                  ],
                  pending_tool_calls: [],
                  child_runs: [],
                },
          ),
        follow: (input: { readonly execution_id: Ids.ExecutionId }) =>
          Stream.fromIterable(
            (input.execution_id === rootExecutionId ? [spawned] : [requested]).map((event) => ({
              _tag: "event" as const,
              event,
            })),
          ),
      })
      Object.assign(fixture.implementation.tools, {
        listPendingApprovals: (input: { readonly execution_id: Ids.ExecutionId }) =>
          Effect.succeed({
            approvals:
              String(input.execution_id) === String(childExecutionId)
                ? [
                    {
                      wait_id: "approval-child",
                      execution_id: childExecutionId,
                      tool_call_id: "call-approval-child",
                      tool_name: "bash",
                      input: { command: "pwd" },
                      requested_at: 3,
                    },
                  ]
                : [],
          }),
      })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        if (backend.follow === undefined) return yield* Effect.die("Missing execution follow")
        return {
          followed: yield* backend.follow("parent", undefined),
          approvals: yield* backend.listApprovals("parent"),
        }
      }).pipe(provideBackend(fixture.implementation))

      expect(result.followed.status).toBe("waiting")
      expect(result.followed.events.find((event) => event.type === "permission.ask.requested")?.data).toMatchObject({
        wait_id: "wait-child",
        execution_id: childExecutionId,
      })
      expect(result.approvals).toEqual([
        {
          waitId: "approval-child",
          executionId: childExecutionId,
          callId: "call-approval-child",
          toolName: "bash",
          input: { command: "pwd" },
          requestedAt: 3,
        },
      ])
    }),
  )
})

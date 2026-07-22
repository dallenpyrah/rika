import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { ChildFanOutHost, Client, Execution, Ids, WorkflowDefinitionHost } from "@relayfx/sdk"
import { Effect, Fiber, Layer, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"
import { currentExecutionRoute, start } from "./current-execution-route"

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
  it.effect("registers compaction and permission policy options", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
      const permissionPolicy = [{ tool: "bash", action: "deny" }] as never
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const route = currentExecutionRoute()
        yield* start(backend, {
          threadId: "thread-a",
          turnId: "turn-a",
          prompt: "prompt",
          startedAt: 1,
          executionRoute: {
            ...route,
            main: {
              ...route.main,
              compaction: { contextWindow: 10_000, reserveTokens: 500, keepRecentTokens: 2_000 },
            },
          },
        })
      }).pipe(
        provideConfiguredBackend(fixture.implementation, {
          selection,
          compaction: { contextWindow: 10_000, reserveTokens: 500, keepRecentTokens: 2_000 },
          permissionPolicy,
        }),
      )
      expect((yield* Ref.get(fixture.registrations))[0]).toMatchObject({
        permission_rules: permissionPolicy,
        metadata: { steering_enabled: true },
        compaction_policy: {
          context_window: 10_000,
          reserve_tokens: 500,
          keep_recent_tokens: 2_000,
        },
      })
    }),
  )

  it.effect("resolves permission policy from the durable execution", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
      const permissionPolicy = { rules: [{ pattern: "bash", level: "deny" as const }] }
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 1 })
      }).pipe(
        provideConfiguredBackend(fixture.implementation, {
          selection,
          permissionPolicyForExecution: (executionId) =>
            executionId === "execution:turn-a"
              ? Effect.succeed(permissionPolicy)
              : Effect.fail(ExecutionBackend.BackendError.make({ message: "Unexpected execution" })),
        }),
      )
      expect((yield* Ref.get(fixture.registrations))[0]).toMatchObject({ permission_rules: permissionPolicy })
    }),
  )

  it.effect.each([
    ["execution.completed", "completed"],
    ["execution.failed", "failed"],
    ["execution.cancelled", "cancelled"],
    ["wait.created", "waiting"],
    ["model.output.delta", "running"],
  ] as const)("derives replay status %s as %s", ([type, status]) =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ replayEvents: [relayEvent(type, 1)] })
      const results = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return [yield* backend.replay("turn-a"), yield* backend.replay("turn-a", "cursor-0")]
      }).pipe(provideBackend(fixture.implementation))
      const replays = yield* Ref.get(fixture.replays)
      expect(results.map((result) => result.status)).toEqual([status, status])
      expect(replays).toEqual([
        { execution_id: "execution:turn-a" },
        { execution_id: "execution:turn-a", after_cursor: "cursor-0" },
      ])
    }),
  )

  it.effect("uses the last Relay terminal event as authority despite stale late events", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
        replayEvents: [
          relayEvent("execution.cancelled", 1),
          relayEvent("model.output.completed", 2),
          relayEvent("execution.failed", 3),
        ],
      })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* backend.replay("turn-a")
      }).pipe(provideBackend(fixture.implementation))
      expect(result.status).toBe("failed")
    }),
  )

  it.effect("pages execution events backward without using unbounded replay", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ pageEvents: [relayEvent("model.output.completed", 4)] })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        if (backend.pageEvents === undefined) return yield* Effect.die("Missing event paging")
        return yield* backend.pageEvents("turn-a", "backward", "cursor-5", 200)
      }).pipe(provideBackend(fixture.implementation))
      expect(result).toMatchObject({
        events: [{ sequence: 4, type: "model.output.completed" }],
        hasMore: true,
        oldestCursor: "oldest",
        newestCursor: "newest",
      })
      expect(yield* Ref.get(fixture.pages)).toEqual([
        {
          execution_id: "execution:turn-a",
          direction: "backward",
          before_cursor: "cursor-5",
          limit: 200,
        },
      ])
      expect(yield* Ref.get(fixture.replays)).toEqual([])
    }),
  )

  it.effect("cancels with deterministic payload and returns the accepted status and replayed events", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
        existingStatus: "running",
        cancelStatus: "queued",
        replayEvents: [relayEvent("execution.cancelled", 1)],
      })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* backend.cancel("turn-a", 50)
      }).pipe(provideBackend(fixture.implementation))
      expect(yield* Ref.get(fixture.cancellations)).toEqual([{ execution_id: "execution:turn-a", cancelled_at: 50 }])
      expect(result.status).toBe("queued")
      expect(result.events.map((value) => value.type)).toEqual(["execution.cancelled"])
    }),
  )

  it.effect("waits for a concurrently starting execution before cancelling", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
        existingStatus: "running",
        unavailableLookups: 2,
        cancelStatus: "cancelled",
        replayEvents: [relayEvent("execution.cancelled", 1)],
      })
      const cancellation = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* backend.cancel("turn-a", 50)
      }).pipe(provideBackend(fixture.implementation), Effect.forkChild)
      yield* TestClock.adjust("50 millis")
      const result = yield* Fiber.join(cancellation)
      expect(yield* Ref.get(fixture.lookups)).toEqual(["execution:turn-a", "execution:turn-a", "execution:turn-a"])
      expect(yield* Ref.get(fixture.cancellations)).toEqual([{ execution_id: "execution:turn-a", cancelled_at: 50 }])
      expect(result.status).toBe("cancelled")
    }),
  )

  it.effect.each(["start", "replay", "cancel"] as const)("maps %s client failures to BackendError", (operation) =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
        fail: operation,
        ...(operation === "cancel" ? { existingStatus: "running" as const } : {}),
      })
      const failure = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        if (operation === "start")
          return yield* Effect.flip(
            start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "p", startedAt: 1 }),
          )
        if (operation === "replay") return yield* Effect.flip(backend.replay("turn-a"))
        return yield* Effect.flip(backend.cancel("turn-a", 2))
      }).pipe(provideBackend(fixture.implementation))
      expect(failure._tag).toBe("ExecutionBackendError")
      expect(failure.message).toContain(`${operation} failed`)
    }),
  )
})

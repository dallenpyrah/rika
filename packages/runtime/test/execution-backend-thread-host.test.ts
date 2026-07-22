import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { TurnPolicy } from "@batonfx/core"
import { ChildFanOutHost, Client, Execution, Ids, WorkflowDefinitionHost } from "@relayfx/sdk"
import { Effect, Layer, Ref, Schema, Stream } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"

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
  it.effect("ensures the thread host entity and notifies it through the durable inbox", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient()
      const kinds: Array<unknown> = []
      const sent: Array<Record<string, unknown>> = []
      Object.assign(fixture.implementation.residents, {
        registerKind: (input: unknown) =>
          Effect.sync(() => {
            kinds.push(input)
            return input
          }),
        spawn: (input: { readonly key: string }) =>
          Effect.succeed({
            kind: "rika-thread",
            key: input.key,
            address_id: `address:entity:${input.key}`,
            execution_id: `execution:entity:${input.key}`,
            generation: 0,
            status: "active",
            created_at: 1,
          }),
        get: (input: { readonly key: string }) =>
          Effect.succeed({
            kind: "rika-thread",
            key: input.key,
            address_id: `address:entity:${input.key}`,
            execution_id: `execution:entity:${input.key}`,
            generation: 0,
            status: "active",
            created_at: 1,
          }),
      })
      Object.assign(fixture.implementation.executions, {
        inspect: (executionId: string) =>
          Effect.succeed({
            execution_id: executionId,
            status: "waiting",
            waiting_on: [{ wait_id: "wait:inbox:host", mode: "event", created_at: 1 }],
            pending_tool_calls: [],
            child_runs: [],
          }),
      })
      Object.assign(fixture.implementation.envelopes, {
        send: (input: Record<string, unknown>) =>
          Effect.sync(() => {
            sent.push(input)
            return { envelope_id: "envelope:notify", execution_id: `execution:entity:thread-a` }
          }),
      })
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* backend.wakeThreadHost!({ threadId: "thread-a", generation: 9, queueRevision: 12, now: 102 })
        yield* backend.wakeThreadHost!({ threadId: "thread-a", generation: 9, queueRevision: 12, now: 103 })
        yield* backend.registerTurnPromoter!(() => Effect.succeed(1))
      }).pipe(provideBackend(fixture.implementation))
      const registrations = yield* Ref.get(fixture.registrations)
      expect(registrations[0]?.id).toBe("agent:rika-thread-host")
      const registration = registrations[0]
      if (registration === undefined || !("agent" in registration)) return yield* Effect.die("Missing host agent")
      expect(registration.agent).toMatchObject({ policy: TurnPolicy.forever })
      expect(registration.max_wait_turns).toBe(1_000_000)
      expect(registration.metadata?.steering_enabled).toBe(false)
      expect(kinds).toEqual([
        {
          kind: "rika-thread",
          agent_id: "agent:rika-thread-host",
          inbox: { drain: "all" },
          state_enabled: false,
          continue_as_new_after_turns: 32,
          metadata: { product: "rika" },
        },
      ])
      expect(sent).toHaveLength(2)
      expect(sent[0]).toMatchObject({
        from: "address:rika",
        to: "address:entity:thread-a",
        idempotency_key: "rika:queue-wake:thread-a:9",
      })
      expect(
        yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
          (sent[0]!.content as Array<{ text: string }>)[0]!.text,
        ),
      ).toEqual({
        kind: "queue-ready",
        thread_id: "thread-a",
        wake_generation: 9,
        queue_revision: 12,
      })
      expect(sent[1]).toMatchObject({ idempotency_key: "rika:queue-wake:thread-a:9" })
    }),
  )

  it.effect("recreates an active thread host whose execution is terminal before get-or-create", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient()
      const calls: Array<string> = []
      const failed = {
        kind: "rika-thread",
        key: "thread-stale",
        address_id: "address:entity:thread-stale",
        execution_id: "execution:entity:thread-stale:0",
        generation: 0,
        status: "active" as const,
        created_at: 1,
      }
      const recreated = { ...failed, execution_id: "execution:entity:thread-stale:1", generation: 1 }
      Object.assign(fixture.implementation.residents, {
        registerKind: (input: unknown) => Effect.succeed(input),
        get: () => Effect.sync(() => (calls.push("get"), failed)),
        destroy: () => Effect.sync(() => (calls.push("destroy"), { ...failed, status: "destroyed" })),
        spawn: () => Effect.sync(() => (calls.push("create"), recreated)),
      })
      Object.assign(fixture.implementation.executions, {
        inspect: (executionId: string) =>
          Effect.sync(() => {
            calls.push("inspect")
            return {
              execution_id: executionId,
              status: executionId === failed.execution_id ? "failed" : "waiting",
              waiting_on:
                executionId === failed.execution_id ? [] : [{ wait_id: "wait:host", mode: "event", created_at: 1 }],
              pending_tool_calls: [],
              child_runs: [],
            }
          }),
      })
      Object.assign(fixture.implementation.envelopes, {
        send: () => Effect.succeed({ envelope_id: "envelope:wake", execution_id: recreated.execution_id }),
      })

      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* backend.wakeThreadHost!({ threadId: "thread-stale", generation: 1, queueRevision: 1, now: 100 })
      }).pipe(provideBackend(fixture.implementation))

      expect(calls).toEqual(["get", "inspect", "destroy", "create", "inspect"])
    }),
  )
})

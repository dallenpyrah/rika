import { describe, expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { vi } from "vitest"
import { ModelResilience } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import { ChildFanOutHost, Client, Content, Execution, Ids, WorkflowDefinitionHost } from "@relayfx/sdk"
import { Effect, Layer, Ref, Schedule, Stream } from "effect"
import { Toolkit } from "effect/unstable/ai"
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

describe("ExecutionBackend Relay client adapter", () => {
  it.effect("constructs the public runtime layer lazily", () =>
    Effect.gen(function* () {
      const model = yield* TestModel.make([])
      expect(
        RelayExecutionBackend.layer({
          filename: ":memory:",
          workspace: "/tmp",
          registration: model.registration,
          selection: model.selection,
        }),
      ).toBeDefined()
    }),
  )

  it.effect.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const)(
    "builds the runtime layer with resilience=%s and extension handlers=%s",
    ([resilience, extensions]: readonly [boolean, boolean]) =>
      Effect.gen(function* () {
        const model = yield* TestModel.make([])
        const fixture = yield* makeClient({
          replayEvents: [
            relayEvent("model.output.completed", 1, [Content.text("fallback")]),
            relayEvent("execution.completed", 2, [Content.text("done")]),
          ],
          streamEvents: [
            relayEvent("model.output.completed", 1, [Content.text("fallback")]),
            relayEvent("execution.completed", 2, [Content.text("done")]),
          ],
        })
        Object.assign(fixture.implementation.executions, { get: () => Effect.succeed({ status: "completed" }) })
        Object.assign(fixture.implementation.childRuns, {
          spawn: () => Effect.succeed({}),
          createFanOut: (definition: unknown) => Effect.succeed(definition),
          inspectFanOut: () => Effect.succeed({ fan_out: null }),
        })
        native.client = fixture.implementation
        native.databaseAcquisitions = 0
        native.runtimeGraphs = 0
        const result = yield* RelayExecutionBackend.layer({
          filename: ":memory:",
          workspace: "/tmp",
          registration: model.registration,
          selection: model.selection,
          ...(resilience ? { modelResilience: ModelResilience.make({ retrySchedule: Schedule.recurs(0) }) } : {}),
          ...(extensions ? { additionalToolkit: Toolkit.make(), additionalHandlerLayer: Layer.empty } : {}),
        }).pipe(Layer.provide(BunServices.layer), Layer.build, Effect.exit)
        expect(result._tag).toBe("Success")
        expect(native.databaseAcquisitions).toBe(1)
        expect(native.runtimeGraphs).toBe(1)
      }),
  )

  it.effect("does not start fan-out children while assembling the runtime", () =>
    Effect.gen(function* () {
      const model = yield* TestModel.make([])
      const fixture = yield* makeClient({
        replayEvents: [
          relayEvent("model.output.completed", 1, [Content.text("fallback")]),
          relayEvent("execution.completed", 2, [Content.text("done")]),
        ],
        streamEvents: [
          relayEvent("model.output.completed", 1, [Content.text("fallback")]),
          relayEvent("execution.completed", 2, [Content.text("done")]),
        ],
      })
      Object.assign(fixture.implementation.executions, { get: () => Effect.succeed({ status: "completed" }) })
      Object.assign(fixture.implementation.childRuns, {
        spawn: () => Effect.succeed({}),
        createFanOut: (definition: unknown) => Effect.succeed(definition),
        inspectFanOut: () => Effect.succeed({ fan_out: null }),
      })
      native.client = fixture.implementation
      yield* RelayExecutionBackend.layer({
        filename: ":memory:",
        workspace: "/tmp",
        registration: model.registration,
        selection: model.selection,
      }).pipe(Layer.provide(BunServices.layer), Layer.build)
      const registrations = yield* Ref.get(fixture.registrations)
      const starts = yield* Ref.get(fixture.starts)
      expect(registrations).toEqual([])
      expect(starts).toEqual([])
    }),
  )
})

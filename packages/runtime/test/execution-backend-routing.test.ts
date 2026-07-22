import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { ChildFanOutHost, Client, Content, Execution, Ids, WorkflowDefinitionHost } from "@relayfx/sdk"
import { Effect, Layer, Ref, Stream } from "effect"
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
  it.effect.each(["execution.completed", "execution.failed", "execution.cancelled"] as const)(
    "terminates the start stream at %s",
    (type) =>
      Effect.gen(function* () {
        const fixture = yield* makeClient({ streamEvents: [relayEvent(type, 1), relayEvent("model.output.delta", 2)] })
        const result = yield* Effect.gen(function* () {
          const backend = yield* ExecutionBackend.Service
          return yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 1 })
        }).pipe(provideBackend(fixture.implementation))
        expect(result.events.map((value) => value.type)).toEqual([type])
      }),
  )

  it.effect("projects opaque Relay failure detail without discarding event data", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
        streamEvents: [
          relayEvent("execution.failed", 1, [], {
            message: "opaque provider failure",
            diagnostic: { retained: true },
          }),
        ],
      })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 1 })
      }).pipe(provideBackend(fixture.implementation))

      expect(result.events[0]).toMatchObject({
        type: "execution.failed",
        text: "opaque provider failure",
        data: { message: "opaque provider failure", diagnostic: { retained: true } },
      })
    }),
  )

  it.effect("prefers terminal failure content over Relay failure metadata", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
        streamEvents: [
          relayEvent("execution.failed", 1, [Content.text("content failure")], { message: "metadata failure" }),
        ],
      })
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 1 })
      }).pipe(provideBackend(fixture.implementation))

      expect(result.events[0]?.text).toBe("content failure")
    }),
  )

  it.effect.each(["queued", "running"] as const)(
    "derives terminal completion after Relay starts with status %s",
    (status) =>
      Effect.gen(function* () {
        const fixture = yield* makeClient({ startStatus: status, streamEvents: [relayEvent("execution.completed", 1)] })
        const result = yield* Effect.gen(function* () {
          const backend = yield* ExecutionBackend.Service
          return yield* start(backend, { threadId: "thread-a", turnId: "turn-a", prompt: "prompt", startedAt: 1 })
        }).pipe(provideBackend(fixture.implementation))
        expect(result.status).toBe("completed")
      }),
  )

  it.effect.each(["queued", "running"] as const)(
    "returns waiting when a %s execution reaches either actionable request",
    (startStatus) =>
      Effect.forEach(["permission.ask.requested", "tool.approval.requested"] as const, (actionableType) =>
        Effect.gen(function* () {
          const fixture = yield* makeClient({
            startStatus,
            streamEvents: [
              relayEvent("model.output.delta", 1),
              relayEvent(actionableType, 2, undefined, { wait_id: "wait:actionable" }),
            ],
            openWaitIds: ["wait:actionable"],
          })
          const seen: Array<string> = []
          const result = yield* Effect.gen(function* () {
            const backend = yield* ExecutionBackend.Service
            return yield* start(backend, {
              threadId: "thread-a",
              turnId: "turn-a",
              prompt: "prompt",
              startedAt: 1,
              onEvent: (item) => seen.push(item.type),
            })
          }).pipe(provideBackend(fixture.implementation))
          expect(result.status).toBe("waiting")
          expect(result.events.map((value) => value.type)).toEqual(["model.output.delta", actionableType])
          expect(seen).toEqual(["model.output.delta", actionableType])
        }),
      ),
  )

  it.effect.each(["completed", "failed", "cancelled"] as const)(
    "streams terminal executions started with status %s so events arrive incrementally",
    (status) =>
      Effect.gen(function* () {
        const fixture = yield* makeClient({
          startStatus: status,
          streamEvents: [
            relayEvent("model.output.delta", 1),
            relayEvent(`execution.${status}` as Execution.ExecutionEvent["type"], 2),
          ],
        })
        const seen: Array<string> = []
        const result = yield* Effect.gen(function* () {
          const backend = yield* ExecutionBackend.Service
          return yield* start(backend, {
            threadId: "thread-a",
            turnId: "turn-a",
            prompt: "prompt",
            startedAt: 1,
            onEvent: (item) => seen.push(item.type),
          })
        }).pipe(provideBackend(fixture.implementation))
        expect(result.status).toBe(status)
        expect(result.events.map((value) => value.type)).toEqual(["model.output.delta", `execution.${status}`])
        expect(seen).toEqual(["model.output.delta", `execution.${status}`])
      }),
  )

  it.effect("uses the pinned current route instead of reselecting at start", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* start(backend, {
          threadId: "thread-variant",
          turnId: "turn-variant",
          prompt: "prompt",
          startedAt: 1,
          executionRoute: {
            ...currentExecutionRoute(),
            main: {
              ...currentExecutionRoute().main,
              effort: "xhigh",
              fast: true,
              registrationKey: "effort:xhigh:fast",
            },
          },
          reasoningEffort: "xhigh",
          fastMode: true,
        })
      }).pipe(provideBackend(fixture.implementation))
      const registered = (yield* Ref.get(fixture.registrations)).at(-1) as
        | { agent?: { model?: { registrationKey?: string } } }
        | undefined
      expect(registered?.agent?.model?.registrationKey).toBe("effort:xhigh:fast")
      expect(RelayExecutionBackend.modelVariantKey("high", false)).toBe("effort:high")
    }),
  )

  it.effect("retains a fixed model selection when variants are unsupported", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* start(backend, {
          threadId: "thread-fixed",
          turnId: "turn-fixed",
          prompt: "prompt",
          startedAt: 1,
          reasoningEffort: "xhigh",
          fastMode: true,
        })
      }).pipe(
        provideConfiguredBackend(fixture.implementation, {
          selection,
          modelVariantPolicy: "fixed-selection",
        }),
      )
      const registered = (yield* Ref.get(fixture.registrations)).at(-1) as
        | { agent?: { model?: { registrationKey?: string } } }
        | undefined
      expect(registered?.agent?.model).toEqual(selection)
      expect(registered?.agent?.model?.registrationKey).toBeUndefined()
    }),
  )
})

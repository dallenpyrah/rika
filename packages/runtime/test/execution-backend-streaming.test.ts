import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { ChildFanOutHost, Client, Content, Execution, Ids, WorkflowDefinitionHost } from "@relayfx/sdk"
import { Deferred, Effect, Exit, Fiber, Layer, Logger, Ref, Schema, Stream, Tracer } from "effect"
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
  it.effect("keeps large execution results out of completed tracing spans", () =>
    Effect.gen(function* () {
      const streamEvents = [
        ...Array.from({ length: 4_000 }, (_, index) =>
          relayEvent("model.output.delta", index + 1, [Content.text(`chunk-${index}`)]),
        ),
        relayEvent("execution.completed", 4_001),
      ]
      const fixture = yield* makeClient({ streamEvents })
      const spans: Array<Tracer.NativeSpan> = []
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const results = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const started = yield* start(backend, {
          threadId: "thread-a",
          turnId: "turn-a",
          prompt: "prompt",
          startedAt: 1,
        })
        const followed = yield* backend.follow!("turn-a", undefined)
        return { started, followed }
      }).pipe(provideBackend(fixture.implementation), Effect.withTracer(tracer))
      expect(results.started.events).toHaveLength(4_001)
      expect(results.followed.events).toHaveLength(4_001)
      for (const name of ["ExecutionBackend.start", "ExecutionBackend.follow"]) {
        const span = spans.find((candidate) => candidate.name === name)
        expect(span?.status._tag).toBe("Ended")
        if (span?.status._tag !== "Ended") continue
        expect(Exit.isSuccess(span.status.exit)).toBe(true)
        if (!Exit.isSuccess(span.status.exit)) continue
        expect(typeof span.status.exit.value).toBe("undefined")
      }
    }),
  )

  it.effect("follows execution events while the durable start call is still running", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const running = relayEvent("tool.call.requested", 1, [], { tool_name: "bash", input: "sleep 20" })
      const completed = relayEvent("execution.completed", 2)
      const implementation: Client.Interface = {
        ...fixture.implementation,
        executions: {
          ...fixture.implementation.executions,
          startByAgentDefinition: (input) =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ execution_id: input.execution_id!, status: "completed" as const }),
            ),
          get: () =>
            Deferred.isDone(started).pipe(
              Effect.map((visible) =>
                visible
                  ? {
                      id: Ids.ExecutionId.make("execution:turn-a"),
                      root_address_id: Ids.AddressId.make("address:rika"),
                      status: "running" as const,
                      created_at: 1,
                      updated_at: 1,
                    }
                  : undefined,
              ),
            ),
          follow: () =>
            Stream.concat(
              Stream.fromEffect(Deferred.await(started).pipe(Effect.as({ _tag: "event" as const, event: running }))),
              Stream.fromEffect(Deferred.await(release).pipe(Effect.as({ _tag: "event" as const, event: completed }))),
            ),
        },
      }
      const seen: Array<string> = []
      const result = yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        return yield* Effect.forkChild(
          start(backend, {
            threadId: "thread-a",
            turnId: "turn-a",
            prompt: "prompt",
            startedAt: 1,
            onEvent: (event) => seen.push(event.type),
          }),
        )
      }).pipe(provideBackend(implementation))
      yield* Effect.whileLoop({
        while: () => seen.length === 0,
        body: () => Effect.yieldNow,
        step: () => undefined,
      })
      expect(seen).toEqual(["tool.call.requested"])
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(result)).events.map((event) => event.type)).toEqual([
        "tool.call.requested",
        "execution.completed",
      ])
    }),
  )

  it.effect("emits safe correlated execution breadcrumbs without payloads", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({
        streamEvents: [
          relayEvent("tool.call.requested", 1, [Content.text("SECRET_CONTENT")], { input: "SECRET_DATA" }),
          relayEvent("tool.result.received", 2, [Content.text("SECRET_RESULT")]),
          relayEvent("execution.completed", 3),
        ],
      })
      const lines: Array<string> = []
      const logger = Logger.make((options) => lines.push(Logger.formatJson.log(options)))
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* start(backend, {
          threadId: "thread-observed",
          turnId: "turn-observed",
          prompt: "SECRET_PROMPT",
          startedAt: 1,
        })
      }).pipe(provideConfiguredBackend(fixture.implementation, { selection }, Logger.layer([logger])))
      const records = yield* Effect.forEach(lines, (line) =>
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({ message: Schema.String, annotations: Schema.Record(Schema.String, Schema.Unknown) }),
          ),
        )(line),
      )
      expect(records.map((record) => record.message)).toEqual([
        "execution.starting",
        "execution.accepted",
        "execution.follow.started",
        "execution.event.received",
        "execution.event.received",
        "execution.event.received",
        "execution.follow.completed",
      ])
      expect(records.find((record) => record.message === "execution.event.received")?.annotations).toMatchObject({
        "rika.execution.id": "execution:turn-observed",
        "rika.turn.id": "turn-observed",
        "rika.event.type": "tool.call.requested",
      })
      expect(lines.join("\n")).not.toContain("SECRET_")
    }),
  )

  it.effect("sends ordered image content to Relay and Baton", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        yield* start(backend, {
          threadId: "thread-image",
          turnId: "turn-image",
          prompt: "before [Image 1] after",
          promptParts: [
            { type: "text", text: "before " },
            { type: "image", mediaType: "image/png", data: "cG5n", filename: "shot.png" },
            { type: "text", text: " after" },
          ],
          startedAt: 1,
        })
      }).pipe(provideBackend(fixture.implementation))
      expect((yield* Ref.get(fixture.starts))[0]?.input).toEqual([
        Content.text("before "),
        { type: "blob-reference", uri: "data:image/png;base64,cG5n", media_type: "image/png", filename: "shot.png" },
        Content.text(" after"),
      ])
    }),
  )
})

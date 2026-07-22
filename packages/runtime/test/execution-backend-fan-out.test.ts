import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { ChildFanOutHost, Client, Execution, Ids, WorkflowDefinitionHost } from "@relayfx/sdk"
import { Effect, Layer, Redacted, Ref, Stream } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"
import { createFanOut, start } from "./current-execution-route"

const MockEffect = vi.hoisted(() => (require("effect") as typeof import("effect")).Effect)

const native = vi.hoisted(() => ({
  client: undefined as Client.Interface | undefined,
  databaseAcquisitions: 0,
  runtimeGraphs: 0,
}))

const routeFor = (
  role: "main" | "oracle" | "compaction" | "librarian" | "painter" | "review" | "readThread" | "task",
  model: { readonly provider: string; readonly model: string; readonly registrationKey?: string },
  compaction: { readonly contextWindow: number; readonly reserveTokens: number; readonly keepRecentTokens: number },
) => ({
  role,
  alias: role,
  ...model,
  registrationKey: model.registrationKey ?? "default",
  providerProtocol: "test" as const,
  providerBaseUrl: "test://model",
  effort: "medium",
  fast: false,
  requestVariant: "test",
  compaction,
})

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

describe("ExecutionBackend Relay client adapter", () => {
  it.effect("durably carries workspace, route, token budget, and compaction through fan-out", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClient({ streamEvents: [relayEvent("execution.completed", 1)] })
      const fanOutInputs: Array<any> = []
      Object.assign(fixture.implementation.childRuns, {
        createFanOut: (input: any) => {
          fanOutInputs.push(input)
          return Effect.succeed({
            fan_out_id: input.fan_out_id,
            parent_execution_id: input.parent_execution_id,
            state: "running",
            max_concurrency: input.max_concurrency,
            join: input.join,
            members: [],
          })
        },
      })
      const oracleSelection = {
        provider: "oracle-provider",
        model: "oracle-model",
        registrationKey: "sol:high:normal",
      }
      const taskSelection = {
        provider: "task-provider",
        model: "task-model",
        registrationKey: "terra:medium:normal",
      }
      const summarySelection = {
        provider: "summary-provider",
        model: "summary-model",
        registrationKey: "terra:low:normal",
      }
      const mainCompaction = { contextWindow: 372_000, reserveTokens: 128_000, keepRecentTokens: 32_000 }
      const oracleCompaction = { contextWindow: 1_000_000, reserveTokens: 128_000, keepRecentTokens: 64_000 }
      yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const route = {
          mode: "test" as const,
          compactionSummary: routeFor("compaction", summarySelection, mainCompaction),
          main: routeFor("main", selection, mainCompaction),
          oracle: routeFor("oracle", oracleSelection, oracleCompaction),
          agents: {
            librarian: routeFor("librarian", selection, mainCompaction),
            painter: routeFor("painter", selection, mainCompaction),
            review: routeFor("review", selection, mainCompaction),
            readThread: routeFor("readThread", selection, mainCompaction),
            task: routeFor("task", taskSelection, mainCompaction),
          },
        }
        yield* start(backend, {
          threadId: "thread",
          turnId: "other-turn",
          prompt: "prompt",
          startedAt: 1,
          executionRoute: route,
        })
        yield* createFanOut(backend, {
          fanOutId: "fan",
          parentTurnId: "turn",
          workspace: "/client/workspace",
          executionRoute: route,
          children: [
            { childId: "oracle", profile: "Oracle", prompt: "inspect" },
            { childId: "task", profile: "Task", prompt: "work" },
          ],
          maxConcurrency: 2,
          join: "all",
          createdAt: 2,
        })
      }).pipe(
        provideConfiguredBackend(fixture.implementation, {
          selection,
          oracleSelection,
          compaction: mainCompaction,
          oracleCompaction,
          resolveWorkspace: (execution) => Effect.succeed(execution.includes("other-turn") ? "/configured" : "/plain"),
          webSearchCredentialsForWorkspace: (workspace) =>
            Effect.succeed(workspace === "/configured" ? { parallel: Redacted.make("secret") } : {}),
        }),
      )
      const registered = (yield* Ref.get(fixture.registrations)).at(-1) as any
      expect(registered.agent.model).toEqual({ ...selection, registrationKey: "default" })
      expect(registered.compaction_policy).toEqual({
        context_window: 372_000,
        reserve_tokens: 128_000,
        keep_recent_tokens: 32_000,
        summary_model: {
          provider: "summary-provider",
          model: "summary-model",
          registration_key: "terra:low:normal",
        },
      })
      expect(registered.child_run_presets.Task).toMatchObject({
        model: {
          provider: selection.provider,
          model: selection.model,
          registration_key: "default",
          metadata: { rika_agent_depth: 1, rika_reasoning_effort: "medium" },
        },
        metadata: { product_profile: "Task", rika_agent_depth: 1, rika_reasoning_effort: "medium" },
      })
      expect(registered.child_run_presets.Task.tool_names).toContain("web_search")
      expect(registered.child_run_presets.Oracle).toMatchObject({
        model: {
          provider: oracleSelection.provider,
          model: oracleSelection.model,
          registration_key: oracleSelection.registrationKey,
          metadata: { rika_agent_depth: 1, rika_reasoning_effort: "medium" },
        },
      })
      const oraclePolicy = {
        context_window: 1_000_000,
        reserve_tokens: 128_000,
        keep_recent_tokens: 64_000,
        summary_model: {
          provider: "summary-provider",
          model: "summary-model",
          registration_key: "terra:low:normal",
        },
      }
      expect(fanOutInputs[0].children[0].override.model).toMatchObject({
        provider: oracleSelection.provider,
        model: oracleSelection.model,
        registration_key: oracleSelection.registrationKey,
        metadata: { rika_agent_depth: 1, rika_reasoning_effort: "medium" },
      })
      expect(fanOutInputs[0].children[0].override.compaction_policy).toEqual(oraclePolicy)
      expect(fanOutInputs[0].children[0].override.tool_names).not.toContain("web_search")
      expect(fanOutInputs[0].children[0].override.tool_names).not.toContain("read_web_page")
      expect(fanOutInputs[0].children[1].override.model).toMatchObject({
        provider: taskSelection.provider,
        model: taskSelection.model,
        registration_key: taskSelection.registrationKey,
        metadata: { rika_agent_depth: 1, rika_reasoning_effort: "medium" },
      })
      expect(fanOutInputs[0].children[1].override.compaction_policy).toEqual(registered.compaction_policy)
      expect(fanOutInputs[0].children[0].metadata).toMatchObject({
        rika_workspace: "/client/workspace",
      })
      expect(fanOutInputs[0].children[0].metadata.rika_execution_route).toEqual({
        mode: "test",
        compactionSummary: routeFor("compaction", summarySelection, mainCompaction),
        main: routeFor("main", selection, mainCompaction),
        oracle: routeFor("oracle", oracleSelection, oracleCompaction),
        agents: {
          librarian: routeFor("librarian", selection, mainCompaction),
          painter: routeFor("painter", selection, mainCompaction),
          review: routeFor("review", selection, mainCompaction),
          readThread: routeFor("readThread", selection, mainCompaction),
          task: routeFor("task", taskSelection, mainCompaction),
        },
      })
    }),
  )

  it("gates web tools by configured provider credentials", () => {
    const unavailable = RelayExecutionBackend.toolkitFor({})
    expect(Object.keys(unavailable.tools)).not.toContain("web_search")
    expect(Object.keys(unavailable.tools)).not.toContain("read_web_page")

    const unsupported = RelayExecutionBackend.toolkitFor({
      webSearchCredentials: { custom: Redacted.make("custom") },
    })
    expect(Object.keys(unsupported.tools)).not.toContain("web_search")

    const exa = RelayExecutionBackend.toolkitFor({
      webSearchCredentials: { exa: Redacted.make("exa") },
    })
    expect(Object.keys(exa.tools)).toContain("web_search")
    expect(Object.keys(exa.tools)).not.toContain("read_web_page")

    const parallel = RelayExecutionBackend.toolkitFor({
      webSearchCredentials: { parallel: Redacted.make("parallel") },
    })
    expect(Object.keys(parallel.tools)).toContain("web_search")
    expect(Object.keys(parallel.tools)).toContain("read_web_page")
  })

  it("composes supported provider factories and reports unknown IDs", () => {
    const configured = RelayExecutionBackend.webSearchFactories({
      exa: Redacted.make("exa"),
      github: Redacted.make("github"),
      custom: Redacted.make("custom"),
    })
    expect(configured.factories).toHaveLength(2)
    expect(configured.unsupportedIds).toEqual(["custom"])
  })
})

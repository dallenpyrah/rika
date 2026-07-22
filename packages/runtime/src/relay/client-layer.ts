import { Agent, ModelRegistry, type Permissions, TurnPolicy } from "@batonfx/core"
import { Client, Content, Ids } from "@relayfx/sdk"
import { Clock, Effect, Fiber, Layer, Option, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { type AgentProfile, BackendError, Service, Status } from "../execution-contract"
import { mainInstructions, parentPermissions, presets, resolve } from "../agent-profiles"
import * as ThreadHost from "../thread-host"
import { definitions, idFor } from "../workflow-definitions"
import { childExecutionDepth, toolsAtDepth } from "../agent-depth"
import { resolveSpawnModel } from "../agent-model"
import { internal as optionsInternal, failureKind, pinnedSelection, toolkitFor } from "./options"
import type { LayerOptions } from "./options"
import {
  internal as codec,
  agentId,
  addressId,
  executionRouteFromMetadata,
  sessionId,
  error,
  executionInput,
  mapFanOut,
  workflow,
  event,
  statusFromEvents,
} from "./execution-codec"
import { internal as executionFollow } from "./execution-follow"
import { makeThreadHostResident } from "./thread-host-resident"
const { followExecution } = executionFollow
const { compactionPolicy, pinnedCompactionPolicy, availableTools, variantSelection } = optionsInternal
const {
  executionId,
  awaitExecutionAvailable,
  makeChildExecutionId,
  routeForProfile,
  routeForSelection,
  workflowExecutionId,
  executionTreeIds,
  traceWithoutResult,
} = codec
export const layerFromClient = <AdditionalTools extends Record<string, Tool.Any> = {}>(
  options: Pick<
    LayerOptions<AdditionalTools>,
    | "selection"
    | "oracleSelection"
    | "compactionSummarySelection"
    | "additionalToolkit"
    | "compaction"
    | "oracleCompaction"
    | "permissionPolicy"
    | "permissionPolicyForExecution"
    | "defaultReasoningEffort"
    | "modelVariantPolicy"
  > & {
    readonly workspace?: string
    readonly resolveWorkspace?: LayerOptions["resolveWorkspace"]
    readonly webSearchCredentials?: LayerOptions["webSearchCredentials"]
    readonly webSearchCredentialsForWorkspace?: LayerOptions["webSearchCredentialsForWorkspace"]
    readonly registerModels?: (registrations: ReadonlyArray<ModelRegistry.Registration>) => Effect.Effect<void>
    readonly onClientReady?: (client: Client.Interface) => Effect.Effect<void>
  },
) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const client = yield* Client.Service
      if (options.onClientReady !== undefined) yield* options.onClientReady(client)
      const permissionPolicyFor = (execution: string) =>
        options.permissionPolicyForExecution === undefined
          ? Effect.succeed(options.permissionPolicy)
          : options
              .permissionPolicyForExecution(execution)
              .pipe(Effect.map((policy) => policy as Permissions.Ruleset | undefined))
      const toolOptionsForExecution = (execution: string) =>
        Effect.gen(function* () {
          const workspace =
            options.resolveWorkspace === undefined
              ? (options.workspace ?? "")
              : yield* options.resolveWorkspace(execution)
          const credentials =
            options.webSearchCredentialsForWorkspace === undefined
              ? options.webSearchCredentials
              : yield* options.webSearchCredentialsForWorkspace(workspace)
          return { ...options, webSearchCredentials: credentials ?? {} }
        })
      const registry =
        Option.getOrUndefined(yield* Effect.serviceOption(ThreadHost.Registry)) ?? (yield* ThreadHost.makeRegistry)
      const wakeThreadHost = yield* makeThreadHostResident(client)
      return Service.of({
        ...(options.registerModels === undefined ? {} : { registerModels: options.registerModels }),
        wakeThreadHost,
        registerTurnPromoter: (promoter) => registry.register(promoter),
        createFanOut: Effect.fn("ExecutionBackend.createFanOut")((input) =>
          Effect.gen(function* () {
            const routePin = input.executionRoute
            const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(routePin)
            const summaryModel = routePin?.compactionSummary
            const parentExecutionId = executionId(input.parentTurnId)
            const depth = childExecutionDepth(String(parentExecutionId)) + 1
            const executionToolOptions = yield* toolOptionsForExecution(String(parentExecutionId))
            const children = yield* Effect.forEach(input.children, (child) => {
              const profile = child.profile ?? "Task"
              const profileRoute =
                options.modelVariantPolicy === "fixed-selection" ? undefined : routeForProfile(routePin, profile)
              const inherited =
                options.modelVariantPolicy === "fixed-selection" ? options.selection : pinnedSelection(routePin.main)
              const requested =
                child.model === undefined ? undefined : resolveSpawnModel(routePin, inherited, child.model)
              if (child.model !== undefined && requested === undefined)
                return Effect.fail(BackendError.make({ message: `Model ${child.model} is not available` }))
              const selected =
                requested?.selection ??
                (profileRoute === undefined
                  ? profile === "Oracle"
                    ? (options.oracleSelection ?? options.selection)
                    : options.selection
                  : pinnedSelection(profileRoute))
              const selectedRoute = requested === undefined ? profileRoute : routeForSelection(routePin, selected)
              const preset = resolve(profile, selected).preset
              const policy =
                selectedRoute === undefined
                  ? compactionPolicy(
                      profile === "Oracle" ? (options.oracleCompaction ?? options.compaction) : options.compaction,
                      options.compactionSummarySelection,
                    )
                  : pinnedCompactionPolicy(selectedRoute, summaryModel)
              const effort = requested?.effort ?? selectedRoute?.effort ?? routePin.main.effort
              return Effect.succeed({
                child_execution_id: makeChildExecutionId(input.parentTurnId, child.childId),
                address_id: addressId,
                input: [Content.text(child.prompt)],
                override: {
                  ...preset,
                  model: {
                    ...preset.model,
                    metadata: {
                      rika_execution_route: durableRoute,
                      rika_agent_depth: depth,
                      rika_reasoning_effort: effort,
                    },
                  },
                  tool_names: availableTools(executionToolOptions, toolsAtDepth(preset.tool_names, depth)),
                  ...(policy === undefined ? {} : { compaction_policy: policy }),
                },
                metadata: {
                  product_profile: profile,
                  steering_enabled: true,
                  rika_agent_depth: depth,
                  rika_reasoning_effort: effort,
                  ...(input.workspace === undefined ? {} : { rika_workspace: input.workspace }),
                  rika_execution_route: durableRoute,
                },
              })
            })
            const state = yield* client.childRuns.createFanOut({
              fan_out_id: Ids.ChildFanOutId.make(input.fanOutId),
              parent_execution_id: parentExecutionId,
              children,
              max_concurrency: input.maxConcurrency,
              join:
                input.join === "quorum"
                  ? { _tag: "quorum", count: input.quorum ?? input.children.length }
                  : { _tag: input.join },
              created_at: input.createdAt,
            })
            return mapFanOut(state)
          }).pipe(Effect.mapError(error)),
        ),
        inspectFanOut: Effect.fn("ExecutionBackend.inspectFanOut")(function* (fanOutId) {
          const result = yield* client.childRuns
            .inspectFanOut({ fan_out_id: Ids.ChildFanOutId.make(fanOutId) })
            .pipe(Effect.mapError(error))
          return result.fan_out === null ? undefined : mapFanOut(result.fan_out)
        }),
        cancelFanOut: Effect.fn("ExecutionBackend.cancelFanOut")(function* (fanOutId, cancelledAt, reason) {
          const result = yield* client.childRuns
            .cancelFanOut({
              fan_out_id: Ids.ChildFanOutId.make(fanOutId),
              cancelled_at: cancelledAt,
              ...(reason === undefined ? {} : { reason }),
            })
            .pipe(Effect.mapError(error))
          return mapFanOut(result.fan_out)
        }),
        registerWorkflows: Effect.fn("ExecutionBackend.registerWorkflows")(function* () {
          return yield* Effect.forEach(definitions, (definition) => client.workflows.registerDefinition(definition), {
            concurrency: 1,
          }).pipe(
            Effect.map((records) =>
              records.map(({ record }) => ({
                name: record.definition.name,
                revision: record.revision,
                digest: record.digest,
              })),
            ),
            Effect.mapError(error),
          )
        }),
        startWorkflow: Effect.fn("ExecutionBackend.startWorkflow")(
          function* (name, runId, revision, ownerTurnId, workspace) {
            const result = yield* client.workflows
              .startRun({
                execution_id: workflowExecutionId(runId, ownerTurnId, workspace),
                workflow_definition_id: idFor(name),
                ...(revision === undefined ? {} : { revision }),
              })
              .pipe(Effect.mapError(error))
            return workflow(result)
          },
        ),
        inspectWorkflow: Effect.fn("ExecutionBackend.inspectWorkflow")(function* (runId, ownerTurnId, workspace) {
          const result = yield* client.workflows
            .inspectRun(workflowExecutionId(runId, ownerTurnId, workspace))
            .pipe(Effect.mapError(error))
          return result === undefined ? undefined : workflow(result)
        }),
        cancelWorkflow: Effect.fn("ExecutionBackend.cancelWorkflow")(function* (runId, ownerTurnId, workspace) {
          const result = yield* client.workflows
            .cancelRun(workflowExecutionId(runId, ownerTurnId, workspace))
            .pipe(Effect.mapError(error))
          return result === undefined ? undefined : workflow(result)
        }),
        invokeChild: Effect.fn("ExecutionBackend.invokeChild")(function* (input) {
          const parentExecutionId = executionId(input.parentTurnId)
          const parent = yield* client.executions.get(parentExecutionId).pipe(Effect.mapError(error))
          const routePin = executionRouteFromMetadata(parent?.agent_snapshot?.metadata)
          if (parent?.agent_snapshot === undefined || routePin === undefined)
            return yield* BackendError.make({ message: `Execution ${input.parentTurnId} has no pinned model route` })
          const route = routeForProfile(routePin, input.profile)
          const preset = resolve(input.profile, pinnedSelection(route)).preset
          const depth = childExecutionDepth(String(parentExecutionId)) + 1
          const executionToolOptions = yield* toolOptionsForExecution(String(parentExecutionId))
          const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(routePin).pipe(Effect.mapError(error))
          yield* client.childRuns
            .spawn({
              execution_id: parentExecutionId,
              child_execution_id: makeChildExecutionId(input.parentTurnId, input.childId),
              address_id: addressId,
              input: [Content.text(input.prompt)],
              instructions: preset.instructions,
              model: {
                ...preset.model,
                metadata: {
                  rika_execution_route: durableRoute,
                  rika_agent_depth: depth,
                  rika_reasoning_effort: route.effort,
                },
              },
              tool_names: availableTools(executionToolOptions, toolsAtDepth(preset.tool_names, depth)),
              permissions: preset.permissions,
              compaction_policy: pinnedCompactionPolicy(route, routePin.compactionSummary),
              metadata: {
                product_profile: input.profile,
                steering_enabled: true,
                rika_agent_depth: depth,
                rika_reasoning_effort: route.effort,
                rika_execution_route: durableRoute,
              },
              wait: false,
            })
            .pipe(Effect.mapError(error))
          return {
            parentTurnId: input.parentTurnId,
            childId: input.childId,
            profile: input.profile,
            type: "accepted" as const,
          }
        }),
        start: Effect.fn(
          function* (input) {
            return yield* Effect.gen(function* () {
              const startedAt = yield* Clock.currentTimeMillis
              const id = executionId(input.turnId)
              const permissionPolicy = yield* permissionPolicyFor(String(id))
              const executionToolOptions = yield* toolOptionsForExecution(String(id))
              const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(input.executionRoute)
              const metadata = {
                steering_enabled: true,
                rika_execution_id: String(id),
                rika_agent_depth: 0,
                rika_reasoning_effort: input.reasoningEffort ?? input.executionRoute.main.effort,
                rika_execution_route: durableRoute,
              }
              const rootCompaction =
                options.modelVariantPolicy === "fixed-selection"
                  ? compactionPolicy(options.compaction, options.compactionSummarySelection)
                  : pinnedCompactionPolicy(input.executionRoute.main, input.executionRoute.compactionSummary)
              const selection =
                options.modelVariantPolicy === "fixed-selection"
                  ? variantSelection(
                      options.selection,
                      input.reasoningEffort ?? options.defaultReasoningEffort,
                      input.fastMode === true,
                      options.modelVariantPolicy ?? "registration-key",
                    )
                  : pinnedSelection(input.executionRoute.main)
              const oracleSelection =
                options.modelVariantPolicy === "fixed-selection"
                  ? options.oracleSelection
                  : pinnedSelection(input.executionRoute.oracle)
              const agentRoutes =
                options.modelVariantPolicy === "fixed-selection" ? undefined : input.executionRoute.agents
              const agentModels =
                agentRoutes === undefined
                  ? {}
                  : {
                      Librarian: pinnedSelection(agentRoutes.librarian),
                      Painter: pinnedSelection(agentRoutes.painter),
                      Review: pinnedSelection(agentRoutes.review),
                      ReadThread: pinnedSelection(agentRoutes.readThread),
                    }
              const childDepth = 1
              const childRunPresets = Object.fromEntries(
                Object.entries(presets(selection, oracleSelection, agentModels)).map(([name, preset]) => {
                  const profile = name as AgentProfile
                  const profileRoute =
                    profile === "Task" ? input.executionRoute.main : routeForProfile(input.executionRoute, profile)
                  const effort =
                    profile === "Task"
                      ? (input.reasoningEffort ?? input.executionRoute.main.effort)
                      : profileRoute.effort
                  const policy =
                    options.modelVariantPolicy === "fixed-selection"
                      ? compactionPolicy(
                          profile === "Oracle" ? (options.oracleCompaction ?? options.compaction) : options.compaction,
                          options.compactionSummarySelection,
                        )
                      : pinnedCompactionPolicy(profileRoute, input.executionRoute.compactionSummary)
                  return [
                    name,
                    {
                      ...preset,
                      model: {
                        ...preset.model,
                        metadata: {
                          rika_execution_route: durableRoute,
                          rika_agent_depth: childDepth,
                          rika_reasoning_effort: effort,
                        },
                      },
                      tool_names: availableTools(executionToolOptions, toolsAtDepth(preset.tool_names, childDepth)),
                      ...(policy === undefined ? {} : { compaction_policy: policy }),
                      metadata: {
                        ...preset.metadata,
                        steering_enabled: true,
                        rika_agent_depth: childDepth,
                        rika_reasoning_effort: effort,
                        rika_execution_route: durableRoute,
                      },
                    },
                  ]
                }),
              )
              yield* Effect.logInfo("execution.starting").pipe(
                Effect.annotateLogs({
                  "rika.model.name": selection.model,
                  "rika.model.provider": selection.provider,
                }),
              )
              const registered = yield* client.agents.register({
                id: agentId,
                address: addressId,
                agent: Agent.make({
                  name: `rika-${encodeURIComponent(input.turnId)}`,
                  instructions: mainInstructions,
                  model: selection,
                  toolkit: toolkitFor(executionToolOptions),
                  policy: TurnPolicy.forever,
                  toolExecution: { concurrency: 4 },
                }),
                permissions: parentPermissions,
                ...(permissionPolicy === undefined ? {} : { permission_rules: permissionPolicy }),
                metadata,
                ...(rootCompaction === undefined ? {} : { compaction_policy: rootCompaction }),
                child_run_presets: childRunPresets,
              })
              const start = client.executions
                .startByAgentDefinition({
                  root_address_id: addressId,
                  session_id: sessionId(input.sessionKey ?? input.threadId),
                  agent_id: agentId,
                  agent_revision: registered.record.current_revision,
                  input: executionInput(input),
                  idempotency_key: input.turnId,
                  execution_id: id,
                  started_at: input.startedAt,
                  completed_at: input.startedAt,
                })
                .pipe(
                  Effect.asVoid,
                  Effect.catchTag("ClientError", (startError) =>
                    client.executions.get(id).pipe(
                      Effect.matchEffect({
                        onFailure: () => Effect.fail(startError),
                        onSuccess: (existing) => (existing === undefined ? Effect.fail(startError) : Effect.void),
                      }),
                    ),
                  ),
                )
              const starter = yield* Effect.forkChild(start)
              yield* Effect.yieldNow
              const started = starter.pollUnsafe()
              if (started !== undefined) yield* Fiber.join(starter)
              else
                yield* Effect.raceFirst(
                  awaitExecutionAvailable(client, id, "Execution acceptance timed out"),
                  Fiber.join(starter),
                )
              yield* Clock.currentTimeMillis.pipe(
                Effect.flatMap((acceptedAt) =>
                  Effect.logInfo("execution.accepted").pipe(
                    Effect.annotateLogs("rika.duration.ms", acceptedAt - startedAt),
                  ),
                ),
              )
              return yield* followExecution(client, input.turnId, undefined, input.onEvent).pipe(
                Effect.ensuring(Fiber.interrupt(starter)),
              )
            }).pipe(
              Effect.tapCause((cause) =>
                Effect.logError("execution.start.failed").pipe(
                  Effect.annotateLogs("rika.failure.kind", failureKind(cause)),
                ),
              ),
              Effect.annotateLogs({
                "rika.execution.id": String(executionId(input.turnId)),
                "rika.thread.id": String(input.threadId),
                "rika.turn.id": String(input.turnId),
              }),
              Effect.mapError(error),
            )
          },
          (effect) => traceWithoutResult("ExecutionBackend.start", effect),
        ),
        follow: Effect.fn(
          function* (turnId, afterCursor, onEvent, reference) {
            return yield* followExecution(client, turnId, afterCursor, onEvent, true, reference).pipe(
              Effect.mapError(error),
            )
          },
          (effect) => traceWithoutResult("ExecutionBackend.follow", effect),
        ),
        replay: Effect.fn("ExecutionBackend.replay")(function* (turnId, afterCursor, reference) {
          return yield* client.executions
            .replay({
              execution_id: executionId(turnId, reference),
              ...(afterCursor === undefined ? {} : { after_cursor: afterCursor }),
            })
            .pipe(
              Effect.map((result) => {
                const events = result.events.map(event)
                return { turnId, status: statusFromEvents(events), events }
              }),
              Effect.mapError(error),
            )
        }),
        pageEvents: Effect.fn("ExecutionBackend.pageEvents")(function* (turnId, direction, cursor, limit, reference) {
          return yield* client.executions
            .pageEvents({
              execution_id: executionId(turnId, reference),
              direction,
              ...(cursor === undefined
                ? {}
                : direction === "forward"
                  ? { after_cursor: cursor }
                  : { before_cursor: cursor }),
              ...(limit === undefined ? {} : { limit }),
            })
            .pipe(
              Effect.map((result) => ({
                events: result.events.map(event),
                hasMore: result.has_more,
                ...(result.oldest_cursor === undefined ? {} : { oldestCursor: result.oldest_cursor }),
                ...(result.newest_cursor === undefined ? {} : { newestCursor: result.newest_cursor }),
              })),
              Effect.mapError(error),
            )
        }),
        cancel: Effect.fn("ExecutionBackend.cancel")(function* (turnId, cancelledAt, reference) {
          return yield* Effect.gen(function* () {
            const id = executionId(turnId, reference)
            yield* awaitExecutionAvailable(client, id, "Execution did not become available for cancellation")
            const accepted = yield* client.executions.cancel({
              execution_id: id,
              cancelled_at: cancelledAt,
            })
            const replay = yield* client.executions.replay({ execution_id: id })
            const events = replay.events.map(event)
            return { turnId, status: Status.make(accepted.status), events }
          }).pipe(Effect.mapError(error))
        }),
        inspect: Effect.fn("ExecutionBackend.inspect")(function* (turnId, reference) {
          const existing = yield* client.executions.get(executionId(turnId, reference))
          if (existing === undefined) return undefined
          return yield* client.executions.inspect(executionId(turnId, reference)).pipe(
            Effect.map((value) => ({
              turnId,
              status: Status.make(value.status),
              ...(value.last_event_cursor === undefined ? {} : { lastCursor: value.last_event_cursor }),
              waits: value.waiting_on.map((wait) => ({
                id: wait.wait_id,
                mode: wait.mode,
                createdAt: wait.created_at,
              })),
              pendingTools: value.pending_tool_calls.map((tool) => ({
                callId: tool.tool_call_id,
                name: tool.tool_name,
                input: tool.input,
                requestedAt: tool.requested_at,
              })),
              children: value.child_runs.map((child) => ({
                executionId: child.child_execution_id,
                status: Status.make(child.status),
              })),
            })),
          )
        }, Effect.mapError(error)),
        steer: Effect.fn("ExecutionBackend.steer")(function* (turnId, text, createdAt, reference) {
          yield* client.executions
            .steer({
              execution_id: executionId(turnId, reference),
              kind: "steering",
              content: [Content.text(text)],
              created_at: createdAt,
            })
            .pipe(Effect.mapError(error))
        }),
        listApprovals: Effect.fn("ExecutionBackend.listApprovals")(function* (turnId, reference) {
          return yield* Effect.gen(function* () {
            const ids = yield* executionTreeIds(client, executionId(turnId, reference))
            const approvals = yield* Effect.forEach(ids, (execution) =>
              client.tools.listPendingApprovals({ execution_id: execution }),
            )
            return approvals.flatMap((result, index) =>
              result.approvals.map((approval) => ({
                waitId: approval.wait_id,
                executionId: String(ids[index]),
                callId: approval.tool_call_id,
                toolName: approval.tool_name,
                input: approval.input,
                requestedAt: approval.requested_at,
              })),
            )
          }).pipe(Effect.mapError(error))
        }),
        resolveToolApproval: Effect.fn("ExecutionBackend.resolveToolApproval")(
          function* (waitId, approved, resolvedAt, comment) {
            yield* client.tools
              .resolveApproval({
                wait_id: Ids.WaitId.make(waitId),
                approved,
                resolved_at: resolvedAt,
                ...(comment === undefined ? {} : { comment }),
              })
              .pipe(Effect.mapError(error))
          },
        ),
        resolvePermission: Effect.fn("ExecutionBackend.resolvePermission")(
          function* (waitId, answer, resolvedAt, reason) {
            yield* client.tools
              .resolvePermission({
                wait_id: Ids.WaitId.make(waitId),
                answer,
                resolved_at: resolvedAt,
                ...(reason === undefined ? {} : { reason }),
              })
              .pipe(Effect.mapError(error))
          },
        ),
      })
    }),
  )

import { Agent, ModelRegistry, TurnPolicy } from "@batonfx/core"
import { AgentTools, Catalog as ToolCatalog, ReadWebPage, Runtime as RikaToolRuntime, WebSearch } from "@rika/tools"
import { ChildFanOutHost, Client, Content, Ids, ModelHub, Runtime, ToolRuntime as RelayToolRuntime } from "@relayfx/sdk"
import { Clock, Context, Crypto, Deferred, Effect, Layer, PlatformError, Redacted, Schema, Stream } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { type AgentProfile, BackendError, Service } from "../execution-contract"
import { parentPermissions, resolve } from "../agent-profiles"
import * as MediaAnalyzer from "../media-analyzer"
import * as ThreadHost from "../thread-host"
import { childExecutionDepth, delegationAvailableAtDepth, toolsAtDepth } from "../agent-depth"
import { resolveSpawnModel } from "../agent-model"
import {
  internal as optionsInternal,
  routedToolRuntimeLayer,
  registrationsFor,
  relayModelSelection,
  buildChildRunInput,
  pinnedSelection,
  toolkitFor,
  webSearchFactories,
} from "./options"
import type { ToolRuntimeRequirements, ExternalToolRuntimeRequirements, LayerOptions } from "./options"
import { internal as codec, addressId, modelSelection, childSessionId, error } from "./execution-codec"
import { layerFromClient } from "./client-layer"
import { internal as embeddedHostHandlers } from "./embedded-host-handlers"
const { makeWorkflowHandlers } = embeddedHostHandlers
const { pinnedCompactionPolicy, availableTools } = optionsInternal
const {
  fanOutAgentId,
  makeChildExecutionId,
  pinnedRouteForExecution,
  routeForProfile,
  routeForSelection,
  awaitChildResult,
} = codec
const normalizeToolRuntimeLayer = <R>(
  toolRuntimeLayer: Layer.Layer<
    RikaToolRuntime.Service,
    BackendError | import("@rika/tools").WorkspaceIndex.WorkspaceIndexError,
    R
  >,
): Layer.Layer<RikaToolRuntime.Service, BackendError, R> =>
  toolRuntimeLayer.pipe(Layer.catch((cause) => Layer.effect(RikaToolRuntime.Service, Effect.fail(error(cause)))))
export const layer = <
  AdditionalTools extends Record<string, Tool.Any> = {},
  RuntimeRequirements extends ToolRuntimeRequirements = never,
>(
  options: LayerOptions<AdditionalTools, RuntimeRequirements>,
): Layer.Layer<
  Service,
  BackendError | PlatformError.PlatformError | Runtime.AcquisitionError,
  Crypto.Crypto | ExternalToolRuntimeRequirements<RuntimeRequirements>
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const sqliteModule = yield* Effect.tryPromise({
        try: () => import("@relayfx/sdk/sqlite"),
        catch: error,
      })
      const promoterRegistry = yield* ThreadHost.makeRegistry
      const promoterRegistryLayer = Layer.succeed(ThreadHost.Registry, promoterRegistry)
      const relayClient = yield* Deferred.make<Client.Interface>()
      {
        const { SQLite } = sqliteModule
        {
          const toolkit = toolkitFor(
            options.webSearchCredentialsForWorkspace === undefined
              ? options
              : {
                  ...options,
                  webSearchCredentials: Object.fromEntries(
                    WebSearch.providerRegistry.map((provider) => [provider.id, Redacted.make("")]),
                  ),
                },
          )
          const runnerToolkit = Toolkit.make(...Object.values(toolkit.tools), ThreadHost.promoteTurnTool)
          const toolOptionsForExecution = (execution: string) =>
            Effect.gen(function* () {
              const workspace =
                options.resolveWorkspace === undefined ? options.workspace : yield* options.resolveWorkspace(execution)
              const credentials =
                options.webSearchCredentialsForWorkspace === undefined
                  ? options.webSearchCredentials
                  : yield* options.webSearchCredentialsForWorkspace(workspace)
              return { ...options, webSearchCredentials: credentials ?? {} }
            })
          const delegation = Effect.fn("ExecutionBackend.delegateAgent")(function* (
            toolName: AgentTools.DelegationToolName,
            profile: AgentProfile,
            input: AgentTools.TaskInput | { readonly prompt: string },
          ) {
            const call = yield* RelayToolRuntime.ToolCallInfo
            const parentDepth = childExecutionDepth(String(call.executionId))
            if (!delegationAvailableAtDepth(parentDepth)) {
              return yield* AgentTools.AgentToolError.make({
                tool: toolName,
                message: `Agent delegation is unavailable at depth ${parentDepth}`,
              })
            }
            const client = yield* Deferred.await(relayClient)
            const parent = yield* client.executions
              .get(call.executionId)
              .pipe(
                Effect.mapError((cause) => AgentTools.AgentToolError.make({ tool: toolName, message: String(cause) })),
              )
            const snapshot = parent?.agent_snapshot
            const routePin =
              parent === undefined
                ? undefined
                : yield* pinnedRouteForExecution(client, parent).pipe(
                    Effect.mapError((cause) =>
                      AgentTools.AgentToolError.make({ tool: toolName, message: String(cause) }),
                    ),
                  )
            if (snapshot === undefined) {
              return yield* AgentTools.AgentToolError.make({
                tool: toolName,
                message: `Execution ${call.executionId} does not have an agent snapshot`,
              })
            }
            if (routePin === undefined) {
              return yield* AgentTools.AgentToolError.make({
                tool: toolName,
                message: "The parent execution does not have a pinned model route",
              })
            }
            const parentSelection = modelSelection(snapshot.model)
            const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(routePin).pipe(
              Effect.mapError((cause) => AgentTools.AgentToolError.make({ tool: toolName, message: String(cause) })),
            )
            const executionToolOptions = yield* toolOptionsForExecution(String(call.executionId)).pipe(
              Effect.mapError((cause) => AgentTools.AgentToolError.make({ tool: toolName, message: String(cause) })),
            )
            const calls = [
              {
                callId: String(call.call.id),
                prompt: input.prompt,
                ...(profile === "Task" && "model" in input && input.model !== undefined ? { model: input.model } : {}),
              },
            ]
            const children = yield* Effect.forEach(calls, (childCall) => {
              const base = {
                child_execution_id: makeChildExecutionId(String(call.executionId), childCall.callId),
                address_id: addressId,
                input: [Content.text(childCall.prompt)],
              }
              if (childCall.model === undefined && snapshot.child_run_presets?.[profile] !== undefined) {
                return Effect.succeed(
                  buildChildRunInput(base, {
                    _tag: "preset",
                    presetName: profile,
                  }),
                )
              }
              const selected =
                profile === "Task"
                  ? resolveSpawnModel(routePin, parentSelection, childCall.model)
                  : options.modelVariantPolicy === "fixed-selection"
                    ? {
                        selection:
                          profile === "Oracle" ? (options.oracleSelection ?? options.selection) : options.selection,
                        effort: routeForProfile(routePin, profile).effort,
                      }
                    : {
                        selection: pinnedSelection(routeForProfile(routePin, profile)),
                        effort: routeForProfile(routePin, profile).effort,
                      }
              if (selected === undefined) {
                return Effect.fail(
                  AgentTools.AgentToolError.make({
                    tool: toolName,
                    message: `Model ${childCall.model} is not available in this execution's registered routes`,
                  }),
                )
              }
              const childDepth = parentDepth + 1
              const preset = resolve(profile, selected.selection).preset
              const selectedRoute = routeForSelection(routePin, selected.selection)
              const policy =
                selectedRoute === undefined
                  ? snapshot.compaction_policy
                  : pinnedCompactionPolicy(selectedRoute, routePin.compactionSummary)
              return Effect.succeed(
                buildChildRunInput(base, {
                  _tag: "override",
                  definition: {
                    instructions: preset.instructions,
                    model: {
                      ...relayModelSelection(selected.selection),
                      metadata: {
                        rika_execution_route: durableRoute,
                        rika_agent_depth: childDepth,
                        rika_reasoning_effort: selected.effort,
                      },
                    },
                    tool_names: availableTools(executionToolOptions, toolsAtDepth(preset.tool_names, childDepth)),
                    permissions: preset.permissions,
                    ...(policy === undefined ? {} : { compaction_policy: policy }),
                    metadata: {
                      product_profile: profile,
                      steering_enabled: true,
                      rika_agent_depth: childDepth,
                      rika_reasoning_effort: selected.effort,
                      rika_execution_route: durableRoute,
                    },
                  },
                }),
              )
            })
            yield* Effect.forEach(
              children,
              (child) =>
                client.childRuns.spawn({
                  execution_id: call.executionId,
                  ...child,
                  wait: false,
                }),
              { discard: true },
            ).pipe(
              Effect.mapError((cause) => AgentTools.AgentToolError.make({ tool: toolName, message: String(cause) })),
            )
            const currentCall = calls.find((childCall) => childCall.callId === String(call.call.id))
            const current =
              currentCall === undefined
                ? undefined
                : children.find(
                    (child) =>
                      child.child_execution_id === makeChildExecutionId(String(call.executionId), currentCall.callId),
                  )
            if (current === undefined) {
              return yield* AgentTools.AgentToolError.make({
                tool: toolName,
                message: `The child for tool call ${call.call.id} is not in its fan-out batch`,
              })
            }
            const result = yield* awaitChildResult(client, String(current.child_execution_id)).pipe(
              Effect.mapError((cause) => AgentTools.AgentToolError.make({ tool: toolName, message: String(cause) })),
            )
            return {
              childExecutionId: String(current.child_execution_id),
              status: result.status,
              output: [...result.output],
            }
          })
          const runDelegation = delegation as unknown as (
            toolName: AgentTools.DelegationToolName,
            profile: AgentProfile,
            input: AgentTools.TaskInput | { readonly prompt: string },
          ) => Effect.Effect<AgentTools.Result, AgentTools.AgentToolError>
          const delegationHandlerLayer: Layer.Layer<Tool.HandlersFor<typeof AgentTools.modelToolkit.tools>> =
            AgentTools.modelToolkit.toLayer({
              task: (input) => runDelegation("task", "Task", input),
              oracle: (input) => runDelegation("oracle", "Oracle", input),
              librarian: (input) => runDelegation("librarian", "Librarian", input),
              review: (input) => runDelegation("review", "Review", input),
            })
          const handlerLayer = Layer.mergeAll(
            options.additionalHandlerLayer === undefined
              ? RikaToolRuntime.handlerLayer
              : Layer.merge(RikaToolRuntime.handlerLayer, options.additionalHandlerLayer),
            ThreadHost.handlerLayer(promoterRegistry),
            delegationHandlerLayer,
          )
          const modelContext = yield* Layer.build(
            ModelHub.layerFromRegistrationEffects([
              ...registrationsFor(options).map((registration) => Effect.succeed(registration)),
              ThreadHost.hostRegistration,
            ]),
          ).pipe(Effect.mapError(error))
          const modelRegistry = Context.get(modelContext, ModelRegistry.Service)
          const languageModelLayer = Layer.succeedContext(modelContext)
          const sharedModelRegistryLayer = Layer.succeed(ModelRegistry.Service, modelRegistry)
          const rikaToolRuntimeLayer = normalizeToolRuntimeLayer(
            options.toolRuntimeLayerForWorkspace !== undefined && options.resolveWorkspace !== undefined
              ? routedToolRuntimeLayer(options.toolRuntimeLayerForWorkspace, options.resolveWorkspace)
              : (options.toolRuntimeLayer ?? RikaToolRuntime.layer(options.workspace)),
          )
          const credentials = options.webSearchCredentials ?? {}
          const search = webSearchFactories(credentials)
          const readPageCredential = WebSearch.configuredReadPageCredential(credentials)
          if (search.unsupportedIds.length > 0)
            yield* Effect.logWarning("web_search.unsupported_provider").pipe(
              Effect.annotateLogs("rika.web_search.provider_ids", search.unsupportedIds.join(",")),
            )
          const toolRuntimeLayer = RelayToolRuntime.layerFromToolkit(runnerToolkit, (tool) => ({
            needsApproval:
              tool.name === ThreadHost.promoteTurnTool.name
                ? false
                : (options.toolNeedsApproval?.(tool.name) ?? ToolCatalog.get(tool.name)?.permission === "ask"),
          })).pipe(
            Layer.provide(handlerLayer),
            Layer.provide(
              rikaToolRuntimeLayer.pipe(
                Layer.provide(MediaAnalyzer.layer(options.selection)),
                Layer.provide(sharedModelRegistryLayer),
                Layer.provide(
                  Layer.mergeAll(
                    WebSearch.factoryLayer(search.factories),
                    ReadWebPage.layer(readPageCredential === undefined ? {} : { apiKey: readPageCredential }),
                  ).pipe(Layer.provide(FetchHttpClient.layer)),
                ),
              ),
            ),
          )
          const childResult = (client: Client.Interface, childId: string) => {
            const childExecutionId = Ids.ExecutionId.make(childId)
            return client.executions.stream({ execution_id: childExecutionId }).pipe(
              Stream.takeUntil(
                (item) =>
                  item.type === "execution.completed" ||
                  item.type === "execution.failed" ||
                  item.type === "execution.cancelled",
              ),
              Stream.runCollect,
              Effect.map((events) => {
                const terminal = events.findLast(
                  (executionEvent) =>
                    executionEvent.type === "execution.completed" ||
                    executionEvent.type === "execution.failed" ||
                    executionEvent.type === "execution.cancelled",
                )
                const modelOutput = events.findLast(
                  (executionEvent) => executionEvent.type === "model.output.completed",
                )
                return {
                  status:
                    terminal?.type === "execution.completed"
                      ? ("completed" as const)
                      : terminal?.type === "execution.cancelled"
                        ? ("cancelled" as const)
                        : ("failed" as const),
                  output:
                    terminal?.content === undefined || terminal.content.length === 0
                      ? (modelOutput?.content ?? [])
                      : terminal.content,
                }
              }),
            )
          }
          const fanOutHandlers = Layer.succeed(
            ChildFanOutHost.Service,
            ChildFanOutHost.Service.of({
              execute: (child, fanOutState, idempotencyKey) =>
                Deferred.await(relayClient).pipe(
                  Effect.flatMap((client) =>
                    Effect.gen(function* () {
                      const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
                      const override = child.override ?? {}
                      const childToolkit = Toolkit.make(
                        ...Object.values(toolkit.tools).filter(
                          (tool) => override.tool_names === undefined || override.tool_names.includes(tool.name),
                        ),
                      )
                      const metadata = {
                        steering_enabled: true,
                        ...override.metadata,
                        ...child.metadata,
                        rika_execution_id: String(child.child_execution_id),
                      }
                      const childSelection =
                        override.model === undefined
                          ? options.selection
                          : {
                              provider: override.model.provider,
                              model: override.model.model,
                              ...(override.model.registration_key === undefined
                                ? {}
                                : {
                                    registrationKey: override.model.registration_key,
                                  }),
                            }
                      const childAgentId = fanOutAgentId(fanOutState.fan_out_id, child.child_execution_id)
                      const registered = yield* client.agents.register({
                        id: childAgentId,
                        address: child.address_id,
                        agent: Agent.make({
                          name: `rika-fan-out-${String(child.child_execution_id)}`,
                          ...(override.instructions === undefined ? {} : { instructions: override.instructions }),
                          model: childSelection,
                          toolkit: childToolkit,
                          policy: TurnPolicy.forever,
                        }),
                        permissions:
                          override.permissions === undefined
                            ? parentPermissions
                            : override.permissions.map((name: string) => ({ name, value: true })),
                        ...(options.permissionPolicy === undefined
                          ? {}
                          : { permission_rules: options.permissionPolicy }),
                        ...(override.output_schema_ref === undefined
                          ? {}
                          : { output_schema_ref: override.output_schema_ref }),
                        metadata,
                        ...(override.compaction_policy === undefined
                          ? {}
                          : { compaction_policy: override.compaction_policy }),
                      })
                      yield* client.executions.startByAgentDefinition({
                        root_address_id: child.address_id,
                        session_id: childSessionId(child.child_execution_id),
                        agent_id: childAgentId,
                        agent_revision: registered.record.current_revision,
                        execution_id: Ids.ExecutionId.make(String(child.child_execution_id)),
                        ...(child.input === undefined ? {} : { input: child.input }),
                        idempotency_key: idempotencyKey,
                        started_at: startedAt,
                        completed_at: startedAt,
                        metadata: {
                          child_execution_id: child.child_execution_id,
                          fan_out_id: fanOutState.fan_out_id,
                          ...child.metadata,
                        },
                      })
                      return yield* childResult(client, String(child.child_execution_id))
                    }),
                  ),
                  Effect.mapError((cause) => ChildFanOutHost.HandlerError.make({ message: String(cause) })),
                ),
              cancel: (childExecutionId) =>
                Deferred.await(relayClient).pipe(
                  Effect.flatMap((client) =>
                    Clock.currentTimeMillis.pipe(
                      Effect.flatMap((cancelledAt) =>
                        client.executions.cancel({
                          execution_id: Ids.ExecutionId.make(String(childExecutionId)),
                          cancelled_at: cancelledAt,
                        }),
                      ),
                      Effect.asVoid,
                      Effect.mapError((cause) => ChildFanOutHost.HandlerError.make({ message: String(cause) })),
                    ),
                  ),
                ),
            }),
          )
          const workflowHandlers = makeWorkflowHandlers(options, relayClient, toolOptionsForExecution, childResult)
          const runtimeLayer = Runtime.layerEmbedded({
            database: SQLite.database({ filename: options.filename }),
            languageModelLayer,
            toolRuntimeLayer,
            childFanOutHostLayer: fanOutHandlers,
            workflowDefinitionHostLayer: workflowHandlers,
          })
          return layerFromClient({
            ...options,
            onClientReady: (client) => Deferred.complete(relayClient, Effect.succeed(client)).pipe(Effect.asVoid),
            registerModels: (registrations) =>
              Effect.forEach(registrations, (registration) => modelRegistry.register({ registration }), {
                discard: true,
              }),
          }).pipe(Layer.provide(runtimeLayer), Layer.provide(promoterRegistryLayer))
        }
      }
    }),
  )

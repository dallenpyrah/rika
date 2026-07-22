import { type Compaction, ModelRegistry, ModelResilience, type Permissions } from "@batonfx/core"
import {
  AgentTools,
  MediaView,
  ProcessRegistry,
  ReadWebPage,
  Runtime as RikaToolRuntime,
  WebSearch,
  WorkspaceIndex,
} from "@rika/tools"
import { type Execution, ToolRuntime as RelayToolRuntime } from "@relayfx/sdk"
import { Cause, Clock, Context, Duration, Effect, Function, Layer, LayerMap, Redacted, Schedule, Schema } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { ChildProcessSpawner } from "effect/unstable/process"
import { type AgentProfile, BackendError, type ExecutionRoutePin } from "../execution-contract"

export { streamingOnlyLanguageModel, withStreamingOnlyModel } from "../streaming-only-model"

export type ModelVariantPolicy = "registration-key" | "fixed-selection"

export type ToolRuntimeRequirements =
  ReturnType<typeof RikaToolRuntime.layer> extends Layer.Layer<infer _A, infer _E, infer R> ? R : never
export type SuppliedToolRuntimeRequirements =
  | MediaView.MediaAnalyzer
  | ModelRegistry.Service
  | ProcessRegistry.Service
  | ReadWebPage.Service
  | WebSearch.Service
export type ExternalToolRuntimeRequirements<R> = Exclude<ToolRuntimeRequirements | R, SuppliedToolRuntimeRequirements>

export const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  if (failure !== null && typeof failure === "object" && "_tag" in failure && typeof failure._tag === "string")
    return failure._tag
  if (failure instanceof Error) return failure.name
  return typeof failure
}

export const isExecutionNotFound = (failure: unknown) =>
  failure !== null && typeof failure === "object" && "_tag" in failure && failure._tag === "ExecutionNotFound"

export const observableEventTypes = new Set([
  "execution.accepted",
  "execution.started",
  "model.input.prepared",
  "model.output.completed",
  "model.usage.reported",
  "tool.call.requested",
  "tool.result.received",
  "tool.approval.requested",
  "tool.approval.resolved",
  "permission.ask.requested",
  "permission.ask.resolved",
  "wait.created",
  "wait.woken",
  "wait.timed_out",
  "wait.cancelled",
  "child_run.spawned",
  "child_fan_out.created",
  "child_fan_out.member.terminal",
  "child_fan_out.terminal",
  "budget.exceeded",
  "execution.completed",
  "execution.failed",
  "execution.cancelled",
])

export interface CompactionPolicy {
  readonly context_window: number
  readonly reserve_tokens: number
  readonly keep_recent_tokens: number
  readonly summary_model?: {
    readonly provider: string
    readonly model: string
    readonly registration_key?: string
  }
}

export interface LayerOptions<AdditionalTools extends Record<string, Tool.Any> = {}, RuntimeRequirements = never> {
  readonly filename: string
  readonly workspace: string
  readonly webSearchCredentials?: Readonly<Record<string, Redacted.Redacted<string>>>
  readonly webSearchCredentialsForWorkspace?: (
    workspace: string,
  ) => Effect.Effect<Readonly<Record<string, Redacted.Redacted<string>>>, BackendError>
  readonly registration: ModelRegistry.Registration
  readonly additionalRegistrations?: ReadonlyArray<ModelRegistry.Registration>
  readonly selection: ModelRegistry.ModelSelection
  readonly oracleSelection?: ModelRegistry.ModelSelection
  readonly compactionSummarySelection?: ModelRegistry.ModelSelection
  readonly defaultReasoningEffort?: string
  readonly modelVariantPolicy?: ModelVariantPolicy
  readonly modelResilience?: ModelResilience.Interface
  readonly compaction?: Compaction.DefaultOptions
  readonly oracleCompaction?: Compaction.DefaultOptions
  readonly permissionPolicy?: Permissions.Ruleset
  readonly permissionPolicyForExecution?: (executionId: string) => Effect.Effect<Permissions.Ruleset, BackendError>
  readonly additionalToolkit?: Toolkit.Toolkit<AdditionalTools>
  readonly additionalHandlerLayer?: Layer.Layer<Tool.HandlersFor<AdditionalTools>, BackendError, never>
  readonly toolRuntimeLayer?: Layer.Layer<
    RikaToolRuntime.Service,
    BackendError | WorkspaceIndex.WorkspaceIndexError,
    RuntimeRequirements
  >
  readonly toolRuntimeLayerForWorkspace?: (
    workspace: string,
  ) => Layer.Layer<
    RikaToolRuntime.Service,
    BackendError | WorkspaceIndex.WorkspaceIndexError,
    RuntimeRequirements | ProcessRegistry.Service
  >
  readonly resolveWorkspace?: (executionId: string) => Effect.Effect<string, BackendError>
  readonly toolNeedsApproval?: (name: string) => boolean
}

export const routedToolRuntimeLayer: {
  <E, R>(
    resolveWorkspace: (executionId: string) => Effect.Effect<string, BackendError>,
  ): (
    layerForWorkspace: (workspace: string) => Layer.Layer<RikaToolRuntime.Service, E, R>,
  ) => Layer.Layer<
    RikaToolRuntime.Service,
    E,
    ChildProcessSpawner.ChildProcessSpawner | Exclude<R, ProcessRegistry.Service>
  >
  <E, R>(
    layerForWorkspace: (workspace: string) => Layer.Layer<RikaToolRuntime.Service, E, R>,
    resolveWorkspace: (executionId: string) => Effect.Effect<string, BackendError>,
  ): Layer.Layer<
    RikaToolRuntime.Service,
    E,
    ChildProcessSpawner.ChildProcessSpawner | Exclude<R, ProcessRegistry.Service>
  >
} = Function.dual(
  2,
  <E, R>(
    layerForWorkspace: (workspace: string) => Layer.Layer<RikaToolRuntime.Service, E, R>,
    resolveWorkspace: (executionId: string) => Effect.Effect<string, BackendError>,
  ) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const dependencies = yield* Effect.context<
          ChildProcessSpawner.ChildProcessSpawner | Exclude<R, ProcessRegistry.Service>
        >()
        const processes = yield* LayerMap.make(() => ProcessRegistry.layer, { idleTimeToLive: Duration.infinity })
        const run = ((request: RikaToolRuntime.Request) =>
          Effect.scoped(
            Effect.gen(function* () {
              const call = yield* RelayToolRuntime.ToolCallInfo
              const workspace = yield* resolveWorkspace(String(call.executionId))
              const processContext = yield* processes.contextEffect(workspace)
              const workspaceLayer = layerForWorkspace(workspace).pipe(
                Layer.provide(Layer.succeedContext(Context.merge(dependencies, processContext))),
              )
              const runtimeContext = yield* Layer.build(workspaceLayer)
              const runtime = Context.get(runtimeContext, RikaToolRuntime.Service)
              const startedAt = yield* Clock.currentTimeMillis
              yield* Effect.logInfo("tool.started").pipe(
                Effect.annotateLogs({
                  "rika.execution.id": String(call.executionId),
                  "rika.tool.call.id": String(call.call.id),
                }),
              )
              return yield* runtime.run(request).pipe(
                Effect.tap(() =>
                  Clock.currentTimeMillis.pipe(
                    Effect.flatMap((completedAt) =>
                      Effect.logInfo("tool.completed").pipe(
                        Effect.annotateLogs("rika.duration.ms", completedAt - startedAt),
                      ),
                    ),
                  ),
                ),
                Effect.tapCause((cause) =>
                  Clock.currentTimeMillis.pipe(
                    Effect.flatMap((failedAt) =>
                      Effect.logError("tool.failed").pipe(
                        Effect.annotateLogs({
                          "rika.duration.ms": failedAt - startedAt,
                          "rika.failure.kind": failureKind(cause),
                        }),
                      ),
                    ),
                  ),
                ),
                Effect.annotateLogs({
                  "rika.execution.id": String(call.executionId),
                  "rika.tool.call.id": String(call.call.id),
                  "rika.tool.name": String(call.call.name),
                }),
              )
            }),
          ).pipe(
            Effect.mapError((cause) =>
              Schema.is(RikaToolRuntime.ToolError)(cause)
                ? cause
                : RikaToolRuntime.ToolError.make({
                    tool: request._tag,
                    message: String(cause),
                    kind: "operation",
                    outcome: "known",
                  }),
            ),
          )) as RikaToolRuntime.Interface["run"]
        return Layer.succeed(RikaToolRuntime.Service, RikaToolRuntime.Service.of({ run }))
      }),
    ),
)

export const defaultModelResilience: ModelResilience.Interface = ModelResilience.make({
  retrySchedule: Schedule.exponential("500 millis", 2).pipe(Schedule.jittered, Schedule.upTo({ times: 3 })),
})

const withResilience = (
  registration: ModelRegistry.Registration,
  resilience: ModelResilience.Interface | undefined,
): ModelRegistry.Registration => {
  if (resilience === undefined) return registration
  const modelLayer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.LanguageModel.pipe(Effect.map((model) => ModelResilience.apply(model, resilience))),
  ).pipe(Layer.provideMerge(registration.layer))
  return { ...registration, layer: modelLayer }
}

export const childExecutionIdFromEvent = (item: Execution.ExecutionEvent) => {
  const value = item.child_execution_id ?? item.data?.child_execution_id
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export const registrationFor = <AdditionalTools extends Record<string, Tool.Any>, R>(
  options: LayerOptions<AdditionalTools, R>,
): ModelRegistry.Registration => withResilience(options.registration, options.modelResilience)

export const registrationsFor = <AdditionalTools extends Record<string, Tool.Any>, R>(
  options: LayerOptions<AdditionalTools, R>,
): Array<ModelRegistry.Registration> => [
  registrationFor(options),
  ...(options.additionalRegistrations ?? []).map((registration) =>
    withResilience(registration, options.modelResilience),
  ),
]

export const relayModelSelection = (selection: ModelRegistry.ModelSelection) => ({
  provider: selection.provider,
  model: selection.model,
  ...(selection.registrationKey === undefined ? {} : { registration_key: selection.registrationKey }),
})

export type ChildRunInputBase = Pick<Execution.SpawnChildRunInput, "child_execution_id" | "address_id" | "input">

export type ChildRunOverride = Pick<
  Execution.SpawnChildRunInput,
  | "instructions"
  | "model"
  | "compaction_policy"
  | "tool_names"
  | "permissions"
  | "workspace_policy"
  | "output_schema_ref"
  | "metadata"
>

export type ChildRunDefinition =
  | { readonly _tag: "preset"; readonly presetName: AgentProfile }
  | { readonly _tag: "override"; readonly definition: ChildRunOverride }

const buildChildRunInputImpl = (base: ChildRunInputBase, definition: ChildRunDefinition) =>
  definition._tag === "preset" ? { ...base, preset_name: definition.presetName } : { ...base, ...definition.definition }

export type ChildRunInput = ReturnType<typeof buildChildRunInputImpl>

export const buildChildRunInput: {
  (definition: ChildRunDefinition): (base: ChildRunInputBase) => ChildRunInput
  (base: ChildRunInputBase, definition: ChildRunDefinition): ChildRunInput
} = Function.dual(2, buildChildRunInputImpl)

const compactionPolicy = (
  compaction: Compaction.DefaultOptions | undefined,
  summaryModel?: ModelRegistry.ModelSelection,
): CompactionPolicy | undefined =>
  compaction === undefined ||
  compaction.contextWindow === undefined ||
  compaction.reserveTokens === undefined ||
  compaction.keepRecentTokens === undefined
    ? undefined
    : {
        context_window: compaction.contextWindow,
        reserve_tokens: compaction.reserveTokens,
        keep_recent_tokens: compaction.keepRecentTokens,
        ...(summaryModel === undefined ? {} : { summary_model: relayModelSelection(summaryModel) }),
      }

const pinnedCompactionPolicy = (
  route: ExecutionRoutePin["main"],
  summaryModel?: ExecutionRoutePin["compactionSummary"],
): CompactionPolicy => ({
  context_window: route.compaction.contextWindow,
  reserve_tokens: route.compaction.reserveTokens,
  keep_recent_tokens: route.compaction.keepRecentTokens,
  ...(summaryModel === undefined ? {} : { summary_model: relayModelSelection(pinnedSelection(summaryModel)) }),
})

export const pinnedSelection = (route: ExecutionRoutePin["main"]): ModelRegistry.ModelSelection => ({
  provider: route.provider,
  model: route.model,
  registrationKey: route.registrationKey,
})

export const toolkitFor = <AdditionalTools extends Record<string, Tool.Any>>(
  options: Pick<LayerOptions<AdditionalTools>, "additionalToolkit" | "webSearchCredentials">,
) =>
  Toolkit.make(
    ...Object.values(RikaToolRuntime.toolkit.tools).filter(
      (tool) =>
        (tool.name !== "web_search" || WebSearch.providerAvailability(options.webSearchCredentials ?? {}).search) &&
        (tool.name !== "read_web_page" || WebSearch.providerAvailability(options.webSearchCredentials ?? {}).readPage),
    ),
    ...Object.values(AgentTools.modelToolkit.tools),
    ...Object.values(options.additionalToolkit?.tools ?? {}),
  )

const availableTools = <AdditionalTools extends Record<string, Tool.Any>>(
  options: Pick<LayerOptions<AdditionalTools>, "additionalToolkit" | "webSearchCredentials">,
  names: ReadonlyArray<string>,
) => {
  const available = toolkitFor(options).tools
  return names.filter((name) => name in available)
}

export const webSearchFactories = (credentials: Readonly<Record<string, Redacted.Redacted<string>>>) =>
  WebSearch.configuredProviderFactories(credentials)

export const modelVariantKey: {
  (fast: boolean): (effort: string) => string
  (effort: string, fast: boolean): string
} = Function.dual(2, (effort: string, fast: boolean) => `effort:${effort}${fast ? ":fast" : ""}`)

const variantSelection = (
  selection: ModelRegistry.ModelSelection,
  effort: string | undefined,
  fast: boolean,
  policy: ModelVariantPolicy,
): ModelRegistry.ModelSelection =>
  policy === "fixed-selection" || (effort === undefined && !fast)
    ? selection
    : { ...selection, registrationKey: modelVariantKey(effort ?? "medium", fast) }

export const internal = { compactionPolicy, pinnedCompactionPolicy, availableTools, variantSelection }

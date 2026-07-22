import { Compaction } from "@batonfx/core"
import { ConfigContract, Models } from "@rika/config"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Cause, Effect, Function, Schema } from "effect"
import * as ModelProviderRuntime from "./model-provider-runtime"

export class ModelConfigurationError extends Schema.TaggedErrorClass<ModelConfigurationError>()(
  "ModelConfigurationError",
  { message: Schema.String },
) {}

const modeIds = ["low", "medium", "high", "ultra"] as const
const agentIds = ["librarian", "painter", "review", "readThread", "task"] as const

const resolveTunedModeRoute = (
  settings: ConfigContract.Settings,
  mode: ConfigContract.ModeId,
  role: ConfigContract.Role,
  tuning?: { readonly fastMode?: boolean },
) => {
  const configured = settings.modes[mode][role]
  const fast = tuning?.fastMode ?? configured.fast ?? false
  const routedSettings: ConfigContract.Settings = {
    ...settings,
    modes: { ...settings.modes, [mode]: { ...settings.modes[mode], [role]: { ...configured, fast } } },
  }
  return ConfigContract.resolveModelRoute(routedSettings, mode, role)
}

const supportingModelRoutes = (settings: ConfigContract.Settings) => [
  ConfigContract.resolveThreadTitleRoute(settings),
  ConfigContract.resolveCompactionSummaryRoute(settings),
  ...agentIds.map((agent) => ConfigContract.resolveAgentRoute(settings, agent)),
]

const modelRoutesForExecutionImpl = (
  settings: ConfigContract.Settings,
  mode: ConfigContract.ModeId,
  tuning?: { readonly fastMode?: boolean },
) => [
  resolveTunedModeRoute(settings, mode, "main", tuning),
  resolveTunedModeRoute(settings, mode, "oracle", tuning),
  ...supportingModelRoutes(settings),
]

export const modelRoutesForExecution: {
  (
    mode: ConfigContract.ModeId,
    tuning?: { readonly fastMode?: boolean },
  ): (settings: ConfigContract.Settings) => ReturnType<typeof modelRoutesForExecutionImpl>
  (
    settings: ConfigContract.Settings,
    mode: ConfigContract.ModeId,
    tuning?: { readonly fastMode?: boolean },
  ): ReturnType<typeof modelRoutesForExecutionImpl>
} = Function.dual((args) => typeof args[0] === "object", modelRoutesForExecutionImpl)

export const defaultModelRoutes = (settings: ConfigContract.Settings) => [
  ...modeIds.flatMap((mode) => [
    ConfigContract.resolveModelRoute(settings, mode, "main"),
    ConfigContract.resolveModelRoute(settings, mode, "oracle"),
  ]),
  ...supportingModelRoutes(settings),
]

export type PreparedPlan = ModelProviderRuntime.PreparedRoutes["plans"][number]

const executionModelRoute = (
  route: ConfigContract.ResolvedModelRoute,
  plan: PreparedPlan,
  role: Turn.ExecutionModelRoute["role"],
): Turn.ExecutionModelRoute => ({
  role,
  alias: route.alias,
  provider: plan.selection.provider,
  model: plan.selection.model,
  registrationKey: plan.registrationKey,
  providerProtocol: route.providerConnection.protocol,
  providerBaseUrl: ModelProviderRuntime.normalizedBaseUrl(route.providerConnection.baseUrl),
  ...(route.providerConnection.apiKeyEnv === undefined
    ? {}
    : { providerApiKeyEnv: route.providerConnection.apiKeyEnv }),
  ...(plan.runtime.adapter === "openai-account" && plan.runtime.credentialIdentity !== undefined
    ? { openAiAccountFingerprint: plan.runtime.credentialIdentity }
    : {}),
  providerRuntime: plan.runtime,
  effort: route.effort,
  fast: route.fast,
  requestVariant: plan.registrationKey,
  providerOptions: plan.options,
  compaction: route.compaction,
})

const executionRoutePinFromPreparedImpl = (
  mode: ConfigContract.ModeId,
  prepared: Pick<ModelProviderRuntime.PreparedRoutes, "routes" | "plans">,
): Turn.ExecutionRoutePin => {
  const routes = prepared.routes
  const plans = prepared.plans
  if (routes.length !== 9 || plans.length !== routes.length)
    throw new Error(`Expected nine prepared execution routes, received ${routes.length}`)
  return {
    mode,
    main: executionModelRoute(routes[0]!, plans[0]!, "main"),
    oracle: executionModelRoute(routes[1]!, plans[1]!, "oracle"),
    title: executionModelRoute(routes[2]!, plans[2]!, "title"),
    compactionSummary: executionModelRoute(routes[3]!, plans[3]!, "compaction"),
    agents: Object.fromEntries(
      agentIds.map((agent, index) => [agent, executionModelRoute(routes[index + 4]!, plans[index + 4]!, agent)]),
    ) as NonNullable<Turn.ExecutionRoutePin["agents"]>,
  }
}

export const executionRoutePinFromPrepared: {
  (
    prepared: Pick<ModelProviderRuntime.PreparedRoutes, "routes" | "plans">,
  ): (mode: ConfigContract.ModeId) => Turn.ExecutionRoutePin
  (
    mode: ConfigContract.ModeId,
    prepared: Pick<ModelProviderRuntime.PreparedRoutes, "routes" | "plans">,
  ): Turn.ExecutionRoutePin
} = Function.dual(2, executionRoutePinFromPreparedImpl)

const executionRoutePinImpl = (
  settings: ConfigContract.Settings,
  mode: ConfigContract.ModeId,
  tuning?: { readonly fastMode?: boolean },
): Turn.ExecutionRoutePin => {
  const routes = modelRoutesForExecution(settings, mode, tuning)
  return executionRoutePinFromPrepared(mode, {
    routes,
    plans: routes.map((route) => ModelProviderRuntime.modelRoutePlan(route)),
  })
}

export const executionRoutePin: {
  (
    mode: ConfigContract.ModeId,
    tuning?: { readonly fastMode?: boolean },
  ): (settings: ConfigContract.Settings) => Turn.ExecutionRoutePin
  (
    settings: ConfigContract.Settings,
    mode: ConfigContract.ModeId,
    tuning?: { readonly fastMode?: boolean },
  ): Turn.ExecutionRoutePin
} = Function.dual((args) => typeof args[0] === "object", executionRoutePinImpl)

export const resolveExecutionRouteForSettings = Effect.fn("Main.resolveExecutionRouteForSettings")(function* (
  settings: ConfigContract.Settings,
  mode: ConfigContract.ModeId,
  tuning?: { readonly fastMode?: boolean },
) {
  return yield* Effect.try({
    try: () => ({
      routes: modelRoutesForExecution(settings, mode, tuning),
      executionRoute: executionRoutePin(settings, mode, tuning),
    }),
    catch: (cause) =>
      Schema.is(ConfigContract.ModelRouteError)(cause)
        ? cause
        : ModelConfigurationError.make({ message: `Could not resolve model route: ${String(cause)}` }),
  })
})

export const productionCompaction = (
  route?: Pick<ConfigContract.ResolvedModelRoute, "compaction">,
): Compaction.DefaultOptions => ({
  contextWindow: route?.compaction.contextWindow ?? Models.defaultCompaction.contextWindow,
  reserveTokens: route?.compaction.reserveTokens ?? Models.defaultCompaction.reserveTokens,
  keepRecentTokens: route?.compaction.keepRecentTokens ?? Models.defaultCompaction.keepRecentTokens,
})

export const registrationTuple = (candidate: {
  readonly provider: string
  readonly model: string
  readonly registrationKey?: string
}) => `${candidate.provider}\0${candidate.model}\0${candidate.registrationKey ?? ""}`

export interface PersistedRouteRegistrationFailure {
  readonly route: Turn.ExecutionModelRoute
  readonly message: string
}

export const causeMessage = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  return failure instanceof Error ? failure.message : String(failure)
}

export const executionModelRoutes = (route: Turn.ExecutionRoutePin): ReadonlyArray<Turn.ExecutionModelRoute> => [
  route.main,
  route.oracle,
  ...(route.title === undefined ? [] : [route.title]),
  ...(route.compactionSummary === undefined ? [] : [route.compactionSummary]),
  ...Object.values(route.agents ?? {}),
]

export const isLegacyUnavailableExecutionRoute = (route: Turn.ExecutionRoutePin) =>
  executionModelRoutes(route).some((candidate) => candidate.registrationKey === "legacy-unavailable")

export const unavailableRouteError = (failure: PersistedRouteRegistrationFailure) =>
  ExecutionBackend.BackendError.make({
    message: `Model route ${failure.route.alias}/${failure.route.effort}${failure.route.fast ? "/fast" : ""} is unavailable: ${failure.message}`,
  })

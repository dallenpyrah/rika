import { ConfigContract, Models } from "@rika/config"
import type * as Turn from "@rika/persistence/turn"
import { withStreamingOnlyModel } from "@rika/runtime/relay"
import { Compaction, ModelRegistry } from "@batonfx/core"
import { anthropic, anthropicClientLayerConfig } from "@batonfx/providers/anthropic"
import {
  OpenAiAccountCredentialError,
  openAi,
  openAiAccount,
  openAiClientLayerConfig,
  type OpenAiAccountCredentials,
} from "@batonfx/providers/openai"
import { OpenAiAuth } from "@rika/app"
import { Config, Context, Effect, Function, Layer, Option, Redacted, Schema, Scope, Semaphore } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"

export interface ProviderRuntimePin {
  readonly adapter: string
  readonly credentialIdentity?: string
}

export class RuntimeError extends Schema.TaggedErrorClass<RuntimeError>()("ModelProviderRuntimeError", {
  message: Schema.String,
}) {}

interface Resolution {
  readonly runtime: ProviderRuntimePin
  readonly options: Readonly<Record<string, unknown>>
  readonly registrationKey: string
}

interface Adapter {
  readonly id: string
  readonly matchesConfigured: (route: ConfigContract.ResolvedModelRoute, account?: Account) => boolean
  readonly matchesPinned: (route: Turn.ExecutionModelRoute) => boolean
  readonly resolve: (route: ConfigContract.ResolvedModelRoute, account?: Account) => ProviderRuntimePin
  readonly options: (route: ConfigContract.ResolvedModelRoute) => Readonly<Record<string, unknown>>
  readonly register: (
    route: ConfigContract.ResolvedModelRoute,
    resolution: Resolution,
    account?: Account,
  ) => Effect.Effect<ModelRegistry.Registration, RuntimeError, Scope.Scope>
  readonly restore: (
    route: Turn.ExecutionModelRoute,
    runtime: ProviderRuntimePin,
  ) => Effect.Effect<ModelRegistry.Registration, RuntimeError, Scope.Scope>
}

interface Account {
  readonly fingerprint: string
  readonly auth: OpenAiAuth.ServiceInterface
}

export const normalizedBaseUrl = (value: string) => {
  const url = new URL(value)
  url.hash = ""
  url.pathname = url.pathname.replace(/\/+$/, "") || "/"
  return url.toString().replace(/\/(?=\?|$)/, "")
}

export const isNativeOpenAiRoute = (route: ConfigContract.ResolvedModelRoute) =>
  route.providerId === "openai" &&
  route.providerConnection.protocol === "openai" &&
  normalizedBaseUrl(route.providerConnection.baseUrl) ===
    normalizedBaseUrl(ConfigContract.defaults.providers.openai!.baseUrl)

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`
}

const sanitizeChatCompletion = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value
  const record = value as Record<string, unknown>
  if (Array.isArray(record.choices))
    for (const choice of record.choices as Array<Record<string, unknown>>) {
      const message = choice.message as Record<string, unknown> | undefined
      if (message?.tool_calls === null) delete message.tool_calls
      if (message !== undefined && message.content === undefined) message.content = null
    }
  return value
}

const sanitizedFetchLayer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return HttpClient.transformResponse(client, (effect) =>
      Effect.flatMap(effect, (response) => {
        const contentType = String(response.headers["content-type"] ?? "")
        if (!contentType.includes("application/json")) return Effect.succeed(response)
        return response.text.pipe(
          Effect.map((text) => {
            const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
            if (Option.isNone(decoded)) return response
            return HttpClientResponse.fromWeb(
              response.request,
              new Response(Schema.encodeSync(Schema.UnknownFromJsonString)(sanitizeChatCompletion(decoded.value)), {
                status: response.status,
                headers: { "content-type": contentType },
              }),
            )
          }),
          Effect.orElseSucceed(() => response),
        )
      }),
    )
  }),
).pipe(Layer.provide(FetchHttpClient.layer))

const provideScoped = <A, E, R, RO, LE, RI>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<RO, LE, RI>) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const parent = yield* Effect.context<RI | Exclude<R, RO>>()
    const provided = yield* Layer.buildWithScope(layer, scope)
    return yield* effect.pipe(Effect.provideContext(Context.merge(parent, provided)))
  })

const credential = (
  name: string | undefined,
  provider: string,
): Effect.Effect<Redacted.Redacted<string> | undefined, RuntimeError> =>
  name === undefined
    ? Effect.void.pipe(Effect.as(undefined as Redacted.Redacted<string> | undefined))
    : Config.option(Config.redacted(name)).pipe(
        Effect.flatMap((value) =>
          Option.match(value, {
            onNone: () =>
              Effect.fail(
                RuntimeError.make({ message: `Missing environment variable ${name} for provider ${provider}` }),
              ),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError(() =>
          RuntimeError.make({ message: `Missing environment variable ${name} for provider ${provider}` }),
        ),
      )

const batonCredentials = (auth: OpenAiAuth.ServiceInterface, fingerprint: string): OpenAiAccountCredentials => {
  const adapt = (
    operation: "acquire" | "refreshRejected",
    effect: Effect.Effect<OpenAiAuth.Credential, OpenAiAuth.Error>,
  ) =>
    effect.pipe(
      Effect.filterOrFail(
        (value) => value.fingerprint === fingerprint,
        () => OpenAiAccountCredentialError.make({ operation }),
      ),
      Effect.map((value) => ({
        accessToken: value.accessToken,
        accountId: Redacted.value(value.accountId),
        generation: value.generation,
      })),
      Effect.mapError(() => OpenAiAccountCredentialError.make({ operation })),
    )
  return {
    acquire: adapt("acquire", auth.acquire),
    refreshRejected: (generation) => adapt("refreshRejected", auth.refreshRejected(generation)),
  }
}

const streamingOnlyRegistration =
  (streamingOnly: boolean) =>
  (registration: ModelRegistry.Registration): ModelRegistry.Registration =>
    streamingOnly ? withStreamingOnlyModel(registration) : registration

const routeStreamingOnly = (route: ConfigContract.ResolvedModelRoute): boolean =>
  route.providerConnection.streamingOnly ?? ConfigContract.isStreamingOnlyBaseUrl(route.providerConnection.baseUrl)

const registerOpenAi = (route: ConfigContract.ResolvedModelRoute, resolution: Resolution) =>
  credential(route.providerConnection.apiKeyEnv, route.providerId).pipe(
    Effect.flatMap((apiKey) =>
      provideScoped(
        openAi({
          model: route.model,
          registrationKey: resolution.registrationKey,
          config: resolution.options as NonNullable<Parameters<typeof openAi>[0]["config"]>,
        }).pipe(
          Effect.map((registration) => ({ ...registration, provider: route.providerId })),
          Effect.map(streamingOnlyRegistration(routeStreamingOnly(route))),
        ),
        openAiClientLayerConfig({
          apiUrl: Config.succeed(route.providerConnection.baseUrl),
          apiKey: Config.succeed(apiKey),
        }).pipe(Layer.provide(sanitizedFetchLayer), Layer.orDie),
      ),
    ),
    Effect.mapError((error) =>
      Schema.is(RuntimeError)(error) ? error : RuntimeError.make({ message: String(error) }),
    ),
  )

const registerAnthropic = (route: ConfigContract.ResolvedModelRoute, resolution: Resolution) =>
  credential(route.providerConnection.apiKeyEnv, route.providerId).pipe(
    Effect.flatMap((apiKey) =>
      provideScoped(
        anthropic({
          model: route.model,
          registrationKey: resolution.registrationKey,
          config: resolution.options as NonNullable<Parameters<typeof anthropic>[0]["config"]>,
        }).pipe(
          Effect.map((registration) => ({ ...registration, provider: route.providerId })),
          Effect.map(streamingOnlyRegistration(routeStreamingOnly(route))),
        ),
        anthropicClientLayerConfig({
          apiUrl: Config.succeed(route.providerConnection.baseUrl),
          apiKey: Config.succeed(apiKey),
        }).pipe(Layer.provide(sanitizedFetchLayer), Layer.orDie),
      ),
    ),
    Effect.mapError((error) =>
      Schema.is(RuntimeError)(error) ? error : RuntimeError.make({ message: String(error) }),
    ),
  )

const unavailableRestore = (route: Turn.ExecutionModelRoute) =>
  Effect.fail(RuntimeError.make({ message: `Pinned provider adapter for ${route.provider} is unavailable` }))

const configuredFromPin = (
  route: Turn.ExecutionModelRoute,
  runtime: ProviderRuntimePin,
): ConfigContract.ResolvedModelRoute => ({
  alias: route.alias,
  effort: route.effort as ConfigContract.Effort,
  fast: route.fast,
  providerId: route.provider as ConfigContract.ProviderId,
  providerConnection: {
    protocol: route.providerProtocol as ConfigContract.ProviderId,
    baseUrl: route.providerBaseUrl,
    ...(runtime.credentialIdentity === undefined ? {} : { apiKeyEnv: runtime.credentialIdentity }),
  },
  candidates: [route.model],
  model: route.model,
  compaction: route.compaction,
  maxOutputTokens: Number(
    (route.providerOptions ?? {}).max_output_tokens ??
      (route.providerOptions ?? {}).max_tokens ??
      route.compaction.reserveTokens,
  ),
  options: route.providerOptions ?? {},
})

const adapters = (auth: OpenAiAuth.ServiceInterface): ReadonlyArray<Adapter> => [
  {
    id: "openai-account",
    matchesConfigured: (route, account) => account !== undefined && isNativeOpenAiRoute(route),
    matchesPinned: (route) =>
      route.providerRuntime?.adapter === "openai-account" || route.openAiAccountFingerprint !== undefined,
    resolve: (_route, account) => ({ adapter: "openai-account", credentialIdentity: account!.fingerprint }),
    options: (route) => {
      const { max_output_tokens: _, ...options } = route.options
      return { ...options, store: false }
    },
    register: (route, resolution, account) =>
      provideScoped(
        openAiAccount({
          model: route.model,
          registrationKey: resolution.registrationKey,
          credentials: batonCredentials(account!.auth, account!.fingerprint),
          config: resolution.options as NonNullable<Parameters<typeof openAiAccount>[0]["config"]>,
        }).pipe(
          Effect.map((registration) => ({ ...registration, provider: route.providerId })),
          Effect.map(withStreamingOnlyModel),
        ),
        sanitizedFetchLayer,
      ).pipe(Effect.mapError((error) => RuntimeError.make({ message: String(error) }))),
    restore: (route, runtime) =>
      runtime.credentialIdentity === undefined ||
      route.provider !== "openai" ||
      route.providerProtocol !== "openai" ||
      normalizedBaseUrl(route.providerBaseUrl) !== normalizedBaseUrl(ConfigContract.defaults.providers.openai!.baseUrl)
        ? unavailableRestore(route)
        : provideScoped(
            openAiAccount({
              model: route.model,
              registrationKey: route.registrationKey,
              credentials: batonCredentials(auth, runtime.credentialIdentity),
              config: {
                ...Object.fromEntries(
                  Object.entries(route.providerOptions ?? {}).filter(([name]) => name !== "max_output_tokens"),
                ),
                store: false,
              } as NonNullable<Parameters<typeof openAiAccount>[0]["config"]>,
            }).pipe(
              Effect.map((registration) => ({ ...registration, provider: route.provider })),
              Effect.map(withStreamingOnlyModel),
            ),
            sanitizedFetchLayer,
          ).pipe(Effect.mapError((error) => RuntimeError.make({ message: String(error) }))),
  },
  {
    id: "openai",
    matchesConfigured: (route) => route.providerConnection.protocol === "openai",
    matchesPinned: (route) =>
      route.providerRuntime?.adapter === "openai" ||
      (route.providerRuntime === undefined &&
        route.openAiAccountFingerprint === undefined &&
        route.providerProtocol === "openai"),
    resolve: (route) => ({
      adapter: "openai",
      ...(route.providerConnection.apiKeyEnv === undefined
        ? {}
        : { credentialIdentity: route.providerConnection.apiKeyEnv }),
    }),
    options: (route) => ({ ...route.options, max_output_tokens: route.maxOutputTokens }),
    register: registerOpenAi,
    restore: (route, runtime) =>
      registerOpenAi(configuredFromPin(route, runtime), {
        runtime,
        registrationKey: route.registrationKey,
        options: route.providerOptions ?? {},
      }),
  },
  {
    id: "anthropic",
    matchesConfigured: (route) => route.providerConnection.protocol === "anthropic",
    matchesPinned: (route) =>
      route.providerRuntime?.adapter === "anthropic" ||
      (route.providerRuntime === undefined && route.providerProtocol === "anthropic"),
    resolve: (route) => ({
      adapter: "anthropic",
      ...(route.providerConnection.apiKeyEnv === undefined
        ? {}
        : { credentialIdentity: route.providerConnection.apiKeyEnv }),
    }),
    options: (route) => ({ ...route.options, max_tokens: route.maxOutputTokens }),
    register: registerAnthropic,
    restore: (route, runtime) =>
      registerAnthropic(configuredFromPin(route, runtime), {
        runtime,
        registrationKey: route.registrationKey,
        options: route.providerOptions ?? {},
      }),
  },
]

export const normalizePinnedRuntime = (route: Turn.ExecutionModelRoute): ProviderRuntimePin =>
  route.providerRuntime ??
  (route.openAiAccountFingerprint !== undefined
    ? { adapter: "openai-account", credentialIdentity: route.openAiAccountFingerprint }
    : {
        adapter: route.providerProtocol,
        ...(route.providerApiKeyEnv === undefined ? {} : { credentialIdentity: route.providerApiKeyEnv }),
      })

const accountStatus = (auth: OpenAiAuth.ServiceInterface) =>
  auth.status.pipe(
    Effect.flatMap((status) => {
      if (status._tag === "Present" || status._tag === "RefreshRequired")
        return Effect.succeed({ fingerprint: status.fingerprint, auth })
      if (status._tag === "Unauthenticated") return Effect.void.pipe(Effect.as(undefined as Account | undefined))
      return Effect.fail(
        RuntimeError.make({ message: "OpenAI account credentials are corrupt; log out, then log in again" }),
      )
    }),
    Effect.mapError((error) =>
      Schema.is(RuntimeError)(error)
        ? error
        : RuntimeError.make({ message: "OpenAI account credentials could not be read" }),
    ),
  )

export interface PreparedRoutes {
  readonly routes: ReadonlyArray<ConfigContract.ResolvedModelRoute>
  readonly plans: ReadonlyArray<ReturnType<typeof plan>>
  readonly registrations: ReadonlyArray<ModelRegistry.Registration>
}

const plan = (route: ConfigContract.ResolvedModelRoute, adapter: Adapter, account?: Account) => {
  const runtime = adapter.resolve(route, account)
  const options = adapter.options(route)
  const registrationKey = `sha256:${createHash("sha256")
    .update(
      canonical({
        adapter: runtime.adapter,
        credentialIdentity: runtime.credentialIdentity,
        provider: route.providerId,
        baseUrl: normalizedBaseUrl(route.providerConnection.baseUrl),
        model: route.model,
        effort: route.effort,
        fast: route.fast,
        options,
      }),
    )
    .digest("hex")}`
  return {
    registrationKey,
    selection: { provider: route.providerId, model: route.model, registrationKey },
    compaction: {
      contextWindow: route.compaction.contextWindow ?? Models.defaultCompaction.contextWindow,
      reserveTokens: route.compaction.reserveTokens ?? Models.defaultCompaction.reserveTokens,
      keepRecentTokens: route.compaction.keepRecentTokens ?? Models.defaultCompaction.keepRecentTokens,
    } satisfies Compaction.DefaultOptions,
    runtime,
    providerRuntime: runtime,
    options,
  }
}

const purePlan = (route: ConfigContract.ResolvedModelRoute, fingerprint?: string) => {
  const available = adapters({} as OpenAiAuth.ServiceInterface)
  const adapter =
    fingerprint !== undefined && isNativeOpenAiRoute(route)
      ? available[0]!
      : available.find((candidate) => candidate.id === route.providerConnection.protocol)!
  return plan(
    route,
    adapter,
    fingerprint === undefined ? undefined : { fingerprint, auth: {} as OpenAiAuth.ServiceInterface },
  )
}

export const modelRoutePlan = Function.dual((args) => typeof args[0] === "object", purePlan) as {
  (route: ConfigContract.ResolvedModelRoute, fingerprint?: string): ReturnType<typeof plan>
  (fingerprint?: string): (route: ConfigContract.ResolvedModelRoute) => ReturnType<typeof plan>
}
export const providerRuntimePin = Function.dual(
  (args) => typeof args[0] === "object",
  (route: ConfigContract.ResolvedModelRoute, fingerprint?: string) => purePlan(route, fingerprint).runtime,
) as {
  (route: ConfigContract.ResolvedModelRoute, fingerprint?: string): ProviderRuntimePin
  (fingerprint?: string): (route: ConfigContract.ResolvedModelRoute) => ProviderRuntimePin
}
export const requestOptions = Function.dual(
  (args) => typeof args[0] === "object",
  (route: ConfigContract.ResolvedModelRoute, fingerprint?: string) => purePlan(route, fingerprint).options,
) as {
  (route: ConfigContract.ResolvedModelRoute, fingerprint?: string): Readonly<Record<string, unknown>>
  (fingerprint?: string): (route: ConfigContract.ResolvedModelRoute) => Readonly<Record<string, unknown>>
}

export interface ServiceInterface {
  readonly prepare: (
    routes: ReadonlyArray<ConfigContract.ResolvedModelRoute>,
  ) => Effect.Effect<PreparedRoutes, RuntimeError>
  readonly restore: (
    routes: ReadonlyArray<Turn.ExecutionModelRoute>,
  ) => Effect.Effect<ReadonlyArray<ModelRegistry.Registration>, RuntimeError>
  readonly restoreOne: (route: Turn.ExecutionModelRoute) => Effect.Effect<ModelRegistry.Registration, RuntimeError>
  readonly normalizePinned: (route: Turn.ExecutionModelRoute) => ProviderRuntimePin
}

export class Service extends Context.Service<Service, ServiceInterface>()("@rika/cli/model-provider-runtime/Service") {
  static readonly layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const auth = yield* OpenAiAuth.Service
      const scope = yield* Effect.scope
      const available = adapters(auth)
      const registrationAdmission = yield* Semaphore.make(1)
      const registrationCache = new Map<string, ModelRegistry.Registration>()
      const inScope = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, Scope.Scope, scope)
      const cachedRegistration = (
        key: string,
        acquire: Effect.Effect<ModelRegistry.Registration, RuntimeError, Scope.Scope>,
      ) =>
        registrationAdmission.withPermits(1)(
          Effect.gen(function* () {
            const existing = registrationCache.get(key)
            if (existing !== undefined) return existing
            const registration = yield* inScope(acquire)
            registrationCache.set(key, registration)
            return registration
          }),
        )
      const prepare: ServiceInterface["prepare"] = (routes) =>
        Effect.gen(function* () {
          const account = routes.some(isNativeOpenAiRoute) ? yield* accountStatus(auth) : undefined
          const resolutions = yield* Effect.forEach(routes, (route) => {
            const adapter = available.find((candidate) => candidate.matchesConfigured(route, account))
            if (adapter === undefined)
              return Effect.fail(
                RuntimeError.make({
                  message: `No model provider adapter supports protocol ${route.providerConnection.protocol} for provider ${route.providerId}`,
                }),
              )
            return Effect.succeed({ route, adapter, plan: plan(route, adapter, account) })
          })
          const distinct = resolutions.filter(
            (item, index, all) =>
              all.findIndex((other) => other.plan.registrationKey === item.plan.registrationKey) === index,
          )
          const registrations = yield* Effect.forEach(
            distinct,
            (item) =>
              cachedRegistration(
                `${item.route.providerId}\0${item.route.model}\0${item.plan.registrationKey}`,
                item.adapter.register(item.route, item.plan, account),
              ),
            { concurrency: 1 },
          )
          return { routes, plans: resolutions.map((item) => item.plan), registrations }
        })
      const restoreOne: ServiceInterface["restoreOne"] = (route) => {
        const runtime = normalizePinnedRuntime(route)
        const adapter = available.find(
          (candidate) => candidate.id === runtime.adapter && candidate.matchesPinned(route),
        )
        return adapter === undefined
          ? unavailableRestore(route)
          : cachedRegistration(
              `${route.provider}\0${route.model}\0${route.registrationKey}`,
              adapter.restore(route, runtime),
            )
      }
      return Service.of({
        prepare,
        normalizePinned: normalizePinnedRuntime,
        restoreOne,
        restore: (routes) =>
          Effect.forEach(
            routes.filter(
              (route, index, all) =>
                route.providerProtocol !== "test" &&
                all.findIndex((other) => other.registrationKey === route.registrationKey) === index,
            ),
            restoreOne,
            { concurrency: 1 },
          ),
      })
    }),
  )
}

export const bypassLayer = Layer.succeed(
  Service,
  Service.of({
    prepare: () => Effect.die("Model provider runtime is unavailable for test models"),
    restore: () => Effect.die("Model provider runtime is unavailable for test models"),
    restoreOne: () => Effect.die("Model provider runtime is unavailable for test models"),
    normalizePinned: normalizePinnedRuntime,
  }),
)

import { Config, Diagnostics } from "@rika/core"
import { Cause, Clock, Context, Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import * as Modes from "./modes"
import * as Provider from "./provider"

export interface Request extends Schema.Schema.Type<typeof Request>, Provider.RuntimeOptions {}
export const Request = Schema.Struct({
  mode: Schema.optional(Modes.ModeName),
  profile: Schema.optional(Modes.ProfileName),
  provider: Schema.optional(Provider.ProviderName),
  model: Schema.optional(Provider.ModelId),
  messages: Schema.Array(Provider.Message),
  reasoning_effort: Schema.optional(Provider.ReasoningEffort),
  temperature: Schema.optional(Schema.Number),
  metadata: Schema.optional(Provider.Metadata),
  fast_mode: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Rika.LLM.Router.Request" })

export interface RoutedRequest extends Schema.Schema.Type<typeof RoutedRequest>, Provider.RuntimeOptions {}
export const RoutedRequest = Schema.Struct({
  mode: Modes.ModeName,
  profile: Schema.optional(Modes.ProfileName),
  provider: Provider.ProviderName,
  model: Provider.ModelId,
  messages: Schema.Array(Provider.Message),
  reasoning_effort: Provider.ReasoningEffort,
  temperature: Schema.optional(Schema.Number),
  metadata: Schema.optional(Provider.Metadata),
  service_tier: Schema.optional(Provider.ServiceTier),
}).annotate({ identifier: "Rika.LLM.Router.RoutedRequest" })

export class RouterError extends Schema.TaggedErrorClass<RouterError>()("RouterError", {
  message: Schema.String,
  mode: Schema.optional(Modes.ModeName),
  profile: Schema.optional(Modes.ProfileName),
  provider: Schema.optional(Provider.ProviderName),
}) {}

export interface Interface {
  readonly route: (request: Request) => Effect.Effect<RoutedRequest, RouterError>
  readonly complete: (
    request: Request,
  ) => Effect.Effect<Provider.GenerateResponse, Provider.ProviderError | RouterError>
  readonly stream: (request: Request) => Stream.Stream<Provider.StreamEvent, Provider.ProviderError | RouterError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/llm/Router") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const registry = yield* Provider.Registry
    const route = makeRoute(config)

    return Service.of({
      route,
      complete: Effect.fn("LLM.Router.complete")(function* (request: Request) {
        const routed = yield* route(request)
        const provider = yield* providerFor(registry, routed)
        const startedAt = yield* Clock.currentTimeMillis
        const fields = llmCallSeed(routed, "message")
        return yield* provider.complete(routed).pipe(
          Effect.tap((response) => Effect.sync(() => enrichResponseFields(fields, response))),
          Effect.onExit((exit) => emitLlmCall(startedAt, fields, exit)),
        )
      }),
      stream: (request: Request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const routed = yield* route(request)
            const provider = yield* providerFor(registry, routed)
            return instrumentStream(routed, provider.stream(routed))
          }),
        ),
    })
  }),
)

export const route = Effect.fn("LLM.Router.route.call")(function* (request: Request) {
  const router = yield* Service
  return yield* router.route(request)
})

export const complete = Effect.fn("LLM.Router.complete.call")(function* (request: Request) {
  const router = yield* Service
  return yield* router.complete(request)
})

export const stream = (request: Request) => Stream.unwrap(Effect.map(Service, (router) => router.stream(request)))

const makeRoute = (config: Config.Interface) =>
  Effect.fn("LLM.Router.route")(function* (request: Request) {
    const values = yield* config.get
    const modeName = request.mode ?? values.default_mode
    const routing = request.profile === undefined ? Modes.get(modeName) : Modes.getProfile(request.profile)
    const provider = request.provider ?? routing.provider
    const model = request.model ?? Modes.primaryModel(routing)
    const temperature = request.temperature ?? routing.temperature
    const metadata = request.metadata
    const serviceTier: Provider.ServiceTier | undefined =
      request.fast_mode === true && provider === "openai" ? "priority" : undefined

    return {
      mode: modeName,
      ...(request.profile === undefined ? {} : { profile: request.profile }),
      provider,
      model,
      messages: request.messages,
      reasoning_effort: request.reasoning_effort ?? routing.reasoning_effort,
      ...(temperature === undefined ? {} : { temperature }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(serviceTier === undefined ? {} : { service_tier: serviceTier }),
      ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
      ...(request.toolkit === undefined ? {} : { toolkit: request.toolkit }),
    }
  })

const llmCallSeed = (routed: RoutedRequest, kind: "message" | "stream"): Diagnostics.Fields => ({
  provider: routed.provider,
  model: routed.model,
  mode: routed.mode,
  ...(routed.profile === undefined ? {} : { profile: routed.profile }),
  reasoning_effort: routed.reasoning_effort,
  ...(routed.service_tier === undefined ? {} : { service_tier: routed.service_tier }),
  request_kind: routed.toolkit === undefined ? kind : "tool",
  message_count: routed.messages.length,
})

const enrichResponseFields = (fields: Diagnostics.Fields, response: Provider.GenerateResponse): void => {
  if (response.id !== undefined) fields.response_id = response.id
  if (response.finish_reason !== undefined) fields.finish_reason = response.finish_reason
  const usage = response.usage
  if (usage === undefined) return
  if (usage.input_tokens !== undefined) fields.token_in = usage.input_tokens
  if (usage.output_tokens !== undefined) fields.token_out = usage.output_tokens
  if (usage.reasoning_tokens !== undefined) fields.reasoning_tokens = usage.reasoning_tokens
  if (usage.total_tokens !== undefined) fields.total_tokens = usage.total_tokens
}

const instrumentStream = (
  routed: RoutedRequest,
  source: Stream.Stream<Provider.StreamEvent, Provider.ProviderError>,
): Stream.Stream<Provider.StreamEvent, Provider.ProviderError> =>
  Stream.unwrap(
    Effect.map(Clock.currentTimeMillis, (startedAt) => {
      const fields = llmCallSeed(routed, "stream")
      let toolCalls = 0
      return source.pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            if (event.type === "tool.call") toolCalls += 1
            if (event.type === "response.completed") {
              fields.tool_call_count = toolCalls
              enrichResponseFields(fields, event.response)
            }
          }),
        ),
        Stream.onExit((exit) => emitLlmCall(startedAt, fields, exit)),
      )
    }),
  )

const emitLlmCall = <A>(
  startedAt: number,
  fields: Diagnostics.Fields,
  exit: Exit.Exit<A, Provider.ProviderError>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const service = yield* Effect.serviceOption(Diagnostics.Service)
    if (Option.isNone(service)) return
    const endedAt = yield* Clock.currentTimeMillis
    const outcome = Exit.isSuccess(exit) ? "success" : "error"
    yield* service.value.emit({
      level: outcome === "error" ? "error" : "info",
      message: `llm.call ${outcome}`,
      data: {
        ...fields,
        op: "llm.call",
        outcome,
        duration_ms: endedAt - startedAt,
        ...(Exit.isSuccess(exit) ? {} : { error: Cause.pretty(exit.cause) }),
      },
    })
  })

const providerFor = (registry: Provider.RegistryInterface, request: RoutedRequest) => {
  const provider = registry.get(request.provider)
  if (provider !== undefined) return Effect.succeed(provider)
  return new RouterError({
    message: `Mode ${request.mode} routed to provider ${request.provider}, but no provider layer is registered`,
    mode: request.mode,
    ...(request.profile === undefined ? {} : { profile: request.profile }),
    provider: request.provider,
  })
}

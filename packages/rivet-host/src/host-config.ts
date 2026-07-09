import { EnvConfig } from "@rika/core"
import type { Client, Registry } from "@rivetkit/effect"
import { ConfigProvider, Context, Effect, Layer, Schema } from "effect"

export const HostMode = Schema.Literals(["local"]).annotate({
  identifier: "Rika.RivetHost.HostConfig.HostMode",
})
export type HostMode = typeof HostMode.Type

export interface Resolved extends Schema.Schema.Type<typeof Resolved> {}
export const Resolved = Schema.Struct({
  mode: HostMode,
  endpoint: Schema.String,
  no_welcome: Schema.Boolean,
}).annotate({ identifier: "Rika.RivetHost.HostConfig.Resolved" })

export interface ResolveOptions {
  readonly endpoint?: string
  readonly noWelcome?: boolean
}

export class HostConfigError extends Schema.TaggedErrorClass<HostConfigError>()("HostConfigError", {
  message: Schema.String,
  key: Schema.optional(Schema.String),
}) {}

export interface Interface {
  readonly resolve: Effect.Effect<Resolved, HostConfigError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/rivet-host/HostConfig") {}

export const defaultLocalEndpoint = "http://127.0.0.1:6420"

export const resolveEnv = (env: Record<string, string | undefined> = process.env) => resolveOptions({}, env)

export const layerFromEnv = (env: Record<string, string | undefined> = process.env) =>
  Layer.succeed(
    Service,
    Service.of({
      resolve: Effect.suspend(() => resolveEnv(env)),
    }),
  )

export const layer = Layer.suspend(() => layerFromEnv())

export const resolve = Effect.fn("HostConfig.resolve.call")(function* () {
  const service = yield* Service
  return yield* service.resolve
})

export const resolveOptions = Effect.fn("HostConfig.resolveOptions")(function* (
  options: ResolveOptions = {},
  env: Record<string, string | undefined> = process.env,
) {
  const provider = EnvConfig.providerFromEnv(env, { booleanKeys: ["RIKA_RIVET_NO_WELCOME"] })
  const configuredEndpoint = options.endpoint ?? env.RIKA_RIVET_ENDPOINT
  const endpoint = configuredEndpoint ?? defaultLocalEndpoint
  yield* validateLocalEndpoint(endpoint)
  const noWelcome = options.noWelcome ?? (yield* noWelcomeFromEnv(provider))
  return {
    mode: "local" as const,
    endpoint,
    no_welcome: noWelcome,
  }
})

export const toRegistryOptions = (host: Resolved): Registry.Options => ({
  endpoint: host.endpoint,
  noWelcome: host.no_welcome,
})

export const toClientOptions = (host: Resolved): Client.Options => ({
  endpoint: host.endpoint,
})

const noWelcomeFromEnv = (provider: ConfigProvider.ConfigProvider) =>
  EnvConfig.optional(provider, EnvConfig.boolean("RIKA_RIVET_NO_WELCOME")).pipe(
    Effect.map((value) => value ?? true),
    Effect.mapError(
      () =>
        new HostConfigError({
          message: "Invalid RIKA_RIVET_NO_WELCOME",
          key: "RIKA_RIVET_NO_WELCOME",
        }),
    ),
  )

const validateLocalEndpoint = (endpoint: string) =>
  Effect.try({
    try: () => {
      const url = new URL(endpoint)
      if (url.protocol !== "http:") throw new Error("Rika local Rivet endpoint must use http")
      if (!localHostnames.has(url.hostname)) throw new Error("Rika local Rivet endpoint must point at localhost")
    },
    catch: (cause) =>
      new HostConfigError({
        message: cause instanceof Error ? cause.message : String(cause),
        key: "RIKA_RIVET_ENDPOINT",
      }),
  })

const localHostnames = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])

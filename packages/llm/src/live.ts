import { Config, Diagnostics } from "@rika/core"
import { Effect, Layer } from "effect"
import * as Anthropic from "./anthropic"
import * as OpenAi from "./openai"
import * as Provider from "./provider"
import * as Router from "./router"

export interface Options {
  readonly openai?: OpenAi.Options
  readonly anthropic?: Anthropic.Options
}

export const defaultModelProviderBaseUrl = "http://127.0.0.1:8317/v1"

export const optionsFromEnv = (env: Record<string, string | undefined>): Options => {
  const apiUrl = modelProviderBaseUrlFromEnv(env)
  const anthropicApiUrl = stripTrailingV1(apiUrl)

  return {
    openai: {
      apiKeyEnv: "RIKA_API_KEY",
      apiUrl,
    },
    anthropic: {
      apiKeyEnv: "RIKA_API_KEY",
      apiUrl: anthropicApiUrl,
    },
  }
}

export const modelProviderBaseUrlFromEnv = (env: Record<string, string | undefined>): string => {
  const configured = env.RIKA_BASE_URL?.trim()
  return configured === undefined || configured.length === 0 ? defaultModelProviderBaseUrl : configured
}

export const stripTrailingV1 = (apiUrl: string): string => {
  const normalized = apiUrl.replace(/\/+$/, "")
  return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized
}

export const providerRegistryLayer = (
  options: Options = {},
): Layer.Layer<Provider.Registry, Config.ConfigError, Config.Service> =>
  Layer.effect(
    Provider.Registry,
    Effect.gen(function* () {
      const providers = yield* Effect.all([OpenAi.provider(options.openai), Anthropic.provider(options.anthropic)])
      return Provider.registryFromProviders(providers)
    }),
  )

export const layer = (
  options: Options = {},
): Layer.Layer<Router.Service, Config.ConfigError, Config.Service | Diagnostics.Service> =>
  Router.layer.pipe(Layer.provideMerge(providerRegistryLayer(options)))

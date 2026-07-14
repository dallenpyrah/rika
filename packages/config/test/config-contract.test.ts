import { describe, expect, it } from "@effect/vitest"
import { ConfigContract, Models } from "../src/index"

describe("ConfigContract", () => {
  it("defines GPT-only main, Oracle, and specialized agent routes", () => {
    expect(ConfigContract.defaults.modes).toEqual({
      low: { main: { alias: "luna", effort: "low" }, oracle: { alias: "sol", effort: "high" } },
      medium: { main: { alias: "terra", effort: "medium" }, oracle: { alias: "sol", effort: "high" } },
      high: { main: { alias: "sol", effort: "xhigh" }, oracle: { alias: "sol", effort: "max" } },
      ultra: { main: { alias: "sol", effort: "max" }, oracle: { alias: "sol", effort: "max" } },
    })
    expect(ConfigContract.defaults.agents).toEqual({
      librarian: { alias: "sol", effort: "high" },
      painter: { alias: "sol", effort: "high" },
      review: { alias: "review", effort: "high" },
      readThread: { alias: "terra", effort: "medium" },
      task: { alias: "terra", effort: "medium" },
    })
    expect(ConfigContract.defaults.models.fable?.candidates).toEqual(["claude-fable-5", "claude-opus-4-8"])
    expect(ConfigContract.defaults.models.review?.candidates).toEqual(["gpt-5.5"])
    expect(ConfigContract.defaults.models.luna?.limits).toEqual({
      maxInputTokens: 922_000,
      maxOutputTokens: 128_000,
      keepRecentTokens: 32_000,
    })
    expect(ConfigContract.defaults.models.review?.limits).toEqual({
      maxInputTokens: 922_000,
      maxOutputTokens: 128_000,
      keepRecentTokens: 32_000,
    })
    expect(Models.catalog.gpt56Sol.limits).toEqual({
      contextWindow: 1_050_000,
      maxInputTokens: 922_000,
      maxOutputTokens: 128_000,
    })
    expect(Models.catalog.gpt56Sol.source).toBe("https://models.dev")
  })

  it.each(["providers", "provider", "model", "oracleModel", "reasoning", "baseUrl", "apiKey"])(
    "rejects legacy root key %s",
    (key) =>
      expect(() => ConfigContract.decodeSettingsInput("settings.json", { [key]: {} })).toThrowError(/unknown key/),
  )

  it("accepts an arbitrary protocol-discriminated gateway with explicit auth", () => {
    const input = {
      gateways: { moon: { protocol: "openai", baseUrl: "https://moon.test/v1", auth: { type: "none" } } },
    } as const
    expect(ConfigContract.decodeSettingsInput("settings.json", input)).toBe(input)
  })

  it.each(["not a url", "/v1", "ftp://moon.test/v1"])("rejects invalid gateway URL %s", (baseUrl) => {
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", {
        gateways: { moon: { protocol: "openai", baseUrl, auth: { type: "none" } } },
      }),
    ).toThrowError(/absolute HTTP or HTTPS URL/)
  })

  it.each([
    "https://user@moon.test/v1",
    "https://user:password@moon.test/v1",
    "https://moon.test/v1?api_key=secret",
    "https://moon.test/v1?access-token=secret",
    "https://moon.test/v1?auth=secret",
    "https://moon.test/v1?signature=secret",
    "https://moon.test/v1?sig=secret",
    "https://moon.test/v1?request-auth-value=secret",
    "https://moon.test/v1?request_signature_value=secret",
    "https://moon.test/v1?request.sig.value=secret",
  ])("rejects credentials in gateway URL %s", (baseUrl) => {
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", {
        gateways: { moon: { protocol: "openai", baseUrl, auth: { type: "none" } } },
      }),
    ).toThrowError(/cannot contain credentials/)
  })

  it.each([
    "apiKey",
    "access_token",
    "authorization",
    "nested.client-secret",
    "nested.items.0.password",
    "nested.auth",
    "nested.signature",
    "nested.sig",
    "nested.request-auth-value",
    "nested.request_signature_value",
    "nested.request-sig-value",
  ])("rejects credential-like provider option key %s recursively", (keyPath) => {
    const parts = keyPath.split(".")
    const options = parts.reduceRight<Record<string, unknown>>((value, key) => ({ [key]: value }), { value: true })
    const source = ConfigContract.defaults.models.luna!
    const model = { ...source, variants: { ...source.variants, low: { normal: { options } } } }
    expect(() => ConfigContract.decodeSettingsInput("settings.json", { models: { moon: model } })).toThrowError(
      /credential-like provider option key/,
    )
  })

  it("accepts legitimate model option keys at any depth", () => {
    const source = ConfigContract.defaults.models.luna!
    const model = {
      ...source,
      variants: {
        ...source.variants,
        low: {
          normal: {
            options: {
              reasoning: { effort: "low" },
              service_tier: "priority",
            },
          },
        },
      },
    }
    expect(ConfigContract.decodeSettingsInput("settings.json", { models: { moon: model } })).toMatchObject({
      models: { moon: model },
    })
  })

  it.each(["max_tokens", "max_output_tokens"])("owns provider output option %s through model limits", (key) => {
    const source = ConfigContract.defaults.models.luna!
    const model = {
      ...source,
      variants: {
        ...source.variants,
        low: { normal: { options: { reasoning: { effort: "low" }, [key]: 1 } } },
      },
    }
    expect(() => ConfigContract.decodeSettingsInput("settings.json", { models: { moon: model } })).toThrowError(
      /limits.maxOutputTokens/,
    )
  })

  it("requires bearer auth to name a valid environment variable", () => {
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", {
        gateways: {
          moon: { protocol: "openai", baseUrl: "https://moon.test/v1", auth: { type: "bearer-env" } },
        },
      }),
    ).toThrowError(/requires an environment variable/)
    expect(ConfigContract.defaults.gateways.openai!.auth).toEqual({ type: "bearer-env", variable: "OPENAI_API_KEY" })
    expect(ConfigContract.defaults.gateways.anthropic!.auth).toEqual({
      type: "bearer-env",
      variable: "ANTHROPIC_API_KEY",
    })
  })

  it("rejects inferred protocols and persisted secrets", () => {
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", { gateways: { moon: { baseUrl: "https://moon.test" } } }),
    ).toThrowError(/explicit supported protocol/)
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", {
        gateways: {
          moon: {
            protocol: "anthropic",
            baseUrl: "https://moon.test",
            auth: { type: "bearer-env", apiKey: "secret" },
          },
        },
      }),
    ).toThrowError(/unknown key apiKey/)
  })

  it("accepts supported logging levels and rejects custom log paths", () => {
    expect(ConfigContract.decodeSettingsInput("settings.json", { logging: { level: "debug" } })).toEqual({
      logging: { level: "debug" },
    })
    expect(() => ConfigContract.decodeSettingsInput("settings.json", { logging: { level: "verbose" } })).toThrowError(
      /Logging level/,
    )
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", { logging: { level: "info", file: "/tmp/rika.log" } }),
    ).toThrowError(/unknown key file/)
  })

  it("rejects incomplete and legacy mode shapes", () => {
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", { modes: { low: { model: "luna" } } }),
    ).toThrowError(/unknown key model/)
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", {
        modes: { low: { main: { alias: "luna", effort: "low" } } },
      }),
    ).toThrowError(/requires main and oracle/)
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", {
        modes: { low: { budget: 1, main: { alias: "luna", effort: "low" }, oracle: { alias: "sol", effort: "high" } } },
      }),
    ).toThrowError(/unknown key budget/)
  })

  it("enforces model limits and typed fast availability", () => {
    const bad = structuredClone(ConfigContract.defaults.models.luna!) as any
    bad.limits.keepRecentTokens = bad.limits.maxInputTokens
    expect(() => ConfigContract.decodeSettingsInput("settings.json", { models: { bad } })).toThrowError(
      /valid model limits/,
    )
    const settings: ConfigContract.Settings = {
      ...ConfigContract.defaults,
      modes: {
        ...ConfigContract.defaults.modes,
        high: { ...ConfigContract.defaults.modes.high, main: { alias: "fable", effort: "max", fast: true } },
      },
    }
    expect(() => ConfigContract.resolveModelRoute(settings, "high", "main")).toThrowError(
      /unavailable fable\/max\/fast/,
    )
  })

  it("derives provider output and operational compaction from model limits", () => {
    expect(ConfigContract.resolveModelRoute(ConfigContract.defaults, "medium", "main")).toMatchObject({
      alias: "terra",
      model: "gpt-5.6-terra",
      effort: "medium",
      options: { reasoning: { effort: "medium" }, max_output_tokens: 128_000 },
      compaction: { contextWindow: 1_050_000, reserveTokens: 128_000, keepRecentTokens: 32_000 },
    })
    expect(ConfigContract.resolveAgentRoute(ConfigContract.defaults, "review")).toMatchObject({
      alias: "review",
      model: "gpt-5.5",
      effort: "high",
    })
  })

  it("accepts configurable specialized agent routes and rejects unknown agents", () => {
    const input = {
      agents: {
        librarian: { alias: "terra", effort: "low" },
        readThread: { alias: "sol", effort: "xhigh", fast: true },
      },
    } as const
    expect(ConfigContract.decodeSettingsInput("settings.json", input)).toBe(input)
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", {
        agents: { unknown: { alias: "sol", effort: "high" } },
      }),
    ).toThrowError(/unknown key unknown/)
  })

  it("accepts a dedicated compaction summary model route", () => {
    const input = { compaction: { summaryModel: { alias: "terra", effort: "medium" } } } as const
    expect(ConfigContract.decodeSettingsInput("settings.json", input)).toBe(input)
    expect(
      ConfigContract.resolveCompactionSummaryRoute({ ...ConfigContract.defaults, compaction: input.compaction }),
    ).toMatchObject({ alias: "terra", model: "gpt-5.6-terra", effort: "medium" })
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", {
        compaction: { summaryModel: { alias: "terra", effort: "unsupported" } },
      }),
    ).toThrowError(/Compaction summary model requires alias and supported effort/)
  })

  it("accepts partial operational overrides for built-in models and requires complete custom models", () => {
    expect(
      ConfigContract.decodeSettingsInput("settings.json", {
        models: { luna: { limits: { maxInputTokens: 353_000 } } },
      }),
    ).toEqual({ models: { luna: { limits: { maxInputTokens: 353_000 } } } })
    expect(() =>
      ConfigContract.decodeSettingsInput("settings.json", {
        models: { custom: { limits: { maxInputTokens: 353_000 } } },
      }),
    ).toThrowError(/requires gateway and non-empty string candidates/)
  })
})

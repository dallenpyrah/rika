import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, Redacted } from "effect"
import { ConfigContract, ConfigService } from "../src/index"

describe("ConfigService", () => {
  it.effect("decodes an absent environment secret without inventing a credential", () =>
    Effect.gen(function* () {
      const config = yield* ConfigService.effective()
      expect(config.environment.parallelApiKey).toBeUndefined()
      expect(JSON.stringify(config)).not.toContain("PARALLEL_API_KEY")
    }).pipe(
      Effect.provide(
        ConfigService.liveEnvironmentLayer().pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        ),
      ),
    ),
  )

  it.effect("keeps a configured environment secret redacted", () => {
    const secret = "configured-secret-must-not-leak"
    return Effect.gen(function* () {
      const config = yield* ConfigService.effective()
      expect(config.environment.parallelApiKey).toBeDefined()
      expect(Redacted.value(config.environment.parallelApiKey!)).toBe(secret)
      expect(JSON.stringify(config)).not.toContain(secret)
    }).pipe(
      Effect.provide(
        ConfigService.liveEnvironmentLayer().pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { PARALLEL_API_KEY: secret } }))),
        ),
      ),
    )
  })

  it.effect("keeps copied environment secrets usable after the config layer scope closes", () => {
    const layer = ConfigService.liveEnvironmentLayer().pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { OPENROUTER_API_KEY: "model-secret" } }))),
    )
    return Effect.gen(function* () {
      const effective = yield* Effect.scoped(
        Layer.build(layer).pipe(Effect.map((context) => Context.get(context, ConfigService.Service))),
      ).pipe(Effect.flatMap((service: ConfigService.Interface) => service.effective))
      expect(Redacted.value(effective.environment.modelApiKey!)).toBe("model-secret")
    })
  })

  it.effect("resolves workspace over global over defaults deterministically", () =>
    Effect.gen(function* () {
      const config = yield* ConfigService.effective()
      expect(config.settings.logging).toEqual({ level: "debug", file: "/tmp/rika.log" })
      expect(config.settings.permissions).toEqual({
        read: "deny",
        search: "allow",
        write: "allow",
        shell: "allow",
        external: "allow",
      })
      expect(config.diagnostics).toEqual([
        { path: "logging", source: "global", message: "global value applied" },
        { path: "permissions", source: "global", message: "global value applied" },
        { path: "logging", source: "workspace", message: "workspace value applied" },
        { path: "permissions", source: "workspace", message: "workspace value applied" },
      ])
    }).pipe(
      Effect.provide(
        ConfigService.memoryLayer({
          global: { logging: { level: "debug", file: "/tmp/rika.log" }, permissions: { read: "deny" } },
          workspace: { logging: { level: "debug" }, permissions: { shell: "allow" } },
        }),
      ),
    ),
  )

  it.effect("keeps credentials redacted and reports only their presence", () =>
    Effect.gen(function* () {
      const config = yield* ConfigService.effective()
      expect(Redacted.value(config.environment.parallelApiKey!)).toBe("secret")
      expect(Redacted.value(config.environment.modelApiKey!)).toBe("model-secret")
      expect(JSON.stringify(config.diagnostics)).not.toContain("secret")
      expect(config.diagnostics.map((diagnostic) => diagnostic.path)).toEqual(["parallelApiKey", "modelApiKey"])
    }).pipe(
      Effect.provide(
        ConfigService.testLayer({
          environment: {
            parallelApiKey: Redacted.make("secret"),
            modelApiKey: Redacted.make("model-secret"),
          },
        }),
      ),
    ),
  )

  it.effect("merges aliases, modes, keymap, MCP, and notification settings", () =>
    Effect.gen(function* () {
      const config = yield* ConfigService.effective()
      expect(config.settings.models.local).toEqual({ provider: "test", model: "fake" })
      expect(config.settings.modes.medium.budget).toBe(99)
      expect(config.settings.keymap.submit).toBe("ctrl+enter")
      expect(config.settings.notifications.enabled).toBe(false)
      expect(config.settings.mcp.docs).toMatchObject({ transport: "remote" })
    }).pipe(
      Effect.provide(
        ConfigService.memoryLayer({
          workspace: {
            models: { local: { provider: "test", model: "fake" } },
            modes: { medium: { budget: 99 } },
            keymap: { submit: "ctrl+enter" },
            notifications: { enabled: false },
            mcp: { docs: { transport: "remote", url: "https://example.test/mcp", headers: {}, enabled: true } },
          },
        }),
      ),
    ),
  )

  it.effect("resolves workspace model and provider connection over global configuration", () =>
    Effect.gen(function* () {
      const config = yield* ConfigService.effective()
      expect(ConfigContract.resolveModelRoute(config.settings, "medium")).toEqual({
        alias: "gateway",
        provider: "vibe",
        model: "workspace-model",
        baseUrl: "https://workspace.vibe.test/v1",
      })
    }).pipe(
      Effect.provide(
        ConfigService.memoryLayer({
          global: {
            providers: { vibe: { baseUrl: "https://global.vibe.test/v1" } },
            models: { gateway: { provider: "vibe", model: "global-model" } },
            modes: { medium: { model: "gateway" } },
          },
          workspace: {
            providers: { vibe: { baseUrl: "https://workspace.vibe.test/v1" } },
            models: { gateway: { provider: "vibe", model: "workspace-model" } },
          },
        }),
      ),
    ),
  )

  it("rejects malformed and secret-bearing JSON configuration with typed failures", () => {
    expect(() => ConfigContract.decodeSettingsInput("bad.json", { providers: { vibe: { baseUrl: 42 } } })).toThrow(
      ConfigContract.ConfigFileError,
    )
    expect(() =>
      ConfigContract.decodeSettingsInput("secret.json", { providers: { vibe: { apiKey: "must-not-persist" } } }),
    ).toThrow(ConfigContract.ConfigFileError)
  })
})

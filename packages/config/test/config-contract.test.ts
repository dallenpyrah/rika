import { describe, expect, it } from "@effect/vitest"
import { ConfigContract } from "../src/index"

describe("ConfigContract", () => {
  describe("decodeSettingsInput", () => {
    it.each([null, "settings", 42, [], true])("rejects a malformed root value: %j", (value) => {
      expect(() => ConfigContract.decodeSettingsInput("settings.json", value)).toThrowError(
        expect.objectContaining({
          _tag: "ConfigFileError",
          path: "settings.json",
          message: "Configuration must be a JSON object",
        }),
      )
    })

    it.each([null, "provider", []])("rejects a malformed provider: %j", (provider) => {
      expect(() =>
        ConfigContract.decodeSettingsInput("settings.json", { providers: { local: provider } }),
      ).toThrowError(expect.objectContaining({ message: "Provider local must be an object" }))
    })

    it("rejects a non-string provider baseUrl", () => {
      expect(() =>
        ConfigContract.decodeSettingsInput("settings.json", { providers: { local: { baseUrl: 8080 } } }),
      ).toThrowError(expect.objectContaining({ message: "Provider local baseUrl must be a string" }))
    })

    it.each([null, "alias", {}, { provider: "local" }, { model: "model-id" }, { provider: 1, model: "model-id" }])(
      "rejects a malformed model alias: %j",
      (alias) => {
        expect(() => ConfigContract.decodeSettingsInput("settings.json", { models: { fast: alias } })).toThrowError(
          expect.objectContaining({ message: "Model alias fast requires string provider and model" }),
        )
      },
    )

    it.each([
      [{ apiKey: "secret" }, "apiKey is environment-only"],
      [{ providers: { local: { apiKey: "secret" } } }, "Provider local apiKey is environment-only"],
    ])("rejects persisted credentials", (value, message) => {
      expect(() => ConfigContract.decodeSettingsInput("settings.json", value)).toThrowError(
        expect.objectContaining({ message }),
      )
    })

    it("returns valid typed provider and model settings", () => {
      const input = {
        providers: { local: { baseUrl: "https://models.example.test/v1" }, direct: {} },
        models: { fast: { provider: "local", model: "model-id" } },
      }
      expect(ConfigContract.decodeSettingsInput("settings.json", input)).toBe(input)
    })
  })

  describe("resolveModelRoute", () => {
    const settings = (provider: ConfigContract.ProviderConnection | undefined): ConfigContract.Settings => ({
      ...ConfigContract.defaults,
      providers: provider === undefined ? {} : { local: provider },
      models: { fast: { provider: "local", model: "model-id" } },
      modes: { ...ConfigContract.defaults.modes, medium: { ...ConfigContract.defaults.modes.medium, model: "fast" } },
    })

    it("rejects a missing model alias with a typed route error", () => {
      const value = { ...settings({}), models: {} }
      expect(() => ConfigContract.resolveModelRoute(value, "medium")).toThrowError(
        expect.objectContaining({
          _tag: "ModelRouteError",
          mode: "medium",
          message: "Mode medium references missing model alias fast",
        }),
      )
    })

    it("resolves a provider baseUrl", () => {
      expect(
        ConfigContract.resolveModelRoute(settings({ baseUrl: "https://models.example.test/v1" }), "medium"),
      ).toEqual({
        alias: "fast",
        provider: "local",
        model: "model-id",
        baseUrl: "https://models.example.test/v1",
      })
    })

    it.each([undefined, {}])("resolves without a baseUrl when the provider connection is %j", (provider) => {
      expect(ConfigContract.resolveModelRoute(settings(provider), "medium")).toEqual({
        alias: "fast",
        provider: "local",
        model: "model-id",
      })
    })
  })
})

import { expect, test } from "vitest"
import { OpenAiAuth } from "@rika/app"
import { ConfigContract } from "@rika/config"
import * as Turn from "@rika/persistence/turn"
import { Cause, ConfigProvider, Context, Effect, Layer, Redacted, Schema, Scope } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import {
  executionModelRoutes,
  executionRoutePin,
  executionRoutePinFromPrepared,
  modelRoutesForExecution,
} from "../src/main"
import * as ModelProviderRuntime from "../src/model-provider-runtime"

const credential = (fingerprint: string): OpenAiAuth.Credential => ({
  accessToken: Redacted.make("account-access-token"),
  idToken: Redacted.make("account-id-token"),
  refreshToken: Redacted.make("account-refresh-token"),
  accountId: Redacted.make("account-id"),
  fingerprint,
  generation: `${fingerprint}.generation`,
  expiresAt: Number.MAX_SAFE_INTEGER,
  refreshedAt: 1,
})

const authService = (
  status: OpenAiAuth.Status = { _tag: "Unauthenticated" },
  acquireFingerprint = status._tag === "Present" || status._tag === "RefreshRequired" ? status.fingerprint : "none",
): OpenAiAuth.ServiceInterface => ({
  loginBrowser: () => Effect.succeed(credential(acquireFingerprint)),
  loginDevice: Effect.succeed(credential(acquireFingerprint)),
  status: Effect.succeed(status),
  logout: Effect.succeed({ removed: true, revocationSupported: false }),
  acquire: Effect.succeed(credential(acquireFingerprint)),
  refreshRejected: () => Effect.succeed(credential(acquireFingerprint)),
})

const runtimeLayer = (auth: OpenAiAuth.ServiceInterface) =>
  ModelProviderRuntime.Service.layer.pipe(Layer.provide(Layer.succeed(OpenAiAuth.Service, auth)))

const withRuntime = <A, E>(
  auth: OpenAiAuth.ServiceInterface,
  effect: (runtime: ModelProviderRuntime.ServiceInterface) => Effect.Effect<A, E, Scope.Scope>,
  environment: Readonly<Record<string, string>> = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(runtimeLayer(auth))
      return yield* effect(Context.get(context, ModelProviderRuntime.Service))
    }),
  ).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)))

test("prepares distinct registrations for every default model tuple and aligns every pin", () =>
  Effect.runPromise(
    withRuntime(
      authService(),
      (runtime) =>
        Effect.gen(function* () {
          const modes = Object.keys(ConfigContract.defaults.modes) as Array<ConfigContract.ModeId>
          const efforts = ["low", "medium", "high", "xhigh", "max"] as const
          const variants = modes.flatMap((mode) =>
            efforts.flatMap((effort) => {
              const configured = ConfigContract.defaults.modes[mode]
              const settings: ConfigContract.Settings = {
                ...ConfigContract.defaults,
                modes: {
                  ...ConfigContract.defaults.modes,
                  [mode]: {
                    main: { ...configured.main, effort },
                    oracle: { ...configured.oracle, effort },
                  },
                },
              }
              return [false, true].map((fastMode) => ({ mode, settings, tuning: { fastMode } }))
            }),
          )
          const routes = variants.flatMap(({ mode, settings, tuning }) =>
            modelRoutesForExecution(settings, mode, tuning),
          )
          const prepared = yield* runtime.prepare(routes)
          expect(prepared.registrations).toHaveLength(30)
          expect(new Set(prepared.registrations.map((item) => item.registrationKey)).size).toBe(30)
          const tuples = new Set(
            prepared.registrations.map((item) => `${item.provider}\0${item.model}\0${item.registrationKey}`),
          )
          for (const { mode, settings, tuning } of variants)
            for (const route of executionModelRoutes(executionRoutePin(settings, mode, tuning)))
              expect(tuples.has(`${route.provider}\0${route.model}\0${route.registrationKey}`)).toBe(true)
        }),
      { OPENAI_API_KEY: "test-api-key" },
    ),
  ))

test("sends configured reasoning effort and summary to custom OpenAI requests", () => {
  const requests = new Array<Record<string, unknown>>()
  const server = Bun.serve({
    port: 0,
    fetch: (request) =>
      request.json().then((value) => {
        requests.push(value as Record<string, unknown>)
        return Response.json({})
      }),
  })
  const settings: ConfigContract.Settings = {
    ...ConfigContract.defaults,
    providers: {
      ...ConfigContract.defaults.providers,
      openai: { protocol: "openai", baseUrl: server.url.toString() },
    },
  }
  return Effect.runPromise(
    withRuntime(authService(), (runtime) =>
      Effect.gen(function* () {
        for (const mode of ["low", "medium", "high", "ultra"] as const) {
          const prepared = yield* runtime.prepare([ConfigContract.resolveModelRoute(settings, mode, "main")])
          const context = yield* Layer.build(prepared.registrations[0]!.layer)
          yield* Effect.exit(LanguageModel.generateText({ prompt: mode }).pipe(Effect.provide(context)))
        }
        expect(requests.map((request) => request.reasoning)).toEqual([
          { effort: "low", summary: "auto" },
          { effort: "medium", summary: "auto" },
          { effort: "xhigh", summary: "auto" },
          { effort: "max", summary: "auto" },
        ])
      }),
    ).pipe(Effect.ensuring(Effect.promise(() => server.stop(true)))),
  )
})

test("retains Anthropic registration behavior", () =>
  Effect.runPromise(
    withRuntime(
      authService(),
      (runtime) =>
        Effect.gen(function* () {
          const settings: ConfigContract.Settings = {
            ...ConfigContract.defaults,
            modes: {
              ...ConfigContract.defaults.modes,
              low: { ...ConfigContract.defaults.modes.low, main: { alias: "fable", effort: "low" } },
            },
          }
          const route = ConfigContract.resolveModelRoute(settings, "low", "main")
          const prepared = yield* runtime.prepare([route])
          expect(prepared.registrations[0]).toMatchObject({
            provider: "anthropic",
            model: "claude-fable-5",
            registrationKey: ModelProviderRuntime.modelRoutePlan(route).registrationKey,
          })
        }),
      { ANTHROPIC_API_KEY: "test" },
    ),
  ))

test("fails before registration when an API credential is missing without exposing a secret", () =>
  Effect.runPromise(
    withRuntime(authService(), (runtime) =>
      Effect.gen(function* () {
        const route = ConfigContract.resolveModelRoute(ConfigContract.defaults, "medium", "main")
        const exit = yield* Effect.exit(runtime.prepare([route]))
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          const text = Cause.pretty(exit.cause)
          expect(text).toContain("OPENAI_API_KEY")
          expect(text).toContain("openai")
          expect(text).not.toContain("account-access-token")
        }
      }),
    ),
  ))

test("uses a native OpenAI account without an API key and applies account request constraints", () =>
  Effect.runPromise(
    withRuntime(authService({ _tag: "Present", fingerprint: "account-a" }), (runtime) =>
      Effect.gen(function* () {
        const routes = modelRoutesForExecution(ConfigContract.defaults, "medium")
        const prepared = yield* runtime.prepare(routes)
        expect(prepared.registrations.length).toBeGreaterThan(0)
        expect(prepared.plans[0]?.runtime).toEqual({ adapter: "openai-account", credentialIdentity: "account-a" })
        expect(prepared.plans[0]?.options).toMatchObject({ store: false })
        expect(prepared.plans[0]?.options).not.toHaveProperty("max_output_tokens")
        const execution = executionRoutePinFromPrepared("medium", prepared)
        expect(execution.main.providerRuntime).toEqual({
          adapter: "openai-account",
          credentialIdentity: "account-a",
        })
        expect(execution.main.openAiAccountFingerprint).toBe("account-a")
      }),
    ),
  ))

test("pins provider runtime identity, roundtrips JSON, and normalizes old account pins", () => {
  const route = ConfigContract.resolveModelRoute(ConfigContract.defaults, "medium", "main")
  const api = ModelProviderRuntime.modelRoutePlan(route)
  const account = ModelProviderRuntime.modelRoutePlan(route, "account-a")
  expect(api.runtime).toEqual({ adapter: "openai", credentialIdentity: "OPENAI_API_KEY" })
  expect(account.runtime).toEqual({ adapter: "openai-account", credentialIdentity: "account-a" })
  expect(account.registrationKey).not.toBe(api.registrationKey)
  const pin = executionRoutePin(ConfigContract.defaults, "medium")
  const encoded = Schema.decodeUnknownSync(Turn.ExecutionRoutePin)(JSON.parse(JSON.stringify(pin)))
  expect(encoded.main.providerRuntime).toEqual(pin.main.providerRuntime)
  const { providerRuntime: _, ...oldPin } = pin.main
  expect(
    ModelProviderRuntime.normalizePinnedRuntime(
      Schema.decodeUnknownSync(Turn.ExecutionModelRoute)({
        ...oldPin,
        openAiAccountFingerprint: "old-account",
      }),
    ),
  ).toEqual({ adapter: "openai-account", credentialIdentity: "old-account" })
})

test("custom OpenAI and Anthropic routes never evaluate corrupt account status", () =>
  Effect.runPromise(
    withRuntime(
      { ...authService(), status: Effect.fail(OpenAiAuth.StoreError.make({ kind: "corrupt", message: "hidden" })) },
      (runtime) =>
        Effect.gen(function* () {
          const settings: ConfigContract.Settings = {
            ...ConfigContract.defaults,
            providers: {
              ...ConfigContract.defaults.providers,
              openai: { protocol: "openai", baseUrl: "https://models.example.test/v1" },
            },
          }
          const routes = [
            ConfigContract.resolveModelRoute(settings, "medium", "main"),
            ConfigContract.resolveModelRoute(settings, "low", "main"),
          ]
          const prepared = yield* runtime.prepare(routes)
          expect(prepared.registrations).toHaveLength(2)
        }),
      { OPENAI_API_KEY: "test", ANTHROPIC_API_KEY: "test" },
    ),
  ))

test("observes a login between prepare calls without rebuilding the runtime", () => {
  let status: OpenAiAuth.Status = { _tag: "Unauthenticated" }
  const auth = { ...authService(), status: Effect.sync(() => status), acquire: Effect.succeed(credential("account-a")) }
  return Effect.runPromise(
    withRuntime(
      auth,
      (runtime) =>
        Effect.gen(function* () {
          const route = ConfigContract.resolveModelRoute(ConfigContract.defaults, "medium", "main")
          const first = yield* runtime.prepare([route])
          status = { _tag: "Present", fingerprint: "account-a" }
          const second = yield* runtime.prepare([route])
          expect(first.plans[0]?.runtime.adapter).toBe("openai")
          expect(second.plans[0]?.runtime.adapter).toBe("openai-account")
        }),
      { OPENAI_API_KEY: "test" },
    ),
  )
})

test("reuses one scoped registration across repeated prepare calls", () =>
  Effect.runPromise(
    withRuntime(
      authService(),
      (runtime) =>
        Effect.gen(function* () {
          const route = ConfigContract.resolveModelRoute(ConfigContract.defaults, "medium", "main")
          const first = yield* runtime.prepare([route])
          const second = yield* runtime.prepare([route])
          expect(second.registrations[0]).toBe(first.registrations[0])
        }),
      { OPENAI_API_KEY: "test" },
    ),
  ))

test("fails a mismatched account fingerprint before a request", () =>
  Effect.runPromise(
    withRuntime(authService({ _tag: "Present", fingerprint: "account-a" }, "account-b"), (runtime) =>
      Effect.gen(function* () {
        const prepared = yield* runtime.prepare([
          ConfigContract.resolveModelRoute(ConfigContract.defaults, "medium", "main"),
        ])
        const context = yield* Layer.build(prepared.registrations[0]!.layer)
        const exit = yield* Effect.exit(
          LanguageModel.generateText({ prompt: "must not send" }).pipe(Effect.provide(context)),
        )
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("account credential acquire failed")
      }),
    ),
  ))

test("restores old API and account routes with their stored registration keys", () =>
  Effect.runPromise(
    withRuntime(
      authService({ _tag: "Present", fingerprint: "account-a" }),
      (runtime) =>
        Effect.gen(function* () {
          const base = executionRoutePin(ConfigContract.defaults, "medium").main
          const { providerRuntime: _, ...oldBase } = base
          const api = yield* Schema.decodeUnknownEffect(Turn.ExecutionModelRoute)({
            ...oldBase,
            registrationKey: "stored-api",
          })
          const { providerApiKeyEnv: __, ...accountBase } = oldBase
          const account = yield* Schema.decodeUnknownEffect(Turn.ExecutionModelRoute)({
            ...accountBase,
            openAiAccountFingerprint: "account-a",
            registrationKey: "stored-account",
          })
          const restored = yield* runtime.restore([api, account])
          expect(restored.map((item) => item.registrationKey)).toEqual(["stored-api", "stored-account"])
        }),
      { OPENAI_API_KEY: "test" },
    ),
  ))

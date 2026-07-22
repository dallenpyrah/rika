import { expect, test } from "vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { createTestRenderer } from "@opentui/core/testing"
import { Cause, Context, Deferred, Effect, Fiber, FileSystem, Layer, Path, Redacted, Schema } from "effect"
import { Operation } from "@rika/app"
import { ConfigContract } from "@rika/config"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { ViewState } from "@rika/tui"
import { Surface } from "@rika/tui/adapter"
import { withClientWorkspace } from "../src/startup-runtime"
import { canonicalDatabaseRoot } from "../src/main"
import { modelRoutePlan } from "../src/model-provider-runtime"
import { validateWebSearchProviders } from "../src/backend-composition"
import {
  executionModelRoutes,
  executionRoutePin,
  modelRoutesForExecution,
  productionCompaction,
  resolveExecutionRouteForSettings,
} from "../src/model-routing"

const distinctModelRoutes = (routes: ReadonlyArray<ConfigContract.ResolvedModelRoute>) =>
  routes.filter(
    (route, index, all) =>
      all.findIndex(
        (candidate) => modelRoutePlan(candidate).registrationKey === modelRoutePlan(route).registrationKey,
      ) === index,
  )

test("rejects web search provider IDs that are not installed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const exit = yield* Effect.exit(validateWebSearchProviders({ custom: Redacted.make("secret") }))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("Unknown web search provider 'custom'")
    }),
  ))

const modelRouteDisplayLabel = (route: ConfigContract.ResolvedModelRoute) => {
  const [provider, version, ...name] = route.model.split("-")
  const modelName = name.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ")
  return `${provider?.toUpperCase()}-${version} ${modelName} ${route.effort}`
}

const recordingBackend = (starts: Array<ExecutionBackend.StartInput>, registrations?: Array<string>) =>
  ExecutionBackend.Service.of({
    ...(registrations === undefined
      ? {}
      : {
          registerModels: (values) =>
            Effect.sync(() => {
              registrations.push(...values.map((value) => value.registrationKey ?? ""))
            }),
        }),
    invokeChild: () => Effect.die("unused"),
    createFanOut: () => Effect.die("unused"),
    inspectFanOut: () => Effect.die("unused"),
    cancelFanOut: () => Effect.die("unused"),
    registerWorkflows: () => Effect.die("unused"),
    startWorkflow: () => Effect.die("unused"),
    inspectWorkflow: () => Effect.die("unused"),
    cancelWorkflow: () => Effect.die("unused"),
    start: (input) =>
      Effect.sync(() => {
        starts.push(input)
        return { turnId: input.turnId, status: "completed" as const, events: [] }
      }),
    inspect: () => Effect.sync((): undefined => undefined),
    replay: () => Effect.die("unused"),
    steer: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
    listApprovals: () => Effect.succeed([]),
    resolveToolApproval: () => Effect.die("unused"),
    resolvePermission: () => Effect.die("unused"),
  })

class RouteOperationError extends Schema.TaggedErrorClass<RouteOperationError>()("OperationError", {
  message: Schema.String,
}) {}

test("uses one canonical directory for both resident databases", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(Layer.build(BunServices.layer), (context) =>
        Effect.provide(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-database-root-" })
            const other = path.join(root, "other")
            const alias = path.join(root, "alias")
            yield* fs.makeDirectory(other)
            yield* fs.symlink(root, alias)
            expect(yield* canonicalDatabaseRoot(path.join(root, "rika.db"), path.join(alias, "relay.db"))).toBe(
              yield* fs.realPath(root),
            )
            expect(
              (yield* Effect.exit(canonicalDatabaseRoot(path.join(root, "rika.db"), path.join(other, "relay.db"))))
                ._tag,
            ).toBe("Failure")
            expect(
              (yield* Effect.exit(canonicalDatabaseRoot(path.join(root, "product.db"), path.join(root, "relay.db"))))
                ._tag,
            ).toBe("Failure")
          }),
          context,
        ),
      ),
    ),
  ))

test("uses production compaction defaults and route overrides", () => {
  expect(productionCompaction()).toEqual({
    contextWindow: 1_050_000,
    reserveTokens: 128_000,
    keepRecentTokens: 32_000,
  })
  expect(
    productionCompaction({ compaction: { contextWindow: 192_000, reserveTokens: 32_000, keepRecentTokens: 16_000 } }),
  ).toEqual({
    contextWindow: 192_000,
    reserveTokens: 32_000,
    keepRecentTokens: 16_000,
  })
})

test("content-addresses non-secret model execution semantics deterministically", () => {
  const route = ConfigContract.resolveModelRoute(ConfigContract.defaults, "high", "oracle")
  const key = modelRoutePlan(route).registrationKey
  expect(key).toMatch(/^sha256:[a-f0-9]{64}$/)
  expect(modelRoutePlan(route).registrationKey).toBe(key)
  expect(
    modelRoutePlan({
      ...route,
      providerConnection: { ...route.providerConnection, baseUrl: `${route.providerConnection.baseUrl}/` },
    }).registrationKey,
  ).toBe(key)
  expect(
    modelRoutePlan({
      ...route,
      providerConnection: { ...route.providerConnection, baseUrl: `${route.providerConnection.baseUrl}#primary` },
    }).registrationKey,
  ).toBe(key)
  const firstQuery = modelRoutePlan({
    ...route,
    providerConnection: { ...route.providerConnection, baseUrl: `${route.providerConnection.baseUrl}/?tenant=first` },
  }).registrationKey
  const secondQuery = modelRoutePlan({
    ...route,
    providerConnection: { ...route.providerConnection, baseUrl: `${route.providerConnection.baseUrl}?tenant=second` },
  }).registrationKey
  expect(firstQuery).not.toBe(secondQuery)
  expect(
    modelRoutePlan({
      ...route,
      providerConnection: {
        ...route.providerConnection,
        baseUrl: `${route.providerConnection.baseUrl}?tenant=first#ignored`,
      },
    }).registrationKey,
  ).toBe(firstQuery)
  const changes = [
    { ...route, providerConnection: { ...route.providerConnection, protocol: "anthropic" as const } },
    { ...route, providerConnection: { ...route.providerConnection, baseUrl: "https://models.example.test/v1" } },
    { ...route, model: "claude-opus-4-8" },
    { ...route, effort: "high" as const },
    { ...route, fast: true },
    { ...route, options: { ...route.options, max_tokens: 64_000 } },
    { ...route, options: { ...route.options, service_tier: "priority" } },
    { ...route, providerConnection: { ...route.providerConnection, apiKeyEnv: undefined } },
    { ...route, providerConnection: { ...route.providerConnection, apiKeyEnv: "OTHER_API_KEY" } },
  ]
  for (const changed of changes) expect(modelRoutePlan(changed).registrationKey).not.toBe(key)
  expect(JSON.stringify(modelRoutePlan(route))).not.toContain("API_KEY_VALUE")
  expect(modelRoutePlan(route).selection.registrationKey).toBe(key)
  expect(executionRoutePin(ConfigContract.defaults, "high").oracle.providerOptions).toEqual(
    modelRoutePlan(route).options,
  )
  expect(executionRoutePin(ConfigContract.defaults, "high").agents?.review.alias).toBe("sol")
  expect(executionRoutePin(ConfigContract.defaults, "medium").tokenBudget).toBeUndefined()
  const settings = {
    ...ConfigContract.defaults,
    compaction: { summaryModel: { alias: "terra", effort: "medium" as const } },
  }
  expect(executionRoutePin(settings, "medium").compactionSummary).toMatchObject({
    role: "compaction",
    alias: "terra",
    model: "gpt-5.6-terra",
  })
})

test("pins GPT 5.6 routes to each mode's configured effort and selected fast tier", () => {
  const modes = ["low", "medium", "high", "ultra"] as const
  for (const mode of modes) {
    for (const fastMode of [false, true]) {
      const route = executionRoutePin(ConfigContract.defaults, mode, { fastMode })
      for (const selected of [route.main, route.oracle, route.title!]) {
        expect(selected.model).toMatch(/^gpt-5\.6-/)
        expect(selected.providerProtocol).toBe("openai")
      }
      expect(route.main.providerOptions).toMatchObject({
        reasoning: { effort: ConfigContract.defaults.modes[mode].main.effort },
      })
      expect(route.oracle.providerOptions).toMatchObject({
        reasoning: { effort: ConfigContract.defaults.modes[mode].oracle.effort },
      })
      expect(route.main.providerOptions?.service_tier).toBe(fastMode ? "priority" : undefined)
      expect(route.oracle.providerOptions?.service_tier).toBe(fastMode ? "priority" : undefined)
      expect(route.title).toMatchObject({
        role: "title",
        alias: "luna",
        model: "gpt-5.6-luna",
        providerProtocol: "openai",
        effort: "low",
        fast: false,
        providerOptions: { reasoning: { effort: "low" } },
      })
    }
  }
})

test("pins aliases, variants, candidates, specialists, titles, and summaries as one admission snapshot", () => {
  const settings: ConfigContract.Settings = {
    ...ConfigContract.defaults,
    providers: {
      ...ConfigContract.defaults.providers,
      openai: {
        ...ConfigContract.defaults.providers.openai,
        baseUrl: "https://models.example.test/v1?tenant=admission",
        apiKeyEnv: "ADMISSION_API_KEY",
      },
    },
  }
  const resolved = modelRoutesForExecution(settings, "high", { fastMode: true })
  expect(resolved.map((route) => route.alias)).toEqual([
    "sol",
    "sol",
    "luna",
    "terra",
    "sol",
    "sol",
    "sol",
    "terra",
    "terra",
  ])
  expect(resolved.map((route) => route.model)).toEqual(resolved.map((route) => route.candidates[0]))

  const pin = executionRoutePin(settings, "high", { fastMode: true })
  expect(executionModelRoutes(pin).map((route) => route.role)).toEqual([
    "main",
    "oracle",
    "title",
    "compaction",
    "librarian",
    "painter",
    "review",
    "readThread",
    "task",
  ])
  expect(pin).toMatchObject({
    mode: "high",
    main: { alias: "sol", effort: "xhigh", fast: true },
    oracle: { alias: "sol", effort: "max", fast: true },
    title: { alias: "luna", effort: "low", fast: false },
    compactionSummary: { alias: "terra", effort: "medium", fast: false },
    agents: {
      librarian: { alias: "sol", effort: "high" },
      painter: { alias: "sol", effort: "high" },
      review: { alias: "sol", effort: "high" },
      readThread: { alias: "terra", effort: "medium" },
      task: { alias: "terra", effort: "medium" },
    },
  })
  for (const route of executionModelRoutes(pin)) {
    expect(route.providerBaseUrl).toBe("https://models.example.test/v1?tenant=admission")
    expect(route.providerApiKeyEnv).toBe("ADMISSION_API_KEY")
    expect(route.requestVariant).toBe(route.registrationKey)
    expect(JSON.stringify(route)).not.toContain("secret")
  }
  expect(pin.main.providerOptions).toMatchObject({ reasoning: { effort: "xhigh" }, service_tier: "priority" })
  expect(pin.oracle.providerOptions).toMatchObject({ reasoning: { effort: "max" }, service_tier: "priority" })
  expect(pin.title?.providerOptions).not.toHaveProperty("service_tier")
  expect(pin.compactionSummary?.providerOptions).not.toHaveProperty("service_tier")
})

test("fails an unavailable tuned route through the typed error channel", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const settings: ConfigContract.Settings = {
        ...ConfigContract.defaults,
        modes: {
          ...ConfigContract.defaults.modes,
          low: {
            ...ConfigContract.defaults.modes.low,
            main: { alias: "fable", effort: "low" },
          },
        },
      }
      const result = yield* Effect.exit(resolveExecutionRouteForSettings(settings, "low", { fastMode: true }))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(Cause.hasDies(result.cause)).toBe(false)
        const failure = result.cause.reasons.find(Cause.isFailReason)
        expect(failure?._tag === "Fail" ? failure.error : undefined).toMatchObject({
          _tag: "ModelRouteError",
          message: expect.stringContaining("Mode low main requests unavailable fable/low/fast variant"),
        })
      }
    }),
  ))

test("surfaces an unavailable tuned route as an interactive execution failure", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Deferred.make<Operation.InteractiveSession>()
        const release = yield* Deferred.make<void>()
        const events = new Array<Operation.InteractiveEvent>()
        const settings: ConfigContract.Settings = {
          ...ConfigContract.defaults,
          modes: {
            ...ConfigContract.defaults.modes,
            low: {
              ...ConfigContract.defaults.modes.low,
              main: { alias: "fable", effort: "low" },
            },
          },
        }
        const operationLayer = Operation.productLayer({
          repositoryLayer: ThreadRepository.memoryLayer(),
          turnRepositoryLayer: TurnRepository.memoryLayer(),
          backendLayer: Layer.succeed(ExecutionBackend.Service, recordingBackend([])),
          resolveExecutionRoute: (mode, tuning) =>
            resolveExecutionRouteForSettings(settings, mode, tuning).pipe(
              Effect.map((resolved) => resolved.executionRoute),
              Effect.mapError((error) => RouteOperationError.make({ message: error.message })),
            ),
          defaultWorkspace: "/work",
          makeThreadId: Effect.succeed(Thread.ThreadId.make("route-failure-thread")),
          makeTurnId: Effect.succeed(Turn.TurnId.make("route-failure-turn")),
          interactive: (_, session) =>
            Deferred.succeed(sessions, session).pipe(Effect.andThen(Deferred.await(release))),
        })
        const operation = Context.get(
          yield* Layer.buildWithScope(operationLayer, yield* Effect.scope),
          Operation.Service,
        )
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(sessions)
        const feed = yield* Effect.forkChild(
          session.events((event) => {
            events.push(event)
          }),
        )
        yield* Effect.yieldNow
        yield* session.submit("unavailable", "low", undefined, { fastMode: true })
        while (!events.some((event) => event._tag === "ExecutionFailed")) yield* Effect.yieldNow
        const failed = events.find((event) => event._tag === "ExecutionFailed")
        expect(failed).toMatchObject({
          _tag: "ExecutionFailed",
          message: expect.stringContaining("Mode low main requests unavailable fable/low/fast variant"),
        })
        yield* Fiber.interrupt(feed)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(operationFiber)
      }),
    ),
  ))

test("renders every default mode route in the mode picker", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const modes = Object.keys(ConfigContract.defaults.modes) as Array<ConfigContract.ModeId>
        const setup = yield* Effect.acquireRelease(
          Effect.tryPromise(() => createTestRenderer({ width: 80, height: 24 })),
          (value) => Effect.sync(() => value.renderer.destroy()),
        )
        const surface = yield* Effect.acquireRelease(
          Effect.sync(
            () => new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { animate: false }),
          ),
          (value) => Effect.sync(() => value.destroy()),
        )
        for (const mode of modes) {
          surface.update({
            ...ViewState.initial("/workspace", mode),
            modePicker: { open: true, selected: modes.indexOf(mode) },
          })
          yield* Effect.tryPromise(() => setup.flush())
          yield* Effect.tryPromise(() => setup.renderOnce())
          const frame = setup.captureCharFrame()
          expect(frame).toContain(
            `Oracle: ${modelRouteDisplayLabel(ConfigContract.resolveModelRoute(ConfigContract.defaults, mode, "oracle"))}`,
          )
          expect(frame).toContain(
            `Agent:  ${modelRouteDisplayLabel(ConfigContract.resolveModelRoute(ConfigContract.defaults, mode, "main"))}`,
          )
        }
      }),
    ),
  ))

test("keeps registrations distinct by the exact Baton registry tuple", () => {
  const route = ConfigContract.resolveModelRoute(ConfigContract.defaults, "high", "oracle")
  const second = { ...route, fast: true }
  expect(modelRoutePlan(second).registrationKey).not.toBe(modelRoutePlan(route).registrationKey)
  expect(distinctModelRoutes([route, second, route])).toEqual([route, second])
})

test("sends each client's workspace to the resident service", () => {
  const interactive = {
    _tag: "Interactive" as const,
    prompt: [],
    ephemeral: false,
  }
  expect(withClientWorkspace(interactive, "/client-a")).toEqual({
    ...interactive,
    clientWorkspace: "/client-a",
    workspace: "/client-a",
  })
  expect(withClientWorkspace({ ...interactive, workspace: "/explicit" }, "/client-b")).toEqual({
    ...interactive,
    clientWorkspace: "/client-b",
    workspace: "/explicit",
  })
  expect(withClientWorkspace({ _tag: "Config", action: "list" }, "/client-c")).toEqual({
    _tag: "Config",
    action: "list",
    clientWorkspace: "/client-c",
  })
  expect(withClientWorkspace({ _tag: "Auth", action: "status", provider: "openai" }, "/client-auth")).toEqual({
    _tag: "Auth",
    action: "status",
    provider: "openai",
    clientWorkspace: "/client-auth",
  })
  expect(withClientWorkspace({ _tag: "Thread", action: "new" }, "/client-d")).toEqual({
    _tag: "Thread",
    action: "new",
    clientWorkspace: "/client-d",
  })
  expect(
    withClientWorkspace(
      { _tag: "Workflow", action: "start", name: "delivery", runId: "delivery-1" },
      "/client-workflow",
    ),
  ).toEqual({
    _tag: "Workflow",
    action: "start",
    name: "delivery",
    runId: "delivery-1",
    clientWorkspace: "/client-workflow",
  })
  expect(withClientWorkspace({ _tag: "Mcp", action: "approve", name: "server" }, "/client-e")).toEqual({
    _tag: "Mcp",
    action: "approve",
    name: "server",
    workspace: "/client-e",
    clientWorkspace: "/client-e",
  })
})

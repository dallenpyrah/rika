import { expect, test } from "vitest"
import { LanguageModel, type ModelRegistry } from "@batonfx/core"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Cause, Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { OpenAiAuth } from "@rika/app"
import { ConfigContract } from "@rika/config"
import * as Database from "@rika/persistence/database"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { persistedModelRoutesForStartup, persistedTitleModelRoutesForStartup } from "../src/startup-runtime"
import { buildTestModelScript, makeReloadingTestModel, parseTestModelScript } from "../src/test-model-script"
import { Service as ModelProviderRuntime } from "../src/model-provider-runtime"
import {
  configuredBackendLayer,
  resolveExecutionWorkspace,
  withPinnedRouteRegistration,
} from "../src/backend-composition"
import { executionRoutePin } from "../src/model-routing"

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

const withBunServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scopedWith((scope) =>
    Layer.buildWithScope(BunServices.layer, scope).pipe(
      Effect.flatMap((context) => effect.pipe(Effect.provide(context))),
    ),
  )

test("isolates a stale persisted route while healthy routes keep starting", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const route = executionRoutePin(ConfigContract.defaults, "medium")
        const { providerApiKeyEnv: _, ...healthy } = route.main
        const { providerRuntime: __, ...oldMain } = route.main
        const stale = {
          ...oldMain,
          alias: "retired",
          provider: "retired-provider",
          providerProtocol: "retired-provider",
          registrationKey: "retired-registration",
          providerApiKeyEnv: "RETIRED_API_KEY",
          requestVariant: "retired-registration",
        }
        const unavailable = [{ route: stale, message: "Missing RETIRED_API_KEY for retired-provider" }]
        expect(unavailable[0]?.route.alias).toBe("retired")
        expect(unavailable[0]?.route.registrationKey).toBe("retired-registration")
        expect(unavailable[0]?.message).toContain("RETIRED_API_KEY")
        const starts = new Array<ExecutionBackend.StartInput>()
        const backend = recordingBackend(starts)
        const isolated = yield* withPinnedRouteRegistration(backend, {
          registeredRoutes: [healthy],
          unavailable,
          registerPinnedRoutes: () => Effect.die("unavailable routes must not be registered"),
        })
        const input = {
          threadId: "thread",
          turnId: "healthy-turn",
          prompt: "healthy",
          startedAt: 1,
          executionRoute: {
            mode: route.mode,
            main: healthy,
            oracle: { ...healthy, role: "oracle" as const },
          },
        }
        expect((yield* isolated.start(input)).status).toBe("completed")
        const failed = yield* Effect.exit(
          isolated.start({
            ...input,
            turnId: "stale-turn",
            executionRoute: {
              mode: route.mode,
              main: stale,
              oracle: { ...stale, role: "oracle" as const },
            },
          }),
        )
        expect(starts.map((start) => start.turnId)).toEqual(["healthy-turn"])
        expect(failed._tag).toBe("Failure")
        if (failed._tag === "Failure") {
          expect(Cause.hasDies(failed.cause)).toBe(false)
          const failure = failed.cause.reasons.find(Cause.isFailReason)
          expect(failure?._tag === "Fail" ? failure.error : undefined).toMatchObject({
            _tag: "ExecutionBackendError",
            message: expect.stringMatching(/retired.*RETIRED_API_KEY/),
          })
        }
      }),
    ),
  ))

test("builds the configured backend with duplicate persisted routes and one unavailable route", () =>
  Effect.runPromise(
    withBunServices(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-stale-route-startup-" })
          const productDatabase = Database.layer(path.join(root, "rika.db"))
          const productDatabaseContext = yield* Layer.buildWithScope(
            productDatabase.pipe(Layer.provide(BunServices.layer)),
            yield* Effect.scope,
          )
          const productDatabaseLayer = Layer.succeedContext(productDatabaseContext)
          const repositoryLayer = ThreadRepository.layer.pipe(Layer.provide(productDatabaseLayer))
          const turnRepositoryLayer = TurnRepository.layer.pipe(Layer.provide(productDatabaseLayer))
          const settings: ConfigContract.Settings = {
            ...ConfigContract.defaults,
            providers: {
              ...ConfigContract.defaults.providers,
              openai: {
                protocol: "openai",
                baseUrl: ConfigContract.defaults.providers.openai!.baseUrl,
              },
            },
          }
          const pinned = executionRoutePin(settings, "medium")
          const { providerRuntime: _, ...oldMain } = pinned.main
          const restored = {
            ...oldMain,
            registrationKey: "restored-startup",
            requestVariant: "restored-startup",
          }
          const stale = {
            ...oldMain,
            alias: "retired-startup",
            provider: "retired-startup",
            providerProtocol: "retired-startup",
            registrationKey: "retired-startup",
            providerApiKeyEnv: "RETIRED_STARTUP_API_KEY",
            requestVariant: "retired-startup",
          }
          const auth = OpenAiAuth.Service.of({
            loginBrowser: () => Effect.die("unused"),
            loginDevice: Effect.die("unused"),
            status: Effect.succeed({ _tag: "Unauthenticated" }),
            logout: Effect.die("unused"),
            acquire: Effect.die("unused"),
            refreshRejected: () => Effect.die("unused"),
          })
          const providerLayer = ModelProviderRuntime.layer.pipe(Layer.provide(Layer.succeed(OpenAiAuth.Service, auth)))
          const context = yield* Layer.buildWithScope(
            configuredBackendLayer({
              filename: path.join(root, "relay.db"),
              workspace: "/work",
              repositoryLayer,
              turnRepositoryLayer,
              settings,
              persistedModelRoutes: [restored, restored, stale],
            }).pipe(Layer.provide(providerLayer)),
            yield* Effect.scope,
          )
          const backend = Context.get(context, ExecutionBackend.Service)
          const failed = yield* Effect.exit(
            backend.start({
              threadId: "stale-thread",
              turnId: "stale-startup-turn",
              prompt: "stale",
              startedAt: 1,
              executionRoute: {
                mode: "medium",
                main: stale,
                oracle: { ...stale, role: "oracle" },
              },
            }),
          )
          expect(failed._tag).toBe("Failure")
          if (failed._tag === "Failure") {
            expect(Cause.hasDies(failed.cause)).toBe(false)
            const failure = failed.cause.reasons.find(Cause.isFailReason)
            expect(failure?._tag === "Fail" ? failure.error : undefined).toMatchObject({
              _tag: "ExecutionBackendError",
              message: expect.stringMatching(/retired-startup.*unavailable/),
            })
          }
        }),
      ),
    ),
  ))

test("resolves a legacy unavailable route to the current default when it starts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const current = executionRoutePin(ConfigContract.defaults, "medium")
      const legacyModel = {
        ...current.main,
        alias: "legacy-unavailable",
        provider: "legacy-unavailable",
        model: "legacy-unavailable",
        registrationKey: "legacy-unavailable",
        providerProtocol: "test" as const,
        providerBaseUrl: "test://legacy-unavailable",
        requestVariant: "legacy-unavailable",
      }
      const legacy: Turn.ExecutionRoutePin = {
        mode: "test",
        main: legacyModel,
        oracle: { ...legacyModel, role: "oracle" },
      }
      const starts = new Array<ExecutionBackend.StartInput>()
      const isolated = yield* withPinnedRouteRegistration(recordingBackend(starts), {
        registeredRoutes: [
          current.main,
          current.oracle,
          current.title!,
          current.compactionSummary!,
          ...Object.values(current.agents!),
        ],
        unavailable: [],
        registerPinnedRoutes: (routes) =>
          Effect.succeed(
            routes.map(
              (route) =>
                ({
                  provider: route.provider,
                  model: route.model,
                  registrationKey: route.registrationKey,
                }) as ModelRegistry.Registration,
            ),
          ),
        resolveLegacyRoute: () => Effect.succeed({ executionRoute: current, registrations: [] }),
      })
      yield* isolated.start({
        threadId: "legacy-thread",
        turnId: "legacy-turn",
        prompt: "backfilled",
        startedAt: 1,
        executionRoute: legacy,
      })
      expect(starts).toHaveLength(1)
      expect(starts[0]?.executionRoute.mode).toBe("medium")
      expect(starts[0]?.executionRoute.main.alias).toBe(current.main.alias)
    }),
  ))

test("re-registers a cloned active route when interrupt-and-send starts it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cloned = executionRoutePin(ConfigContract.defaults, "high")
      const starts = new Array<ExecutionBackend.StartInput>()
      const registrations = new Array<string>()
      const isolated = yield* withPinnedRouteRegistration(recordingBackend(starts, registrations), {
        registeredRoutes: [],
        unavailable: [],
        registerPinnedRoutes: (routes) =>
          Effect.succeed(
            routes.map(
              (route) =>
                ({
                  provider: route.provider,
                  model: route.model,
                  registrationKey: route.registrationKey,
                }) as ModelRegistry.Registration,
            ),
          ),
      })
      yield* isolated.start({
        threadId: "interrupt-thread",
        turnId: "interrupt-successor",
        prompt: "continue",
        startedAt: 1,
        executionRoute: cloned,
      })
      expect(starts).toHaveLength(1)
      expect(registrations).toContain(cloned.main.registrationKey)
      expect(registrations).toContain(cloned.oracle.registrationKey)
    }),
  ))

test("restores every pinned role from a nonterminal turn into the restart registration set", () => {
  const route = executionRoutePin(ConfigContract.defaults, "high")
  const owner: Turn.Turn = {
    id: Turn.TurnId.make("review-owner"),
    threadId: "review-thread" as Turn.Turn["threadId"],
    prompt: "Review workspace changes",
    status: "running",
    executionRoute: {
      ...route,
      main: { ...route.main, registrationKey: "workspace-main" },
      oracle: { ...route.oracle, registrationKey: "workspace-oracle" },
    },
    reviewFanOutId: "review:review-owner",
    createdAt: 1,
    updatedAt: 2,
  }
  expect(persistedModelRoutesForStartup([owner]).map((candidate) => candidate.registrationKey)).toEqual([
    "workspace-main",
    "workspace-oracle",
    route.title!.registrationKey,
    route.compactionSummary!.registrationKey,
    route.agents!.librarian.registrationKey,
    route.agents!.painter.registrationKey,
    route.agents!.review.registrationKey,
    route.agents!.readThread.registrationKey,
    route.agents!.task.registrationKey,
  ])
  const titleOwner: Turn.Turn = {
    ...owner,
    id: Turn.TurnId.make("completed-title-owner"),
    status: "completed",
    executionRoute: {
      ...route,
      title: { ...route.title!, registrationKey: "completed-title-route" },
    },
  }
  expect(
    [...persistedModelRoutesForStartup([owner]), titleOwner.executionRoute.title!].map(
      (candidate) => candidate.registrationKey,
    ),
  ).toContain("completed-title-route")
})

test("loads title model pins from completed turn rows for restart registration", () =>
  Effect.runPromise(
    withBunServices(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-title-routes-" })
          const databaseContext = yield* Layer.buildWithScope(
            Database.layer(path.join(root, "rika.db")).pipe(Layer.provide(BunServices.layer)),
            yield* Effect.scope,
          )
          const databaseLayer = Layer.succeedContext(databaseContext)
          const repositories = yield* Layer.buildWithScope(
            Layer.merge(
              ThreadRepository.layer.pipe(Layer.provide(databaseLayer)),
              TurnRepository.layer.pipe(Layer.provide(databaseLayer)),
            ),
            yield* Effect.scope,
          )
          const route = executionRoutePin(ConfigContract.defaults, "medium")
          yield* Effect.gen(function* () {
            const threads = yield* ThreadRepository.Service
            const turns = yield* TurnRepository.Service
            const thread = yield* threads.create({
              id: Thread.ThreadId.make("title-restart-thread"),
              workspace: "/work",
              title: "Seed",
              now: 1,
            })
            const turn = yield* turns.createForSubmission({
              id: Turn.TurnId.make("title-restart-turn"),
              threadId: thread.id,
              prompt: "title me",
              executionRoute: {
                ...route,
                title: { ...route.title!, registrationKey: "durable-title-registration" },
              },
              queueCapacity: 128,
              now: 1,
            })
            yield* turns.setStatus(turn.id, "completed", undefined, 2)
          }).pipe(Effect.provide(repositories))
          const titleRoutes = yield* persistedTitleModelRoutesForStartup.pipe(Effect.provide(databaseContext))
          expect(titleRoutes.map((candidate) => candidate.registrationKey)).toContain("durable-title-registration")
        }),
      ),
    ),
  ))

test("uses the owning thread workspace for durable title executions", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const repositories = Layer.merge(ThreadRepository.memoryLayer(), TurnRepository.memoryLayer())
        const repositoryContext = yield* Layer.build(repositories)
        const repositoryLayer = Layer.succeedContext(repositoryContext)
        const threads = Context.get(repositoryContext, ThreadRepository.Service)
        const turns = Context.get(repositoryContext, TurnRepository.Service)
        const thread = yield* threads.create({
          id: Thread.ThreadId.make("title-workspace-thread"),
          workspace: "/thread-workspace",
          title: "Seed",
          now: 1,
        })
        yield* turns.createForSubmission({
          id: Turn.TurnId.make("title-workspace-turn"),
          threadId: thread.id,
          prompt: "title me",
          executionRoute: executionRoutePin(ConfigContract.defaults, "medium"),
          queueCapacity: 128,
          now: 1,
        })
        const workspace = yield* resolveExecutionWorkspace(
          "execution:title:title-workspace-turn",
          "/backend-workspace",
          repositoryLayer,
          repositoryLayer,
        )
        expect(workspace).toBe("/thread-workspace")
      }),
    ),
  ))

test("parses and builds multi-part, object, and delayed TestModel turns", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const json = yield* Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)([
        {
          parts: [
            { type: "reasoning", text: "inspect" },
            { type: "toolCall", name: "read", params: { path: "a.txt" }, id: "read-1" },
          ],
          delayMs: 25,
          usage: { inputTokens: 7, outputTokens: 3 },
        },
        { parts: [{ type: "text", text: "done" }] },
        { object: { summary: "reviewed", findings: [] }, delayMs: 10 },
      ])
      const parsed = yield* parseTestModelScript(json)
      expect(parsed).toHaveLength(3)
      const built = yield* buildTestModelScript(json)
      expect(built).toEqual([
        {
          _tag: "Turn",
          parts: [
            { _tag: "Reasoning", text: "inspect" },
            { _tag: "ToolCall", name: "read", params: { path: "a.txt" }, id: "read-1", providerExecuted: false },
          ],
          delay: 25,
          usage: {
            inputTokens: { uncached: 7, total: 7, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 3, text: 3, reasoning: undefined },
          },
        },
        { _tag: "Turn", parts: [{ _tag: "Text", text: "done" }] },
        { _tag: "Object", value: { summary: "reviewed", findings: [] }, delay: 10 },
      ])
    }),
  ))

test("builds a fresh scripted model registration after its source file changes", () =>
  Effect.runPromise(
    Effect.scoped(
      withBunServices(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-reloading-model-" })
          const script = `${root}/script.json`
          yield* fs.writeFileString(script, '[{"parts":[{"type":"text","text":"first"}]}]')
          const fixture = yield* makeReloadingTestModel(script)
          const context = yield* Layer.build(fixture.registration.layer)
          const first = yield* LanguageModel.generateText({ prompt: "first" }).pipe(Effect.provide(context))
          expect(first.text).toBe("first")
          yield* fs.writeFileString(script, '[{"parts":[{"type":"text","text":"second"}]}]')
          const reloadedContext = yield* Layer.build(fixture.registration.layer)
          const second = yield* LanguageModel.generateText({ prompt: "second" }).pipe(Effect.provide(reloadedContext))
          expect(second.text).toBe("second")
        }),
      ),
    ),
  ))

test("rejects malformed, empty, and unsafe scripts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const results = yield* Effect.all(
        [
          "not json",
          "[]",
          '[{"parts":[]}]',
          '[{"parts":[{"type":"toolCall","name":4}]}]',
          '[{"parts":[{"type":"text","text":"x"}],"delayMs":-1}]',
          '[{"parts":[{"type":"text","text":"x"}],"usage":{"inputTokens":-1}}]',
        ].map((value) => Effect.exit(parseTestModelScript(value))),
      )
      expect(results.every((result) => result._tag === "Failure")).toBe(true)
    }),
  ))

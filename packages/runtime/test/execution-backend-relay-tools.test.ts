import * as BunServices from "@effect/platform-bun/BunServices"
import { ModelRegistry, Response } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import { Runtime as RikaToolRuntime } from "@rika/tools"
import { expect, test } from "vitest"
import { Database } from "bun:sqlite"
import { Effect, FileSystem, Layer, Schedule, Schema } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"
import { createFanOut, start } from "./current-execution-route"

const executionModelRoute = (
  role: "main" | "oracle",
  selection: { readonly provider: string; readonly model: string; readonly registrationKey?: string },
): ExecutionBackend.ExecutionModelRoute => ({
  role,
  alias: role,
  provider: selection.provider,
  model: selection.model,
  registrationKey: selection.registrationKey ?? role,
  providerProtocol: "test",
  providerBaseUrl: "test://model",
  effort: "medium",
  fast: false,
  requestVariant: selection.registrationKey ?? role,
  compaction: { contextWindow: 1_000, reserveTokens: 100, keepRecentTokens: 50 },
})

const provide = <A, E, R, ROut, E2, RIn>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<ROut, E2, RIn>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* Effect.provide(effect, context)
    }),
  )

const runNative = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof BunServices.layer>>) =>
  Effect.runPromise(provide(effect, BunServices.layer))

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)

const withBackend = <A, E>(
  script: Parameters<typeof TestModel.make>[0],
  run: (
    fixture: TestModel.Fixture,
    directory: string,
  ) => Effect.Effect<A, E, ExecutionBackend.Service | FileSystem.FileSystem>,
  options?: Pick<RelayExecutionBackend.LayerOptions, "modelResilience" | "compaction" | "permissionPolicy"> & {
    readonly registration?: (fixture: TestModel.Fixture) => ModelRegistry.Registration
  },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runtime-" })
      const fixture = yield* TestModel.make(script)
      const { registration, ...layerOptions } = options ?? {}
      return yield* provide(
        run(fixture, directory),
        RelayExecutionBackend.layer({
          filename: `${directory}/relay.db`,
          workspace: directory,
          registration: registration?.(fixture) ?? fixture.registration,
          selection: fixture.selection,
          modelVariantPolicy: "fixed-selection",
          ...layerOptions,
        }),
      )
    }),
  )

test(
  "routes standalone workflow child tools through the client workspace",
  () =>
    runNative(
      Effect.gen(function* () {
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-workflow-workspace-" })
            const workspace = `${directory}/workspace`
            yield* fileSystem.makeDirectory(workspace)
            yield* fileSystem.writeFileString(`${workspace}/fixture.txt`, "workflow workspace marker")
            const fixture = yield* TestModel.make([
              TestModel.toolCall("read", { path: "fixture.txt" }, { id: "call-workflow-read" }),
              TestModel.text("investigated"),
              TestModel.object({ answer: "investigated", evidence: [] }),
              TestModel.text("implemented"),
              TestModel.object({ summary: "implemented", files: [] }),
              TestModel.text("reviewed"),
              TestModel.object({ summary: "reviewed", findings: [] }),
              TestModel.text("fixed"),
              TestModel.object({ summary: "fixed", files: [] }),
              TestModel.text("verified"),
              TestModel.object({ summary: "verified", files: [] }),
            ])
            const backendLayer = RelayExecutionBackend.layer({
              filename: `${directory}/relay.db`,
              workspace: directory,
              registration: fixture.registration,
              selection: fixture.selection,
              modelVariantPolicy: "fixed-selection",
              toolRuntimeLayerForWorkspace: RikaToolRuntime.layerWithProcessRegistry,
              resolveWorkspace: (executionId) => {
                const resolved = RelayExecutionBackend.workspaceFromExecutionId(executionId)
                return resolved === undefined
                  ? Effect.fail(
                      ExecutionBackend.BackendError.make({
                        message: `Unknown execution ${executionId}`,
                      }),
                    )
                  : Effect.succeed(resolved)
              },
              toolNeedsApproval: () => false,
              permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
            })
            return yield* provide(
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                yield* backend.registerWorkflows()
                yield* backend.startWorkflow("delivery", "workspace-run", undefined, undefined, workspace)
                const completed = yield* backend.inspectWorkflow("workspace-run", undefined, workspace).pipe(
                  Effect.repeat({
                    while: (inspection) => inspection?.status === "running",
                    schedule: Schedule.spaced("20 millis"),
                  }),
                )
                return { completed, requests: yield* fixture.requests }
              }),
              backendLayer,
            )
          }),
        )

        expect(result.completed?.status).toBe("completed")
        expect(result.completed?.runId).toBe("workspace-run")
        expect(encodeJson(result.requests)).toContain("workflow workspace marker")
      }),
    ),
  60_000,
)

test(
  "streams grouped model parts and persists usage through Relay SQLite",
  () =>
    runNative(
      Effect.gen(function* () {
        const usage = Response.Usage.make({
          inputTokens: { uncached: 7, total: 7, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 3, text: 3, reasoning: undefined },
        })
        const result = yield* withBackend(
          [TestModel.turn([TestModel.text("group "), TestModel.text("stream")], { usage })],
          () =>
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              const completed = yield* start(backend, {
                threadId: "thread-stream",
                turnId: "turn-stream",
                prompt: "go",
                startedAt: 1,
              })
              return yield* backend.replay(completed.turnId)
            }),
        )
        expect(result.status).toBe("completed")
        expect(
          result.events
            .filter((event) => event.type === "model.output.delta")
            .map((event) => event.text)
            .join(""),
        ).toBe("group stream")
        expect(result.events.map((event) => event.type)).toContain("model.usage.reported")
      }),
    ),
  30_000,
)

test.skipIf(!("reasoning" in TestModel))(
  "projects and replays reasoning separately from assistant text",
  () =>
    runNative(
      Effect.gen(function* () {
        const result = yield* withBackend(
          [TestModel.turn([TestModel.reasoning("inspect state"), TestModel.text("final answer")])],
          () =>
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              const completed = yield* start(backend, {
                threadId: "thread-reasoning",
                turnId: "turn-reasoning",
                prompt: "reason",
                startedAt: 1,
              })
              return { completed, replay: yield* backend.replay(completed.turnId) }
            }),
        )
        const reasoning = result.completed.events.filter((event) => event.type === "model.reasoning.delta")
        const assistant = result.completed.events.filter((event) => event.type === "model.output.delta")
        expect(reasoning.map((event) => event.text).join("")).toBe("inspect state")
        expect(assistant.map((event) => event.text).join("")).toBe("final answer")
        expect(reasoning[0]?.cursor).not.toBe(assistant[0]?.cursor)
        expect(result.replay.events).toEqual(result.completed.events)
      }),
    ),
  30_000,
)

test(
  "corrects unknown and malformed tool calls at the durable model boundary",
  () =>
    runNative(
      Effect.gen(function* () {
        const cases = [
          ["turn-unknown", "not_a_rika_tool", {}],
          ["turn-malformed", "read", { path: 42 }],
        ] as const
        yield* Effect.forEach(cases, ([turnId, name, params]) =>
          Effect.gen(function* () {
            const outcome = yield* withBackend(
              [TestModel.toolCall(name, params, { id: turnId }), TestModel.text("corrected")],
              (fixture) =>
                Effect.gen(function* () {
                  const backend = yield* ExecutionBackend.Service
                  const result = yield* start(backend, { threadId: turnId, turnId, prompt: "call tool", startedAt: 1 })
                  return { result, requests: yield* fixture.requests }
                }),
            )
            expect(outcome.result.status).toBe("completed")
            expect(
              outcome.result.events
                .filter((event) => event.type === "model.output.delta")
                .map((event) => event.text)
                .join(""),
            ).toBe("corrected")
            expect(outcome.requests).toHaveLength(2)
          }),
        )
      }),
    ),
  30_000,
)

test(
  "preserves a canonical terminal failure",
  () =>
    runNative(
      Effect.gen(function* () {
        const result = yield* withBackend(
          Array.from({ length: 3 }, (_, index) =>
            TestModel.toolCall("not_a_rika_tool", {}, { id: `invalid-tool-${index}` }),
          ),
          () =>
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              return yield* start(backend, {
                threadId: "thread-failure",
                turnId: "turn-failure",
                prompt: "fail",
                startedAt: 1,
              })
            }),
        )
        const failures = result.events.filter((event) => event.type === "execution.failed")
        expect(result.status).toBe("failed")
        expect(failures).toHaveLength(1)
        expect(failures[0]?.data?.message).toBe(failures[0]?.text)
        expect(failures[0]?.text).toContain("not_a_rika_tool")
      }),
    ),
  120_000,
)

test(
  "settles a Rika fan-out child",
  () =>
    runNative(
      Effect.gen(function* () {
        const childOutput = "CHILD_OK"
        const result = yield* withBackend(
          [TestModel.text("parent ready"), TestModel.text("CHILD_OK")],
          (_, directory) =>
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              yield* start(backend, {
                threadId: "thread-long-child",
                turnId: "turn-long-child-parent",
                prompt: "prepare fan-out",
                startedAt: 1,
              })
              yield* createFanOut(backend, {
                parentTurnId: "turn-long-child-parent",
                fanOutId: "fan-out:long-child",
                children: [{ childId: "long-child", prompt: "produce the child result" }],
                maxConcurrency: 1,
                join: "all",
                createdAt: 2,
              })
              const fanOut = yield* backend.inspectFanOut("fan-out:long-child").pipe(
                Effect.repeat({
                  while: (inspection) => inspection?.state === "joining",
                  schedule: Schedule.spaced("20 millis"),
                }),
              )
              const database = new Database(`${directory}/relay.db`, { readonly: true })
              const childExecutions = database
                .query<
                  { readonly id: string; readonly status: string },
                  []
                >("select id, status from relay_executions where id = 'child:turn-long-child-parent:long-child'")
                .all()
              database.close()
              return { fanOut, childExecutions }
            }),
        )
        expect(result.fanOut?.state).toBe("satisfied")
        expect(result.childExecutions).toEqual([{ id: "child:turn-long-child-parent:long-child", status: "completed" }])
        expect(result.fanOut?.members).toEqual([
          {
            childId: "long-child",
            ordinal: 0,
            state: "completed",
            output: childOutput,
          },
        ])
      }),
    ),
  60_000,
)

test(
  "executes persisted main and Oracle fan-out routes without enforcing a legacy route budget",
  () =>
    runNative(
      Effect.gen(function* () {
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runtime-routes-" })
            const main = yield* TestModel.make([TestModel.text("parent-main"), TestModel.text("child-main")], {
              provider: "main-provider",
              model: "main-model",
              registrationKey: "main",
            })
            const oracle = yield* TestModel.make([TestModel.text("child-oracle")], {
              provider: "oracle-provider",
              model: "oracle-model",
              registrationKey: "oracle",
            })
            const executionRoute: ExecutionBackend.ExecutionRoutePin = {
              mode: "test",
              tokenBudget: 1_000,
              main: executionModelRoute("main", main.selection),
              oracle: executionModelRoute("oracle", oracle.selection),
            }
            return yield* provide(
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                yield* start(backend, {
                  threadId: "thread-routes",
                  turnId: "turn-routes-parent",
                  prompt: "prepare fan-out",
                  startedAt: 1,
                  executionRoute,
                })
                yield* createFanOut(backend, {
                  parentTurnId: "turn-routes-parent",
                  fanOutId: "fan-out:routes",
                  executionRoute,
                  children: [
                    { childId: "oracle-route", profile: "Oracle", prompt: "ask Oracle" },
                    { childId: "main-route", profile: "Task", prompt: "ask main" },
                  ],
                  maxConcurrency: 2,
                  join: "all",
                  createdAt: 2,
                })
                const fanOut = yield* backend.inspectFanOut("fan-out:routes").pipe(
                  Effect.repeat({
                    while: (inspection) => inspection?.state === "joining",
                    schedule: Schedule.spaced("20 millis"),
                  }),
                )
                return {
                  fanOut,
                  mainRequests: yield* main.requests,
                  oracleRequests: yield* oracle.requests,
                }
              }),
              RelayExecutionBackend.layer({
                filename: `${directory}/relay.db`,
                workspace: directory,
                registration: main.registration,
                additionalRegistrations: [oracle.registration],
                selection: main.selection,
                oracleSelection: oracle.selection,
              }),
            )
          }),
        )
        expect(result.fanOut?.state).toBe("satisfied")
        expect(result.fanOut?.members.map((member) => member.output)).toEqual(["child-oracle", "child-main"])
        expect(result.mainRequests).toHaveLength(2)
        expect(result.oracleRequests).toHaveLength(1)
        expect(encodeJson(result.mainRequests[1]?.prompt)).toContain("ask main")
        expect(encodeJson(result.oracleRequests[0]?.prompt)).toContain("ask Oracle")
      }),
    ),
  60_000,
)

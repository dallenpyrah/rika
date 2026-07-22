import * as BunServices from "@effect/platform-bun/BunServices"
import { LanguageModel, ModelRegistry } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import { Runtime } from "@rika/tools"
import { expect, test } from "vitest"
import { Database } from "bun:sqlite"
import { Clock, Effect, FileSystem, Layer, Ref, Schema, Stream } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"
import { start } from "./current-execution-route"

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)
const decodeToolExecution = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      tool_execution: Schema.optional(Schema.Struct({ concurrency: Schema.Finite })),
    }),
  ),
)

const executionModelRoute = (
  role: ExecutionBackend.ExecutionModelRoute["role"],
  selection: { readonly provider: string; readonly model: string; readonly registrationKey?: string },
  effort = "medium",
): ExecutionBackend.ExecutionModelRoute => ({
  role,
  alias: role,
  provider: selection.provider,
  model: selection.model,
  registrationKey: selection.registrationKey ?? role,
  providerProtocol: "test",
  providerBaseUrl: "test://model",
  effort,
  fast: false,
  requestVariant: selection.registrationKey ?? role,
  compaction: { contextWindow: 372_000, reserveTokens: 128_000, keepRecentTokens: 32_000 },
})

test("three Task calls in one model turn run as overlapping durable children", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-parallel-" })
      const fixture = yield* TestModel.make([
        TestModel.turn([
          TestModel.toolCall("task", { prompt: "Explore alpha." }, { id: "call-alpha" }),
          TestModel.toolCall("task", { prompt: "Explore beta." }, { id: "call-beta" }),
          TestModel.toolCall("task", { prompt: "Explore gamma." }, { id: "call-gamma" }),
        ]),
        TestModel.turn([TestModel.text("alpha")], { delay: "400 millis" }),
        TestModel.turn([TestModel.text("beta")], { delay: "400 millis" }),
        TestModel.turn([TestModel.text("gamma")], { delay: "400 millis" }),
        TestModel.text("All three explorations finished."),
      ])
      const windows = yield* Ref.make<
        Array<{ readonly prompt: string; readonly startedAt: number; readonly completedAt?: number }>
      >([])
      const trackingLayer = Layer.effect(
        LanguageModel.LanguageModel,
        Effect.gen(function* () {
          const model = yield* LanguageModel.LanguageModel
          const streamText = ((options: Parameters<LanguageModel.Service["streamText"]>[0]) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const prompt = encodeJson(options.prompt)
                const startedAt = yield* Clock.currentTimeMillis
                const index = yield* Ref.modify(windows, (current) => [
                  current.length,
                  [...current, { prompt, startedAt }],
                ])
                return model
                  .streamText(options)
                  .pipe(
                    Stream.ensuring(
                      Clock.currentTimeMillis.pipe(
                        Effect.flatMap((completedAt) =>
                          Ref.update(windows, (current) =>
                            current.map((window, currentIndex) =>
                              currentIndex === index ? { ...window, completedAt } : window,
                            ),
                          ),
                        ),
                      ),
                    ),
                  )
              }),
            )) as LanguageModel.Service["streamText"]
          return { ...model, streamText }
        }),
      ).pipe(Layer.provide(fixture.layer))
      const registration = yield* ModelRegistry.registrationFromLayer({
        ...fixture.selection,
        layer: trackingLayer,
      })
      const backendLayer = RelayExecutionBackend.layer({
        filename: `${directory}/relay.db`,
        workspace: directory,
        registration,
        selection: fixture.selection,
        modelVariantPolicy: "fixed-selection",
        toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false })),
        toolNeedsApproval: () => false,
        permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const settled = yield* start(backend, {
          threadId: "thread-parallel-spawn",
          turnId: "turn-parallel-spawn",
          prompt: "Explore alpha, beta, and gamma independently.",
          startedAt: 1,
        })
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/relay.db`, { readonly: true })),
          (connection) => Effect.sync(() => connection.close()),
        )
        const children = database
          .query<
            { readonly id: string; readonly status: string; readonly agent_snapshot_json: string },
            []
          >("select id, status, agent_snapshot_json from relay_executions where id like 'child:%' order by id")
          .all()
        const root = database
          .query<
            { readonly agent_snapshot_json: string },
            []
          >("select agent_snapshot_json from relay_executions where id = 'execution:turn-parallel-spawn'")
          .get()
        const childRuns = database
          .query<
            { readonly id: string; readonly metadata_json: string },
            []
          >("select id, metadata_json from relay_child_executions order by id")
          .all()
        return {
          settled,
          children,
          root,
          childRuns,
          selection: fixture.selection,
          requests: yield* fixture.requests,
          windows: yield* Ref.get(windows),
        }
      }).pipe(Effect.provide(backendContext))
    }),
  )
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const bunContext = yield* Layer.build(BunServices.layer)
        return yield* program.pipe(Effect.provide(bunContext))
      }),
    ).pipe(
      Effect.tap(({ settled, children, root, childRuns, selection, requests, windows }) =>
        Effect.sync(() => {
          const childWindows = windows.slice(1, 4)
          expect(settled.status, encodeJson(settled.events.filter((event) => event.type === "execution.failed"))).toBe(
            "completed",
          )
          expect(settled.events.filter((event) => event.type === "child_run.spawned")).toHaveLength(3)
          expect(children).toHaveLength(3)
          expect(children.every((child) => child.status === "completed")).toBe(true)
          expect(decodeToolExecution(root?.agent_snapshot_json ?? "{}").tool_execution).toEqual({ concurrency: 4 })
          expect(
            children.every((child) => decodeToolExecution(child.agent_snapshot_json).tool_execution === undefined),
          ).toBe(true)
          expect(
            childRuns
              .map(({ metadata_json }) => JSON.parse(metadata_json))
              .map(({ kind, preset_name }) => ({
                kind,
                preset_name,
              })),
          ).toEqual([
            { kind: "static", preset_name: "Task" },
            { kind: "static", preset_name: "Task" },
            { kind: "static", preset_name: "Task" },
          ])
          expect(
            children.map(({ agent_snapshot_json }) => {
              const snapshot = JSON.parse(agent_snapshot_json) as {
                readonly model?: { readonly model?: string; readonly registration_key?: string }
              }
              return [snapshot.model?.model, snapshot.model?.registration_key]
            }),
          ).toEqual([
            [selection.model, selection.registrationKey],
            [selection.model, selection.registrationKey],
            [selection.model, selection.registrationKey],
          ])
          expect(windows).toHaveLength(5)
          expect(childWindows).toHaveLength(3)
          expect(
            childWindows.every((window) =>
              ["Explore alpha.", "Explore beta.", "Explore gamma."].some((prompt) => window.prompt.includes(prompt)),
            ),
          ).toBe(true)
          expect(Math.max(...childWindows.map((window) => window.startedAt))).toBeLessThan(
            Math.min(...childWindows.map((window) => window.completedAt ?? 0)),
          )
          expect(requests.slice(1, 4).every((request) => request.operation === "streamText")).toBe(true)
          expect(
            settled.events
              .filter(
                (event) =>
                  event.type === "model.output.delta" && event.cursor.startsWith("execution:turn-parallel-spawn:"),
              )
              .map((event) => event.text)
              .join(""),
          ).toBe("All three explorations finished.")
        }),
      ),
    ),
  )
}, 60_000)

test("high mode runs Luna, Terra, and inherited Sol Task calls in one batch", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-high-models-" })
      const sol = yield* TestModel.make(
        [
          TestModel.turn([
            TestModel.toolCall("task", { prompt: "Explore with Luna.", model: "gpt-5.6-luna" }, { id: "call-luna" }),
            TestModel.toolCall("task", { prompt: "Explore with Terra.", model: "gpt-5.6-terra" }, { id: "call-terra" }),
            TestModel.toolCall("task", { prompt: "Explore with inherited Sol." }, { id: "call-sol" }),
          ]),
          TestModel.text("Sol completed its exploration."),
          TestModel.text("All model choices completed."),
        ],
        { provider: "test", model: "gpt-5.6-sol", registrationKey: "sol-xhigh" },
      )
      const luna = yield* TestModel.make([TestModel.text("Luna completed its exploration.")], {
        provider: "test",
        model: "gpt-5.6-luna",
        registrationKey: "luna-low",
      })
      const terra = yield* TestModel.make([TestModel.text("Terra completed its exploration.")], {
        provider: "test",
        model: "gpt-5.6-terra",
        registrationKey: "terra-medium",
      })
      const executionRoute: ExecutionBackend.ExecutionRoutePin = {
        mode: "high",
        main: executionModelRoute("main", sol.selection, "xhigh"),
        oracle: executionModelRoute(
          "oracle",
          { provider: "test", model: "gpt-5.6-sol", registrationKey: "sol-max" },
          "max",
        ),
        title: executionModelRoute("title", luna.selection, "low"),
        compactionSummary: executionModelRoute("compaction", terra.selection, "medium"),
        agents: {
          librarian: executionModelRoute(
            "librarian",
            { provider: "test", model: "gpt-5.6-sol", registrationKey: "sol-high" },
            "high",
          ),
          painter: executionModelRoute(
            "painter",
            { provider: "test", model: "gpt-5.6-sol", registrationKey: "sol-high" },
            "high",
          ),
          review: executionModelRoute(
            "review",
            { provider: "test", model: "gpt-5.6-sol", registrationKey: "sol-high" },
            "high",
          ),
          readThread: executionModelRoute("readThread", terra.selection, "medium"),
          task: executionModelRoute("task", terra.selection, "medium"),
        },
      }
      const backendLayer = RelayExecutionBackend.layer({
        filename: `${directory}/relay.db`,
        workspace: directory,
        registration: sol.registration,
        additionalRegistrations: [luna.registration, terra.registration],
        selection: sol.selection,
        toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false })),
        toolNeedsApproval: () => false,
        permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const settled = yield* start(backend, {
          threadId: "thread-high-models",
          turnId: "turn-high-models",
          prompt: "Run Luna, Terra, and inherited Sol together.",
          startedAt: 1,
          executionRoute,
        })
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/relay.db`, { readonly: true })),
          (connection) => Effect.sync(() => connection.close()),
        )
        const children = database
          .query<
            { readonly status: string; readonly agent_snapshot_json: string },
            []
          >("select status, agent_snapshot_json from relay_executions where id like 'child:%' order by id")
          .all()
        const childRuns = database
          .query<
            { readonly id: string; readonly metadata_json: string },
            []
          >("select id, metadata_json from relay_child_executions order by id")
          .all()
        const results = database
          .query<
            { readonly error: string | null },
            []
          >("select result.error from relay_tool_calls call join relay_tool_results result on result.tool_call_id = call.id where call.execution_id = 'execution:turn-high-models' and call.name = 'task' order by call.created_at")
          .all()
        return { settled, children, childRuns, results }
      }).pipe(Effect.provide(backendContext))
    }),
  )
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const bunContext = yield* Layer.build(BunServices.layer)
        return yield* program.pipe(Effect.provide(bunContext))
      }),
    ).pipe(
      Effect.tap(({ settled, children, childRuns, results }) =>
        Effect.sync(() => {
          expect(settled.status).toBe("completed")
          expect(children).toHaveLength(3)
          expect(children.every((child) => child.status === "completed")).toBe(true)
          expect(results).toEqual([{ error: null }, { error: null }, { error: null }])
          const childRunMetadata = (callId: string) => {
            const child = childRuns.find(({ id }) => id.endsWith(`:${callId}`))
            return child === undefined ? undefined : JSON.parse(child.metadata_json)
          }
          expect(childRunMetadata("call-sol")).toMatchObject({ kind: "static", preset_name: "Task" })
          expect(childRunMetadata("call-luna")).toMatchObject({ kind: "dynamic" })
          expect(childRunMetadata("call-luna")).not.toHaveProperty("preset_name")
          expect(childRunMetadata("call-terra")).toMatchObject({ kind: "dynamic" })
          expect(childRunMetadata("call-terra")).not.toHaveProperty("preset_name")
          expect(
            children.map((child) => {
              const snapshot = JSON.parse(child.agent_snapshot_json) as {
                readonly model?: { readonly model?: string; readonly registration_key?: string }
              }
              return [snapshot.model?.model, snapshot.model?.registration_key]
            }),
          ).toEqual(
            expect.arrayContaining([
              ["gpt-5.6-luna", "luna-low"],
              ["gpt-5.6-terra", "terra-medium"],
              ["gpt-5.6-sol", "sol-xhigh"],
            ]),
          )
        }),
      ),
    ),
  )
}, 60_000)

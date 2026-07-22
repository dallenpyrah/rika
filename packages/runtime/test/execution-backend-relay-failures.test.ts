import * as BunServices from "@effect/platform-bun/BunServices"
import { AiError, ModelRegistry, ModelResilience, Response } from "@batonfx/core"
import { classifyFailure as classifyOpenAiFailure } from "@batonfx/providers/openai"
import { TestModel } from "@batonfx/test"
import { expect, test } from "vitest"
import { Database } from "bun:sqlite"
import { Duration, Effect, Fiber, FileSystem, Layer, Schedule, Schema } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"
import { start } from "./current-execution-route"

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
  "retries a transient TestModel failure inside the durable execution",
  () =>
    runNative(
      Effect.gen(function* () {
        const retryable = AiError.make({
          module: "test",
          method: "streamText",
          reason: AiError.RateLimitError.make({}),
        })
        const program = withBackend(
          [TestModel.failure(retryable), TestModel.text("recovered")],
          (fixture) =>
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              const result = yield* start(backend, {
                threadId: "thread-retry",
                turnId: "turn-retry",
                prompt: "retry",
                startedAt: 1,
              })
              return { result, requests: yield* fixture.requests }
            }),
          { modelResilience: ModelResilience.make({ retrySchedule: Schedule.recurs(1) }) },
        )
        const result = yield* program
        expect(result.result.status).toBe("completed")
        expect(result.requests).toHaveLength(2)
        expect(
          result.result.events
            .filter((event) => event.type === "model.output.delta")
            .map((event) => event.text)
            .join(""),
        ).toBe("recovered")
      }),
    ),
  30_000,
)

test(
  "durably compacts and replays one classified pre-output context overflow",
  () =>
    runNative(
      Effect.gen(function* () {
        const overflow = AiError.make({
          module: "openai",
          method: "streamText",
          reason: AiError.InvalidRequestError.make({ description: "maximum context length exceeded" }),
        })
        const result = yield* withBackend(
          [
            TestModel.turn([TestModel.toolCall("read", { path: "fixture.txt" }, { id: "overflow-read" })]),
            TestModel.failure(overflow),
            TestModel.text(
              "Goal: Recover the rejected request. The fixture was read. Replay from the compacted projection.",
            ),
            TestModel.text("recovered after compaction"),
          ],
          (fixture, directory) =>
            Effect.gen(function* () {
              const fileSystem = yield* FileSystem.FileSystem
              yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "durable overflow fixture")
              const backend = yield* ExecutionBackend.Service
              const execution = yield* start(backend, {
                threadId: "thread-overflow-recovery",
                turnId: "turn-overflow-recovery",
                prompt: "read fixture.txt and finish",
                startedAt: 1,
              })
              const database = new Database(`${directory}/relay.db`, { readonly: true })
              const checkpoints = database
                .query("SELECT checkpoint_id, summary FROM relay_agent_compactions WHERE execution_id = ?")
                .all("execution:turn-overflow-recovery") as ReadonlyArray<{ checkpoint_id: string; summary: string }>
              database.close()
              return { execution, checkpoints, requests: yield* fixture.requests }
            }),
          {
            compaction: { contextWindow: 100_000, reserveTokens: 1, keepRecentTokens: 1 },
            registration: (fixture) => ({
              ...fixture.registration,
              classifyFailure: classifyOpenAiFailure,
            }),
          },
        )
        expect(result.execution.status).toBe("completed")
        expect(result.checkpoints).toHaveLength(1)
        expect(result.checkpoints[0]?.summary).toContain("Recover the rejected request")
        expect(result.requests.map((request) => request.operation)).toEqual([
          "streamText",
          "streamText",
          "generateText",
          "streamText",
        ])
        expect(result.execution.events.filter((event) => event.type === "tool.result.received")).toHaveLength(1)
        expect(encodeJson(result.requests[3]?.prompt)).toContain("Recover the rejected request")
        expect(
          result.execution.events
            .filter((event) => event.type === "model.output.delta")
            .map((event) => event.text)
            .join(""),
        ).toBe("recovered after compaction")
      }),
    ),
  30_000,
)

test(
  "fails a second classified context overflow after exactly one compacted replay",
  () =>
    runNative(
      Effect.gen(function* () {
        const overflow = AiError.make({
          module: "openai",
          method: "streamText",
          reason: AiError.InvalidRequestError.make({ description: "maximum context length exceeded" }),
        })
        const result = yield* withBackend(
          [
            TestModel.turn([TestModel.toolCall("read", { path: "fixture.txt" }, { id: "overflow-twice-read" })]),
            TestModel.failure(overflow),
            TestModel.text("Goal: Retry once. The first request overflowed. Use one compacted replay."),
            TestModel.failure(overflow),
          ],
          (fixture, directory) =>
            Effect.gen(function* () {
              const fileSystem = yield* FileSystem.FileSystem
              yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "overflow twice fixture")
              const backend = yield* ExecutionBackend.Service
              const execution = yield* start(backend, {
                threadId: "thread-overflow-twice",
                turnId: "turn-overflow-twice",
                prompt: "read fixture.txt and finish",
                startedAt: 1,
              })
              const database = new Database(`${directory}/relay.db`, { readonly: true })
              const checkpoint = database
                .query("SELECT count(*) AS count FROM relay_agent_compactions WHERE execution_id = ?")
                .get("execution:turn-overflow-twice") as { count: number }
              database.close()
              return { execution, checkpointCount: checkpoint.count, requests: yield* fixture.requests }
            }),
          {
            compaction: { contextWindow: 100_000, reserveTokens: 1, keepRecentTokens: 1 },
            registration: (fixture) => ({
              ...fixture.registration,
              classifyFailure: classifyOpenAiFailure,
            }),
          },
        )
        expect(result.execution.status).toBe("failed")
        expect(result.checkpointCount).toBe(1)
        expect(result.requests.map((request) => request.operation)).toEqual([
          "streamText",
          "streamText",
          "generateText",
          "streamText",
        ])
        expect(result.execution.events.filter((event) => event.type === "tool.result.received")).toHaveLength(1)
      }),
    ),
  30_000,
)

test(
  "accepts steering while a TestModel execution is active",
  () =>
    runNative(
      Effect.gen(function* () {
        const program = withBackend(
          [
            TestModel.turn([TestModel.toolCall("read", { path: "fixture.txt" }, { id: "steer-read" })], {
              delay: Duration.millis(100),
            }),
            TestModel.text("steered"),
          ],
          (fixture, directory) =>
            Effect.scoped(
              Effect.gen(function* () {
                const fileSystem = yield* FileSystem.FileSystem
                yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "fixture")
                const backend = yield* ExecutionBackend.Service
                const fiber = yield* Effect.forkScoped(
                  start(backend, { threadId: "thread-steer", turnId: "turn-steer", prompt: "start", startedAt: 1 }),
                )
                yield* fixture.awaitRequests(1)
                yield* backend.steer("turn-steer", "focus on the fixture", 2)
                const result = yield* Fiber.join(fiber)
                return { result, requests: yield* fixture.requests }
              }),
            ),
        )
        const result = yield* program
        expect(result.result.status).toBe("completed")
        expect(result.requests).toHaveLength(2)
        expect(encodeJson(result.requests[0])).not.toContain("focus on the fixture")
        expect(encodeJson(result.requests[1]).match(/focus on the fixture/g)).toHaveLength(1)
      }),
    ),
  30_000,
)

test(
  "persists automatic compaction across backend restart and reuses compacted context",
  () =>
    runNative(
      Effect.gen(function* () {
        const usage = Response.Usage.make({
          inputTokens: { uncached: 200, total: 200, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        })
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-compaction-" })
            yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "sensitive fixture contents")
            const fixture = yield* TestModel.make([
              TestModel.turn([TestModel.toolCall("read", { path: "fixture.txt" }, { id: "compact-read" })], {
                usage,
              }),
              TestModel.text(
                "Goal: Finish the compacted run. The fixture was read. Continue with the durable checkpoint.",
              ),
              TestModel.text("compaction complete"),
            ])
            const filename = `${directory}/relay.db`
            const options = {
              filename,
              workspace: directory,
              registration: fixture.registration,
              selection: fixture.selection,
              modelVariantPolicy: "fixed-selection" as const,
              compaction: { contextWindow: 100, reserveTokens: 1, keepRecentTokens: 10 },
            }
            const input = {
              threadId: "thread-compaction",
              turnId: "turn-compaction",
              prompt: "read fixture.txt and finish",
              startedAt: 1,
            }
            const run = <A, E>(effect: Effect.Effect<A, E, ExecutionBackend.Service>) =>
              provide(effect, RelayExecutionBackend.layer(options))
            const completed = yield* run(
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                return yield* start(backend, input)
              }),
            )
            const database = new Database(filename, { readonly: true })
            const checkpoints = database
              .query("SELECT checkpoint_id, summary, turn FROM relay_agent_compactions WHERE execution_id = ?")
              .all("execution:turn-compaction") as ReadonlyArray<{
              checkpoint_id: string
              summary: string
              turn: number
            }>
            database.close()
            const reopened = yield* run(
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                const duplicate = yield* start(backend, input)
                return { duplicate, replay: yield* backend.replay(input.turnId) }
              }),
            )
            const verifyDatabase = new Database(filename, { readonly: true })
            const checkpointCount = verifyDatabase
              .query("SELECT count(*) AS count FROM relay_agent_compactions WHERE execution_id = ?")
              .get("execution:turn-compaction") as { count: number }
            verifyDatabase.close()
            return {
              completed,
              reopened,
              checkpoints,
              checkpointCount: checkpointCount.count,
              requests: yield* fixture.requests,
            }
          }),
        )
        expect(result.completed.status).toBe("completed")
        expect(result.checkpoints).toHaveLength(1)
        expect(result.checkpoints[0]?.checkpoint_id).toContain("compaction:execution:turn-compaction")
        expect(result.checkpoints[0]?.summary).toContain("Finish the compacted run")
        expect(result.checkpointCount).toBe(1)
        expect(result.reopened.duplicate.events).toEqual(result.reopened.replay.events)
        expect(result.requests).toHaveLength(3)
        expect(result.requests.map((request) => request.operation)).toEqual([
          "streamText",
          "generateText",
          "streamText",
        ])
        expect(encodeJson(result.requests[1]?.prompt)).toContain("Summarize the conversation")
        expect(encodeJson(result.requests[1]?.prompt)).not.toContain("sensitive fixture contents")
        expect(encodeJson(result.requests[1]?.prompt)).not.toContain("compaction complete")
        expect(encodeJson(result.requests[2]?.prompt)).toContain("Finish the compacted run")
        expect(encodeJson(result.requests[2]?.prompt)).toContain("sensitive fixture contents")
        expect(encodeJson(result.reopened.replay.events)).toContain("sensitive fixture contents")
      }),
    ),
  60_000,
)

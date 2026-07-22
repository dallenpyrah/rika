import * as BunServices from "@effect/platform-bun/BunServices"
import { ModelRegistry } from "@batonfx/core"
import { TestModel } from "@batonfx/test"
import { Runtime as RikaToolRuntime } from "@rika/tools"
import { expect, test } from "vitest"
import { Database } from "bun:sqlite"
import { Clock, Duration, Effect, FileSystem, Layer, Schema } from "effect"
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
  "completes idempotently and replays from a cursor",
  () =>
    runNative(
      Effect.gen(function* () {
        const program = withBackend([TestModel.text("deterministic answer")], (fixture) =>
          Effect.gen(function* () {
            const backend = yield* ExecutionBackend.Service
            const streamed: Array<ExecutionBackend.Event> = []
            const input = {
              threadId: "thread-a",
              turnId: "turn-a",
              prompt: "hello",
              startedAt: 1,
              onEvent: (event: ExecutionBackend.Event) => streamed.push(event),
            }
            const first = yield* start(backend, input)
            const { onEvent: _onEvent, ...duplicateInput } = input
            const duplicate = yield* start(backend, duplicateInput)
            const replay = yield* backend.replay(input.turnId)
            const cursor = replay.events.at(1)?.cursor
            const after = yield* backend.replay(input.turnId, cursor)
            return { first, duplicate, replay, after, streamed, requests: yield* fixture.requests }
          }),
        )
        const result = yield* program
        expect(result.first.status).toBe("completed")
        expect(result.first.events.map((event) => event.type)).toContain("model.output.completed")
        expect(result.streamed).toEqual([...result.first.events])
        expect(result.duplicate.events.map((event) => event.cursor)).toEqual(
          result.first.events.map((event) => event.cursor),
        )
        expect(result.replay.events.map((event) => event.cursor)).toEqual(
          result.first.events.map((event) => event.cursor),
        )
        expect(result.after.events[0]?.cursor).not.toBe(result.replay.events[0]?.cursor)
        expect(result.requests).toHaveLength(1)
      }),
    ),
  30_000,
)

test(
  "executes the Rika toolkit through Relay and returns the result to Baton",
  () =>
    runNative(
      Effect.gen(function* () {
        const program = withBackend(
          [
            TestModel.turn([TestModel.toolCall("read", { path: "fixture.txt" }, { id: "read-1" })]),
            TestModel.text("tool complete"),
          ],
          (fixture, directory) =>
            Effect.gen(function* () {
              const fileSystem = yield* FileSystem.FileSystem
              yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "tool fixture")
              const backend = yield* ExecutionBackend.Service
              const result = yield* start(backend, {
                threadId: "thread-tools",
                turnId: "turn-tools",
                prompt: "read fixture.txt",
                startedAt: 1,
              })
              return { result, requests: yield* fixture.requests }
            }),
        )
        const result = yield* program
        expect(result.result.status).toBe("completed")
        expect(result.requests).toHaveLength(2)
        expect(encodeJson(result.requests[1])).toContain("fixture.txt")
      }),
    ),
  30_000,
)

test(
  "keeps provider tool-call identifiers on the wire and namespaces durable keys by execution",
  () =>
    runNative(
      Effect.gen(function* () {
        const originalCallId = `call_${"a".repeat(59)}`
        const program = withBackend(
          [
            TestModel.toolCall("grep", { pattern: "fixture", regex: false }, { id: originalCallId }),
            TestModel.text("first tool turn complete"),
            TestModel.toolCall("grep", { pattern: "fixture", regex: false }, { id: originalCallId }),
            TestModel.text("second tool turn complete"),
          ],
          (fixture, directory) =>
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              const first = yield* start(backend, {
                threadId: "thread-reused-call-id",
                turnId: "first-reused-call-id",
                prompt: "first",
                startedAt: 1,
              })
              const second = yield* start(backend, {
                threadId: "thread-reused-call-id",
                turnId: "second-reused-call-id",
                prompt: "second",
                startedAt: 2,
              })
              const calls = yield* Effect.acquireUseRelease(
                Effect.sync(() => new Database(`${directory}/relay.db`, { readonly: true })),
                (database) =>
                  Effect.sync(() =>
                    database
                      .query<
                        { readonly id: string; readonly execution_id: string },
                        []
                      >("select id, execution_id from relay_tool_calls order by execution_id")
                      .all(),
                  ),
                (connection) => Effect.sync(() => connection.close()),
              )
              return { first, second, calls, requests: yield* fixture.requests }
            }),
          { compaction: { contextWindow: 1_000_000, reserveTokens: 100, keepRecentTokens: 100 } },
        )
        const result = yield* program
        expect(result.first.status).toBe("completed")
        expect(result.second.status).toBe("completed")
        expect(result.calls).toHaveLength(2)
        expect(result.calls.map((call) => call.id)).toEqual([originalCallId, originalCallId])
        expect(new Set(result.calls.map((call) => call.execution_id)).size).toBe(2)
        const secondTurnRequest = result.requests[2]
        expect(secondTurnRequest).toBeDefined()
        const replayedCallIds = secondTurnRequest!.prompt.content.flatMap((message) =>
          typeof message.content === "string"
            ? []
            : message.content.flatMap((part) =>
                part.type === "tool-call" || part.type === "tool-result" ? [part.id] : [],
              ),
        )
        expect(replayedCallIds).toEqual([originalCallId, originalCallId])
        expect(encodeJson(secondTurnRequest!.prompt.content)).toContain("first")
        expect(encodeJson(secondTurnRequest!.prompt.content)).toContain("second")
        const providerCallIds = result.requests.flatMap((request) =>
          request.prompt.content.flatMap((message) =>
            typeof message.content === "string"
              ? []
              : message.content.flatMap((part) =>
                  part.type === "tool-call" || part.type === "tool-result" ? [part.id] : [],
                ),
          ),
        )
        expect(providerCallIds.length).toBeGreaterThan(0)
        expect(providerCallIds.every((callId) => callId === originalCallId && callId.length <= 64)).toBe(true)
      }),
    ),
  30_000,
)

test(
  "delivers tool lifecycle events while the execution is still running",
  () =>
    runNative(
      Effect.gen(function* () {
        const program = withBackend(
          [
            TestModel.toolCall("bash", { command: "/bin/sleep 0.2", timeout_ms: 500 }, { id: "timed-tool" }),
            TestModel.turn([TestModel.text("timed tool complete")], { delay: Duration.millis(200) }),
          ],
          () =>
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              const clock = yield* Clock.Clock
              const received: Array<{ readonly type: string; readonly at: number }> = []
              const result = yield* start(backend, {
                threadId: "thread-live-tool-events",
                turnId: "turn-live-tool-events",
                prompt: "run the timed tool",
                startedAt: 1,
                onEvent: (event) => received.push({ type: event.type, at: clock.currentTimeMillisUnsafe() }),
              })
              return { received, result }
            }),
        )
        const { received, result } = yield* program
        const requested = received.find((event) => event.type === "tool.call.requested")
        const completed = received.find((event) => event.type === "tool.result.received")
        const output = received.find((event) => event.type === "model.output.delta")
        expect(result.status).toBe("completed")
        expect(requested).toBeDefined()
        expect(completed).toBeDefined()
        expect(output).toBeDefined()
        expect(completed!.at - requested!.at).toBeGreaterThanOrEqual(100)
        expect(output!.at - completed!.at).toBeGreaterThanOrEqual(100)
        expect(output!.at - requested!.at).toBeLessThan(1_000)
      }),
    ),
  30_000,
)

test(
  "routes durable tools to each execution's workspace",
  () =>
    runNative(
      Effect.gen(function* () {
        const program = Effect.scoped(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runtime-workspaces-" })
            const firstWorkspace = `${directory}/first`
            const secondWorkspace = `${directory}/second`
            yield* fileSystem.makeDirectory(firstWorkspace)
            yield* fileSystem.makeDirectory(secondWorkspace)
            const fixture = yield* TestModel.make([
              TestModel.toolCall("bash", { command: "sleep 0.1; printf alive > process.txt", timeout_ms: 0 }),
              TestModel.toolCall("shell_command_status", { processId: "1", waitMillis: 1_000 }),
              TestModel.toolCall("write", { path: "result.txt", content: "first" }),
              TestModel.text("first complete"),
              TestModel.toolCall("write", { path: "result.txt", content: "second" }),
              TestModel.text("second complete"),
            ])
            const workspaceByExecution = new Map([
              ["execution:first-turn", firstWorkspace],
              ["execution:second-turn", secondWorkspace],
            ])
            let runtimeBuilds = 0
            const backendLayer = RelayExecutionBackend.layer({
              filename: `${directory}/relay.db`,
              workspace: directory,
              registration: fixture.registration,
              selection: fixture.selection,
              modelVariantPolicy: "fixed-selection",
              toolRuntimeLayerForWorkspace: (workspace) => {
                runtimeBuilds += 1
                return RikaToolRuntime.layerWithProcessRegistry(workspace)
              },
              resolveWorkspace: (executionId) => {
                const workspace = workspaceByExecution.get(executionId)
                return workspace === undefined
                  ? Effect.fail(ExecutionBackend.BackendError.make({ message: `Unknown execution ${executionId}` }))
                  : Effect.succeed(workspace)
              },
              toolNeedsApproval: () => false,
              permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
            })
            yield* provide(
              Effect.gen(function* () {
                const backend = yield* ExecutionBackend.Service
                yield* start(backend, { threadId: "first-thread", turnId: "first-turn", prompt: "first", startedAt: 1 })
                yield* start(backend, {
                  threadId: "second-thread",
                  turnId: "second-turn",
                  prompt: "second",
                  startedAt: 2,
                })
              }),
              backendLayer,
            )
            const contents = yield* Effect.all([
              fileSystem.readFileString(`${firstWorkspace}/result.txt`),
              fileSystem.readFileString(`${secondWorkspace}/result.txt`),
              fileSystem.readFileString(`${firstWorkspace}/process.txt`),
            ])
            return { contents, runtimeBuilds }
          }),
        )

        expect(yield* program).toEqual({ contents: ["first", "second", "alive"], runtimeBuilds: 4 })
      }),
    ),
  30_000,
)

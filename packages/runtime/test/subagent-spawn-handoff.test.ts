import * as BunServices from "@effect/platform-bun/BunServices"
import { TestModel } from "@batonfx/test"
import { Runtime } from "@rika/tools"
import { expect, test } from "vitest"
import { Database } from "bun:sqlite"
import { Effect, FileSystem, Layer, Schedule } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"
import { start } from "./current-execution-route"

const terminal = (status: string) => status === "completed" || status === "failed" || status === "cancelled"

test("model spawns a durable Oracle child through the handoff tool and resumes with its result", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-" })
      const fixture = yield* TestModel.make([
        TestModel.toolCall("oracle", { prompt: "Investigate the boundary." }, { id: "call-oracle" }),
        TestModel.turn([
          ...Array.from({ length: 1_100 }, () => TestModel.text(".")),
          TestModel.text("Oracle investigated the boundary."),
        ]),
        TestModel.text("Parent synthesized the child answer."),
      ])
      const runtimeLayer = Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false }))
      const backendLayer = RelayExecutionBackend.layer({
        filename: `${directory}/relay.db`,
        workspace: directory,
        registration: fixture.registration,
        selection: fixture.selection,
        modelVariantPolicy: "fixed-selection",
        toolRuntimeLayer: runtimeLayer,
        toolNeedsApproval: () => false,
        permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
        compaction: {
          contextWindow: 1_000_000,
          reserveTokens: 100,
          keepRecentTokens: 100,
        },
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const started = yield* start(backend, {
          threadId: "thread-subagent",
          turnId: "turn-subagent",
          prompt: "Ask the Oracle to investigate the boundary.",
          startedAt: 1,
        })
        const settled = yield* backend.replay("turn-subagent").pipe(
          Effect.repeat({
            while: (result) => !terminal(result.status),
            schedule: Schedule.spaced("20 millis"),
          }),
        )
        const inspection = yield* backend.inspect("turn-subagent")
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/relay.db`, { readonly: true })),
          (connection) => Effect.sync(() => connection.close()),
        )
        const childExecutionId = `child:${encodeURIComponent("execution:turn-subagent")}:call-oracle`
        const child = database
          .query<
            { readonly id: string; readonly session_id: string | null; readonly status: string },
            [string]
          >("select id, session_id, status from relay_executions where id = ?")
          .get(childExecutionId ?? "")
        const childFailure =
          child === null
            ? null
            : database
                .query<
                  { readonly data_json: string },
                  [string]
                >("select data_json from relay_execution_events where execution_id = ? and type = 'execution.failed'")
                .get(child.id)
        const childEventCount =
          child === null
            ? 0
            : (database
                .query<
                  { readonly count: number },
                  [string]
                >("select count(*) as count from relay_execution_events where execution_id = ?")
                .get(child.id)?.count ?? 0)
        return { started, settled, inspection, child, childFailure, childEventCount }
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
      Effect.tap(({ started, settled, inspection, child, childFailure, childEventCount }) =>
        Effect.sync(() => {
          const settledTypes = settled.events.map((event) => event.type)
          const requested = settled.events.filter((event) => event.type === "tool.call.requested")
          expect(started.status).not.toBe("failed")
          expect(requested.some((event) => event.data?.tool_name === "oracle")).toBe(true)
          expect(childFailure).toBeNull()
          expect(settledTypes).toContain("child_run.spawned")
          expect(settled.status).toBe("completed")
          expect(inspection?.children).toHaveLength(1)
          expect(child?.status).toBe("completed")
          expect(child?.session_id).toBe(`session:child:${child?.id}`)
          expect(childEventCount).toBeGreaterThan(1_000)
          expect(inspection?.children[0]?.status).toBe("completed")
          expect(
            settled.events
              .filter((event) => event.type === "model.output.delta")
              .map((event) => event.text)
              .join(""),
          ).toBe("Parent synthesized the child answer.")
        }),
      ),
    ),
  )
}, 60_000)

test("handoff children resolve real workspace tools through their parent Rika turn", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-workspace-" })
      const workspace = `${directory}/workspace`
      yield* fileSystem.makeDirectory(workspace)
      yield* fileSystem.writeFileString(`${workspace}/AGENTS.md`, "child workspace marker")
      const fixture = yield* TestModel.make([
        TestModel.toolCall("review", { prompt: "Inspect AGENTS.md." }, { id: "call-review" }),
        TestModel.turn([TestModel.toolCall("read", { path: "AGENTS.md" }, { id: "call-child-read" })]),
        TestModel.text("Child inspected the workspace."),
        TestModel.text("Parent received the review."),
      ])
      const workspaces = new Map([["turn-review", workspace]])
      const backendLayer = RelayExecutionBackend.layer({
        filename: `${directory}/relay.db`,
        workspace: directory,
        registration: fixture.registration,
        selection: fixture.selection,
        modelVariantPolicy: "fixed-selection",
        toolRuntimeLayerForWorkspace: Runtime.layerWithProcessRegistry,
        resolveWorkspace: (executionId) => {
          const turnId = RelayExecutionBackend.turnIdFromExecutionId(executionId)
          const resolved = turnId === undefined ? undefined : workspaces.get(turnId)
          return resolved === undefined
            ? Effect.fail(
                ExecutionBackend.BackendError.make({
                  message: turnId === undefined ? `Unknown execution ${executionId}` : `Turn ${turnId} does not exist`,
                }),
              )
            : Effect.succeed(resolved)
        },
        toolNeedsApproval: () => false,
        permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const started = yield* start(backend, {
          threadId: "thread-review",
          turnId: "turn-review",
          prompt: "Ask Review to inspect AGENTS.md.",
          startedAt: 1,
        })
        const settled = yield* backend.replay("turn-review").pipe(
          Effect.repeat({
            while: (result) => !terminal(result.status),
            schedule: Schedule.spaced("20 millis"),
          }),
        )
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/relay.db`, { readonly: true })),
          (connection) => Effect.sync(() => connection.close()),
        )
        const toolResult = database
          .query<
            { readonly output_json: string; readonly error: string | null },
            [string]
          >("select output_json, error from relay_tool_results where output_json like ?")
          .get("%child workspace marker%")
        return { started, settled, toolResult }
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
      Effect.tap(({ started, settled, toolResult }) =>
        Effect.sync(() => {
          expect(started.status).toBe("completed")
          expect(settled.status).toBe("completed")
          expect(toolResult?.error).toBeNull()
          expect(toolResult?.output_json).toContain("child workspace marker")
        }),
      ),
    ),
  )
}, 60_000)

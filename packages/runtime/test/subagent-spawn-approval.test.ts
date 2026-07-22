import * as BunServices from "@effect/platform-bun/BunServices"
import { TestModel } from "@batonfx/test"
import { Runtime } from "@rika/tools"
import { expect, test } from "vitest"
import { Database } from "bun:sqlite"
import { Effect, FileSystem, Layer } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"
import { start } from "./current-execution-route"

test("handoff child approval asks surface through the parent and resume after approval", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-permission-" })
      yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "permission marker")
      const fixture = yield* TestModel.make([
        TestModel.toolCall("review", { prompt: "Read fixture.txt." }, { id: "call-parent-review" }),
        TestModel.toolCall("read", { path: "fixture.txt" }, { id: "call-child-permission" }),
        TestModel.text("Child read the fixture."),
        TestModel.text("Parent received the approved child result."),
      ])
      const backendLayer = RelayExecutionBackend.layer({
        filename: `${directory}/relay.db`,
        workspace: directory,
        registration: fixture.registration,
        selection: fixture.selection,
        modelVariantPolicy: "fixed-selection",
        toolRuntimeLayer: Runtime.layer(directory),
        toolNeedsApproval: (name) => name === "read",
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const input = {
          threadId: "thread-child-permission",
          turnId: "turn-child-permission",
          prompt: "Ask Review to read fixture.txt.",
          startedAt: 1,
        }
        const waiting = yield* start(backend, input)
        const ask = waiting.events.find((event) => event.type === "tool.approval.requested")
        const waitId = ask?.data?.wait_id
        if (typeof waitId !== "string") return yield* Effect.die("Missing child permission wait")
        const approvals = yield* backend.listApprovals(input.turnId)
        yield* backend.resolveToolApproval(waitId, true, 2, "test approval")
        const completed = yield* start(backend, input)
        return { waiting, ask, approvals, completed, requests: yield* fixture.requests }
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
      Effect.tap(({ waiting, ask, approvals, completed, requests }) =>
        Effect.sync(() => {
          expect(waiting.status).toBe("waiting")
          expect(String(ask?.data?.execution_id).startsWith("child:execution%3Aturn-child-permission:")).toBe(true)
          expect(approvals[0]?.executionId).toBe(String(ask?.data?.execution_id))
          expect(completed.status).toBe("completed")
          expect(requests.length).toBeGreaterThanOrEqual(4)
        }),
      ),
    ),
  )
}, 60_000)

test("parent and handoff child may reuse a model tool-call identifier", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-call-id-" })
      yield* fileSystem.writeFileString(`${directory}/fixture.txt`, "shared call id marker")
      const fixture = yield* TestModel.make([
        TestModel.toolCall("review", { prompt: "Read fixture.txt." }, { id: "call_shared" }),
        TestModel.toolCall("read", { path: "fixture.txt" }, { id: "call_shared" }),
        TestModel.text("Child reused the call id."),
        TestModel.text("Parent received the child result."),
      ])
      const backendLayer = RelayExecutionBackend.layer({
        filename: `${directory}/relay.db`,
        workspace: directory,
        registration: fixture.registration,
        selection: fixture.selection,
        modelVariantPolicy: "fixed-selection",
        toolRuntimeLayer: Runtime.layer(directory),
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
        const completed = yield* start(backend, {
          threadId: "thread-shared-call-id",
          turnId: "turn-shared-call-id",
          prompt: "Ask Review to read fixture.txt.",
          startedAt: 1,
        })
        const inspection = yield* backend.inspect("turn-shared-call-id")
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(`${directory}/relay.db`, { readonly: true })),
          (connection) => Effect.sync(() => connection.close()),
        )
        const readResult = database
          .query<
            { readonly output_json: string; readonly error: string | null },
            [string]
          >("select output_json, error from relay_tool_results where output_json like ?")
          .get("%shared call id marker%")
        const calls = database
          .query<
            { readonly id: string; readonly execution_id: string },
            []
          >("select id, execution_id from relay_tool_calls order by execution_id, id")
          .all()
        return { completed, inspection, readResult, calls }
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
      Effect.tap(({ completed, inspection, readResult, calls }) =>
        Effect.sync(() => {
          expect(completed.status).toBe("completed")
          expect(inspection?.children[0]?.status).toBe("completed")
          expect(readResult?.error).toBeNull()
          expect(readResult?.output_json).toContain("shared call id marker")
          expect(calls).toHaveLength(2)
          expect(calls.map((call) => call.id)).toEqual(["call_shared", "call_shared"])
          expect(new Set(calls.map((call) => call.execution_id)).size).toBe(2)
        }),
      ),
    ),
  )
}, 60_000)

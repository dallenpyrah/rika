import * as BunServices from "@effect/platform-bun/BunServices"
import { TestModel } from "@batonfx/test"
import { Runtime } from "@rika/tools"
import { expect, test } from "bun:test"
import { Effect, FileSystem, Schedule } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"

const terminal = (status: string) => status === "completed" || status === "failed" || status === "cancelled"

test("model spawns a durable Oracle child through the handoff tool and resumes with its result", async () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-" })
      const fixture = yield* TestModel.make([
        TestModel.toolCall("transfer_to_oracle", {}, { id: "call-oracle" }),
        TestModel.text("Oracle investigated the boundary."),
        TestModel.text('{"answer":"Oracle investigated the boundary.","evidence":[]}'),
        TestModel.text("Parent synthesized the child answer."),
      ])
      const runtimeLayer = Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false }))
      const backendLayer = RelayExecutionBackend.layer({
        filename: `${directory}/relay.db`,
        workspace: directory,
        registration: fixture.registration,
        selection: fixture.selection,
        toolRuntimeLayer: runtimeLayer,
        toolNeedsApproval: () => false,
        permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
      })
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const started = yield* backend.start({
          threadId: "thread-subagent",
          turnId: "turn-subagent",
          prompt: "Ask the Oracle to investigate the boundary.",
          startedAt: 1,
        })
        const settled = yield* backend.replay("turn-subagent").pipe(
          Effect.repeat({
            while: (result) => !terminal(result.status),
            schedule: Schedule.both(Schedule.spaced("20 millis"), Schedule.recurs(500)),
          }),
        )
        return { started, settled }
      }).pipe(Effect.provide(backendLayer))
    }),
  ).pipe(Effect.provide(BunServices.layer))
  const { started, settled } = await Effect.runPromise(program)
  const settledTypes = settled.events.map((event) => event.type)
  const requested = settled.events.filter((event) => event.type === "tool.call.requested")
  expect(started.status).not.toBe("failed")
  expect(requested.some((event) => (event.data?.tool_name as string | undefined) === "transfer_to_oracle")).toBe(true)
  expect(settledTypes).toContain("child_run.spawned")
  expect(settled.status).toBe("completed")
}, 60_000)

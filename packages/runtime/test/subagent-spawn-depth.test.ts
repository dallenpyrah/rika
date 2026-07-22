import * as BunServices from "@effect/platform-bun/BunServices"
import { TestModel } from "@batonfx/test"
import { Runtime } from "@rika/tools"
import { expect, test } from "vitest"
import { Database } from "bun:sqlite"
import { Effect, FileSystem, Layer } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"
import { start } from "./current-execution-route"

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

test("depth-one agents call specialists and spawn a chosen depth-two model without depth-three tools", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-subagent-nested-" })
      const terra = yield* TestModel.make(
        [
          TestModel.toolCall("task", { prompt: "Coordinate nested work." }, { id: "call-depth-one" }),
          TestModel.turn([
            TestModel.toolCall("oracle", { prompt: "Check the nested design." }, { id: "call-oracle" }),
            TestModel.toolCall(
              "task",
              { prompt: "Do a cheap nested check.", model: "gpt-5.6-luna" },
              { id: "call-depth-two" },
            ),
          ]),
          TestModel.text("Depth one combined both results."),
          TestModel.text("Root received the nested result."),
        ],
        { provider: "test", model: "gpt-5.6-terra", registrationKey: "terra-medium" },
      )
      const luna = yield* TestModel.make([TestModel.text("Luna completed the nested check.")], {
        provider: "test",
        model: "gpt-5.6-luna",
        registrationKey: "luna-medium",
      })
      const sol = yield* TestModel.make([TestModel.text("Oracle checked the nested design.")], {
        provider: "test",
        model: "gpt-5.6-sol",
        registrationKey: "sol-medium",
      })
      const executionRoute: ExecutionBackend.ExecutionRoutePin = {
        mode: "test",
        main: executionModelRoute("main", terra.selection),
        oracle: executionModelRoute("oracle", sol.selection),
        title: executionModelRoute("title", luna.selection),
        agents: {
          librarian: executionModelRoute("librarian", terra.selection),
          painter: executionModelRoute("painter", terra.selection),
          review: executionModelRoute("review", terra.selection),
          readThread: executionModelRoute("readThread", terra.selection),
          task: executionModelRoute("task", terra.selection),
        },
      }
      const backendLayer = RelayExecutionBackend.layer({
        filename: `${directory}/relay.db`,
        workspace: directory,
        registration: terra.registration,
        additionalRegistrations: [luna.registration, sol.registration],
        selection: terra.selection,
        toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "runtime", truncated: false })),
        toolNeedsApproval: () => false,
        permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
      })
      const backendContext = yield* Layer.build(backendLayer)
      return yield* Effect.gen(function* () {
        const backend = yield* ExecutionBackend.Service
        const settled = yield* start(backend, {
          threadId: "thread-nested-spawn",
          turnId: "turn-nested-spawn",
          prompt: "Coordinate nested work.",
          startedAt: 1,
          executionRoute,
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
        const failures = database
          .query<
            { readonly execution_id: string; readonly data_json: string },
            []
          >("select execution_id, data_json from relay_execution_events where execution_id like 'child:%' and type = 'execution.failed' order by execution_id")
          .all()
        const delegationResults = database
          .query<
            {
              readonly execution_id: string
              readonly name: string
              readonly input_json: string
              readonly output_json: string
              readonly error: string | null
            },
            []
          >(
            "select call.execution_id, call.name, call.input_json, result.output_json, result.error from relay_tool_calls call join relay_tool_results result on result.tool_call_id = call.id where call.execution_id like 'child:%' and call.name in ('task', 'oracle') order by call.created_at",
          )
          .all()
        return {
          settled,
          children,
          failures,
          delegationResults,
          terraRequests: yield* terra.requests,
          lunaRequests: yield* luna.requests,
          solRequests: yield* sol.requests,
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
      Effect.tap(({ settled, children, failures, delegationResults, terraRequests, lunaRequests, solRequests }) =>
        Effect.sync(() => {
          const delegationTools = ["task", "oracle", "librarian", "review"]
          const depthOneTools = terraRequests[1]?.tools.map((tool) => tool.name) ?? []
          const lunaDepthTwoTools = lunaRequests[0]?.tools.map((tool) => tool.name) ?? []
          const oracleDepthTwoTools = solRequests[0]?.tools.map((tool) => tool.name) ?? []
          expect(settled.status).toBe("completed")
          expect(failures).toEqual([])
          expect(terraRequests).toHaveLength(4)
          expect(delegationResults).toHaveLength(2)
          expect(delegationResults.map((result) => ({ name: result.name, error: result.error }))).toEqual([
            { name: "oracle", error: null },
            { name: "task", error: null },
          ])
          expect(children).toHaveLength(3)
          expect(children.every((child) => child.status === "completed")).toBe(true)
          expect(depthOneTools).toEqual(expect.arrayContaining(delegationTools))
          expect(lunaDepthTwoTools).not.toEqual(expect.arrayContaining(delegationTools))
          expect(oracleDepthTwoTools).not.toEqual(expect.arrayContaining(delegationTools))
          expect(lunaRequests).toHaveLength(1)
          expect(solRequests).toHaveLength(1)
          expect(
            children.some((child) => {
              const snapshot = JSON.parse(child.agent_snapshot_json) as {
                readonly model?: {
                  readonly model?: string
                  readonly registration_key?: string
                  readonly metadata?: {
                    readonly rika_agent_depth?: number
                    readonly rika_reasoning_effort?: string
                  }
                }
              }
              return (
                snapshot.model?.model === "gpt-5.6-terra" &&
                snapshot.model.registration_key === "terra-medium" &&
                snapshot.model.metadata?.rika_agent_depth === 1 &&
                snapshot.model.metadata.rika_reasoning_effort === "medium"
              )
            }),
          ).toBe(true)
          expect(
            children.some((child) => {
              const snapshot = JSON.parse(child.agent_snapshot_json) as {
                readonly model?: {
                  readonly model?: string
                  readonly registration_key?: string
                  readonly metadata?: {
                    readonly rika_agent_depth?: number
                    readonly rika_reasoning_effort?: string
                  }
                }
              }
              return (
                snapshot.model?.model === "gpt-5.6-luna" &&
                snapshot.model.registration_key === "luna-medium" &&
                snapshot.model.metadata?.rika_agent_depth === 2 &&
                snapshot.model.metadata.rika_reasoning_effort === "medium"
              )
            }),
          ).toBe(true)
          expect(
            settled.events
              .filter(
                (event) =>
                  event.type === "model.output.delta" && event.cursor.startsWith("execution:turn-nested-spawn:"),
              )
              .map((event) => event.text)
              .join(""),
          ).toBe("Root received the nested result.")
        }),
      ),
    ),
  )
}, 60_000)

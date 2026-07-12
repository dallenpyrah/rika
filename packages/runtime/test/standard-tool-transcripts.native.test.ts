import * as BunServices from "@effect/platform-bun/BunServices"
import { TestModel } from "@batonfx/test"
import { Catalog, Runtime, ThreadTools } from "@rika/tools"
import { expect, test } from "bun:test"
import { Effect, FileSystem } from "effect"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"

const cases = [
  ["find_files", { query: "fixture" }],
  ["grep", { pattern: "needle", regex: false }],
  ["read_file", { path: "fixture.txt", limit: 1 }],
  ["create_file", { path: "created.txt", content: "value" }],
  ["edit_file", { path: "fixture.txt", oldText: "old", newText: "new" }],
  ["apply_patch", { patchText: "*** Begin Patch\n*** End Patch" }],
  ["shell", { command: "printf", args: ["safe"] }],
  ["shell_command_status", { processId: "process-1", waitMillis: 0 }],
  ["git_status", {}],
  ["web_search", { objective: "deterministic research", searchQueries: ["fixture"] }],
  ["read_web_page", { url: "https://example.test/page", fullContent: true }],
  ["view_media", { path: "fixture.png" }],
  ["find_thread", { query: "workspace:fixture", limit: 1 }],
  ["read_thread", { threadId: "thread-fixture", maxTurns: 1, maxChars: 100 }],
] as const

const caseNames = new Set<string>(cases.map(([name]) => name))
const standardNames = Catalog.definitions
  .map(({ name }) => name)
  .filter((name): name is (typeof cases)[number][0] => caseNames.has(name))

const threadHandlers = ThreadTools.toolkit.toLayer(
  Effect.succeed({
    find_thread: () => Effect.succeed({ text: "thread result", truncated: false }),
    read_thread: () => Effect.succeed({ text: "thread transcript", truncated: false }),
  }),
)

test("standard catalog transcript matrix is complete", () => {
  expect(cases.map(([name]) => name).toSorted()).toEqual(standardNames.toSorted())
})

for (const [name, parameters] of cases) {
  test(`persists deterministic ${name} call and result`, async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-tool-matrix-" })
        const fixture = yield* TestModel.make([
          TestModel.toolCall(name, parameters, { id: `call-${name}` }),
          TestModel.text(`${name} complete`),
        ])
        const definition = Catalog.get(name)!
        const marker = name === "read_file" ? "[REDACTED]" : `deterministic ${name}`
        const bounded = marker
          .repeat(Math.ceil((definition.outputLimit + 1) / marker.length))
          .slice(0, definition.outputLimit)
        const runtimeLayer = Runtime.testLayer((request) =>
          request._tag === "ReadFile"
            ? Effect.succeed({ text: "[REDACTED]", truncated: false })
            : Effect.succeed({ text: bounded, truncated: true }),
        )
        const backendLayer = RelayExecutionBackend.layer({
          filename: `${directory}/relay.db`,
          workspace: directory,
          registration: fixture.registration,
          selection: fixture.selection,
          additionalToolkit: ThreadTools.toolkit,
          additionalHandlerLayer: threadHandlers,
          toolRuntimeLayer: runtimeLayer,
          toolNeedsApproval: () => false,
          permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
        })
        return yield* Effect.gen(function* () {
          const backend = yield* ExecutionBackend.Service
          const completed = yield* backend.start({
            threadId: `thread-${name}`,
            turnId: `turn-${name}`,
            prompt: `invoke ${name}`,
            startedAt: 1,
          })
          return { completed, replay: yield* backend.replay(`turn-${name}`), requests: yield* fixture.requests }
        }).pipe(Effect.provide(backendLayer))
      }),
    ).pipe(Effect.provide(BunServices.layer))
    const result = await Effect.runPromise(program)
    const definition = Catalog.get(name)!
    const types = result.replay.events.map((event) => event.type)
    expect(result.completed.status).toBe("completed")
    expect(types).toContain("tool.call.requested")
    expect(types).toContain("tool.result.received")
    expect(result.replay.events).toEqual(result.completed.events)
    expect(definition.permission).toBe("allow")
    const transcript = JSON.stringify(result.requests[1])
    expect(transcript).not.toContain("rika-tool-matrix-")
    if (name !== "read_file" && name !== "find_thread" && name !== "read_thread")
      expect(transcript).toContain('"truncated":true')
    if (name === "read_file") expect(transcript).toContain("[REDACTED]")
  }, 30_000)

  test(`rejects malformed ${name} input at the durable boundary`, async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-malformed-" })
          const malformedInput = name === "git_status" ? { refresh: 42 } : { malformed: 42 }
          const fixture = yield* TestModel.make([TestModel.toolCall(name, malformedInput, { id: `bad-${name}` })])
          return yield* Effect.gen(function* () {
            const backend = yield* ExecutionBackend.Service
            return yield* backend.start({ threadId: `bad-${name}`, turnId: `bad-${name}`, prompt: "bad", startedAt: 1 })
          }).pipe(
            Effect.provide(
              RelayExecutionBackend.layer({
                filename: `${directory}/relay.db`,
                workspace: directory,
                registration: fixture.registration,
                selection: fixture.selection,
                additionalToolkit: ThreadTools.toolkit,
                additionalHandlerLayer: threadHandlers,
                toolRuntimeLayer: Runtime.testLayer(() => Effect.succeed({ text: "unexpected", truncated: false })),
                toolNeedsApproval: () => false,
                permissionPolicy: { rules: [{ pattern: "*", level: "allow" }] },
              }),
            ),
            Effect.exit,
          )
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    )
    expect(result._tag).toBe("Failure")
    expect(JSON.stringify(result)).toMatch(/Schema|Parse|invalid|malformed|Execution workflow failed/i)
  }, 30_000)
}

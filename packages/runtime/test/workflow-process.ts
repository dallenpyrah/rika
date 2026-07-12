import { layer as fileSystemLayer } from "@effect/platform-bun/BunFileSystem"
import { TestModel } from "@batonfx/test"
import {
  ChildFanOutRuntime,
  Client,
  Ids,
  LanguageModelService,
  RunnerRuntime,
  SQLite,
  ToolRuntime,
  WorkflowDefinitionRuntime,
} from "@relayfx/sdk/sqlite"
import { Effect, FileSystem, Layer, ManagedRuntime } from "effect"
import { Toolkit } from "effect/unstable/ai"
import * as ExecutionBackend from "../src/execution-contract"
import * as RelayExecutionBackend from "../src/execution-backend"

const database = process.env.RIKA_WORKFLOW_DATABASE ?? "missing.sqlite"
const control = process.env.RIKA_WORKFLOW_WORKSPACE ?? "."
const append = (value: unknown) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fileSystem.writeFileString(`${control}/workflow-visible.ndjson`, `${JSON.stringify(value)}\n`, { flag: "a" }),
    ),
    Effect.provide(fileSystemLayer),
  )
const execute = (childId: string, idempotencyKey: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    yield* append({ type: "dispatch", childId, idempotencyKey })
    const release = `${control}/${childId.replaceAll(":", "-")}.release`
    while (!(yield* fileSystem.exists(release))) yield* Effect.sleep("10 millis")
    yield* append({ type: "effect", childId, idempotencyKey })
    return [{ type: "text" as const, text: childId }]
  }).pipe(Effect.provide(fileSystemLayer))

const fanOutHandlers = ChildFanOutRuntime.testHandlersLayer({
  execute: (child, _fanOut, idempotencyKey) =>
    execute(String(child.child_execution_id), idempotencyKey).pipe(
      Effect.map((output) => ({ status: "completed" as const, output })),
    ),
  cancel: () => Effect.void,
})
const fanOutLayer = SQLite.childFanOutLayer({ filename: database }, fanOutHandlers)
const workflowHandlers = Layer.effect(
  WorkflowDefinitionRuntime.HandlerService,
  ChildFanOutRuntime.Service.pipe(
    Effect.map((fanOut) =>
      WorkflowDefinitionRuntime.HandlerService.of({
        child: (executionId, operation, context) =>
          execute(`child:${executionId}:${operation.id}`, context.idempotency_key),
        approval: (_executionId, operation) => Effect.succeed({ approved: true, prompt: operation.prompt }),
        timer: (_executionId, operation) => Effect.sleep(`${operation.duration_ms} millis`),
        branch: () => Effect.succeed(true),
        structuredCompletion: (_schema, value) => Effect.succeed(value ?? null),
        createChildFanOut: (definition) => fanOut.create(definition),
        admitChildFanOut: () => Effect.void,
        inspectChildFanOut: fanOut.inspect,
      }),
    ),
  ),
).pipe(Layer.provide(fanOutLayer))
const workflowLayer = SQLite.workflowLayer({ filename: database }, workflowHandlers)
const fixture = await Effect.runPromise(TestModel.make(Array.from({ length: 20 }, () => TestModel.text("unused"))))
const runnerLayer = RunnerRuntime.layerWithServices({
  databaseLayer: SQLite.layer({ filename: database }),
  languageModelLayer: LanguageModelService.layer([fixture.registration]),
  toolRuntimeLayer: ToolRuntime.layerFromToolkit(Toolkit.make()).pipe(Layer.provide(Layer.empty)),
})
const clientLayer = Client.layerFromRuntime.pipe(
  Layer.provideMerge(Layer.mergeAll(runnerLayer, fanOutLayer, workflowLayer)),
)
const backendLayer = RelayExecutionBackend.layerFromClient({ selection: { provider: "test", model: "workflow" } }).pipe(
  Layer.provide(clientLayer),
)
const runtime = ManagedRuntime.make(Layer.merge(backendLayer, workflowLayer))
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
const handle = async (message: { readonly id: string; readonly type: string; readonly value?: any }) => {
  const value = await runtime.runPromise(
    Effect.gen(function* () {
      const backend = yield* ExecutionBackend.Service
      if (message.type === "recover") {
        const workflows = yield* WorkflowDefinitionRuntime.Service
        return yield* workflows.recover()
      }
      if (message.type === "register") return yield* backend.registerWorkflows()
      if (message.type === "start")
        return yield* backend.startWorkflow(message.value.name, message.value.runId, message.value.revision)
      return yield* backend.inspectWorkflow(message.value)
    }),
  )
  send({ id: message.id, ok: true, value })
}
let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf("\n")
  while (newline >= 0) {
    const message = JSON.parse(buffer.slice(0, newline))
    buffer = buffer.slice(newline + 1)
    void handle(message).catch((error) => send({ id: message.id, ok: false, error: String(error) }))
    newline = buffer.indexOf("\n")
  }
})
send({ type: "ready", pid: process.pid, host: Ids.WorkflowDefinitionId.make("rika") })

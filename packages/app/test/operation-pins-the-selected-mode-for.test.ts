import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Effect, Layer, Ref } from "effect"
import { Operation } from "../src/index"

const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer)
        return yield* Effect.provide(effect, context)
      }),
    )

const backend = ExecutionBackend.Service.of({
  invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
  createFanOut: () => Effect.die("unused"),
  inspectFanOut: () => Effect.die("unused"),
  cancelFanOut: () => Effect.die("unused"),
  registerWorkflows: () => Effect.die("unused"),
  startWorkflow: () => Effect.die("unused"),
  inspectWorkflow: () => Effect.die("unused"),
  cancelWorkflow: () => Effect.die("unused"),
  start: (input) =>
    Effect.succeed({
      turnId: input.turnId,
      status: "completed",
      events: [
        { cursor: "cursor-a", sequence: 1, type: "model.output.completed", createdAt: 1, text: "answer" },
        { cursor: "cursor-b", sequence: 2, type: "execution.completed", createdAt: 2 },
      ],
    }),
  replay: (turnId) => Effect.succeed({ turnId, status: "completed", events: [] }),
  cancel: (turnId) => Effect.succeed({ turnId, status: "cancelled", events: [] }),
  inspect: () => Effect.void.pipe(Effect.as(undefined)),
  steer: () => Effect.void,
  listApprovals: () => Effect.succeed([]),
  resolveToolApproval: () => Effect.void,
  resolvePermission: () => Effect.void,
})

describe("Operation", () => {
  it.effect("pins the selected mode for non-interactive runs and maps workflow defects", () =>
    Effect.gen(function* () {
      const modes = yield* Ref.make<ReadonlyArray<string>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const layer = Operation.productLayer({
        repositoryLayer: ThreadRepository.memoryLayer(),
        turnRepositoryLayer: TurnRepository.memoryLayer(),
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        resolveExecutionRoute: (mode) => {
          runSync(Ref.update(modes, (all) => [...all, mode]))
          return Effect.succeed({
            version: 1,
            mode,
            tokenBudget: 1,
            main: {
              role: "main",
              alias: "test",
              provider: "test",
              model: "test",
              registrationKey: "test",
              providerProtocol: "test",
              providerBaseUrl: "test://model",
              effort: "medium",
              fast: false,
              requestVariant: "test",
              compaction: { contextWindow: 10, reserveTokens: 2, keepRecentTokens: 1 },
            },
            oracle: {
              role: "oracle",
              alias: "test",
              provider: "test",
              model: "test",
              registrationKey: "test",
              providerProtocol: "test",
              providerBaseUrl: "test://model",
              effort: "medium",
              fast: false,
              requestVariant: "test",
              compaction: { contextWindow: 10, reserveTokens: 2, keepRecentTokens: 1 },
            },
          })
        },
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("mode-thread")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("mode-turn")),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({
          _tag: "Run",
          prompt: ["mode"],
          mode: "ultra",
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        })
      }).pipe(provideLayer(layer))
      expect(yield* Ref.get(modes)).toEqual(["ultra"])

      const workflowLayer = Operation.productLayer({
        repositoryLayer: ThreadRepository.memoryLayer(),
        turnRepositoryLayer: TurnRepository.memoryLayer(),
        backendLayer: Layer.succeed(
          ExecutionBackend.Service,
          ExecutionBackend.Service.of({
            ...backend,
            inspectWorkflow: () => Effect.fail(ExecutionBackend.BackendError.make({ message: "workflow failure" })),
          }),
        ),
        defaultWorkspace: "/work",
        makeThreadId: Effect.die("unused"),
        makeTurnId: Effect.die("unused"),
      })
      const result = yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        const workflow = yield* Effect.result(operation.run({ _tag: "Workflow", action: "inspect", runId: "defect" }))
        const update = yield* Effect.result(operation.run({ _tag: "Update" }))
        const skill = yield* Effect.result(operation.run({ _tag: "Skill", action: "list" }))
        return [workflow, update, skill]
      }).pipe(provideLayer(workflowLayer))
      expect(result.every((value) => value._tag === "Failure")).toBe(true)
    }),
  )
})

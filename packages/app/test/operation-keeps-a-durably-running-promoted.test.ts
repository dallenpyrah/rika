import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Catalog as ToolCatalog } from "@rika/tools"
import { ExecutionExtensions } from "@rika/extensions"
import { Deferred, Effect, Fiber, Layer, Ref, Schema } from "effect"
import { TestConsole } from "effect/testing"
import { Operation, ResolvedContext } from "../src/index"
import { executionRoute } from "./current-state"

const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer)
        return yield* Effect.provide(effect, context)
      }),
    )

const reconcileDependencies = (extensions: ExecutionExtensions.Interface) =>
  Layer.merge(
    ResolvedContext.testLayer({ resolve: () => Effect.die("unused") }),
    Layer.succeed(ExecutionExtensions.Service, extensions),
  )

const unusedExtensions = ExecutionExtensions.Service.of({
  future: () => Effect.die("unused"),
  resume: () => Effect.die("unused"),
})

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

const selectionThread = (id: string): Thread.Thread => ({
  id: Thread.ThreadId.make(id),
  workspace: "/work",
  title: id,
  labels: [],
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
})

describe("Operation", () => {
  it.effect("keeps a durably running promoted turn running when its promoter is interrupted", () =>
    Effect.gen(function* () {
      const thread = selectionThread("interrupted-running-thread")
      const queued: Turn.Turn = {
        id: Turn.TurnId.make("interrupted-running-turn"),
        threadId: thread.id,
        prompt: "already durable",
        executionRoute: executionRoute(),
        status: "queued",
        createdAt: 1,
        updatedAt: 1,
      }
      const turns = yield* TurnRepository.makeMemory([queued])
      const backendEntered = yield* Deferred.make<void>()
      const blockingBackend = ExecutionBackend.Service.of({
        ...backend,
        start: () => Deferred.succeed(backendEntered, undefined).pipe(Effect.andThen(Effect.never)),
      })
      const repair = yield* Effect.forkChild(
        Operation.reconcile(undefined, () =>
          Effect.succeed({ prompt: queued.prompt, promptParts: undefined, extensionPin: undefined }),
        ).pipe(
          provideLayer(
            Layer.mergeAll(
              reconcileDependencies(unusedExtensions),
              ThreadRepository.memoryLayer([thread]),
              Layer.succeed(TurnRepository.Service, turns),
              Layer.succeed(ExecutionBackend.Service, blockingBackend),
            ),
          ),
        ),
      )

      yield* Deferred.await(backendEntered)
      expect(yield* turns.get(queued.id)).toMatchObject({ status: "running" })
      yield* Fiber.interrupt(repair)

      expect(yield* turns.get(queued.id)).toMatchObject({ status: "running" })
      expect(yield* turns.readQueue(thread.id)).toMatchObject({ revision: 2, queuedCount: 0, turns: [] })
    }),
  )

  it.effect("reconciles review route owners through their fan-out without executing the parent prompt", () =>
    Effect.gen(function* () {
      const owner = Turn.TurnId.make("review-owner")
      const turns = yield* TurnRepository.makeMemory([
        {
          id: owner,
          threadId: Thread.ThreadId.make("review-thread"),
          prompt: "Review workspace changes",
          status: "running",
          executionRoute: Turn.testExecutionRoute("medium"),
          reviewFanOutId: "review:review-owner",
          createdAt: 1,
          updatedAt: 2,
        },
      ])
      const starts = yield* Ref.make(0)
      const inspections = yield* Ref.make(0)
      const routeOwnerBackend = ExecutionBackend.Service.of({
        ...backend,
        start: () => Ref.update(starts, (count) => count + 1).pipe(Effect.andThen(Effect.die("must not start"))),
        inspect: () => Effect.die("must not inspect as a turn"),
        inspectFanOut: () =>
          Ref.updateAndGet(inspections, (count) => count + 1).pipe(
            Effect.map((count) =>
              count === 1
                ? {
                    fanOutId: "review:review-owner",
                    parentTurnId: owner,
                    state: "joining" as const,
                    maxConcurrency: 3,
                    join: "best-effort" as const,
                    members: [],
                  }
                : undefined,
            ),
          ),
      })
      const dependencies = Layer.mergeAll(
        reconcileDependencies(unusedExtensions),
        ThreadRepository.memoryLayer(),
        Layer.succeed(TurnRepository.Service, turns),
        Layer.succeed(ExecutionBackend.Service, routeOwnerBackend),
      )
      yield* Operation.reconcile().pipe(provideLayer(dependencies))
      expect((yield* turns.get(owner))?.status).toBe("running")
      yield* Operation.reconcile().pipe(provideLayer(dependencies))
      expect((yield* turns.get(owner))?.status).toBe("failed")
      expect(yield* Ref.get(starts)).toBe(0)
    }),
  )

  it.effect("reconciles FIFO successors after failed and cancelled turns", () =>
    Effect.gen(function* () {
      const threadId = Thread.ThreadId.make("terminal-fifo")
      const turns = yield* TurnRepository.makeMemory(
        ["failed", "cancelled", "completed"].map((id, index) => ({
          id: Turn.TurnId.make(id),
          threadId,
          prompt: id,
          executionRoute: executionRoute(),
          status: "queued" as const,
          createdAt: index + 1,
          updatedAt: index + 1,
        })),
      )
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const terminalBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Ref.update(starts, (values) => [...values, String(input.turnId)]).pipe(
            Effect.as({
              turnId: input.turnId,
              status:
                input.turnId === "failed"
                  ? ("failed" as const)
                  : input.turnId === "cancelled"
                    ? ("cancelled" as const)
                    : ("completed" as const),
              events: [],
            }),
          ),
      })
      yield* Operation.reconcile().pipe(
        provideLayer(
          Layer.mergeAll(
            reconcileDependencies(unusedExtensions),
            ThreadRepository.memoryLayer(),
            Layer.succeed(TurnRepository.Service, turns),
            Layer.succeed(ExecutionBackend.Service, terminalBackend),
          ),
        ),
      )
      expect(yield* Ref.get(starts)).toEqual(["failed", "cancelled", "completed"])
    }),
  )

  it.effect("records operations through the test layer", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<Operation.Input>>([])
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Doctor" })
      }).pipe(provideLayer(Operation.testLayer(calls)))
      expect(yield* Ref.get(calls)).toEqual([{ _tag: "Doctor" }])
    }),
  )

  it.effect("reports unavailable operations as expected failures", () =>
    Effect.gen(function* () {
      const operation = yield* Operation.Service
      const unavailable = yield* Effect.result(operation.run({ _tag: "Doctor" }))
      const run = yield* Effect.result(
        operation.run({
          _tag: "Run",
          prompt: ["hello"],
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        }),
      )
      expect(unavailable._tag).toBe("Failure")
      expect(run._tag).toBe("Failure")
    }).pipe(provideLayer(Operation.unavailableLayer)),
  )

  it.effect("starts, inspects, cancels, and reports missing workflow runs", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([])
      const workflowBackend = ExecutionBackend.Service.of({
        ...backend,
        registerWorkflows: () => Ref.update(calls, (values) => [...values, "register"]).pipe(Effect.as([])),
        startWorkflow: (name, runId, revision, _ownerTurnId, workspace) =>
          Ref.update(calls, (values) => [...values, `start:${name}:${runId}:${revision}:${workspace}`]).pipe(
            Effect.as({
              runId,
              workflow: name,
              revision: revision ?? 1,
              digest: "digest",
              status: "running" as const,
              createdAt: 1,
              updatedAt: 1,
            }),
          ),
        inspectWorkflow: (runId, _ownerTurnId, workspace) =>
          Ref.update(calls, (values) => [...values, `inspect:${runId}:${workspace}`]).pipe(
            Effect.as(
              runId === "missing"
                ? undefined
                : {
                    runId,
                    workflow: "delivery",
                    revision: 2,
                    digest: "digest",
                    status: "completed" as const,
                    createdAt: 1,
                    updatedAt: 2,
                  },
            ),
          ),
        cancelWorkflow: (runId, _ownerTurnId, workspace) =>
          Ref.update(calls, (values) => [...values, `cancel:${runId}:${workspace}`]).pipe(
            Effect.as(
              runId === "missing"
                ? undefined
                : {
                    runId,
                    workflow: "delivery",
                    revision: 2,
                    digest: "digest",
                    status: "cancelled" as const,
                    createdAt: 1,
                    updatedAt: 3,
                  },
            ),
          ),
      })
      const layer = Layer.merge(
        TestConsole.layer,
        Operation.productLayer({
          repositoryLayer: ThreadRepository.memoryLayer(),
          turnRepositoryLayer: TurnRepository.memoryLayer(),
          backendLayer: Layer.succeed(ExecutionBackend.Service, workflowBackend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.die("unused"),
          makeTurnId: Effect.die("unused"),
        }),
      )
      const output = yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({
          _tag: "Workflow",
          action: "start",
          name: "delivery",
          runId: "run",
          revision: 2,
          clientWorkspace: "/client-work",
        })
        yield* operation.run({ _tag: "Workflow", action: "inspect", runId: "run", clientWorkspace: "/client-work" })
        yield* operation.run({ _tag: "Workflow", action: "cancel", runId: "run", clientWorkspace: "/client-work" })
        return yield* Effect.result(
          operation.run({ _tag: "Workflow", action: "inspect", runId: "missing", clientWorkspace: "/client-work" }),
        )
      }).pipe(provideLayer(layer))
      expect(output._tag).toBe("Failure")
      expect(yield* Ref.get(calls)).toEqual([
        "register",
        "start:delivery:run:2:/client-work",
        "inspect:run:/client-work",
        "cancel:run:/client-work",
        "inspect:missing:/client-work",
      ])
    }),
  )

  it.effect("runs thread metadata and tool catalog operations", () =>
    Effect.gen(function* () {
      const ids = yield* Ref.make(["thread-a", "session-a"] as ReadonlyArray<string>)
      const nextId = Effect.gen(function* () {
        const values = yield* Ref.get(ids)
        const value = values[0]
        if (value === undefined) return yield* Effect.die("No test id")
        yield* Ref.set(ids, values.slice(1))
        return value
      })
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const layer = Layer.mergeAll(
        TestConsole.layer,
        Operation.productLayer({
          repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
          turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
          backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
          defaultWorkspace: "/work",
          makeThreadId: nextId.pipe(Effect.map(Thread.ThreadId.make)),
          makeTurnId: Effect.succeed(Turn.TurnId.make("turn-a")),
        }),
      )
      const output = yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Thread", action: "new", clientWorkspace: "/client-work" })
        yield* operation.run({ _tag: "Thread", action: "rename", threadId: "thread-a", title: "Named" })
        yield* operation.run({ _tag: "Thread", action: "label", threadId: "thread-a", labels: ["one"] })
        yield* operation.run({ _tag: "Thread", action: "pin", threadId: "thread-a" })
        yield* operation.run({ _tag: "Thread", action: "archive", threadId: "thread-a" })
        yield* operation.run({ _tag: "Thread", action: "list", includeArchived: true })
        yield* operation.run({ _tag: "Thread", action: "search", query: ["Named"], includeArchived: true })
        yield* operation.run({ _tag: "Thread", action: "unarchive", threadId: "thread-a" })
        const catalogLine = (yield* TestConsole.logLines).length
        yield* operation.run({ _tag: "ToolCatalog", action: "list" })
        for (const mode of ["low", "medium", "high", "ultra"] as const)
          yield* operation.run({ _tag: "ToolCatalog", action: "list", mode })
        yield* operation.run({ _tag: "ToolCatalog", action: "show", name: "read" })
        const missing = yield* Effect.result(operation.run({ _tag: "ToolCatalog", action: "show", name: "missing" }))
        const catalogOutput = (yield* TestConsole.logLines).slice(catalogLine)
        yield* operation.run({ _tag: "Thread", action: "delete", threadId: "thread-a" })
        expect(missing._tag).toBe("Failure")
        if (missing._tag === "Failure")
          expect(missing.failure).toMatchObject({
            _tag: "OperationUnavailable",
            message: "Tool missing does not exist",
          })
        return { catalogOutput, lines: yield* TestConsole.logLines }
      }).pipe(provideLayer(layer))
      const lines = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(output.lines)
      expect(lines.some((line) => line.includes('"title":"Named"'))).toBe(true)
      expect(lines.some((line) => line.includes('"workspace":"/client-work"'))).toBe(true)
      expect(lines.some((line) => line.includes('"name":"read"'))).toBe(true)
      const catalogOutput = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(output.catalogOutput)
      expect(catalogOutput).toHaveLength(6)
      expect(new Set(catalogOutput.slice(0, 5))).toEqual(new Set([catalogOutput[0]!]))
      expect(catalogOutput[0]!.length).toBeLessThanOrEqual(40_000)
      expect(catalogOutput[5]!.length).toBeLessThanOrEqual(4_000)
      for (const forbidden of ["apiKey", "accessToken", "credential", "secret"]) {
        expect(catalogOutput[0]!.toLowerCase()).not.toContain(forbidden.toLowerCase())
        expect(catalogOutput[5]!.toLowerCase()).not.toContain(forbidden.toLowerCase())
      }
      const listedJson = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(catalogOutput[0]!)
      const definitions = yield* Schema.decodeUnknownEffect(Schema.Array(ToolCatalog.Definition))(listedJson)
      expect(definitions.length).toBeGreaterThan(0)
      expect(definitions.length).toBeLessThanOrEqual(64)
      expect(new Set(definitions.map(({ name }) => name)).size).toBe(definitions.length)
      expect(
        definitions.every(
          ({ description, timeoutMillis, outputLimit, presentation }) =>
            description.length > 0 &&
            timeoutMillis > 0 &&
            timeoutMillis <= 120_000 &&
            outputLimit > 0 &&
            outputLimit <= 40_000 &&
            presentation.action.length > 0 &&
            presentation.activeLabel.length > 0 &&
            presentation.completeLabel.length > 0,
        ),
      ).toBe(true)
      const shownJson = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(catalogOutput[5]!)
      const shown = yield* Schema.decodeUnknownEffect(ToolCatalog.Definition)(shownJson)
      expect(shown).toEqual(definitions.find(({ name }) => name === "read"))
    }),
  )

  it.effect("continues, searches, exports, and summarizes persisted threads", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("thread-a"),
        workspace: "/work/project",
        title: "Release notes",
        labels: ["urgent"],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 2,
      }
      const turn: Turn.Turn = {
        id: Turn.TurnId.make("turn-a"),
        threadId: thread.id,
        prompt: "Write the release",
        executionRoute: executionRoute(),
        status: "completed",
        createdAt: 3,
        updatedAt: 4,
      }
      const layer = Layer.merge(
        TestConsole.layer,
        Operation.productLayer({
          repositoryLayer: ThreadRepository.memoryLayer([thread]),
          turnRepositoryLayer: TurnRepository.memoryLayer([turn]),
          backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.succeed(Thread.ThreadId.make("unused")),
          makeTurnId: Effect.succeed(Turn.TurnId.make("unused")),
        }),
      )
      const output = yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Thread", action: "continue", last: true })
        yield* operation.run({ _tag: "Thread", action: "continue", threadIds: ["thread-a"] })
        yield* operation.run({ _tag: "Thread", action: "search", query: ["project", "urgent"] })
        yield* operation.run({ _tag: "Thread", action: "export", threadId: "thread-a", format: "json" })
        yield* operation.run({ _tag: "Thread", action: "export", threadId: "thread-a", format: "markdown" })
        yield* operation.run({ _tag: "Thread", action: "usage", threadId: "thread-a" })
        return yield* TestConsole.logLines
      }).pipe(provideLayer(layer))
      expect(output[0]).toContain('"id":"thread-a"')
      expect(output[0]).toContain('"status":"completed"')
      expect(output[1]).toContain('"id":"thread-a"')
      expect(output[2]).toContain('"title":"Release notes"')
      expect(output[3]).toContain('"prompt":"Write the release"')
      expect(output[4]).toContain("# Release notes")
      expect(output[5]).toContain('"completed":1')
    }),
  )
})

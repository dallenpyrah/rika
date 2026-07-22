import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { Operation } from "../src/index"
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

const holdSession =
  (sessions: Ref.Ref<ReadonlyArray<Operation.InteractiveSession>>) =>
  (_: Operation.Input & { readonly _tag: "Interactive" }, session: Operation.InteractiveSession) =>
    Ref.update(sessions, (values) => [...values, session]).pipe(Effect.andThen(Effect.never))

const openInteractiveSession = Effect.fn("OperationTest.openInteractiveSession")(function* (
  sessions: Ref.Ref<ReadonlyArray<Operation.InteractiveSession>>,
  input: Operation.Input & { readonly _tag: "Interactive" },
) {
  const operation = yield* Operation.Service
  const previousCount = (yield* Ref.get(sessions)).length
  yield* Effect.forkChild(operation.run(input))
  while ((yield* Ref.get(sessions)).length <= previousCount) yield* Effect.yieldNow
  const session = (yield* Ref.get(sessions)).at(-1)
  if (session === undefined) return yield* Effect.die("Missing interactive session")
  return session
})

const settleEvents = Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true })

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
  it.effect("forks persisted history through a requested turn", () =>
    Effect.gen(function* () {
      const source: Thread.Thread = {
        id: Thread.ThreadId.make("source"),
        workspace: "/work",
        title: "Source",
        labels: ["kept"],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 2,
      }
      const repository = yield* ThreadRepository.makeMemory([source])
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("one"),
          threadId: source.id,
          prompt: "one",
          executionRoute: executionRoute(),
          status: "completed",
          createdAt: 3,
          updatedAt: 4,
        },
        {
          id: Turn.TurnId.make("two"),
          threadId: source.id,
          prompt: "two",
          executionRoute: executionRoute(),
          status: "completed",
          createdAt: 5,
          updatedAt: 6,
        },
      ])
      const layer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("fork")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("fork-turn")),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Thread", action: "fork", threadId: "source", atTurn: "one" })
      }).pipe(provideLayer(layer))
      expect(yield* turns.list(Thread.ThreadId.make("fork"))).toMatchObject([{ prompt: "one", status: "completed" }])
      expect(yield* repository.get(Thread.ThreadId.make("fork"))).toMatchObject({ title: "Source", labels: ["kept"] })
    }),
  )

  it.effect("forks queued history with consistent bounded queue state", () =>
    Effect.gen(function* () {
      const source = selectionThread("queued-fork-source")
      const sourceTurns: ReadonlyArray<Turn.Turn> = [
        {
          id: Turn.TurnId.make("fork-history"),
          threadId: source.id,
          prompt: "history",
          executionRoute: executionRoute(),
          status: "completed",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: Turn.TurnId.make("fork-queued-one"),
          threadId: source.id,
          prompt: "queued one",
          executionRoute: executionRoute(),
          status: "queued",
          createdAt: 2,
          updatedAt: 2,
        },
        {
          id: Turn.TurnId.make("fork-queued-two"),
          threadId: source.id,
          prompt: "queued two",
          executionRoute: executionRoute(),
          status: "queued",
          createdAt: 3,
          updatedAt: 3,
        },
      ]
      const repository = yield* ThreadRepository.makeMemory([source])
      const turns = yield* TurnRepository.makeMemory(sourceTurns)
      const turnSequence = yield* Ref.make(0)
      const layer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        defaultWorkspace: "/work",
        pendingTurnCapacity: 2,
        makeThreadId: Effect.succeed(Thread.ThreadId.make("queued-fork")),
        makeTurnId: Ref.updateAndGet(turnSequence, (value) => value + 1).pipe(
          Effect.map((value) => Turn.TurnId.make(`queued-fork-copy-${value}`)),
        ),
      })

      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Thread", action: "fork", threadId: source.id })
      }).pipe(provideLayer(layer))

      expect((yield* turns.list(Thread.ThreadId.make("queued-fork"))).map((turn) => turn.status)).toEqual([
        "completed",
        "queued",
        "queued",
      ])
      expect(yield* turns.readQueue(Thread.ThreadId.make("queued-fork"))).toMatchObject({
        revision: 2,
        queuedCount: 2,
        turns: [{ prompt: "queued one" }, { prompt: "queued two" }],
      })
    }),
  )

  it.effect("rejects a fork before creation when copied queue history exceeds capacity", () =>
    Effect.gen(function* () {
      const source = selectionThread("bounded-fork-source")
      const repository = yield* ThreadRepository.makeMemory([source])
      const turns = yield* TurnRepository.makeMemory(
        ["one", "two"].map(
          (id, index): Turn.Turn => ({
            id: Turn.TurnId.make(`bounded-fork-${id}`),
            threadId: source.id,
            prompt: id,
            executionRoute: executionRoute(),
            status: "queued",
            createdAt: index + 1,
            updatedAt: index + 1,
          }),
        ),
      )
      const layer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        defaultWorkspace: "/work",
        pendingTurnCapacity: 1,
        makeThreadId: Effect.succeed(Thread.ThreadId.make("bounded-fork")),
        makeTurnId: Effect.die("must preflight capacity"),
      })

      const result = yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        return yield* Effect.result(operation.run({ _tag: "Thread", action: "fork", threadId: source.id }))
      }).pipe(provideLayer(layer))

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "OperationUnavailable", message: expect.stringContaining("TurnQueueFull") },
      })
      expect(yield* repository.get(Thread.ThreadId.make("bounded-fork"))).toBeUndefined()
    }),
  )

  it.effect("keeps fork copy and publication atomic against racing submissions", () =>
    Effect.gen(function* () {
      const source = selectionThread("atomic-fork-source")
      const forkId = Thread.ThreadId.make("atomic-fork")
      const repository = yield* ThreadRepository.makeMemory([source])
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("atomic-fork-active"),
          threadId: source.id,
          prompt: "source active",
          executionRoute: executionRoute(),
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: Turn.TurnId.make("atomic-fork-queued"),
          threadId: source.id,
          prompt: "source queued",
          executionRoute: executionRoute(),
          status: "queued",
          createdAt: 2,
          updatedAt: 2,
        },
      ])
      const copyEntered = yield* Deferred.make<void>()
      const releaseCopy = yield* Deferred.make<void>()
      const delayedTurns = TurnRepository.Service.of({
        ...turns,
        copy: (turn, capacity) =>
          turn.threadId === forkId && turn.prompt === "source active"
            ? Deferred.succeed(copyEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCopy)),
                Effect.andThen(turns.copy(turn, capacity)),
              )
            : turns.copy(turn, capacity),
      })
      const forkBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: (turnId) => Effect.succeed({ turnId, status: "running", waits: [], pendingTools: [], children: [] }),
        replay: (turnId) => Effect.succeed({ turnId, status: "running", events: [] }),
        start: (input) => Effect.succeed({ turnId: input.turnId, status: "running", events: [] }),
      })
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const turnSequence = yield* Ref.make(0)
      const layer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, delayedTurns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, forkBackend),
        defaultWorkspace: "/work",
        pendingTurnCapacity: 1,
        makeThreadId: Effect.succeed(forkId),
        makeTurnId: Ref.updateAndGet(turnSequence, (value) => value + 1).pipe(
          Effect.map((value) => Turn.TurnId.make(`atomic-fork-copy-${value}`)),
        ),
        interactive: holdSession(sessions),
      })

      const forkResult = yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        const fork = yield* Effect.forkChild(
          Effect.result(operation.run({ _tag: "Thread", action: "fork", threadId: source.id })),
        )
        yield* Deferred.await(copyEntered)
        yield* session.selectThread(forkId, 1)
        const submissions = yield* Effect.forEach(["racing one", "racing two"], (prompt) =>
          Effect.forkChild(session.submit(prompt)),
        )
        yield* settleEvents
        yield* Deferred.succeed(releaseCopy, undefined)
        const result = yield* Fiber.join(fork)
        yield* Effect.forEach(submissions, Fiber.join, { discard: true })
        return result
      }).pipe(provideLayer(layer))

      expect(forkResult._tag).toBe("Success")
      expect((yield* turns.list(forkId)).map((turn) => [turn.prompt, turn.status])).toEqual([
        ["source active", "running"],
        ["source queued", "queued"],
      ])
      expect(yield* repository.get(forkId)).toMatchObject({ archived: false })
    }),
  )

  it.effect("uses the configured interactive operation", () =>
    Effect.gen(function* () {
      const received = yield* Ref.make<ReadonlyArray<Operation.Input>>([])
      const input: Operation.Input = {
        _tag: "Interactive",
        prompt: ["hello"],
        workspace: "/interactive",
        ephemeral: false,
      }
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run(input)
      }).pipe(
        provideLayer(
          Operation.productLayer({
            repositoryLayer: ThreadRepository.memoryLayer(),
            turnRepositoryLayer: TurnRepository.memoryLayer(),
            backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-a")),
            makeTurnId: Effect.succeed(Turn.TurnId.make("turn-a")),
            interactive: (interactiveInput) => Ref.update(received, (inputs) => [...inputs, interactiveInput]),
          }),
        ),
      )
      expect(yield* Ref.get(received)).toEqual([input])
    }),
  )

  it.effect("drains more than one batch of thread summary repairs", () =>
    Effect.gen(function* () {
      const thread = selectionThread("summary-repair-thread")
      const turns = Array.from(
        { length: 101 },
        (_, index): Turn.Turn => ({
          id: Turn.TurnId.make(`summary-repair-${index}`),
          threadId: thread.id,
          prompt: `repair ${index}`,
          executionRoute: executionRoute(),
          status: "completed",
          createdAt: index + 1,
          updatedAt: index + 1,
        }),
      )
      const inspections = yield* Ref.make<ReadonlyArray<string>>([])
      const repairBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: (turnId) =>
          Ref.update(inspections, (values) => [...values, String(turnId)]).pipe(
            Effect.as({ turnId, status: "completed" as const, waits: [], pendingTools: [], children: [] }),
          ),
        replay: (turnId) => Effect.succeed({ turnId, status: "completed" as const, events: [] }),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Interactive", prompt: [], workspace: "/work", ephemeral: false })
      }).pipe(
        provideLayer(
          Operation.productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: TurnRepository.memoryLayer(turns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, repairBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.die("unused"),
            interactive: () => Effect.void,
          }),
        ),
      )
      expect(new Set((yield* Ref.get(inspections)).filter((turnId) => turnId.startsWith("summary-repair-"))).size).toBe(
        101,
      )
    }),
  )

  it.effect("repairs each orphan once in the owner scope and scans again on reconnect", () =>
    Effect.gen(function* () {
      const thread = selectionThread("repair-thread")
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("repair-one"),
          threadId: thread.id,
          prompt: "repair one",
          executionRoute: executionRoute(),
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
      ])
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const callbacks = yield* Ref.make(0)
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const repairBackend = ExecutionBackend.Service.of({
        ...backend,
        follow: () => Effect.die("missing executions must be repaired before follow"),
        start: (input) =>
          Ref.update(starts, (values) => [...values, String(input.turnId)]).pipe(
            Effect.andThen(
              input.turnId === "repair-one"
                ? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst)))
                : Effect.void,
            ),
            Effect.andThen(backend.start(input)),
          ),
      })
      const layer = Operation.productLayer({
        repositoryLayer: ThreadRepository.memoryLayer([thread]),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, repairBackend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.die("unused"),
        makeTurnId: Effect.die("unused"),
        interactive: () => Ref.update(callbacks, (count) => count + 1),
      })

      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        const reconnects = yield* Effect.forEach(["/one", "/two"], (workspace) =>
          Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], workspace, ephemeral: false })),
        )
        yield* Deferred.await(firstStarted)
        yield* settleEvents
        const callbacksBeforeRepairFinished = yield* Ref.get(callbacks)
        expect(yield* Ref.get(starts)).toEqual(["repair-one"])
        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Effect.forEach(reconnects, Fiber.join, { discard: true })
        expect(callbacksBeforeRepairFinished).toBe(2)

        yield* turns.createForSubmission({
          id: Turn.TurnId.make("repair-two"),
          threadId: thread.id,
          prompt: "repair two",
          executionRoute: executionRoute(),
          queueCapacity: 64,
          now: 2,
        })
        yield* turns.setStatus(Turn.TurnId.make("repair-two"), "running", undefined, 2)
        yield* operation.run({ _tag: "Interactive", prompt: [], workspace: "/three", ephemeral: false })
        yield* settleEvents
        expect(yield* Ref.get(starts)).toEqual(["repair-one", "repair-two"])
      }).pipe(provideLayer(layer))
    }),
  )
})

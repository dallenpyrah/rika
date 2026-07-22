import { describe, expect, it } from "@effect/vitest"
import { ConfigContract } from "@rika/config"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { ExecutionExtensions } from "@rika/extensions"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { it as rawIt } from "vitest"
import { Operation, ResolvedContext } from "../src/index"
import { createTurn, executionRoute } from "./current-state"

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
  it.effect("rejects every action after an interactive session closes", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const writes = yield* Ref.make(0)
      const starts = yield* Ref.make(0)
      const turns = yield* TurnRepository.makeMemory([])
      const repository = TurnRepository.Service.of({
        ...turns,
        createForSubmission: (input) =>
          Ref.update(writes, (count) => count + 1).pipe(Effect.andThen(createTurn(turns, input))),
      })
      const closedBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) => Ref.update(starts, (count) => count + 1).pipe(Effect.andThen(backend.start(input))),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
        const session = (yield* Ref.get(sessions))[0]
        if (session === undefined) return yield* Effect.die("missing session")
        const actions = [
          session.events(() => undefined),
          session.submit("closed submit"),
          session.shell("true", true),
          session.editQueued("turn", "edit"),
          session.dequeue("turn"),
          session.steerQueued("turn", "steer"),
          session.steer("steer"),
          session.interruptAndSend("interrupt"),
          session.cancel,
          session.newThread,
          session.resolvePermission("wait", "permission", "allow"),
          session.selectThread("thread", 1),
          session.readQueue("thread"),
          session.loadOlder,
          session.previewThread("thread"),
          session.reopenThread(1),
          session.replay("turn", undefined),
        ]
        const results = yield* Effect.forEach(actions, Effect.exit)
        expect(results).toHaveLength(actions.length)
        for (const result of results) {
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") expect(String(result.cause)).toContain("Interactive session is closed")
        }
      }).pipe(
        provideLayer(
          Operation.productLayer({
            repositoryLayer: ThreadRepository.memoryLayer(),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, repository),
            backendLayer: Layer.succeed(ExecutionBackend.Service, closedBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.succeed(Thread.ThreadId.make("closed-thread")),
            makeTurnId: Effect.succeed(Turn.TurnId.make("closed-turn")),
            interactive: (_, session) => Ref.update(sessions, (values) => [...values, session]),
          }),
        ),
      )
      expect(yield* Ref.get(writes)).toBe(0)
      expect(yield* Ref.get(starts)).toBe(0)
      expect(yield* turns.listNonterminal).toEqual([])
    }),
  )

  rawIt("releases an admitted turn observer when its interactive session closes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const thread: Thread.Thread = {
          id: Thread.ThreadId.make("admitted-thread"),
          workspace: "/work",
          title: "Admitted",
          labels: [],
          pinned: false,
          archived: false,
          createdAt: 1,
          updatedAt: 1,
        }
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const submitted = yield* Deferred.make<Fiber.Fiber<void, Operation.OperationUnavailable>>()
        const starts = yield* Ref.make(0)
        const turns = yield* TurnRepository.makeMemory([])
        const admittedBackend = ExecutionBackend.Service.of({
          ...backend,
          start: (input) =>
            Ref.update(starts, (count) => count + 1).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(backend.start(input)),
            ),
        })
        yield* Effect.gen(function* () {
          const operation = yield* Operation.Service
          yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
          expect(yield* Ref.get(starts)).toBe(1)
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(yield* Deferred.await(submitted))
        }).pipe(
          provideLayer(
            Operation.productLayer({
              repositoryLayer: ThreadRepository.memoryLayer([thread]),
              turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
              backendLayer: Layer.succeed(ExecutionBackend.Service, admittedBackend),
              defaultWorkspace: "/work",
              makeThreadId: Effect.die("unused"),
              makeTurnId: Effect.succeed(Turn.TurnId.make("admitted-turn")),
              interactive: (_, session) =>
                Effect.gen(function* () {
                  yield* session.selectThread(thread.id, 1)
                  yield* Deferred.succeed(submitted, yield* Effect.forkChild(session.submit("accepted")))
                  yield* Deferred.await(started)
                }),
            }),
          ),
        )
        expect(yield* Ref.get(starts)).toBe(1)
        expect((yield* turns.get(Turn.TurnId.make("admitted-turn")))?.status).toBe("running")
      }),
    ),
  )

  it.effect("rejects secret-bearing config before execution_route_json persistence", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const turns = yield* TurnRepository.makeMemory([])
      const writes = yield* Ref.make(0)
      const repository = TurnRepository.Service.of({
        ...turns,
        createForSubmission: (input) =>
          Ref.update(writes, (count) => count + 1).pipe(Effect.andThen(createTurn(turns, input))),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* session.submit("must not persist")
      }).pipe(
        provideLayer(
          Operation.productLayer({
            repositoryLayer: ThreadRepository.memoryLayer(),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, repository),
            backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
            resolveExecutionRoute: () =>
              Effect.try(() => {
                ConfigContract.decodeSettingsInput("settings.json", {
                  models: {
                    unsafe: {
                      ...ConfigContract.defaults.models.luna,
                      variants: { low: { normal: { options: { nested: { signature: "secret" } } } } },
                    },
                  },
                })
                return Turn.testExecutionRoute("medium")
              }),
            defaultWorkspace: "/work",
            makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-rejected-config")),
            makeTurnId: Effect.succeed(Turn.TurnId.make("turn-rejected-config")),
            interactive: holdSession(sessions),
          }),
        ),
      )
      expect(yield* Ref.get(writes)).toBe(0)
      expect(yield* turns.get(Turn.TurnId.make("turn-rejected-config"))).toBeUndefined()
    }),
  )

  it.effect("keeps one backend layer alive for sequential interactive submissions", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const acquisitions = yield* Ref.make(0)
      const turnIds = yield* Ref.make(0)
      const turns = yield* TurnRepository.makeMemory([])
      const backendLayer = Layer.effect(
        ExecutionBackend.Service,
        Ref.updateAndGet(acquisitions, (value) => value + 1).pipe(
          Effect.map((generation) =>
            ExecutionBackend.Service.of({
              ...backend,
              start: (input) =>
                Ref.update(starts, (values) => [...values, `${generation}:${input.prompt}`]).pipe(
                  Effect.andThen(backend.start(input)),
                ),
            }),
          ),
        ),
      )
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* session.submit("First turn", "low")
        while ((yield* turns.get(Turn.TurnId.make("turn-1")))?.status !== "completed") yield* Effect.yieldNow
        yield* session.submit("Second turn", "ultra")
        while ((yield* turns.get(Turn.TurnId.make("turn-2")))?.status !== "completed") yield* Effect.yieldNow
      }).pipe(
        provideLayer(
          Operation.productLayer({
            repositoryLayer: ThreadRepository.memoryLayer(),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer,
            defaultWorkspace: "/work",
            makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-sequential")),
            makeTurnId: Ref.updateAndGet(turnIds, (value) => value + 1).pipe(
              Effect.map((value) => Turn.TurnId.make(`turn-${value}`)),
            ),
            interactive: holdSession(sessions),
          }),
        ),
      )
      expect(yield* Ref.get(acquisitions)).toBe(1)
      expect((yield* Ref.get(starts)).filter((value) => !value.includes("Generate a concise"))).toEqual([
        "1:First turn",
        "1:Second turn",
      ])
      expect((yield* turns.get(Turn.TurnId.make("turn-1")))?.executionRoute?.mode).toBe("low")
      expect((yield* turns.get(Turn.TurnId.make("turn-2")))?.executionRoute?.mode).toBe("ultra")
      expect((yield* turns.get(Turn.TurnId.make("turn-2")))?.status).toBe("completed")
    }),
  )

  it.effect("re-prepares an accepted Turn once and starts with its pinned route", () =>
    Effect.gen(function* () {
      const pinnedRoute = {
        ...executionRoute(),
        main: { ...executionRoute().main, model: "pinned-recovery-model" },
      }
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("turn-restart"),
          threadId: Thread.ThreadId.make("thread-restart"),
          prompt: "resume",
          executionRoute: pinnedRoute,
          status: "accepted",
          createdAt: 1,
          updatedAt: 2,
        },
      ])
      const starts = yield* Ref.make<ReadonlyArray<ExecutionBackend.StartInput>>([])
      const preparations = yield* Ref.make(0)
      const restartBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Ref.update(starts, (values) => [...values, input]).pipe(
            Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
          ),
      })
      yield* Operation.reconcile(unusedExtensions, (turn) =>
        Ref.update(preparations, (count) => count + 1).pipe(
          Effect.as({
            prompt: `${turn.prompt} with recomputed context`,
            promptParts: undefined,
            extensionPin: undefined,
          }),
        ),
      ).pipe(
        provideLayer(
          Layer.mergeAll(
            reconcileDependencies(unusedExtensions),
            ThreadRepository.memoryLayer([selectionThread("thread-restart")]),
            Layer.succeed(TurnRepository.Service, turns),
            Layer.succeed(ExecutionBackend.Service, restartBackend),
          ),
        ),
      )
      expect(yield* Ref.get(starts)).toMatchObject([
        {
          threadId: "thread-restart",
          turnId: "turn-restart",
          prompt: "resume with recomputed context",
          startedAt: 2,
          executionRoute: { main: { model: "pinned-recovery-model" } },
        },
      ])
      expect(yield* Ref.get(preparations)).toBe(1)
      expect((yield* Ref.get(starts))[0]?.executionRoute).toEqual(pinnedRoute)
      expect((yield* turns.get(Turn.TurnId.make("turn-restart")))?.status).toBe("completed")
    }),
  )

  it.effect("does not restart a turn dequeued after the reconcile scan", () =>
    Effect.gen(function* () {
      const turnId = Turn.TurnId.make("stale-reconcile-turn")
      const threadId = Thread.ThreadId.make("stale-reconcile-thread")
      const queued: Turn.Turn = {
        id: turnId,
        threadId,
        prompt: "do not restart",
        executionRoute: executionRoute(),
        status: "queued",
        createdAt: 1,
        updatedAt: 1,
      }
      const turns = yield* TurnRepository.makeMemory([queued])
      const scanned = yield* Deferred.make<void>()
      const continueReconcile = yield* Deferred.make<void>()
      const delayedTurns = TurnRepository.Service.of({
        ...turns,
        listNonterminal: Deferred.succeed(scanned, undefined).pipe(
          Effect.andThen(Deferred.await(continueReconcile)),
          Effect.as([{ ...queued, status: "running" as const }]),
        ),
      })
      const starts = yield* Ref.make(0)
      const staleBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Ref.update(starts, (count) => count + 1).pipe(
            Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
          ),
      })
      const repair = yield* Effect.forkChild(
        Operation.reconcile().pipe(
          provideLayer(
            Layer.mergeAll(
              reconcileDependencies(unusedExtensions),
              ThreadRepository.memoryLayer(),
              Layer.succeed(TurnRepository.Service, delayedTurns),
              Layer.succeed(ExecutionBackend.Service, staleBackend),
            ),
          ),
        ),
      )

      yield* Deferred.await(scanned)
      yield* turns.dequeue(turnId)
      yield* Deferred.succeed(continueReconcile, undefined)
      yield* Fiber.join(repair)

      expect(yield* Ref.get(starts)).toBe(0)
      expect(yield* turns.get(turnId)).toBeUndefined()
    }),
  )

  it.effect("releases an interrupted preparation claim without terminalizing the queued turn", () =>
    Effect.gen(function* () {
      const thread = selectionThread("interrupted-preparation-thread")
      const queued: Turn.Turn = {
        id: Turn.TurnId.make("interrupted-preparation-turn"),
        threadId: thread.id,
        prompt: "retry after interruption",
        executionRoute: executionRoute(),
        status: "queued",
        createdAt: 1,
        updatedAt: 1,
      }
      const turns = yield* TurnRepository.makeMemory([queued])
      const preparationEntered = yield* Deferred.make<void>()
      const repair = yield* Effect.forkChild(
        Operation.reconcile(undefined, () =>
          Deferred.succeed(preparationEntered, undefined).pipe(Effect.andThen(Effect.never)),
        ).pipe(
          provideLayer(
            Layer.mergeAll(
              reconcileDependencies(unusedExtensions),
              ThreadRepository.memoryLayer([thread]),
              Layer.succeed(TurnRepository.Service, turns),
              Layer.succeed(ExecutionBackend.Service, backend),
            ),
          ),
        ),
      )

      yield* Deferred.await(preparationEntered)
      yield* Fiber.interrupt(repair)

      expect(yield* turns.get(queued.id)).toMatchObject({ status: "queued" })
      expect(yield* turns.readQueue(thread.id)).toMatchObject({ revision: 1, queuedCount: 1 })
      expect((yield* turns.claimNextQueued(thread.id, 2))?.turn.id).toBe(queued.id)
    }),
  )
})

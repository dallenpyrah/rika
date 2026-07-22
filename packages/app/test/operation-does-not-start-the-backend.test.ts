import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Deferred, Effect, Layer, Ref } from "effect"
import { Operation, ResolvedContext } from "../src/index"

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
  it.effect("does not start the backend when cancellation wins during preparation", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const starts = yield* Ref.make(0)
      const cancellations = yield* Ref.make(0)
      const preparationEntered = yield* Deferred.make<void>()
      const releasePreparation = yield* Deferred.make<void>()
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const cancellingBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) => Ref.update(starts, (count) => count + 1).pipe(Effect.andThen(backend.start(input))),
        inspect: (turnId) => Effect.succeed({ turnId, status: "running", waits: [], pendingTools: [], children: [] }),
        cancel: (turnId, now) =>
          Ref.update(cancellations, (count) => count + 1).pipe(
            Effect.as({
              turnId,
              status: "cancelled" as const,
              events: [{ cursor: "cancelled", sequence: 1, type: "execution.cancelled", createdAt: now }],
            }),
          ),
      })
      const layer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, cancellingBackend),
        resolvedContextLayer: ResolvedContext.testLayer({
          resolve: () =>
            Deferred.succeed(preparationEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releasePreparation)),
              Effect.as({ sources: [], diagnostics: [], digest: "" }),
            ),
        }),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("cancel-preparation-thread")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("cancel-preparation-turn")),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events((event) => runSync(Ref.update(events, (all) => [...all, event]))))
        yield* Effect.yieldNow
        yield* session.submit("cancel while preparing")
        yield* Deferred.await(preparationEntered)
        yield* session.cancel
        yield* Deferred.succeed(releasePreparation, undefined)
        while ((yield* turns.get(Turn.TurnId.make("cancel-preparation-turn")))?.status !== "cancelled")
          yield* Effect.yieldNow
        yield* settleEvents
      }).pipe(provideLayer(layer))
      expect(yield* Ref.get(starts)).toBe(0)
      expect(yield* Ref.get(cancellations)).toBe(0)
      expect((yield* Ref.get(events)).some((event) => event._tag === "TurnStarted")).toBe(false)
      expect(yield* turns.get(Turn.TurnId.make("cancel-preparation-turn"))).toMatchObject({ status: "cancelled" })
    }),
  )

  it.effect("titles a new thread through its pinned GPT 5.6 Luna route", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const titleRoute = {
        ...Turn.testExecutionRoute("low").main,
        role: "title" as const,
        model: "gpt-5.6-luna",
        effort: "low",
      }
      const routedBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Ref.update(starts, (values) => [...values, `${input.executionRoute.main.model}:${input.turnId}`]).pipe(
            Effect.as({
              turnId: input.turnId,
              status: "completed" as const,
              events: [
                {
                  cursor: `cursor:${input.turnId}:output`,
                  sequence: 1,
                  type: "model.output.completed" as const,
                  createdAt: 1,
                  text: input.turnId.startsWith("title:") ? "Selected Route Title" : "answer",
                },
                {
                  cursor: `cursor:${input.turnId}:completed`,
                  sequence: 2,
                  type: "execution.completed" as const,
                  createdAt: 2,
                },
              ],
            }),
          ),
      })
      const layer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, routedBackend),
        resolveExecutionRoute: (mode) => {
          const route = Turn.testExecutionRoute(mode)
          return Effect.succeed({
            ...route,
            main: { ...route.main, model: `${mode}-model` },
            title: titleRoute,
          })
        },
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-selected-title")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("turn-selected-title")),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* session.submit("Build groceries", "high")
        while ((yield* Ref.get(starts)).length < 2) yield* Effect.yieldNow
      }).pipe(provideLayer(layer))

      expect(yield* Ref.get(starts)).toEqual([
        "high-model:turn-selected-title",
        "gpt-5.6-luna:title:turn-selected-title",
      ])
      expect(yield* repository.get(Thread.ThreadId.make("thread-selected-title"))).toMatchObject({
        title: "Selected Route Title",
      })
    }),
  )

  it.effect("keeps the seed title when best-effort titling fails", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const titleFailingBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          input.turnId.startsWith("title:")
            ? Effect.fail(ExecutionBackend.BackendError.make({ message: "title unavailable" }))
            : backend.start(input),
      })
      const layer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, titleFailingBackend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-title-failure")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("turn-title-failure")),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events((event) => runSync(Ref.update(events, (values) => [...values, event]))))
        yield* Effect.yieldNow
        yield* session.submit("Stable seed title")
        yield* Effect.yieldNow
      }).pipe(provideLayer(layer))

      expect(yield* turns.get(Turn.TurnId.make("turn-title-failure"))).toMatchObject({ status: "completed" })
      expect(yield* repository.get(Thread.ThreadId.make("thread-title-failure"))).toMatchObject({
        title: "Stable seed title",
      })
      expect((yield* Ref.get(events)).some((event) => event._tag === "ThreadTitled")).toBe(false)
      expect((yield* Ref.get(events)).some((event) => event._tag === "ExecutionFailed")).toBe(false)
    }),
  )

  it.effect("finishes a durable title from replay after restart without starting it again", () =>
    Effect.gen(function* () {
      const thread = selectionThread("title-restart-thread")
      const prompt = "Recover this title after restart"
      const repository = yield* ThreadRepository.makeMemory([{ ...thread, title: prompt }])
      const firstTurn: Turn.Turn = {
        id: Turn.TurnId.make("title-restart-turn"),
        threadId: thread.id,
        prompt,
        status: "completed",
        executionRoute: Turn.testExecutionRoute("medium"),
        createdAt: 1,
        updatedAt: 2,
      }
      const turns = yield* TurnRepository.makeMemory([firstTurn])
      const starts = yield* Ref.make(0)
      const replayed = yield* Ref.make<ReadonlyArray<string>>([])
      const restartedBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) => Ref.update(starts, (count) => count + 1).pipe(Effect.andThen(backend.start(input))),
        inspect: (executionId) =>
          Effect.succeed(
            executionId === "title:title-restart-turn"
              ? {
                  turnId: executionId,
                  status: "completed" as const,
                  waits: [],
                  pendingTools: [],
                  children: [],
                }
              : undefined,
          ),
        replay: (executionId) =>
          Ref.update(replayed, (values) => [...values, executionId]).pipe(
            Effect.as({
              turnId: executionId,
              status: "completed" as const,
              events: [
                {
                  cursor: "restarted-title-output",
                  sequence: 1,
                  type: "model.output.completed" as const,
                  createdAt: 3,
                  text: "Recovered Durable Title",
                },
                { cursor: "restarted-title-done", sequence: 2, type: "execution.completed" as const, createdAt: 4 },
              ],
            }),
          ),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }))
        while ((yield* repository.get(thread.id))?.title !== "Recovered Durable Title") yield* Effect.yieldNow
      }).pipe(
        provideLayer(
          Operation.productLayer({
            repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, restartedBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.die("unused"),
            interactive: () => Effect.never,
          }),
        ),
      )

      expect(yield* Ref.get(starts)).toBe(0)
      expect(yield* Ref.get(replayed)).toContain("title:title-restart-turn")
    }),
  )

  it.effect("does not reclassify a completed turn when thread promotion fails", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const promotionFailingBackend = ExecutionBackend.Service.of({
        ...backend,
        wakeThreadHost: () => Effect.fail(ExecutionBackend.BackendError.make({ message: "promotion failed" })),
        registerTurnPromoter: () => Effect.void,
      })
      const layer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, promotionFailingBackend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-promotion-failure")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("turn-promotion-failure")),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events((event) => runSync(Ref.update(events, (values) => [...values, event]))))
        yield* Effect.yieldNow
        yield* session.submit("Completed response")
        yield* Effect.yieldNow
      }).pipe(provideLayer(layer))

      expect(yield* turns.get(Turn.TurnId.make("turn-promotion-failure"))).toMatchObject({ status: "completed" })
      expect((yield* Ref.get(events)).some((event) => event._tag === "ExecutionFailed")).toBe(false)
    }),
  )
})

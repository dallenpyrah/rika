import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
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

const collectEvents = (session: Operation.InteractiveSession, events: Array<Operation.InteractiveEvent>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(session.events((event) => events.push(event)))
    yield* Effect.yieldNow
    return fiber
  })

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
  it.effect("dispatches successful interactive queue and control callbacks", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("interactive-controls"),
        workspace: "/work",
        title: "Controls",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const repository = yield* ThreadRepository.makeMemory([thread])
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("active-control"),
          threadId: thread.id,
          prompt: "active",
          executionRoute: executionRoute(),
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: Turn.TurnId.make("queued-control"),
          threadId: thread.id,
          prompt: "queued",
          executionRoute: executionRoute(),
          status: "queued",
          createdAt: 2,
          updatedAt: 2,
        },
        {
          id: Turn.TurnId.make("queued-control-2"),
          threadId: thread.id,
          prompt: "queued second",
          executionRoute: executionRoute(),
          status: "queued",
          createdAt: 3,
          updatedAt: 3,
        },
      ])
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const dispatch = (event: Operation.InteractiveEvent) =>
        runSync(Ref.update(events, (current) => [...current, event]))
      const controlBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: (turnId) =>
          Effect.succeed({
            turnId,
            status: "running",
            lastCursor: "inspected",
            waits: [],
            pendingTools: [],
            children: [],
          }),
        cancel: (turnId) =>
          Effect.succeed({
            turnId,
            status: "cancelled",
            events: [{ cursor: "cancelled", sequence: 1, type: "execution.cancelled", createdAt: 3 }],
          }),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events(dispatch))
        yield* Effect.yieldNow
        yield* session.selectThread(thread.id, 1)
        yield* session.editQueued("queued-control", "edited")
        yield* session.dequeue("queued-control")
        yield* session.submit("later")
        yield* session.steerQueued("queued-control-2", "redirect")
        yield* session.resolvePermission("wait", "permission", "allow")
        yield* session.replay("active-control", "cursor")
        yield* session.cancel
        yield* session.reopenThread(2)
        yield* Effect.yieldNow
      }).pipe(
        provideLayer(
          Operation.productLayer({
            repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, controlBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.succeed(Turn.TurnId.make("submitted-control")),
            interactive: holdSession(sessions),
          }),
        ),
      )
      const dispatched = yield* Ref.get(events)
      expect(dispatched.some((event) => event._tag === "SelectionLoaded")).toBe(true)
      expect(dispatched.some((event) => event._tag === "QueueUpdated")).toBe(true)
      expect(dispatched.filter((event) => event._tag === "ExecutionControlled")).toHaveLength(3)
      expect(dispatched.some((event) => event._tag === "TranscriptPatched")).toBe(true)
      expect(yield* turns.get(Turn.TurnId.make("active-control"))).toMatchObject({
        status: "cancelled",
        lastCursor: "cancelled",
      })
      expect(yield* turns.get(Turn.TurnId.make("queued-control-2"))).toBeUndefined()
      expect(yield* turns.get(Turn.TurnId.make("submitted-control"))).toMatchObject({ status: "completed" })
    }),
  )

  it.effect("reprepares an edited promoted queued turn before starting it", () =>
    Effect.gen(function* () {
      const thread = selectionThread("edit-preparation-thread")
      const activeId = Turn.TurnId.make("edit-preparation-active")
      const queuedId = Turn.TurnId.make("edit-preparation-queued")
      const turns = yield* TurnRepository.makeMemory([
        {
          id: activeId,
          threadId: thread.id,
          prompt: "active",
          executionRoute: executionRoute(),
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: queuedId,
          threadId: thread.id,
          prompt: "original prompt",
          executionRoute: executionRoute(),
          status: "queued",
          createdAt: 2,
          updatedAt: 2,
        },
      ])
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events: Array<Operation.InteractiveEvent> = []
      const preparationEntered = yield* Deferred.make<void>()
      const releasePreparation = yield* Deferred.make<void>()
      const preparations = yield* Ref.make(0)
      const starts = yield* Ref.make<ReadonlyArray<{ readonly prompt: string; readonly status: string | undefined }>>(
        [],
      )
      const preparedBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: (turnId) =>
          Effect.succeed(
            turnId === activeId ? { turnId, status: "running", waits: [], pendingTools: [], children: [] } : undefined,
          ),
        cancel: (turnId) => Effect.succeed({ turnId, status: "cancelled", events: [] }),
        start: (input) =>
          Effect.gen(function* () {
            const persisted = yield* turns.get(Turn.TurnId.make(input.turnId)).pipe(Effect.orDie)
            yield* Ref.update(starts, (all) => [...all, { prompt: input.prompt, status: persisted?.status }])
            return yield* backend.start(input)
          }),
      })
      const layer = Operation.productLayer({
        repositoryLayer: ThreadRepository.memoryLayer([thread]),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, preparedBackend),
        resolvedContextLayer: ResolvedContext.testLayer({
          resolve: () =>
            Effect.gen(function* () {
              const attempt = yield* Ref.updateAndGet(preparations, (count) => count + 1)
              if (attempt === 1) {
                yield* Deferred.succeed(preparationEntered, undefined)
                yield* Deferred.await(releasePreparation)
              }
              return { sources: [], diagnostics: [], digest: "" }
            }),
        }),
        defaultWorkspace: "/work",
        makeThreadId: Effect.die("unused"),
        makeTurnId: Effect.die("unused"),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, { _tag: "Interactive", prompt: [], ephemeral: false })
        yield* collectEvents(session, events)
        yield* session.selectThread(thread.id, 1)
        yield* Effect.forkChild(session.cancel)
        yield* Deferred.await(preparationEntered)
        yield* session.editQueued(queuedId, "edited prompt")
        yield* Deferred.succeed(releasePreparation, undefined)
        while ((yield* turns.get(queuedId))?.status !== "completed") yield* Effect.yieldNow
        yield* settleEvents
      }).pipe(provideLayer(layer))

      expect(yield* Ref.get(preparations)).toBe(2)
      expect(yield* Ref.get(starts)).toEqual([{ prompt: "edited prompt", status: "running" }])
      const queueEvents = events.filter((event) => event._tag === "QueueUpdated")
      expect(queueEvents.map((event) => [event.revision, event.queuedCount, event.change._tag])).toEqual([
        [2, 1, "Updated"],
        [3, 0, "Removed"],
      ])
      const started = events.filter((event) => event._tag === "TurnStarted")
      expect(started).toHaveLength(1)
      expect(started[0]).toMatchObject({ turn: { id: queuedId, prompt: "edited prompt", status: "running" } })
    }),
  )

  it.effect("skips a dequeued promoted head and runs the next queued turn", () =>
    Effect.gen(function* () {
      const thread = selectionThread("dequeue-preparation-thread")
      const activeId = Turn.TurnId.make("dequeue-preparation-active")
      const headId = Turn.TurnId.make("dequeue-preparation-head")
      const nextId = Turn.TurnId.make("dequeue-preparation-next")
      const turns = yield* TurnRepository.makeMemory([
        {
          id: activeId,
          threadId: thread.id,
          prompt: "active",
          executionRoute: executionRoute(),
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: headId,
          threadId: thread.id,
          prompt: "head",
          executionRoute: executionRoute(),
          status: "queued",
          createdAt: 2,
          updatedAt: 2,
        },
        {
          id: nextId,
          threadId: thread.id,
          prompt: "next",
          executionRoute: executionRoute(),
          status: "queued",
          createdAt: 3,
          updatedAt: 3,
        },
      ])
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events: Array<Operation.InteractiveEvent> = []
      const preparationEntered = yield* Deferred.make<void>()
      const releasePreparation = yield* Deferred.make<void>()
      const preparations = yield* Ref.make(0)
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const preparedBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: (turnId) =>
          Effect.succeed(
            turnId === activeId ? { turnId, status: "running", waits: [], pendingTools: [], children: [] } : undefined,
          ),
        cancel: (turnId) => Effect.succeed({ turnId, status: "cancelled", events: [] }),
        start: (input) =>
          Ref.update(starts, (all) => [...all, String(input.turnId)]).pipe(Effect.andThen(backend.start(input))),
      })
      const layer = Operation.productLayer({
        repositoryLayer: ThreadRepository.memoryLayer([thread]),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, preparedBackend),
        resolvedContextLayer: ResolvedContext.testLayer({
          resolve: () =>
            Effect.gen(function* () {
              const attempt = yield* Ref.updateAndGet(preparations, (count) => count + 1)
              if (attempt === 1) {
                yield* Deferred.succeed(preparationEntered, undefined)
                yield* Deferred.await(releasePreparation)
              }
              return { sources: [], diagnostics: [], digest: "" }
            }),
        }),
        defaultWorkspace: "/work",
        makeThreadId: Effect.die("unused"),
        makeTurnId: Effect.die("unused"),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, { _tag: "Interactive", prompt: [], ephemeral: false })
        yield* collectEvents(session, events)
        yield* session.selectThread(thread.id, 1)
        yield* Effect.forkChild(session.cancel)
        yield* Deferred.await(preparationEntered)
        yield* session.dequeue(headId)
        yield* Deferred.succeed(releasePreparation, undefined)
        while ((yield* turns.get(nextId))?.status !== "completed") yield* Effect.yieldNow
        yield* settleEvents
      }).pipe(provideLayer(layer))

      expect(yield* Ref.get(preparations)).toBe(2)
      expect(yield* Ref.get(starts)).toEqual([nextId])
      expect(yield* turns.get(headId)).toBeUndefined()
      expect(yield* turns.readQueue(thread.id)).toMatchObject({ revision: 4, queuedCount: 0, turns: [] })
      const queueEvents = events.filter((event) => event._tag === "QueueUpdated")
      expect(queueEvents.map((event) => [event.revision, event.queuedCount, event.change._tag])).toEqual([
        [3, 1, "Removed"],
        [4, 0, "Removed"],
      ])
      expect(events.filter((event) => event._tag === "TurnStarted").map((event) => event.turn.id)).toEqual([nextId])
      expect(events.some((event) => event._tag === "ExecutionFailed" && event.turnId === headId)).toBe(false)
    }),
  )

  it.effect("steers a claimed queued prompt before preparation makes it running", () =>
    Effect.gen(function* () {
      const thread = selectionThread("steer-race-thread")
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("steer-race-active"),
          threadId: thread.id,
          prompt: "active",
          executionRoute: executionRoute(),
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: Turn.TurnId.make("steer-race-queued"),
          threadId: thread.id,
          prompt: "queued prompt",
          executionRoute: executionRoute(),
          status: "queued",
          createdAt: 2,
          updatedAt: 2,
        },
      ])
      const queuedRead = yield* Deferred.make<void>()
      const releaseQueuedRead = yield* Deferred.make<void>()
      const delayedTurns = TurnRepository.Service.of({
        ...turns,
        takeQueued: (id) =>
          id === "steer-race-queued"
            ? Deferred.succeed(queuedRead, undefined).pipe(
                Effect.andThen(Deferred.await(releaseQueuedRead)),
                Effect.andThen(turns.takeQueued(id)),
              )
            : turns.takeQueued(id),
      })
      const steers = yield* Ref.make<ReadonlyArray<string>>([])
      const raceBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: (turnId) => Effect.succeed({ turnId, status: "running", waits: [], pendingTools: [], children: [] }),
        steer: (_turnId, text) => Ref.update(steers, (values) => [...values, text]),
      })
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* session.selectThread(thread.id, 1)
        const steering = yield* Effect.forkChild(session.steerQueued("steer-race-queued", "fallback"))
        yield* Deferred.await(queuedRead)
        yield* turns.setStatus(Turn.TurnId.make("steer-race-active"), "completed", undefined, 3)
        expect((yield* turns.claimNextQueued(thread.id, 4))?.turn.id).toBe("steer-race-queued")
        yield* Deferred.succeed(releaseQueuedRead, undefined)
        yield* Fiber.join(steering)
      }).pipe(
        provideLayer(
          Operation.productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, delayedTurns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, raceBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.die("unused"),
            interactive: holdSession(sessions),
          }),
        ),
      )
      expect(yield* Ref.get(steers)).toEqual(["queued prompt"])
      expect(yield* turns.get(Turn.TurnId.make("steer-race-queued"))).toBeUndefined()
    }),
  )
})

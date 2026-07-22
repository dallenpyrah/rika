import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Deferred, Effect, Layer, Ref } from "effect"
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
  it.effect("restores a queued prompt when steering the active turn fails", () =>
    Effect.gen(function* () {
      const thread = selectionThread("steer-failure-thread")
      const queuedId = Turn.TurnId.make("steer-failure-queued")
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("steer-failure-active"),
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
          prompt: "keep this prompt",
          executionRoute: executionRoute(),
          status: "queued",
          createdAt: 2,
          updatedAt: 2,
        },
        {
          id: Turn.TurnId.make("steer-failure-later"),
          threadId: thread.id,
          prompt: "later prompt",
          executionRoute: executionRoute(),
          status: "queued",
          createdAt: 3,
          updatedAt: 3,
        },
      ])
      const failingBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: (turnId) => Effect.succeed({ turnId, status: "running", waits: [], pendingTools: [], children: [] }),
        steer: () => Effect.fail(ExecutionBackend.BackendError.make({ message: "forced steer failure" })),
      })
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const received: Array<Operation.InteractiveEvent> = []

      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* collectEvents(session, received)
        yield* session.selectThread(thread.id, 1)
        received.length = 0
        yield* session.steerQueued(queuedId, "unused fallback")
        yield* settleEvents
      }).pipe(
        provideLayer(
          Operation.productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, failingBackend),
            defaultWorkspace: "/work",
            pendingTurnCapacity: 2,
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.die("unused"),
            interactive: holdSession(sessions),
          }),
        ),
      )

      expect(yield* turns.get(queuedId)).toMatchObject({ status: "queued", prompt: "keep this prompt", createdAt: 2 })
      expect((yield* turns.readQueue(thread.id)).turns.map((turn) => turn.id)).toEqual([
        "steer-failure-queued",
        "steer-failure-later",
      ])
      expect(received).toContainEqual(
        expect.objectContaining({ _tag: "ExecutionFailed", message: expect.stringContaining("forced steer failure") }),
      )
    }),
  )

  it.effect("interrupts an active turn and starts the replacement callback", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("interrupt-thread"),
        workspace: "/work",
        title: "Interrupt",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("active"),
          threadId: thread.id,
          prompt: "active",
          executionRoute: executionRoute(),
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
      ])
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events((event) => runSync(Ref.update(events, (all) => [...all, event]))))
        yield* Effect.yieldNow
        yield* session.reopenThread(1)
        yield* session.interruptAndSend("replacement prompt")
        yield* Effect.yieldNow
      }).pipe(
        provideLayer(
          Operation.productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, {
              ...backend,
              inspect: (turnId) =>
                Effect.succeed({ turnId, status: "running", waits: [], pendingTools: [], children: [] }),
            }),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.succeed(Turn.TurnId.make("replacement")),
            interactive: holdSession(sessions),
          }),
        ),
      )
      expect(yield* turns.get(Turn.TurnId.make("active"))).toMatchObject({ status: "cancelled" })
      expect(yield* turns.get(Turn.TurnId.make("replacement"))).toMatchObject({ status: "completed" })
      expect((yield* Ref.get(events)).map((event) => event._tag)).toContain("QueueUpdated")
    }),
  )

  it.effect("executes interrupt-and-send when terminal admission races pending creation", () =>
    Effect.gen(function* () {
      const thread = selectionThread("interrupt-race-thread")
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("interrupt-race-active"),
          threadId: thread.id,
          prompt: "active",
          executionRoute: executionRoute(),
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
      ])
      const racingTurns = TurnRepository.Service.of({
        ...turns,
        createForSubmission: (input) =>
          turns
            .setStatus(Turn.TurnId.make("interrupt-race-active"), "completed", undefined, input.now)
            .pipe(Effect.andThen(turns.createForSubmission(input))),
      })
      const starts = yield* Ref.make<ReadonlyArray<string>>([])
      const raceBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: (turnId) =>
          Effect.succeed(
            turnId === "interrupt-race-active"
              ? { turnId, status: "running" as const, waits: [], pendingTools: [], children: [] }
              : undefined,
          ),
        start: (input) =>
          Ref.update(starts, (values) => [...values, String(input.turnId)]).pipe(Effect.andThen(backend.start(input))),
      })
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* session.selectThread(thread.id, 1)
        yield* session.interruptAndSend("replacement")
      }).pipe(
        provideLayer(
          Operation.productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, racingTurns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, raceBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.succeed(Turn.TurnId.make("interrupt-race-pending")),
            interactive: holdSession(sessions),
          }),
        ),
      )
      expect(yield* Ref.get(starts)).toEqual(["interrupt-race-pending"])
      expect(yield* turns.get(Turn.TurnId.make("interrupt-race-pending"))).toMatchObject({ status: "completed" })
      expect(yield* turns.readQueue(thread.id)).toMatchObject({ queuedCount: 0, turns: [] })
    }),
  )

  it.effect("releases a defensive observer collision without terminalizing the queued turn", () =>
    Effect.gen(function* () {
      const thread = selectionThread("observer-collision-thread")
      const active: Turn.Turn = {
        id: Turn.TurnId.make("observer-collision-active"),
        threadId: thread.id,
        prompt: "active",
        executionRoute: executionRoute(),
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      }
      const queued: Turn.Turn = {
        id: Turn.TurnId.make("observer-collision-queued"),
        threadId: thread.id,
        prompt: "queued",
        executionRoute: executionRoute(),
        status: "queued",
        createdAt: 2,
        updatedAt: 2,
      }
      const turns = yield* TurnRepository.makeMemory([active, queued])
      const collisionTurns = TurnRepository.Service.of({
        ...turns,
        listNonterminal: Effect.succeed([active, { ...queued, status: "running" as const }]),
        get: (id) =>
          turns
            .get(id)
            .pipe(
              Effect.map((turn) =>
                id === queued.id && turn !== undefined ? { ...turn, status: "running" as const } : turn,
              ),
            ),
      })
      const observerClaimed = yield* Deferred.make<void>()
      const collisionBackend = ExecutionBackend.Service.of({
        ...backend,
        inspect: (turnId) => Effect.succeed({ turnId, status: "running", waits: [], pendingTools: [], children: [] }),
        follow: (turnId) =>
          (turnId === queued.id ? Deferred.succeed(observerClaimed, undefined) : Effect.void).pipe(
            Effect.andThen(Effect.never),
          ),
      })
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* session.selectThread(thread.id, 1)
        yield* Deferred.await(observerClaimed)
        yield* session.cancel
      }).pipe(
        provideLayer(
          Operation.productLayer({
            repositoryLayer: ThreadRepository.memoryLayer([thread]),
            turnRepositoryLayer: Layer.succeed(TurnRepository.Service, collisionTurns),
            backendLayer: Layer.succeed(ExecutionBackend.Service, collisionBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.die("unused"),
            makeTurnId: Effect.die("unused"),
            interactive: holdSession(sessions),
          }),
        ),
      )
      expect(yield* turns.get(queued.id)).toMatchObject({ status: "queued" })
      expect(yield* turns.readQueue(thread.id)).toMatchObject({ queuedCount: 1, turns: [{ id: queued.id }] })
    }),
  )

  it.effect("durably submits interactive prompts and projects completion", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const liveBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          backend.start(input).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                for (const event of result.events) input.onEvent?.(event)
              }),
            ),
          ),
      })
      const layer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, liveBackend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-interactive")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("turn-interactive")),
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
        yield* session.submit("exact prompt")
        while ((yield* turns.get(Turn.TurnId.make("turn-interactive")))?.status !== "completed") yield* Effect.yieldNow
        while ((yield* Ref.get(events)).filter((event) => event._tag !== "ThreadsListed").length < 4)
          yield* Effect.yieldNow
      }).pipe(provideLayer(layer))
      const dispatched = yield* Ref.get(events)
      const transcript = dispatched.filter((event) => event._tag !== "ThreadsListed")
      expect(transcript.slice(0, 4)).toEqual([
        { _tag: "ThreadActivated", threadId: "thread-interactive", title: "exact prompt" },
        {
          _tag: "TurnStarted",
          selectionEpoch: 0,
          threadId: "thread-interactive",
          turn: expect.objectContaining({
            id: "turn-interactive",
            threadId: "thread-interactive",
            prompt: "exact prompt",
            status: "running",
          }),
        },
        {
          _tag: "TranscriptPatched",
          selectionEpoch: 0,
          threadId: "thread-interactive",
          turnId: "turn-interactive",
          revision: 1,
          event: { cursor: "cursor-a", sequence: 1, type: "model.output.completed", createdAt: 1, text: "answer" },
        },
        {
          _tag: "TranscriptPatched",
          selectionEpoch: 0,
          threadId: "thread-interactive",
          turnId: "turn-interactive",
          revision: 2,
          event: { cursor: "cursor-b", sequence: 2, type: "execution.completed", createdAt: 2 },
        },
      ])
      expect(transcript[4]).toMatchObject({ _tag: "ThreadTitled", threadId: "thread-interactive", title: "answer" })
      expect(yield* turns.get(Turn.TurnId.make("turn-interactive"))).toMatchObject({
        prompt: "exact prompt",
        status: "completed",
        lastCursor: "cursor-b",
      })
    }),
  )

  it.effect("fails preparation without emitting TurnStarted or calling the backend", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const starts = yield* Ref.make(0)
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const layer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(
          ExecutionBackend.Service,
          ExecutionBackend.Service.of({
            ...backend,
            start: (input) => Ref.update(starts, (count) => count + 1).pipe(Effect.andThen(backend.start(input))),
          }),
        ),
        resolvedContextLayer: ResolvedContext.testLayer({ resolve: () => Effect.die("preparation failed") }),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("preparation-thread")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("preparation-turn")),
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
        yield* session.submit("cannot prepare")
        while ((yield* turns.get(Turn.TurnId.make("preparation-turn")))?.status !== "failed") yield* Effect.yieldNow
        while (!(yield* Ref.get(events)).some((event) => event._tag === "ExecutionFailed")) yield* Effect.yieldNow
      }).pipe(provideLayer(layer))
      expect(yield* Ref.get(starts)).toBe(0)
      expect((yield* Ref.get(events)).some((event) => event._tag === "TurnStarted")).toBe(false)
    }),
  )
})

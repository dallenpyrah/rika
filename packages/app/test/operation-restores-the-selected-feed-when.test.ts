import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Deferred, Effect, Fiber, Layer, Ref, Scheduler } from "effect"
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

const makeSelectionLoadHarness = Effect.fn("OperationTest.makeSelectionLoadHarness")(function* (eventCount: number) {
  const previous = selectionThread("selection-previous")
  const target = selectionThread("selection-target")
  const repository = yield* ThreadRepository.makeMemory([previous, target])
  const turns = yield* TurnRepository.makeMemory()
  const targetGetEntered = yield* Deferred.make<void>()
  const releaseTargetGet = yield* Deferred.make<void>()
  const liveEventsEmitted = yield* Deferred.make<void>()
  const releaseExecution = yield* Deferred.make<void>()
  const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
  let targetGetBlocked = false
  let targetGetFailed = false
  const delayedRepository = ThreadRepository.Service.of({
    ...repository,
    get: (id) =>
      targetGetFailed && id === target.id
        ? Effect.fail(ThreadRepository.RepositoryError.make({ message: "forced thread lookup failure" }))
        : targetGetBlocked && id === target.id
          ? Deferred.succeed(targetGetEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseTargetGet)),
              Effect.andThen(repository.get(id)),
            )
          : repository.get(id),
  })
  const streamed: ReadonlyArray<ExecutionBackend.Event> = Array.from({ length: eventCount }, (_, index) => ({
    cursor: `selection-live-${index + 1}`,
    sequence: index + 1,
    type: "model.output.delta",
    createdAt: index + 1,
    text: String(index + 1),
  }))
  const selectionBackend = ExecutionBackend.Service.of({
    ...backend,
    start: (input) =>
      Effect.sync(() => {
        for (const event of streamed) input.onEvent?.(event)
      }).pipe(
        Effect.andThen(Deferred.succeed(liveEventsEmitted, undefined)),
        Effect.andThen(Deferred.await(releaseExecution)),
        Effect.as({ turnId: input.turnId, status: "completed" as const, events: streamed }),
      ),
    inspect: (turnId) =>
      Effect.succeed({ turnId, status: "running" as const, waits: [], pendingTools: [], children: [] }),
    replay: (turnId) => Effect.succeed({ turnId, status: "running" as const, events: [] }),
  })
  const layer = Operation.productLayer({
    repositoryLayer: Layer.succeed(ThreadRepository.Service, delayedRepository),
    turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
    backendLayer: Layer.succeed(ExecutionBackend.Service, selectionBackend),
    defaultWorkspace: "/work",
    makeThreadId: Effect.die("unused"),
    makeTurnId: Effect.succeed(Turn.TurnId.make("selection-live-turn")),
    interactive: holdSession(sessions),
  })
  return {
    previous,
    target,
    turns,
    sessions,
    layer,
    targetGetEntered,
    liveEventsEmitted,
    releaseExecution: Deferred.succeed(releaseExecution, undefined),
    beginTargetGet: Effect.sync(() => {
      targetGetBlocked = true
    }),
    failTargetGet: Effect.sync(() => {
      targetGetFailed = true
    }),
    releaseTargetGet: Effect.sync(() => {
      targetGetBlocked = false
    }).pipe(Effect.andThen(Deferred.succeed(releaseTargetGet, undefined))),
  }
})

describe("Operation", () => {
  it.effect("restores the selected feed when thread lookup is interrupted", () =>
    Effect.gen(function* () {
      const harness = yield* makeSelectionLoadHarness(1)
      yield* Effect.gen(function* () {
        const source = yield* openInteractiveSession(harness.sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        const selecting = yield* openInteractiveSession(harness.sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        const received: Array<Operation.InteractiveEvent> = []
        yield* collectEvents(selecting, received)
        yield* source.selectThread(harness.previous.id, 1)
        yield* selecting.selectThread(harness.previous.id, 1)
        yield* settleEvents
        received.length = 0

        yield* harness.beginTargetGet
        const selection = yield* Effect.forkChild(selecting.selectThread(harness.target.id, 2))
        yield* Deferred.await(harness.targetGetEntered)
        yield* Fiber.interrupt(selection)
        yield* source.submit("stream after interrupted selection")
        yield* Deferred.await(harness.liveEventsEmitted)
        yield* settleEvents

        expect(received).toContainEqual(
          expect.objectContaining({
            _tag: "TranscriptPatched",
            selectionEpoch: 1,
            threadId: harness.previous.id,
            turnId: Turn.TurnId.make("selection-live-turn"),
          }),
        )
        yield* harness.releaseExecution
      }).pipe(provideLayer(harness.layer))
    }),
  )

  it.effect("does not let a failed selection overwrite a newer selection", () =>
    Effect.gen(function* () {
      const previous = selectionThread("selection-rollback-previous")
      const current = selectionThread("selection-rollback-current")
      const repository = yield* ThreadRepository.makeMemory([previous, current])
      const failedLookup = yield* Deferred.make<void>()
      const interleavingRepository = ThreadRepository.Service.of({
        ...repository,
        get: (id) =>
          id === "selection-rollback-missing"
            ? Deferred.succeed(failedLookup, undefined).pipe(Effect.as(undefined))
            : repository.get(id),
      })
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const layer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, interleavingRepository),
        turnRepositoryLayer: TurnRepository.memoryLayer(),
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.die("unused"),
        makeTurnId: Effect.die("unused"),
        interactive: holdSession(sessions),
      })

      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        const received: Array<Operation.InteractiveEvent> = []
        yield* collectEvents(session, received)
        yield* session.selectThread(previous.id, 1)
        received.length = 0
        const selectCurrent = yield* Effect.forkChild(
          Deferred.await(failedLookup).pipe(
            Effect.andThen(session.selectThread(current.id, 3)),
            Effect.provideService(Scheduler.MaxOpsBeforeYield, 2_048),
          ),
        )
        yield* session.selectThread("selection-rollback-missing", 2)
        yield* Fiber.join(selectCurrent)
        yield* session.readQueue(current.id)
        yield* settleEvents

        expect(received).toContainEqual(
          expect.objectContaining({
            _tag: "SelectionLoaded",
            selectionEpoch: 3,
            thread: expect.objectContaining({ id: current.id }),
          }),
        )
        expect(received).toContainEqual(
          expect.objectContaining({ _tag: "QueueUpdated", selectionEpoch: 3, threadId: current.id }),
        )
      }).pipe(provideLayer(layer), Effect.provideService(Scheduler.MaxOpsBeforeYield, 3))
    }),
  )

  it.effect("delivers critical target events while selection is in flight", () =>
    Effect.gen(function* () {
      const harness = yield* makeSelectionLoadHarness(1)
      yield* Effect.gen(function* () {
        const source = yield* openInteractiveSession(harness.sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        const selecting = yield* openInteractiveSession(harness.sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        const received: Array<Operation.InteractiveEvent> = []
        yield* collectEvents(selecting, received)
        yield* source.selectThread(harness.target.id, 1)
        yield* selecting.selectThread(harness.previous.id, 1)
        yield* source.submit("active target turn")
        yield* Deferred.await(harness.liveEventsEmitted)
        yield* settleEvents
        received.length = 0

        yield* harness.beginTargetGet
        const selection = yield* Effect.forkChild(selecting.selectThread(harness.target.id, 2))
        yield* Deferred.await(harness.targetGetEntered)
        yield* source.steer("critical during selection")
        yield* settleEvents

        expect(received).toContainEqual(
          expect.objectContaining({
            _tag: "ExecutionControlled",
            selectionEpoch: 2,
            threadId: harness.target.id,
            action: "steered",
          }),
        )
        yield* Fiber.interrupt(selection)
        yield* harness.releaseExecution
      }).pipe(provideLayer(harness.layer))
    }),
  )

  it.effect("requests transcript resync when selection activity exceeds its buffer and allows a clean reselect", () =>
    Effect.gen(function* () {
      const harness = yield* makeSelectionLoadHarness(8_193)
      yield* Effect.gen(function* () {
        const source = yield* openInteractiveSession(harness.sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        const selecting = yield* openInteractiveSession(harness.sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        const received: Array<Operation.InteractiveEvent> = []
        yield* collectEvents(selecting, received)
        yield* source.selectThread(harness.target.id, 1)
        yield* selecting.selectThread(harness.previous.id, 1)
        yield* settleEvents
        received.length = 0

        yield* harness.beginTargetGet
        const selection = yield* Effect.forkChild(selecting.selectThread(harness.target.id, 2))
        yield* Deferred.await(harness.targetGetEntered)
        yield* source.submit("overflow during selection")
        yield* Deferred.await(harness.liveEventsEmitted)
        yield* harness.releaseTargetGet
        yield* Fiber.join(selection)
        yield* settleEvents

        expect(
          received
            .filter(
              (event) =>
                (event._tag === "SelectionLoaded" || event._tag === "TranscriptResyncRequired") &&
                event.selectionEpoch === 2,
            )
            .map((event) => event._tag),
        ).toEqual(["SelectionLoaded", "TranscriptResyncRequired"])

        received.length = 0
        yield* selecting.selectThread(harness.target.id, 3)
        yield* settleEvents
        expect(received.filter((event) => event._tag === "SelectionLoaded" && event.selectionEpoch === 3)).toHaveLength(
          1,
        )
        expect(received.some((event) => event._tag === "TranscriptResyncRequired" && event.selectionEpoch === 3)).toBe(
          false,
        )
        yield* harness.releaseExecution
      }).pipe(provideLayer(harness.layer))
    }),
  )

  it.effect("bounds activity buffered for an initial thread that has not been selected", () =>
    Effect.gen(function* () {
      const harness = yield* makeSelectionLoadHarness(8_193)
      yield* Effect.gen(function* () {
        const source = yield* openInteractiveSession(harness.sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        const initial = yield* openInteractiveSession(harness.sessions, {
          _tag: "Interactive",
          prompt: [],
          threadId: harness.target.id,
          ephemeral: false,
        })
        const received: Array<Operation.InteractiveEvent> = []
        yield* collectEvents(initial, received)
        yield* source.selectThread(harness.target.id, 1)
        received.length = 0

        yield* source.submit("overflow before initial selection")
        yield* Deferred.await(harness.liveEventsEmitted)
        yield* initial.selectThread(harness.target.id, 1)
        yield* settleEvents

        expect(
          received
            .filter(
              (event) =>
                (event._tag === "SelectionLoaded" || event._tag === "TranscriptResyncRequired") &&
                event.selectionEpoch === 1,
            )
            .map((event) => event._tag),
        ).toEqual(["SelectionLoaded", "TranscriptResyncRequired"])
        expect(received.filter((event) => event._tag === "TranscriptPatched")).toHaveLength(0)
        yield* harness.releaseExecution
      }).pipe(provideLayer(harness.layer))
    }),
  )

  it.effect("exercises every interactive session control and its safe failure path", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const dispatch = (event: Operation.InteractiveEvent) => runSync(Ref.update(events, (all) => [...all, event]))
      const layer = Operation.productLayer({
        repositoryLayer: ThreadRepository.memoryLayer(),
        turnRepositoryLayer: TurnRepository.memoryLayer([
          {
            id: Turn.TurnId.make("orphan"),
            threadId: Thread.ThreadId.make("orphan-thread"),
            prompt: "queued",
            executionRoute: executionRoute(),
            status: "queued",
            createdAt: 1,
            updatedAt: 1,
          },
        ]),
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("thread")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("turn")),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events(dispatch))
        yield* Effect.yieldNow
        yield* session.shell("pwd", false)
        yield* session.editQueued("orphan", "changed")
        yield* session.dequeue("missing")
        yield* session.steer("direction")
        yield* session.interruptAndSend("next")
        yield* session.cancel
        yield* session.resolvePermission("wait", "permission", "allow")
        yield* session.resolvePermission("wait", "permission", "deny")
        yield* session.resolvePermission("wait", "permission", "always")
        yield* session.selectThread("missing", 1)
        yield* session.reopenThread(2)
        yield* session.replay("turn", undefined)
        yield* Effect.yieldNow
      }).pipe(provideLayer(layer))
      expect((yield* Ref.get(events)).filter((event) => event._tag === "ExecutionFailed").length).toBeGreaterThan(0)
      expect((yield* Ref.get(events)).at(-1)).toMatchObject({
        _tag: "ExecutionFailed",
        message: expect.stringContaining("No thread selected"),
      })
    }),
  )

  it.effect("admits 100 queued turns with constant-size deltas and no per-submit host wake", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const dispatch = (event: Operation.InteractiveEvent) => runSync(Ref.update(events, (all) => [...all, event]))
      const wakes = yield* Ref.make<ReadonlyArray<ExecutionBackend.ThreadQueueWake>>([])
      const promoters = yield* Ref.make<ReadonlyArray<ExecutionBackend.TurnPromoter>>([])
      const started = yield* Ref.make<ReadonlyArray<string>>([])
      const turnSequence = yield* Ref.make(0)
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("hosted"),
        workspace: "/work",
        title: "Hosted",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const hostedBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Ref.update(started, (all) => [...all, input.turnId]).pipe(
            Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
          ),
        inspect: (turnId) =>
          Effect.succeed(
            turnId === "busy"
              ? {
                  turnId,
                  status: "running" as const,
                  waits: [],
                  pendingTools: [],
                  children: [],
                }
              : undefined,
          ),
        wakeThreadHost: (wake) => Ref.update(wakes, (all) => [...all, wake]),
        registerTurnPromoter: (promoter) => Ref.update(promoters, (all) => [...all, promoter]),
      })
      const turns = yield* TurnRepository.makeMemory([
        {
          id: Turn.TurnId.make("busy"),
          threadId: thread.id,
          prompt: "active",
          executionRoute: executionRoute(),
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
      ])
      const layer = Operation.productLayer({
        repositoryLayer: ThreadRepository.memoryLayer([thread]),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, hostedBackend),
        defaultWorkspace: "/work",
        pendingTurnCapacity: 128,
        makeThreadId: Effect.succeed(thread.id),
        makeTurnId: Ref.updateAndGet(turnSequence, (value) => value + 1).pipe(
          Effect.map((value) => Turn.TurnId.make(`queued-turn-${value}`)),
        ),
        interactive: holdSession(sessions),
      })
      yield* Effect.gen(function* () {
        const session = yield* openInteractiveSession(sessions, {
          _tag: "Interactive",
          prompt: [],
          ephemeral: false,
        })
        yield* Effect.forkChild(session.events(dispatch))
        yield* Effect.yieldNow
        yield* session.selectThread("hosted", 1)
        yield* Effect.forEach(
          Array.from({ length: 100 }, (_, index) => index),
          (index) => session.submit(`while busy ${index}`),
          { concurrency: "unbounded", discard: true },
        )
        yield* settleEvents
      }).pipe(provideLayer(layer))
      expect(yield* Ref.get(started)).toEqual([])
      expect(yield* Ref.get(wakes)).toEqual([])
      expect((yield* Ref.get(promoters)).length).toBeGreaterThan(0)
      expect((yield* Ref.get(events)).filter((event) => event._tag === "QueueUpdated")).toHaveLength(100)
      expect(yield* turns.readQueue(thread.id)).toMatchObject({ revision: 100, queuedCount: 100 })
      const promoter = (yield* Ref.get(promoters))[0]
      if (promoter === undefined) return yield* Effect.die("missing promoter")
      expect(yield* promoter("missing-thread", 1)).toBe(0)
    }),
  )
})

import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Deferred, Effect, Fiber, Layer, Queue, Ref } from "effect"
import { it as rawIt } from "vitest"
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
  it.effect("coalesces concurrent reconnect repairs into one scan and one requested rescan", () =>
    Effect.gen(function* () {
      const turns = yield* TurnRepository.makeMemory()
      const scans = yield* Ref.make(0)
      const firstScanStarted = yield* Deferred.make<void>()
      const releaseFirstScan = yield* Deferred.make<void>()
      const countedTurns = TurnRepository.Service.of({
        ...turns,
        listNonterminal: Ref.updateAndGet(scans, (count) => count + 1).pipe(
          Effect.tap((count) => (count === 1 ? Deferred.succeed(firstScanStarted, undefined) : Effect.void)),
          Effect.tap((count) => (count === 1 ? Deferred.await(releaseFirstScan) : Effect.void)),
          Effect.andThen(turns.listNonterminal),
        ),
      })
      const layer = Operation.productLayer({
        repositoryLayer: ThreadRepository.memoryLayer(),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, countedTurns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.die("unused"),
        makeTurnId: Effect.die("unused"),
        interactive: () => Effect.void,
      })

      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* Effect.forEach(
          Array.from({ length: 20 }),
          (_, index) =>
            operation.run({
              _tag: "Interactive",
              prompt: [],
              workspace: `/reconnect-${index}`,
              ephemeral: false,
            }),
          { concurrency: "unbounded", discard: true },
        )
        yield* Deferred.await(firstScanStarted)
        yield* Deferred.succeed(releaseFirstScan, undefined)
        while ((yield* Ref.get(scans)) < 2) yield* Effect.yieldNow
        yield* settleEvents
      }).pipe(provideLayer(layer))

      expect(yield* Ref.get(scans)).toBe(2)
    }),
  )

  it.effect("retains a complete submission before the event feed attaches", () =>
    Effect.gen(function* () {
      const received = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const layer = Operation.productLayer({
        repositoryLayer: ThreadRepository.memoryLayer(),
        turnRepositoryLayer: TurnRepository.memoryLayer(),
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("prefeed-thread")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("prefeed-turn")),
        interactive: (_, session) =>
          Effect.gen(function* () {
            yield* session.submit("before feed")
            const terminal = yield* Queue.unbounded<void>()
            yield* Effect.raceFirst(
              session.events((event) => {
                runSync(Ref.update(received, (events) => [...events, event]))
                if (event._tag === "TranscriptPatched" && event.event.type === "execution.completed")
                  Queue.offerUnsafe(terminal, undefined)
              }),
              Queue.take(terminal),
            )
          }),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
      }).pipe(provideLayer(layer))
      const events = yield* Ref.get(received)
      expect(events.filter((event) => event._tag === "TurnStarted")).toHaveLength(1)
      expect(
        events
          .filter((event) => event._tag === "TranscriptPatched")
          .map((event) => (event._tag === "TranscriptPatched" ? event.event.cursor : "")),
      ).toEqual(["cursor-a", "cursor-b"])
    }),
  )

  rawIt("publishes one promoted lifecycle and one copy of every streamed cursor to every session", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const thread: Thread.Thread = {
          id: Thread.ThreadId.make("promoted-thread"),
          workspace: "/work",
          title: "Promoted",
          labels: [],
          pinned: false,
          archived: false,
          createdAt: 1,
          updatedAt: 1,
        }
        const turns = yield* TurnRepository.makeMemory([
          {
            id: Turn.TurnId.make("promoted-turn"),
            threadId: thread.id,
            prompt: "queued",
            status: "queued",
            executionRoute: Turn.testExecutionRoute("medium"),
            createdAt: 2,
            updatedAt: 2,
          },
        ])
        const starts = yield* Ref.make<ReadonlyArray<string>>([])
        const promoters = yield* Ref.make<ReadonlyArray<ExecutionBackend.TurnPromoter>>([])
        const wakes = yield* Ref.make<ReadonlyArray<ExecutionBackend.ThreadQueueWake>>([])
        const sessions = yield* Queue.unbounded<{
          readonly workspace: string
          readonly session: Operation.InteractiveSession
        }>()
        const events = new Map<string, Array<Operation.InteractiveEvent>>()
        const feedCompleted = Symbol("feed-completed")
        const streamed = [
          { cursor: "streamed", sequence: 1, type: "model.output.completed", createdAt: 3, text: "done" },
          { cursor: "terminal", sequence: 2, type: "execution.completed", createdAt: 4 },
        ] as const
        const promotedBackend = ExecutionBackend.Service.of({
          ...backend,
          start: (input) =>
            Ref.update(starts, (values) => [...values, String(input.turnId)]).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  for (const event of streamed) input.onEvent?.(event)
                }),
              ),
              Effect.as({ turnId: input.turnId, status: "completed" as const, events: streamed }),
            ),
          wakeThreadHost: (wake) => Ref.update(wakes, (values) => [...values, wake]),
          registerTurnPromoter: (promoter) => Ref.update(promoters, (values) => [...values, promoter]),
        })
        const layer = Operation.productLayer({
          repositoryLayer: ThreadRepository.memoryLayer([thread]),
          turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
          backendLayer: Layer.succeed(ExecutionBackend.Service, promotedBackend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.die("unused"),
          makeTurnId: Effect.die("unused"),
          interactive: (input, session) =>
            Effect.gen(function* () {
              const workspace = input.workspace ?? "unknown"
              events.set(workspace, [])
              yield* Queue.offer(sessions, { workspace, session })
              yield* session
                .events((event) => {
                  events.get(workspace)!.push(event)
                  if (event._tag === "TranscriptPatched" && event.event.type === "execution.completed")
                    throw feedCompleted
                })
                .pipe(Effect.catchDefect((defect) => (defect === feedCompleted ? Effect.void : Effect.die(defect))))
            }),
        })
        yield* Effect.gen(function* () {
          const operation = yield* Operation.Service
          const coordinate = Effect.gen(function* () {
            const one = yield* Queue.take(sessions)
            const two = yield* Queue.take(sessions)
            yield* Effect.all([one.session.selectThread(thread.id, 1), two.session.selectThread(thread.id, 1)], {
              concurrency: 2,
            })
            const promoter = (yield* Ref.get(promoters))[0]
            const wake = (yield* Ref.get(wakes))[0]
            if (promoter === undefined || wake === undefined) return yield* Effect.die("Missing promoter wake")
            expect(yield* promoter(thread.id, wake.generation)).toBe(1)
          })
          yield* Effect.all(
            [
              operation.run({ _tag: "Interactive", prompt: [], workspace: "/one", ephemeral: false }),
              operation.run({ _tag: "Interactive", prompt: [], workspace: "/two", ephemeral: false }),
              coordinate,
            ],
            { concurrency: 3, discard: true },
          )
        }).pipe(provideLayer(layer))
        expect(yield* Ref.get(starts)).toEqual(["promoted-turn"])
        for (const received of events.values()) {
          expect(received.filter((event) => event._tag === "TurnStarted")).toHaveLength(1)
          expect(
            received
              .filter((event) => event._tag === "TranscriptPatched")
              .map((event) => (event._tag === "TranscriptPatched" ? event.event.cursor : "")),
          ).toEqual(["streamed", "terminal"])
        }
      }),
    ),
  )

  rawIt(
    "recovers a complete atomic selection after the source feed exceeds its bounded window",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const eventCount = 8_300
          const streamed: ReadonlyArray<ExecutionBackend.Event> = [
            ...Array.from(
              { length: eventCount },
              (_, index): ExecutionBackend.Event => ({
                cursor: `chunk-${index + 1}`,
                sequence: index + 1,
                type: "model.output.delta",
                createdAt: index + 1,
                text: "x",
              }),
            ),
            {
              cursor: "terminal",
              sequence: eventCount + 1,
              type: "execution.completed",
              createdAt: eventCount + 1,
            },
          ]
          let recovered: Extract<Operation.InteractiveEvent, { readonly _tag: "SelectionLoaded" }> | undefined
          const overflowBackend = ExecutionBackend.Service.of({
            ...backend,
            start: (input) =>
              Effect.sync(() => {
                for (const event of streamed) input.onEvent?.(event)
                return { turnId: input.turnId, status: "completed" as const, events: streamed }
              }),
            replay: (turnId) => Effect.succeed({ turnId, status: "completed" as const, events: streamed }),
          })
          const layer = Operation.productLayer({
            repositoryLayer: ThreadRepository.memoryLayer(),
            turnRepositoryLayer: TurnRepository.memoryLayer(),
            backendLayer: Layer.succeed(ExecutionBackend.Service, overflowBackend),
            defaultWorkspace: "/work",
            makeThreadId: Effect.succeed(Thread.ThreadId.make("overflow-thread")),
            makeTurnId: Effect.succeed(Turn.TurnId.make("overflow-turn")),
            interactive: (_, session) =>
              Effect.gen(function* () {
                yield* session.submit("overflow")
                const received = yield* Queue.unbounded<Operation.InteractiveEvent>()
                const recover = Effect.gen(function* () {
                  while (true) {
                    const event = yield* Queue.take(received)
                    if (event._tag === "TranscriptResyncRequired")
                      yield* session.selectThread(event.threadId, event.selectionEpoch + 1)
                    if (event._tag === "SelectionLoaded") {
                      recovered = event
                      return
                    }
                  }
                })
                yield* Effect.raceFirst(
                  session.events((event) => Queue.offerUnsafe(received, event)),
                  recover,
                )
              }),
          })
          yield* Effect.gen(function* () {
            const operation = yield* Operation.Service
            yield* operation.run({ _tag: "Interactive", prompt: [], ephemeral: false })
          }).pipe(provideLayer(layer))
          expect(recovered).toBeDefined()
          expect(recovered?.selectionEpoch).toBe(1)
          expect(recovered?.activeTurn).toBeUndefined()
          expect(Math.max(...(recovered?.entries.map((entry) => entry.projectionRevision) ?? []))).toBe(eventCount + 1)
          expect(
            recovered?.entries
              .flatMap((entry) => (entry.unit.content._tag === "Entry" ? [entry.unit.content] : []))
              .filter((entry) => entry.role === "assistant")
              .map((entry) => entry.text)
              .join(""),
          ).toHaveLength(eventCount)
        }),
      ),
    30_000,
  )

  it.effect("delivers live transcript patches after the selection snapshot without loss or reordering", () =>
    Effect.gen(function* () {
      const harness = yield* makeSelectionLoadHarness(3)
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
        yield* source.submit("stream during selection")
        yield* Deferred.await(harness.liveEventsEmitted)
        yield* harness.releaseTargetGet
        yield* Fiber.join(selection)
        yield* settleEvents

        const selectedTranscript = received.filter(
          (event) =>
            (event._tag === "SelectionLoaded" && event.selectionEpoch === 2) ||
            (event._tag === "TranscriptPatched" && event.turnId === "selection-live-turn"),
        )
        expect(
          selectedTranscript.map((event) =>
            event._tag === "SelectionLoaded"
              ? event._tag
              : event._tag === "TranscriptPatched"
                ? event.event.cursor
                : "",
          ),
        ).toEqual(["SelectionLoaded", "selection-live-1", "selection-live-2", "selection-live-3"])
        expect(selectedTranscript.every((event) => "selectionEpoch" in event && event.selectionEpoch === 2)).toBe(true)

        yield* harness.releaseExecution
        while ((yield* harness.turns.get(Turn.TurnId.make("selection-live-turn")))?.status !== "completed")
          yield* Effect.yieldNow
        yield* settleEvents
        expect(
          received
            .filter((event) => event._tag === "TranscriptPatched" && event.turnId === "selection-live-turn")
            .map((event) => (event._tag === "TranscriptPatched" ? event.event.cursor : "")),
        ).toEqual(["selection-live-1", "selection-live-2", "selection-live-3"])
      }).pipe(provideLayer(harness.layer))
    }),
  )

  it.effect("restores the selected feed after the thread repository fails", () =>
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

        yield* harness.failTargetGet
        yield* selecting.selectThread(harness.target.id, 2)
        yield* source.submit("stream after failed selection")
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
})

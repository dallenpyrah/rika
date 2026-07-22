import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Runtime as ToolRuntime } from "@rika/tools"
import { Context, Deferred, Effect, Fiber, Layer, Queue, Ref } from "effect"
import { TestClock } from "effect/testing"
import { Operation } from "../src/index"
import { createTurn, executionRoute } from "./current-state"

const collectEvents = (session: Operation.InteractiveSession, events: Array<Operation.InteractiveEvent>) =>
  Effect.forkChild(session.events((event) => events.push(event))).pipe(Effect.andThen(Effect.yieldNow))

const waitForSessions = (sessions: Ref.Ref<ReadonlyArray<Operation.InteractiveSession>>, count = 1) =>
  Effect.gen(function* () {
    while ((yield* Ref.get(sessions)).length < count) yield* Effect.yieldNow
  })

const thread = (id: string, updatedAt: number): Thread.Thread => ({
  id: Thread.ThreadId.make(id),
  workspace: "/work",
  title: id,
  labels: [],
  pinned: false,
  archived: false,
  createdAt: updatedAt,
  updatedAt,
})

const active = (threadId: Thread.ThreadId, id = "active"): Turn.Turn => ({
  id: Turn.TurnId.make(id),
  threadId,
  prompt: "active prompt",
  executionRoute: executionRoute(),
  status: "running",
  createdAt: 1,
  updatedAt: 1,
  lastCursor: "active-cursor",
})

const makeHarness = Effect.fn("InteractiveSessionTest.makeHarness")(function* (
  followAfterPermission: boolean = false,
  toolApprovalWaitIds: ReadonlyArray<string> = [],
  pagedEvents?: ReadonlyArray<ExecutionBackend.Event>,
  stalePageCursor: boolean = false,
) {
  const older = thread("older", 1)
  const latest = thread("latest", 2)
  const repositories = yield* ThreadRepository.makeMemory([older, latest])
  const turns = yield* TurnRepository.makeMemory([active(older.id), active(latest.id, "latest-active")])
  const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
  const controls = yield* Ref.make<ReadonlyArray<ReadonlyArray<unknown>>>([])
  const permissionResolved = yield* Deferred.make<void>()
  const hiddenExecutions = yield* Ref.make<ReadonlySet<string>>(new Set())
  const transcripts = Context.get(yield* Layer.build(TranscriptRepository.memoryLayer), TranscriptRepository.Service)
  const record = (...call: ReadonlyArray<unknown>) => Ref.update(controls, (calls) => [...calls, call])
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
      followAfterPermission
        ? record("start", input.turnId).pipe(
            Effect.as({
              turnId: input.turnId,
              status: "completed" as const,
              events: [{ cursor: "queued-done", sequence: 1, type: "execution.completed", createdAt: 3 }],
            }),
          )
        : Effect.die("unused"),
    ...(followAfterPermission
      ? {
          follow: (
            turnId: string,
            afterCursor: string | undefined,
            onEvent?: (event: ExecutionBackend.Event) => void,
          ) => {
            const output = {
              cursor: "resumed-output",
              sequence: 2,
              type: "model.output.completed",
              createdAt: 2,
              text: "created file",
            }
            const completed = { cursor: "resumed-done", sequence: 3, type: "execution.completed", createdAt: 3 }
            return record("follow", turnId, afterCursor).pipe(
              Effect.andThen(turnId === "active" ? Deferred.await(permissionResolved) : Effect.void),
              Effect.tap(() => Effect.sync(() => onEvent?.(output))),
              Effect.tap(() => Effect.sync(() => onEvent?.(completed))),
              Effect.as({ turnId, status: "completed" as const, events: [output, completed] }),
            )
          },
        }
      : {}),
    inspect: (turnId) =>
      Ref.get(hiddenExecutions).pipe(
        Effect.map((hidden) =>
          turnId === "recorded-shell" || hidden.has(turnId)
            ? undefined
            : { turnId, status: "running" as const, waits: [], pendingTools: [], children: [] },
        ),
      ),
    steer: (turnId, text, now) => record("steer", turnId, text, now),
    cancel: (turnId, now) =>
      record("cancel", turnId, now).pipe(
        Effect.as({
          turnId,
          status: "cancelled" as const,
          events: [{ cursor: "cancel-cursor", sequence: 1, type: "execution.cancelled", createdAt: now }],
        }),
      ),
    replay: (turnId, cursor) =>
      record("replay", turnId, cursor).pipe(
        Effect.as({ turnId, status: "running" as const, events: [], lastCursor: cursor }),
      ),
    ...(pagedEvents === undefined
      ? {}
      : {
          pageEvents: (turnId: string, direction: "forward" | "backward", cursor?: string, limit = 200) => {
            const boundary =
              cursor === undefined
                ? direction === "forward"
                  ? 0
                  : pagedEvents.length
                : pagedEvents.findIndex((event) => event.cursor === cursor) + (direction === "forward" ? 1 : 0)
            const page =
              direction === "forward"
                ? pagedEvents.slice(boundary, boundary + limit)
                : pagedEvents.slice(Math.max(0, boundary - limit), boundary)
            const hasMore =
              direction === "forward" ? boundary + page.length < pagedEvents.length : boundary > page.length
            return record("page", turnId, direction, cursor, limit).pipe(
              Effect.as({
                events: page,
                hasMore,
                ...(page[0] === undefined
                  ? {}
                  : {
                      oldestCursor:
                        direction === "backward" && stalePageCursor && cursor !== undefined ? cursor : page[0].cursor,
                    }),
                ...(page.at(-1) === undefined
                  ? {}
                  : {
                      newestCursor:
                        direction === "forward" && stalePageCursor && cursor !== undefined
                          ? cursor
                          : page.at(-1)!.cursor,
                    }),
              }),
            )
          },
        }),
    listApprovals: (turnId) =>
      record("list-approvals", turnId).pipe(
        Effect.as(
          toolApprovalWaitIds.map((waitId) => ({
            waitId,
            callId: `call-${waitId}`,
            toolName: "write",
            input: { path: "a.ts" },
            requestedAt: 0,
          })),
        ),
      ),
    resolveToolApproval: (waitId, approved, now) => record("tool-approval", waitId, approved, now),
    resolvePermission: (waitId, decision, now) =>
      record("permission", waitId, decision, now).pipe(Effect.andThen(Deferred.succeed(permissionResolved, undefined))),
  })
  const layer = Operation.productLayer({
    repositoryLayer: Layer.succeed(ThreadRepository.Service, repositories),
    turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
    transcriptRepositoryLayer: Layer.succeed(TranscriptRepository.Service, transcripts),
    backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
    defaultWorkspace: "/work",
    makeThreadId: Effect.die("unused"),
    makeTurnId: Effect.succeed(Turn.TurnId.make("pending")),
    interactive: (_, session) =>
      Ref.update(sessions, (values) => [...values, session]).pipe(Effect.andThen(Effect.never)),
  })
  const context = yield* Layer.build(layer)
  const operation = Context.get(context, Operation.Service)
  yield* Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }))
  yield* waitForSessions(sessions)
  yield* Ref.set(controls, [])
  const session = (yield* Ref.get(sessions))[0]
  if (session === undefined) return yield* Effect.die("Missing interactive session")
  return { session, repositories, turns, transcripts, controls, hiddenExecutions, older, latest }
})

describe("InteractiveSession controls", () => {
  it.effect("publishes live thread summaries and clears unread state when a thread is selected", () =>
    Effect.gen(function* () {
      const { session, older } = yield* makeHarness()
      const events = yield* Queue.unbounded<Operation.InteractiveEvent>()
      const watcher = yield* Effect.forkChild(session.events((event) => Queue.offerUnsafe(events, event)))
      const initial = yield* Queue.take(events)
      expect(initial).toMatchObject({
        _tag: "ThreadsListed",
        threads: expect.arrayContaining([
          expect.objectContaining({ id: "older", status: "running", unread: true }),
          expect.objectContaining({ id: "latest", status: "running", unread: true }),
        ]),
      })
      yield* TestClock.adjust("10 millis")
      yield* session.selectThread(older.id, 3)
      let selected = yield* Queue.take(events)
      while (
        selected._tag !== "ThreadsListed" ||
        selected.threads.find((item) => item.id === older.id)?.unread !== false
      )
        selected = yield* Queue.take(events)
      expect(selected).toMatchObject({
        _tag: "ThreadsListed",
        threads: expect.arrayContaining([expect.objectContaining({ id: "older", unread: false })]),
      })
      yield* Fiber.interrupt(watcher)
    }),
  )

  it.effect("keeps simultaneous interactive sessions independent and uses each request workspace", () =>
    Effect.gen(function* () {
      const repositories = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const sessions = new Map<string, Operation.InteractiveSession>()
      const toolWorkspaces: Array<string> = []
      const threadSequence = yield* Ref.make(0)
      const turnSequence = yield* Ref.make(0)
      const backend = ExecutionBackend.Service.of({
        invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
        createFanOut: () => Effect.die("unexpected createFanOut"),
        inspectFanOut: () => Effect.die("unexpected inspectFanOut"),
        cancelFanOut: () => Effect.die("unexpected cancelFanOut"),
        registerWorkflows: () => Effect.die("unexpected registerWorkflows"),
        startWorkflow: () => Effect.die("unexpected startWorkflow"),
        inspectWorkflow: () => Effect.die("unexpected inspectWorkflow"),
        cancelWorkflow: () => Effect.die("unexpected cancelWorkflow"),
        inspect: () => Effect.void.pipe(Effect.as(undefined)),
        start: (input) => Effect.succeed({ turnId: input.turnId, status: "completed" as const, events: [] }),
        replay: (turnId, lastCursor) =>
          Effect.succeed({ turnId, status: "completed" as const, events: [], lastCursor }),
        steer: () => Effect.die("unexpected steer"),
        cancel: () => Effect.die("unexpected cancel"),
        listApprovals: () => Effect.succeed([]),
        resolveToolApproval: () => Effect.void,
        resolvePermission: () => Effect.die("unexpected resolvePermission"),
      })
      const layer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repositories),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        toolRuntimeLayer: (workspace) => {
          toolWorkspaces.push(workspace)
          return ToolRuntime.testLayer(() => Effect.succeed({ text: workspace, truncated: false }))
        },
        defaultWorkspace: "/default",
        makeThreadId: Ref.updateAndGet(threadSequence, (value) => value + 1).pipe(
          Effect.map((value) => Thread.ThreadId.make(`thread-${value}`)),
        ),
        makeTurnId: Ref.updateAndGet(turnSequence, (value) => value + 1).pipe(
          Effect.map((value) => Turn.TurnId.make(`turn-${value}`)),
        ),
        interactive: (input, session) =>
          Effect.sync(() => sessions.set(input.workspace ?? "/default", session)).pipe(Effect.andThen(Effect.never)),
      })
      const context = yield* Layer.build(layer)
      const operation = Context.get(context, Operation.Service)
      yield* Effect.forkChild(
        Effect.all(
          [
            operation.run({ _tag: "Interactive", prompt: [], workspace: "/alpha", ephemeral: false }),
            operation.run({ _tag: "Interactive", prompt: [], workspace: "/beta", ephemeral: false }),
          ],
          { concurrency: "unbounded", discard: true },
        ),
      )
      while (sessions.size < 2) yield* Effect.yieldNow
      const alpha = sessions.get("/alpha")
      const beta = sessions.get("/beta")
      if (alpha === undefined || beta === undefined) return yield* Effect.die("Missing interactive sessions")
      const alphaEvents: Array<Operation.InteractiveEvent> = []
      const betaEvents: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(alpha, alphaEvents)
      yield* collectEvents(beta, betaEvents)
      yield* Effect.all([alpha.submit("alpha prompt"), beta.submit("beta prompt")], { concurrency: "unbounded" })
      yield* Effect.all([alpha.shell("pwd", true), beta.shell("pwd", true)])
      const alphaThreadId = alphaEvents.find((event) => event._tag === "ThreadActivated")?.threadId
      const betaThreadId = betaEvents.find((event) => event._tag === "ThreadActivated")?.threadId
      expect(alphaThreadId).not.toBe(betaThreadId)
      yield* Effect.all([alpha.selectThread(alphaThreadId!, 1), beta.selectThread(betaThreadId!, 1)])
      yield* Effect.all([alpha.submit("alpha follow-up"), beta.submit("beta follow-up")])
      expect((yield* repositories.get(Thread.ThreadId.make(alphaThreadId!)))?.workspace).toBe("/alpha")
      expect((yield* repositories.get(Thread.ThreadId.make(betaThreadId!)))?.workspace).toBe("/beta")
      expect((yield* turns.list(Thread.ThreadId.make(alphaThreadId!))).map((turn) => turn.prompt)).toEqual([
        "alpha prompt",
        "alpha follow-up",
      ])
      expect((yield* turns.list(Thread.ThreadId.make(betaThreadId!))).map((turn) => turn.prompt)).toEqual([
        "beta prompt",
        "beta follow-up",
      ])
      expect(toolWorkspaces.toSorted()).toEqual(["/alpha", "/beta"])
    }),
  )

  it.effect("submits a prompt through every returned session callback", () =>
    Effect.gen(function* () {
      const repositories = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const submittedBackend = ExecutionBackend.Service.of({
        invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
        createFanOut: () => Effect.die("unused"),
        inspectFanOut: () => Effect.die("unused"),
        cancelFanOut: () => Effect.die("unused"),
        registerWorkflows: () => Effect.die("unused"),
        startWorkflow: () => Effect.die("unused"),
        inspectWorkflow: () => Effect.die("unused"),
        cancelWorkflow: () => Effect.die("unused"),
        inspect: () => Effect.void.pipe(Effect.as(undefined)),
        start: (input) =>
          Effect.succeed({
            turnId: input.turnId,
            status: "completed" as const,
            events: [
              { cursor: "output", sequence: 1, type: "model.output.completed", createdAt: 1 },
              { cursor: "done", sequence: 2, type: "execution.completed", createdAt: 2 },
            ],
          }),
        replay: () => Effect.die("unused"),
        steer: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
        listApprovals: () => Effect.succeed([]),
        resolveToolApproval: () => Effect.void,
        resolvePermission: () => Effect.die("unused"),
      })
      const layer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repositories),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, submittedBackend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.succeed(Thread.ThreadId.make("created")),
        makeTurnId: Effect.succeed(Turn.TurnId.make("created-turn")),
        interactive: (_, session) =>
          Ref.update(sessions, (values) => [...values, session]).pipe(Effect.andThen(Effect.never)),
      })
      const context = yield* Layer.build(layer)
      const operation = Context.get(context, Operation.Service)
      yield* Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }))
      yield* waitForSessions(sessions)
      const session = (yield* Ref.get(sessions))[0]
      if (session === undefined) return yield* Effect.die("Missing interactive session")
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.reopenThread(1)
      yield* session.submit("")
      while ((yield* turns.get(Turn.TurnId.make("created-turn")))?.status !== "completed") yield* Effect.yieldNow
      while (events.filter((event) => event._tag !== "ThreadsListed").length < 4) yield* Effect.yieldNow
      expect(events.filter((event) => event._tag !== "ThreadsListed")).toEqual([
        { _tag: "ThreadActivated", threadId: "created", title: "New thread" },
        {
          _tag: "TurnStarted",
          selectionEpoch: 0,
          threadId: "created",
          turn: expect.objectContaining({ id: "created-turn", threadId: "created", prompt: "", status: "running" }),
        },
        {
          _tag: "TranscriptPatched",
          selectionEpoch: 0,
          threadId: "created",
          turnId: "created-turn",
          revision: 1,
          event: { cursor: "output", sequence: 1, type: "model.output.completed", createdAt: 1 },
        },
        {
          _tag: "TranscriptPatched",
          selectionEpoch: 0,
          threadId: "created",
          turnId: "created-turn",
          revision: 2,
          event: { cursor: "done", sequence: 2, type: "execution.completed", createdAt: 2 },
        },
      ])
      expect(yield* repositories.get(Thread.ThreadId.make("created"))).toMatchObject({ title: "New thread" })
      expect(yield* turns.get(Turn.TurnId.make("created-turn"))).toMatchObject({
        status: "completed",
        lastCursor: "done",
      })
    }),
  )

  it.effect("admits, edits, and dequeues pending turns while the active turn is still executing", () =>
    Effect.gen(function* () {
      const repositories = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const nextTurn = yield* Ref.make(0)
      const activeStarted = yield* Deferred.make<void>()
      const activeSubmitted = yield* Deferred.make<void>()
      const releaseActive = yield* Deferred.make<void>()
      const pendingStarted = yield* Deferred.make<void>()
      const backend = ExecutionBackend.Service.of({
        invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
        createFanOut: () => Effect.die("unused"),
        inspectFanOut: () => Effect.die("unused"),
        cancelFanOut: () => Effect.die("unused"),
        registerWorkflows: () => Effect.die("unused"),
        startWorkflow: () => Effect.die("unused"),
        inspectWorkflow: () => Effect.die("unused"),
        cancelWorkflow: () => Effect.die("unused"),
        inspect: () => Effect.void.pipe(Effect.as(undefined)),
        start: (input) =>
          input.turnId === "turn-0"
            ? Deferred.succeed(activeStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseActive)),
                Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
              )
            : Deferred.succeed(pendingStarted, undefined).pipe(
                Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
              ),
        replay: () => Effect.die("unused"),
        steer: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
        listApprovals: () => Effect.succeed([]),
        resolveToolApproval: () => Effect.void,
        resolvePermission: () => Effect.die("unused"),
      })
      const layer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repositories),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
        defaultWorkspace: "/work",
        pendingTurnCapacity: 2,
        makeThreadId: Effect.succeed(Thread.ThreadId.make("thread")),
        makeTurnId: Ref.getAndUpdate(nextTurn, (value) => value + 1).pipe(
          Effect.map((value) => Turn.TurnId.make(`turn-${value}`)),
        ),
        interactive: (_, session) =>
          Ref.update(sessions, (values) => [...values, session]).pipe(Effect.andThen(Effect.never)),
      })
      const context = yield* Layer.build(layer)
      const operation = Context.get(context, Operation.Service)
      yield* Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }))
      yield* waitForSessions(sessions)
      const session = (yield* Ref.get(sessions))[0]
      if (session === undefined) return yield* Effect.die("Missing interactive session")
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)

      const activeFiber = yield* Effect.forkChild(
        session.submit("active").pipe(Effect.andThen(Deferred.succeed(activeSubmitted, undefined))),
      )
      yield* Deferred.await(activeStarted)
      expect(yield* Deferred.isDone(activeSubmitted)).toBe(true)
      const pending = yield* Effect.forkChild(session.submit("pending"))
      const removed = yield* Effect.forkChild(session.submit("removed"))
      for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow
      yield* session.submit("overflow")
      yield* Effect.yieldNow

      expect(yield* turns.readQueue(Thread.ThreadId.make("thread"))).toMatchObject({
        queuedCount: 2,
        turns: [
          { id: "turn-1", prompt: "pending", status: "queued" },
          { id: "turn-2", prompt: "removed", status: "queued" },
        ],
      })
      expect(events).toContainEqual(
        expect.objectContaining({
          _tag: "QueueUpdated",
          change: { _tag: "Added", item: { id: "turn-1", prompt: "pending" } },
        }),
      )
      expect(events).toContainEqual({
        _tag: "QueueFull",
        selectionEpoch: 0,
        threadId: "thread",
        capacity: 2,
        count: 2,
      })
      expect(yield* turns.get(Turn.TurnId.make("turn-3"))).toBeUndefined()
      yield* session.editQueued("turn-1", "edited")
      yield* session.dequeue("turn-2")
      expect(yield* turns.readQueue(Thread.ThreadId.make("thread"))).toMatchObject({
        queuedCount: 1,
        turns: [{ id: "turn-1", prompt: "edited", status: "queued" }],
      })
      expect(yield* Deferred.isDone(pendingStarted)).toBe(false)

      yield* Deferred.succeed(releaseActive, undefined)
      yield* Deferred.await(pendingStarted)
      yield* Effect.yieldNow
      yield* Fiber.join(activeFiber)
      yield* Fiber.join(pending)
      yield* Fiber.join(removed)
      expect(yield* turns.get(Turn.TurnId.make("turn-1"))).toMatchObject({ status: "completed" })
      expect(events.filter((event) => event._tag === "TurnStarted").map((event) => event.turn.id)).toEqual([
        "turn-0",
        "turn-1",
      ])
    }),
  )

  it.effect("edits and dequeues queued turns and reports the remaining queue", () =>
    Effect.gen(function* () {
      const { session, turns, older } = yield* makeHarness()
      yield* createTurn(turns, { id: Turn.TurnId.make("queued"), threadId: older.id, prompt: "before", now: 2 })
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 2)
      yield* session.editQueued("queued", "after")
      yield* Effect.yieldNow
      expect((yield* turns.get(Turn.TurnId.make("queued")))?.prompt).toBe("after")
      expect(events.at(-1)).toEqual({
        _tag: "QueueUpdated",
        selectionEpoch: 2,
        threadId: "older",
        revision: 2,
        queuedCount: 1,
        change: { _tag: "Updated", item: { id: "queued", prompt: "after" } },
      })
      events.length = 0
      yield* session.selectThread(older.id, 3)
      yield* Effect.yieldNow
      const page = events.find((event) => event._tag === "SelectionLoaded")
      expect(page?._tag === "SelectionLoaded" ? page.entries.some((entry) => entry.turn.id === "queued") : true).toBe(
        false,
      )
      yield* session.dequeue("queued")
      yield* Effect.yieldNow
      expect(yield* turns.get(Turn.TurnId.make("queued"))).toBeUndefined()
      expect(events.at(-1)).toEqual({
        _tag: "QueueUpdated",
        selectionEpoch: 3,
        threadId: "older",
        revision: 3,
        queuedCount: 0,
        change: { _tag: "Removed", turnId: "queued" },
      })
    }),
  )

  it.effect("steers and cancels the selected active turn", () =>
    Effect.gen(function* () {
      const { session, turns, controls, older } = yield* makeHarness()
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* session.steer("change course")
      yield* session.cancel
      yield* Effect.yieldNow
      expect(yield* Ref.get(controls)).toEqual([
        ["replay", "active", undefined],
        ["steer", "active", "change course", 0],
        ["cancel", "active", 0],
      ])
      expect(yield* turns.get(Turn.TurnId.make("active"))).toMatchObject({
        status: "cancelled",
        lastCursor: "cancel-cursor",
      })
      expect(events.at(-1)).toEqual({
        _tag: "ExecutionControlled",
        selectionEpoch: 1,
        threadId: "older",
        turnId: "active",
        action: "cancelled",
      })
    }),
  )
})

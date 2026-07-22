import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import * as Transcript from "@rika/transcript"
import { Context, Deferred, Effect, Layer, Ref } from "effect"
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
  it.effect("projects one Turn incrementally from bounded forward event pages", () =>
    Effect.gen(function* () {
      const pagedEvents = Array.from(
        { length: 450 },
        (_, index): ExecutionBackend.Event => ({
          cursor: `cursor-${index + 1}`,
          sequence: index + 1,
          type: "model.output.completed",
          createdAt: index + 1,
          text: `event ${index + 1}`,
        }),
      )
      const { session, controls, older } = yield* makeHarness(false, [], pagedEvents)
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* Effect.yieldNow

      const received = events.find((event) => event._tag === "SelectionLoaded")
      const projected =
        received?._tag === "SelectionLoaded" ? received.entries.filter((entry) => entry.turn.id === "active") : []
      expect(projected).toHaveLength(2)
      expect(projected.at(-1)?.unit).toMatchObject({
        revision: 450,
        content: { _tag: "Entry", role: "assistant", text: "event 450" },
      })
      expect(yield* Ref.get(controls)).toEqual([
        ["page", "active", "forward", undefined, 200],
        ["page", "active", "forward", "cursor-200", 200],
        ["page", "active", "forward", "cursor-400", 200],
      ])
    }),
  )

  it.effect("fails transcript loading when forward paging stops advancing", () =>
    Effect.gen(function* () {
      const pagedEvents = Array.from(
        { length: 450 },
        (_, index): ExecutionBackend.Event => ({
          cursor: `cursor-${index + 1}`,
          sequence: index + 1,
          type: "model.output.completed",
          createdAt: index + 1,
          text: `event ${index + 1}`,
        }),
      )
      const { session, controls, older } = yield* makeHarness(false, [], pagedEvents, true)
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* Effect.yieldNow

      expect(events.find((event) => event._tag === "ExecutionFailed")).toMatchObject({
        message: expect.stringContaining("cursor did not advance"),
      })
      expect(yield* Ref.get(controls)).toEqual([
        ["page", "active", "forward", undefined, 200],
        ["page", "active", "forward", "cursor-200", 200],
      ])
    }),
  )

  it.effect("keeps queued turns in the queue and out of the transcript when selecting a thread", () =>
    Effect.gen(function* () {
      const { session, turns, controls, older } = yield* makeHarness()
      const queued = yield* createTurn(turns, {
        id: Turn.TurnId.make("queued-selection"),
        threadId: older.id,
        prompt: "queued prompt",
        now: 2,
      })
      const shell = yield* turns.copy(
        {
          id: Turn.TurnId.make("recorded-shell"),
          threadId: older.id,
          prompt: "$ printf recorded\n\noutput:recorded",
          executionRoute: executionRoute(),
          status: "completed",
          createdAt: 3,
          updatedAt: 4,
        },
        128,
      )
      yield* turns.setStatus(Turn.TurnId.make("active"), "completed", "done", 5)
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* Effect.yieldNow

      expect(events.find((event) => event._tag === "SelectionLoaded")).toMatchObject({
        queue: [{ id: queued.id }],
        entries: [
          { turn: { id: "active" }, unit: { content: { _tag: "Entry" } } },
          { turn: { id: shell.id, status: "completed" }, unit: { content: { _tag: "Entry" } } },
        ],
      })
      expect(yield* Ref.get(controls)).toEqual([["replay", "active", undefined]])
    }),
  )

  it.effect("loads at least two hundred units to a Turn boundary and prepends older pages on demand", () =>
    Effect.gen(function* () {
      const { session, turns, older } = yield* makeHarness()
      yield* turns.setStatus(Turn.TurnId.make("active"), "completed", "done", 2)
      for (let index = 0; index < 240; index += 1) {
        const created = yield* createTurn(turns, {
          id: Turn.TurnId.make(`history-${index.toString().padStart(3, "0")}`),
          threadId: older.id,
          prompt: `history ${index}`,
          now: index + 10,
        })
        yield* turns.setStatus(created.id, "completed", undefined, index + 10)
      }
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* Effect.yieldNow
      const initial = events.find((event) => event._tag === "SelectionLoaded")
      yield* session.loadOlder
      yield* Effect.yieldNow
      expect(initial?._tag === "SelectionLoaded" ? initial.hasOlder : false).toBe(true)
      expect(initial?._tag === "SelectionLoaded" ? initial.entries : []).toHaveLength(200)
      expect(initial?._tag === "SelectionLoaded" ? initial.entries[0]?.unit.key : undefined).toBe(
        "turn:history-040:user",
      )
      expect(
        initial?._tag === "SelectionLoaded" ? initial.entries.map((entry) => entry.turn.id).at(-1) : undefined,
      ).toBe(Turn.TurnId.make("history-239"))
      const prepended = events.find((event) => event._tag === "TranscriptPagePrepended")
      expect(prepended?._tag === "TranscriptPagePrepended" ? prepended.hasOlder : true).toBe(false)
      expect(
        prepended?._tag === "TranscriptPagePrepended" ? prepended.entries.map((entry) => entry.turn.id) : [],
      ).toEqual([
        Turn.TurnId.make("active"),
        ...Array.from({ length: 40 }, (_, index) => Turn.TurnId.make(`history-${index.toString().padStart(3, "0")}`)),
      ])
    }),
  )

  it.effect("stops the initial semantic page at the nearest Turn boundary", () =>
    Effect.gen(function* () {
      const { session, turns, transcripts, older } = yield* makeHarness()
      yield* turns.setStatus(Turn.TurnId.make("active"), "completed", "done", 2)
      for (let turnIndex = 0; turnIndex < 5; turnIndex += 1) {
        const created = yield* createTurn(turns, {
          id: Turn.TurnId.make(`boundary-${turnIndex}`),
          threadId: older.id,
          prompt: `boundary ${turnIndex}`,
          now: turnIndex + 10,
        })
        const completed = yield* turns.setStatus(created.id, "completed", undefined, turnIndex + 10)
        const units: Array<Transcript.Unit> = [
          {
            key: `turn:${created.id}:user`,
            turnId: created.id,
            order: { sequence: 0, part: 0 },
            revision: 0,
            content: { _tag: "Entry", role: "user", text: created.prompt },
          },
          ...Array.from(
            { length: 72 },
            (_, index): Transcript.Unit => ({
              key: `${created.id}:assistant:${index.toString().padStart(2, "0")}`,
              turnId: created.id,
              order: { sequence: index + 1, part: 0 },
              revision: index + 1,
              content: { _tag: "Entry", role: "assistant", text: `${created.id} ${index}` },
            }),
          ),
        ]
        yield* transcripts.replace(completed, { ...Transcript.empty(created.id, created.prompt), units, revision: 72 })
      }
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* Effect.yieldNow

      const initial = events.find((event) => event._tag === "SelectionLoaded")
      const loaded = initial?._tag === "SelectionLoaded" ? initial.entries : []
      expect(loaded).toHaveLength(219)
      expect(loaded[0]?.unit.key).toBe("turn:boundary-2:user")
      expect(initial?._tag === "SelectionLoaded" ? initial.hasOlder : false).toBe(true)

      yield* session.loadOlder
      yield* Effect.yieldNow
      const prepended = events.find((event) => event._tag === "TranscriptPagePrepended")
      const olderEntries = prepended?._tag === "TranscriptPagePrepended" ? prepended.entries : []
      expect(olderEntries).toHaveLength(50)
      expect(olderEntries.at(-1)?.unit.key).not.toBe(loaded[0]?.unit.key)
      expect(new Set([...olderEntries, ...loaded].map((entry) => entry.unit.key)).size).toBe(
        olderEntries.length + loaded.length,
      )
    }),
  )

  it.effect("projects control failures instead of failing the session effect", () =>
    Effect.gen(function* () {
      const { session } = yield* makeHarness()
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread("missing", 1)
      yield* session.steer("nowhere")
      yield* session.editQueued("missing", "no")
      yield* Effect.yieldNow
      const failures = events.filter((event) => event._tag === "ExecutionFailed")
      expect(failures).toHaveLength(3)
      expect(failures[0]).toMatchObject({ message: expect.stringContaining("Thread missing does not exist") })
      expect(failures[1]).toMatchObject({ message: expect.stringContaining("No thread selected") })
      expect(failures[2]).toMatchObject({ message: expect.stringContaining("is not queued") })
    }),
  )
})

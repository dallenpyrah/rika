import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Runtime as ToolRuntime } from "@rika/tools"
import { Context, Deferred, Effect, Fiber, Layer, Ref } from "effect"
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
  it.effect("persists interrupt-and-send before cancelling the active turn", () =>
    Effect.gen(function* () {
      const { turns, controls, older } = yield* makeHarness()
      const persistedAtCancel = yield* Ref.make<Turn.Turn | undefined>(undefined)
      const checkingBackend = ExecutionBackend.Service.of({
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
            status: "completed" as const,
            events: [{ cursor: "replacement-done", sequence: 1, type: "execution.completed", createdAt: 4 }],
          }),
        replay: (turnId) => Effect.succeed({ turnId, status: "running", events: [] }),
        inspect: (turnId) => Effect.succeed({ turnId, status: "running", waits: [], pendingTools: [], children: [] }),
        steer: () => Effect.void,
        cancel: (turnId) =>
          turns.get(Turn.TurnId.make("pending")).pipe(
            Effect.orDie,
            Effect.flatMap((pending) => Ref.set(persistedAtCancel, pending)),
            Effect.as({ turnId, status: "cancelled" as const, events: [] }),
          ),
        listApprovals: () => Effect.succeed([]),
        resolveToolApproval: () => Effect.void,
        resolvePermission: () => Effect.void,
      })
      const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
      const layer = Operation.productLayer({
        repositoryLayer: ThreadRepository.memoryLayer([older]),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(ExecutionBackend.Service, checkingBackend),
        defaultWorkspace: "/work",
        makeThreadId: Effect.die("unused"),
        makeTurnId: Effect.succeed(Turn.TurnId.make("pending")),
        interactive: (_, value) =>
          Ref.update(sessions, (values) => [...values, value]).pipe(Effect.andThen(Effect.never)),
      })
      const context = yield* Layer.build(layer)
      const operation = Context.get(context, Operation.Service)
      yield* Effect.forkChild(operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }))
      yield* waitForSessions(sessions)
      const checkingSession = (yield* Ref.get(sessions))[0]
      if (checkingSession === undefined) return yield* Effect.die("Missing interactive session")
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(checkingSession, events)
      yield* checkingSession.selectThread(older.id, 1)
      yield* checkingSession.interruptAndSend("next prompt")
      yield* Effect.yieldNow
      expect(yield* Ref.get(persistedAtCancel)).toMatchObject({ prompt: "next prompt", status: "queued" })
      expect((yield* turns.get(Turn.TurnId.make("active")))?.status).toBe("cancelled")
      expect(yield* turns.get(Turn.TurnId.make("pending"))).toMatchObject({
        status: "completed",
        lastCursor: "replacement-done",
      })
      expect(events.filter((event) => event._tag === "QueueUpdated").map((event) => event.change._tag)).toEqual([
        "Added",
        "Removed",
      ])
      expect(yield* Ref.get(controls)).toEqual([])
    }),
  )

  it.effect("maps allow, deny, and always permission decisions", () =>
    Effect.gen(function* () {
      const { session, controls } = yield* makeHarness()
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread("older", 1)
      yield* Ref.set(controls, [])
      events.length = 0
      yield* session.resolvePermission("allow-wait", "permission", "allow")
      yield* session.resolvePermission("deny-wait", "permission", "deny")
      yield* session.resolvePermission("always-wait", "permission", "always")
      yield* Effect.yieldNow
      expect(yield* Ref.get(controls)).toEqual([
        ["permission", "allow-wait", "Approved", 0],
        ["permission", "deny-wait", "Denied", 0],
        ["permission", "always-wait", "Always", 0],
      ])
      const resolved = events.filter((event) => event._tag === "ExecutionControlled")
      expect(resolved).toHaveLength(3)
      expect(resolved.every((event) => event.action === "permission-resolved" && event.selectionEpoch === 1)).toBe(true)
    }),
  )

  it.effect("resolves pending tool approvals through the tool approval endpoint", () =>
    Effect.gen(function* () {
      const { session, controls } = yield* makeHarness(false, ["allow-tool", "always-tool", "deny-tool"])
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread("older", 1)
      yield* Ref.set(controls, [])
      yield* session.resolvePermission("allow-tool", "tool-approval", "allow")
      yield* session.resolvePermission("always-tool", "tool-approval", "always")
      yield* session.resolvePermission("deny-tool", "tool-approval", "deny")
      expect(yield* Ref.get(controls)).toEqual([
        ["tool-approval", "allow-tool", true, 0],
        ["tool-approval", "always-tool", true, 0],
        ["tool-approval", "deny-tool", false, 0],
      ])
    }),
  )

  it.effect("follows an approved durable permission through completion and drains the queue", () =>
    Effect.gen(function* () {
      const priorOutput = {
        cursor: "prior-output",
        sequence: 0,
        type: "model.output.completed",
        createdAt: 1,
        text: "work before permission",
      }
      const priorPermission = {
        cursor: "permission-wait",
        sequence: 1,
        type: "permission.ask.requested",
        createdAt: 1,
        data: { wait_id: "permission-wait", title: "Allow work" },
      }
      const { session, turns, controls, older } = yield* makeHarness(true, [], [priorOutput, priorPermission])
      yield* turns.setStatus(Turn.TurnId.make("active"), "waiting", "wait-cursor", 2)
      yield* createTurn(turns, {
        id: Turn.TurnId.make("queued-after-wait"),
        threadId: older.id,
        prompt: "queued prompt",
        now: 3,
      })
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* session.resolvePermission("permission-wait", "permission", "allow")
      yield* Effect.yieldNow
      expect(yield* Ref.get(controls)).toContainEqual(["follow", "active", "wait-cursor"])
      expect(yield* turns.get(Turn.TurnId.make("active"))).toMatchObject({
        status: "completed",
        lastCursor: "resumed-done",
      })
      expect(yield* turns.get(Turn.TurnId.make("queued-after-wait"))).toMatchObject({
        status: "completed",
        lastCursor: "queued-done",
      })
      expect(events).toContainEqual({
        _tag: "TranscriptPatched",
        selectionEpoch: 1,
        threadId: "older",
        turnId: "active",
        revision: expect.any(Number),
        event: expect.objectContaining({ type: "model.output.completed", text: "created file" }),
      })
      expect(events).toContainEqual({
        _tag: "TranscriptPatched",
        selectionEpoch: 1,
        threadId: "older",
        turnId: "active",
        revision: expect.any(Number),
        event: expect.objectContaining({ cursor: "resumed-done", type: "execution.completed" }),
      })
      events.length = 0
      yield* session.selectThread(older.id, 2)
      yield* Effect.yieldNow
      const page = events.find((event) => event._tag === "SelectionLoaded")
      expect(page?._tag === "SelectionLoaded" ? page.entries : []).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            unit: expect.objectContaining({
              content: expect.objectContaining({ _tag: "Entry", text: "work before permission" }),
            }),
          }),
          expect.objectContaining({
            unit: expect.objectContaining({
              content: expect.objectContaining({ _tag: "Entry", text: "created file" }),
            }),
          }),
        ]),
      )
    }),
  )

  it.effect("starts every queued turn exactly once after a waiting turn completes", () =>
    Effect.gen(function* () {
      const { session, turns, controls, older } = yield* makeHarness(true)
      const events: Array<Operation.InteractiveEvent> = []
      yield* turns.setStatus(Turn.TurnId.make("active"), "waiting", "wait-cursor", 2)
      for (const [index, id] of ["promoted-one", "promoted-two", "promoted-three"].entries())
        yield* createTurn(turns, {
          id: Turn.TurnId.make(id),
          threadId: older.id,
          prompt: id,
          now: 10 + index,
        })
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* session.resolvePermission("permission-wait", "permission", "allow")
      while (
        (yield* turns.get(Turn.TurnId.make("promoted-three")))?.status !== "completed" ||
        events.filter((event) => event._tag === "TurnStarted").length < 3
      )
        yield* Effect.yieldNow
      const calls = yield* Ref.get(controls)
      expect(calls.filter((call) => call[0] === "start")).toEqual([
        ["start", "promoted-one"],
        ["start", "promoted-two"],
        ["start", "promoted-three"],
      ])
      expect(calls.some((call) => call[0] === "follow" && String(call[1]).startsWith("promoted-"))).toBe(false)
      expect(
        events
          .filter((event) => event._tag === "TurnStarted")
          .map((event) => (event._tag === "TurnStarted" ? String(event.turn.id) : "")),
      ).toEqual(["promoted-one", "promoted-two", "promoted-three"])
    }),
  )

  it.effect(
    "persists approved shell output, keeps incognito output transient, denies execution, and queues while busy",
    () =>
      Effect.gen(function* () {
        const repositories = yield* ThreadRepository.makeMemory()
        const turns = yield* TurnRepository.makeMemory()
        const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
        const commands = yield* Ref.make<ReadonlyArray<string>>([])
        const permissionWorkspaces = yield* Ref.make<ReadonlyArray<string>>([])
        let turnNumber = 0
        const layer = Operation.productLayer({
          repositoryLayer: Layer.succeed(ThreadRepository.Service, repositories),
          turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
          backendLayer: Layer.succeed(
            ExecutionBackend.Service,
            ExecutionBackend.Service.of({
              invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
              createFanOut: () => Effect.die("unused"),
              inspectFanOut: () => Effect.die("unused"),
              cancelFanOut: () => Effect.die("unused"),
              registerWorkflows: () => Effect.die("unused"),
              startWorkflow: () => Effect.die("unused"),
              inspectWorkflow: () => Effect.die("unused"),
              cancelWorkflow: () => Effect.die("unused"),
              start: () => Effect.die("unused"),
              inspect: () => Effect.void.pipe(Effect.as(undefined)),
              replay: () => Effect.die("unused"),
              steer: () => Effect.die("unused"),
              cancel: () => Effect.die("unused"),
              listApprovals: () => Effect.succeed([]),
              resolveToolApproval: () => Effect.void,
              resolvePermission: () => Effect.die("unused"),
            }),
          ),
          toolRuntimeLayer: () =>
            ToolRuntime.testLayer((request) => {
              const command = request._tag === "Shell" ? request.args.join(" ") : request._tag
              return Ref.update(commands, (values) => [...values, command]).pipe(
                Effect.as({ text: `output:${command}`, truncated: false }),
              )
            }),
          defaultWorkspace: "/work",
          shellPermission: (workspace) =>
            Ref.update(permissionWorkspaces, (values) => [...values, workspace]).pipe(Effect.as("ask" as const)),
          makeThreadId: Effect.succeed(Thread.ThreadId.make("shell-thread")),
          makeTurnId: Effect.sync(() => Turn.TurnId.make(`shell-turn-${turnNumber++}`)),
          interactive: (_, session) =>
            Ref.update(sessions, (values) => [...values, session]).pipe(Effect.andThen(Effect.never)),
        })
        const context = yield* Layer.build(layer)
        const operation = Context.get(context, Operation.Service)
        yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false, workspace: "/client-shell" }),
        )
        yield* waitForSessions(sessions)
        expect(yield* Ref.get(permissionWorkspaces)).toContain("/client-shell")
        const session = (yield* Ref.get(sessions))[0]
        if (session === undefined) return yield* Effect.die("Missing interactive session")
        const allEvents: Array<Operation.InteractiveEvent> = []
        yield* collectEvents(session, allEvents)

        const runShell = Effect.fn("InteractiveSessionTest.runShell")(function* (
          command: string,
          incognito: boolean,
          decision: "allow" | "deny" | "always",
        ) {
          const first = allEvents.length
          const fiber = yield* Effect.forkChild(session.shell(command, incognito))
          while (!allEvents.slice(first).some((event) => event._tag === "ShellPermissionRequested"))
            yield* Effect.yieldNow
          const permission = allEvents.slice(first).find((event) => event._tag === "ShellPermissionRequested")
          if (permission?._tag !== "ShellPermissionRequested") return yield* Effect.die("Missing shell permission")
          yield* session.resolvePermission(permission.id, "permission", decision)
          yield* Fiber.join(fiber)
          yield* Effect.yieldNow
          return allEvents.slice(first)
        })

        const persisted = yield* runShell("printf persisted", false, "allow")
        expect(persisted.find((event) => event._tag === "ShellCompleted")).toMatchObject({ incognito: false })
        expect((yield* turns.list(Thread.ThreadId.make("shell-thread")))[0]).toMatchObject({
          prompt: expect.stringContaining("output:-lc printf persisted"),
          status: "completed",
        })

        const denied = yield* runShell("printf denied", false, "deny")
        expect(denied.find((event) => event._tag === "ExecutionFailed")).toMatchObject({
          message: "Shell command denied",
        })
        expect(yield* Ref.get(commands)).toEqual(["-lc printf persisted"])

        const beforeIncognito = (yield* turns.list(Thread.ThreadId.make("shell-thread"))).length
        const incognito = yield* runShell("printf secret", true, "always")
        expect(incognito.find((event) => event._tag === "ShellCompleted")).toMatchObject({ incognito: true })
        expect((yield* turns.list(Thread.ThreadId.make("shell-thread"))).length).toBe(beforeIncognito)
        expect(yield* Ref.get(commands)).toEqual(["-lc printf persisted", "-lc printf secret"])

        yield* turns.copy(
          {
            ...active(Thread.ThreadId.make("shell-thread"), "active-shell-blocker"),
            prompt: "active",
            createdAt: 2,
            updatedAt: 2,
          },
          128,
        )
        const queuedStart = allEvents.length
        yield* session.shell("printf queued", false)
        while (!allEvents.slice(queuedStart).some((event) => event._tag === "QueueUpdated")) yield* Effect.yieldNow
        const queued = allEvents.slice(queuedStart)
        expect(queued.some((event) => event._tag === "ShellPermissionRequested")).toBe(false)
        expect(queued.findLast((event) => event._tag === "QueueUpdated")).toMatchObject({
          change: { _tag: "Added", item: { prompt: expect.stringContaining("printf queued") } },
        })
        expect(
          (yield* turns.list(Thread.ThreadId.make("shell-thread"))).find((turn) =>
            turn.prompt.startsWith("$ printf queued"),
          ),
        ).toMatchObject({ status: "queued" })
      }),
  )

  it.effect("selects a thread, reopens the latest thread, and replays after the requested cursor", () =>
    Effect.gen(function* () {
      const { session, controls, older } = yield* makeHarness()
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* session.reopenThread(2)
      yield* session.replay("latest-active", "cursor-7")
      yield* Effect.yieldNow
      expect(events.find((event) => event._tag === "SelectionLoaded" && event.thread.id === "older")).toMatchObject({
        _tag: "SelectionLoaded",
        thread: { id: "older" },
        entries: [{ turn: { id: "active" } }],
      })
      expect(events.find((event) => event._tag === "SelectionLoaded" && event.thread.id === "latest")).toMatchObject({
        _tag: "SelectionLoaded",
        thread: { id: "latest" },
        entries: [{ turn: { id: "latest-active" } }],
      })
      expect(events.filter((event) => event._tag === "TranscriptPatched")).toEqual([])
      expect(yield* Ref.get(controls)).toEqual([
        ["replay", "active", undefined],
        ["replay", "latest-active", undefined],
        ["replay", "latest-active", "cursor-7"],
      ])
    }),
  )
})

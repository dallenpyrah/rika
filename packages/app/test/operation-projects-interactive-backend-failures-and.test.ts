import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Effect, Layer, Ref } from "effect"
import { TestConsole } from "effect/testing"
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

const nonActivation = (list: ReadonlyArray<Operation.InteractiveEvent>) =>
  list.filter((event) => event._tag !== "ThreadActivated")

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

describe("Operation", () => {
  it.effect("projects interactive backend failures and terminal failure statuses", () =>
    Effect.gen(function* () {
      const runCase = (status: "backend" | "failed" | "failed-event" | "cancelled") =>
        Effect.gen(function* () {
          const repository = yield* ThreadRepository.makeMemory()
          const turns = yield* TurnRepository.makeMemory()
          const events = yield* Ref.make<ReadonlyArray<Operation.InteractiveEvent>>([])
          const sessions = yield* Ref.make<ReadonlyArray<Operation.InteractiveSession>>([])
          const runSync = Effect.runSyncWith(yield* Effect.context<never>())
          const caseBackend = ExecutionBackend.Service.of({
            ...backend,
            start: (input) =>
              status === "backend"
                ? input.turnId === "turn-backend"
                  ? turns
                      .createForSubmission({
                        id: Turn.TurnId.make("successor-backend"),
                        threadId: Thread.ThreadId.make(input.threadId),
                        prompt: "queued successor",
                        executionRoute: executionRoute(),
                        queueCapacity: 128,
                        now: 1,
                      })
                      .pipe(
                        Effect.mapError((cause) => ExecutionBackend.BackendError.make({ message: cause.message })),
                        Effect.andThen(
                          Effect.fail(ExecutionBackend.BackendError.make({ message: "interactive backend failed" })),
                        ),
                      )
                  : backend.start(input)
                : Effect.succeed({
                    turnId: input.turnId,
                    status: status === "failed-event" ? ("failed" as const) : status,
                    events:
                      status === "failed-event"
                        ? [
                            {
                              cursor: "failure-cursor",
                              sequence: 1,
                              type: "execution.failed",
                              createdAt: 1,
                              text: "opaque provider failure",
                            },
                          ]
                        : [],
                  }),
          })
          yield* Effect.gen(function* () {
            const session = yield* openInteractiveSession(sessions, {
              _tag: "Interactive",
              prompt: [],
              ephemeral: false,
            })
            yield* Effect.forkChild(
              session.events((event) => runSync(Ref.update(events, (values) => [...values, event]))),
            )
            yield* Effect.yieldNow
            yield* session.submit("prompt")
            while (true) {
              const turn = yield* turns.get(Turn.TurnId.make(`turn-${status}`))
              if (turn !== undefined && ["completed", "failed", "cancelled"].includes(turn.status)) break
              yield* Effect.yieldNow
            }
            if (status === "backend")
              while ((yield* turns.get(Turn.TurnId.make("successor-backend")))?.status !== "completed")
                yield* Effect.yieldNow
            if (status === "backend")
              while (!(yield* Ref.get(events)).some((event) => event._tag === "ExecutionFailed")) yield* Effect.yieldNow
            if (status === "failed")
              while (!(yield* Ref.get(events)).some((event) => event._tag === "ExecutionFailed")) yield* Effect.yieldNow
            if (status === "failed-event")
              while (!(yield* Ref.get(events)).some((event) => event._tag === "TranscriptPatched"))
                yield* Effect.yieldNow
          }).pipe(
            provideLayer(
              Operation.productLayer({
                repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
                turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
                backendLayer: Layer.succeed(ExecutionBackend.Service, caseBackend),
                defaultWorkspace: "/work",
                makeThreadId: Effect.succeed(Thread.ThreadId.make(`thread-${status}`)),
                makeTurnId: Effect.succeed(Turn.TurnId.make(`turn-${status}`)),
                interactive: holdSession(sessions),
              }),
            ),
          )
          return {
            events: yield* Ref.get(events),
            turn: yield* turns.get(Turn.TurnId.make(`turn-${status}`)),
            successor: yield* turns.get(Turn.TurnId.make(`successor-${status}`)),
          }
        })
      const failedBackend = yield* runCase("backend")
      const failed = yield* runCase("failed")
      const failedEvent = yield* runCase("failed-event")
      const cancelled = yield* runCase("cancelled")
      const failedBackendEvent = nonActivation(failedBackend.events).find((event) => event._tag === "ExecutionFailed")
      expect(failedBackendEvent).toMatchObject({ _tag: "ExecutionFailed" })
      expect(failedBackendEvent?._tag === "ExecutionFailed" ? failedBackendEvent.message : undefined).toContain(
        "interactive backend failed",
      )
      expect(failedBackend.turn?.status).toBe("failed")
      expect(failedBackend.successor?.status).toBe("completed")
      expect(nonActivation(failed.events)).toContainEqual({
        _tag: "ExecutionFailed",
        selectionEpoch: 0,
        threadId: "thread-failed",
        turnId: "turn-failed",
        message: "Execution failed",
      })
      expect(nonActivation(failedEvent.events)).toContainEqual({
        _tag: "TranscriptPatched",
        selectionEpoch: 0,
        threadId: "thread-failed-event",
        turnId: "turn-failed-event",
        revision: 1,
        event: {
          cursor: "failure-cursor",
          sequence: 1,
          type: "execution.failed",
          createdAt: 1,
          text: "opaque provider failure",
        },
      })
      expect(nonActivation(failedEvent.events).some((event) => event._tag === "ExecutionFailed")).toBe(false)
      expect(nonActivation(cancelled.events).some((event) => event._tag === "ExecutionFailed")).toBe(false)
    }),
  )

  it.effect("runs a new thread and persists its terminal turn", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRepository.makeMemory()
      const turns = yield* TurnRepository.makeMemory()
      const starts = yield* Ref.make<ReadonlyArray<ExecutionBackend.StartInput>>([])
      const runningStatuses = yield* Ref.make<ReadonlyArray<Turn.Status>>([])
      const runBackend = ExecutionBackend.Service.of({
        ...backend,
        start: (input) =>
          Effect.gen(function* () {
            const turn = yield* turns.get(Turn.TurnId.make(input.turnId)).pipe(Effect.orDie)
            yield* Ref.update(starts, (inputs) => [...inputs, input])
            yield* Ref.update(runningStatuses, (statuses) =>
              turn === undefined ? statuses : [...statuses, turn.status],
            )
            return {
              turnId: input.turnId,
              status: "completed",
              events: [
                { cursor: "cursor-a", sequence: 1, type: "model.output.completed", createdAt: 1 },
                { cursor: "cursor-b", sequence: 2, type: "model.output.completed", createdAt: 2, text: "answer" },
                { cursor: "cursor-c", sequence: 3, type: "execution.completed", createdAt: 3 },
              ],
            }
          }),
      })
      const layer = Layer.mergeAll(
        TestConsole.layer,
        Operation.productLayer({
          repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
          turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
          backendLayer: Layer.succeed(ExecutionBackend.Service, runBackend),
          defaultWorkspace: "/default-workspace",
          makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-new")),
          makeTurnId: Effect.succeed(Turn.TurnId.make("turn-new")),
        }),
      )
      const output = yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({
          _tag: "Run",
          prompt: [],
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        })
        return yield* TestConsole.logLines
      }).pipe(provideLayer(layer))
      const thread = yield* repository.get(Thread.ThreadId.make("thread-new"))
      const turn = yield* turns.get(Turn.TurnId.make("turn-new"))
      expect(thread).toMatchObject({
        id: "thread-new",
        workspace: "/default-workspace",
        title: "New thread",
      })
      expect(yield* Ref.get(starts)).toMatchObject([
        { threadId: "thread-new", turnId: "turn-new", prompt: "", startedAt: 0 },
      ])
      expect(yield* Ref.get(runningStatuses)).toEqual(["running"])
      expect(turn).toMatchObject({
        id: "turn-new",
        threadId: "thread-new",
        prompt: "",
        status: "completed",
        lastCursor: "cursor-c",
      })
      expect(output.filter((line): line is string => typeof line === "string" && line === "answer")).toEqual(["answer"])
    }),
  )

  it.effect("reuses a requested thread and streams every event as JSON", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("thread-existing"),
        workspace: "/existing",
        title: "Existing",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const repository = yield* ThreadRepository.makeMemory([thread])
      const turns = yield* TurnRepository.makeMemory()
      const layer = Layer.mergeAll(
        TestConsole.layer,
        Operation.productLayer({
          repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
          turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
          backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.die("A reused thread must not create an id"),
          makeTurnId: Effect.succeed(Turn.TurnId.make("turn-existing")),
        }),
      )
      const output = yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({
          _tag: "Run",
          prompt: ["existing", "prompt"],
          threadId: "thread-existing",
          ephemeral: false,
          streamJson: true,
          streamJsonInput: false,
          streamJsonThinking: false,
        })
        return yield* TestConsole.logLines
      }).pipe(provideLayer(layer))
      const persisted = yield* repository.list({ includeArchived: true })
      const turn = yield* turns.get(Turn.TurnId.make("turn-existing"))
      expect(persisted).toEqual([thread])
      expect(turn).toMatchObject({ threadId: "thread-existing", prompt: "existing prompt", status: "completed" })
      expect(output.filter((line): line is string => typeof line === "string" && line.startsWith("{"))).toEqual([
        '{"cursor":"cursor-a","sequence":1,"type":"model.output.completed","createdAt":1,"text":"answer"}',
        '{"cursor":"cursor-b","sequence":2,"type":"execution.completed","createdAt":2}',
      ])
    }),
  )

  it.effect("maps a missing requested thread to OperationUnavailable", () =>
    Effect.gen(function* () {
      const operation = yield* Operation.Service
      const error = yield* Effect.flip(
        operation.run({
          _tag: "Run",
          prompt: ["hello"],
          threadId: "missing",
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        }),
      )
      expect(error).toMatchObject({
        _tag: "OperationUnavailable",
        operation: "Run",
      })
      expect(error.message).toContain("Thread missing does not exist")
    }).pipe(
      provideLayer(
        Operation.productLayer({
          repositoryLayer: ThreadRepository.memoryLayer(),
          turnRepositoryLayer: TurnRepository.memoryLayer(),
          backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-a")),
          makeTurnId: Effect.succeed(Turn.TurnId.make("turn-a")),
        }),
      ),
    ),
  )

  it.effect("rejects a missing initial interactive thread before opening the session", () =>
    Effect.gen(function* () {
      const operation = yield* Operation.Service
      const error = yield* Effect.flip(
        operation.run({
          _tag: "Interactive",
          prompt: [],
          threadId: "missing",
          ephemeral: false,
        }),
      )
      expect(error).toMatchObject({ _tag: "OperationUnavailable", operation: "Interactive" })
      expect(error.message).toContain("Thread missing does not exist")
    }).pipe(
      provideLayer(
        Operation.productLayer({
          repositoryLayer: ThreadRepository.memoryLayer(),
          turnRepositoryLayer: TurnRepository.memoryLayer(),
          backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
          defaultWorkspace: "/work",
          makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-a")),
          makeTurnId: Effect.succeed(Turn.TurnId.make("turn-a")),
          interactive: () => Effect.die("Missing thread must not open an interactive session"),
        }),
      ),
    ),
  )

  it.effect("does not start queued submissions", () =>
    Effect.gen(function* () {
      const thread: Thread.Thread = {
        id: Thread.ThreadId.make("thread-a"),
        workspace: "/work",
        title: "Busy",
        labels: [],
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
      }
      const repository = yield* ThreadRepository.makeMemory([thread])
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
      const starts = yield* Ref.make(0)
      const operationLayer = Operation.productLayer({
        repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
        turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
        backendLayer: Layer.succeed(
          ExecutionBackend.Service,
          ExecutionBackend.Service.of({
            ...backend,
            inspect: (turnId) =>
              Effect.succeed({ turnId, status: "running", waits: [], pendingTools: [], children: [] }),
            start: (input) => Ref.update(starts, (count) => count + 1).pipe(Effect.andThen(backend.start(input))),
          }),
        ),
        defaultWorkspace: "/work",
        makeThreadId: Effect.die("unused"),
        makeTurnId: Effect.succeed(Turn.TurnId.make("queued")),
      })
      yield* Effect.gen(function* () {
        const operation = yield* Operation.Service
        yield* operation.run({
          _tag: "Run",
          prompt: ["later"],
          threadId: "thread-a",
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        })
      }).pipe(provideLayer(operationLayer))
      expect(yield* Ref.get(starts)).toBe(0)
      expect((yield* turns.get(Turn.TurnId.make("queued")))?.status).toBe("queued")
    }),
  )

  it.effect("maps backend failures to OperationUnavailable", () =>
    Effect.gen(function* () {
      const operation = yield* Operation.Service
      const error = yield* Effect.flip(
        operation.run({
          _tag: "Run",
          prompt: ["hello"],
          ephemeral: false,
          streamJson: false,
          streamJsonInput: false,
          streamJsonThinking: false,
        }),
      )
      expect(error).toMatchObject({
        _tag: "OperationUnavailable",
        operation: "Run",
      })
      expect(error.message).toContain("backend failed")
    }).pipe(
      provideLayer(
        Operation.productLayer({
          repositoryLayer: ThreadRepository.memoryLayer(),
          turnRepositoryLayer: TurnRepository.memoryLayer(),
          backendLayer: Layer.succeed(
            ExecutionBackend.Service,
            ExecutionBackend.Service.of({
              ...backend,
              start: () => Effect.fail(ExecutionBackend.BackendError.make({ message: "backend failed" })),
            }),
          ),
          defaultWorkspace: "/work",
          makeThreadId: Effect.succeed(Thread.ThreadId.make("thread-a")),
          makeTurnId: Effect.succeed(Turn.TurnId.make("turn-a")),
        }),
      ),
    ),
  )
})

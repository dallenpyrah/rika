import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import * as Transcript from "@rika/transcript"
import { Context, Deferred, Effect, Fiber, Layer, Queue, Ref } from "effect"
import { Operation } from "../src/index"
import { executeInteractiveCommand } from "../src/operation-contract"

const baseBackend = ExecutionBackend.Service.of({
  invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
  createFanOut: () => Effect.die("unused"),
  inspectFanOut: () => Effect.die("unused"),
  cancelFanOut: () => Effect.die("unused"),
  registerWorkflows: () => Effect.die("unused"),
  startWorkflow: () => Effect.die("unused"),
  inspectWorkflow: () => Effect.die("unused"),
  cancelWorkflow: () => Effect.die("unused"),
  start: (input) => Effect.succeed({ turnId: input.turnId, status: "completed", events: [] }),
  replay: (turnId) => Effect.succeed({ turnId, status: "completed", events: [] }),
  cancel: (turnId) => Effect.succeed({ turnId, status: "cancelled", events: [] }),
  inspect: () => Effect.void.pipe(Effect.as(undefined)),
  steer: () => Effect.void,
  listApprovals: () => Effect.succeed([]),
  resolveToolApproval: () => Effect.void,
  resolvePermission: () => Effect.void,
})

const thread = (id: string): Thread.Thread => ({
  id: Thread.ThreadId.make(id),
  workspace: "/work",
  title: id,
  labels: [],
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
})

const interactiveLayer = (
  repository: ThreadRepository.Interface,
  turns: TurnRepository.Interface,
  backend: ExecutionBackend.Interface,
  registration: Deferred.Deferred<Operation.InteractiveSession>,
  makeThreadId: Effect.Effect<Thread.ThreadId> = Effect.die("unused"),
  makeTurnId: Effect.Effect<Turn.TurnId> = Effect.die("unused"),
  transcripts?: TranscriptRepository.Interface,
) =>
  Operation.productLayer({
    repositoryLayer: Layer.succeed(ThreadRepository.Service, repository),
    turnRepositoryLayer: Layer.succeed(TurnRepository.Service, turns),
    ...(transcripts === undefined
      ? {}
      : { transcriptRepositoryLayer: Layer.succeed(TranscriptRepository.Service, transcripts) }),
    backendLayer: Layer.succeed(ExecutionBackend.Service, backend),
    defaultWorkspace: "/work",
    makeThreadId,
    makeTurnId,
    interactive: (_, session) => Deferred.succeed(registration, session).pipe(Effect.andThen(Effect.never)),
  })

describe("interactive session extensions", () => {
  it.effect("replays a stale pricing checkpoint and allows its cost to decrease", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const selected = thread("priced")
        const repository = yield* ThreadRepository.makeMemory([selected])
        const target: Turn.Turn = {
          id: Turn.TurnId.make("turn-priced"),
          threadId: selected.id,
          prompt: "priced",
          executionRoute: Turn.testExecutionRoute(),
          status: "completed",
          createdAt: 1,
          updatedAt: 1,
        }
        const turns = yield* TurnRepository.makeMemory([target])
        const transcriptContext = yield* Layer.build(TranscriptRepository.memoryLayer)
        const transcripts = Context.get(transcriptContext, TranscriptRepository.Service)
        yield* transcripts.replace(target, { ...Transcript.empty(target.id, target.prompt), costUsd: 15 })
        const usage: ExecutionBackend.Event = {
          cursor: "corrected-usage",
          sequence: 1,
          type: "model.usage.reported",
          createdAt: 1,
          data: { cost_usd: 5 },
        }
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          inspect: (executionId) =>
            Effect.succeed(
              executionId === target.id
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
            Effect.succeed({ turnId: executionId, status: "completed" as const, events: [usage] }),
        })
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const context = yield* Layer.build(
          interactiveLayer(
            repository,
            turns,
            backend,
            registration,
            Effect.die("unused"),
            Effect.die("unused"),
            transcripts,
          ),
        )
        const operation = Context.get(context, Operation.Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events = yield* Queue.unbounded<Operation.InteractiveEvent>()
        const feed = yield* Effect.forkChild(session.events((event) => Queue.offerUnsafe(events, event)))

        yield* session.selectThread(selected.id, 1)
        let loaded = yield* Queue.take(events)
        while (loaded._tag !== "SelectionLoaded") loaded = yield* Queue.take(events)

        expect(loaded.threadCostUsd).toBe(5)
        expect(loaded.globalCostUsd).toBe(5)
        expect(yield* transcripts.get(target.id)).toMatchObject({
          costUsd: 5,
          pricingVersion: Transcript.pricingVersion,
        })

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("loads one thread with its child cost and the data-root global total", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = thread("first")
        const second = thread("second")
        const repository = yield* ThreadRepository.makeMemory([first, second])
        const turns = yield* TurnRepository.makeMemory([
          {
            id: Turn.TurnId.make("turn-first"),
            threadId: first.id,
            prompt: "first",
            executionRoute: Turn.testExecutionRoute(),
            status: "completed",
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: Turn.TurnId.make("turn-second"),
            threadId: second.id,
            prompt: "second",
            executionRoute: Turn.testExecutionRoute(),
            status: "completed",
            createdAt: 2,
            updatedAt: 2,
          },
        ])
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const executionEvents = new Map<string, ReadonlyArray<ExecutionBackend.Event>>([
          [
            "turn-first",
            [
              {
                cursor: "first-usage",
                sequence: 0,
                type: "model.usage.reported",
                createdAt: 1,
                data: { cost_usd: 1 },
              },
            ],
          ],
          [
            "turn-first-child",
            [
              {
                cursor: "first-child-usage",
                sequence: 0,
                type: "model.usage.reported",
                createdAt: 1,
                data: { cost_usd: 2 },
              },
            ],
          ],
          [
            "turn-second",
            [
              {
                cursor: "second-usage",
                sequence: 0,
                type: "model.usage.reported",
                createdAt: 2,
                data: { cost_usd: 4 },
              },
            ],
          ],
        ])
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          inspect: (executionId) =>
            Effect.succeed(
              executionEvents.has(executionId)
                ? {
                    turnId: executionId,
                    status: "completed" as const,
                    waits: [],
                    pendingTools: [],
                    children:
                      executionId === "turn-first"
                        ? [{ executionId: "turn-first-child", status: "completed" as const }]
                        : [],
                  }
                : undefined,
            ),
          replay: (executionId) =>
            Effect.succeed({
              turnId: executionId,
              status: "completed" as const,
              events: executionEvents.get(executionId) ?? [],
            }),
        })
        const context = yield* Layer.build(interactiveLayer(repository, turns, backend, registration))
        const operation = Context.get(context, Operation.Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events = yield* Queue.unbounded<Operation.InteractiveEvent>()
        const feed = yield* Effect.forkChild(session.events((event) => Queue.offerUnsafe(events, event)))

        yield* session.selectThread(first.id, 1)
        let loaded = yield* Queue.take(events)
        while (loaded._tag !== "SelectionLoaded") loaded = yield* Queue.take(events)

        expect(loaded.threadCostUsd).toBe(3)
        expect(loaded.globalCostUsd).toBe(7)
        expect(new Set(loaded.entries.map((entry) => entry.projectionCostUsd))).toEqual(new Set([3]))

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("attaches an inspected child with no projected parent tool under a synthesized subagent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const selected = thread("synth")
        const repository = yield* ThreadRepository.makeMemory([selected])
        const turns = yield* TurnRepository.makeMemory([
          {
            id: Turn.TurnId.make("turn-synth"),
            threadId: selected.id,
            prompt: "synth",
            executionRoute: Turn.testExecutionRoute(),
            status: "completed",
            createdAt: 1,
            updatedAt: 1,
          },
        ])
        const childId = "turn-synth-child"
        const rootEvents: ReadonlyArray<ExecutionBackend.Event> = [
          { cursor: "root-answer", sequence: 0, type: "model.output.completed", createdAt: 1, text: "Delegated." },
        ]
        const childEvents: ReadonlyArray<ExecutionBackend.Event> = [
          {
            cursor: "child-read",
            sequence: 0,
            type: "tool.call.requested",
            createdAt: 2,
            data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts" } },
          },
          {
            cursor: "child-answer",
            sequence: 1,
            type: "model.output.completed",
            createdAt: 3,
            text: "Child finished.",
          },
        ]
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          inspect: (executionId) =>
            Effect.succeed(
              executionId === "turn-synth"
                ? {
                    turnId: executionId,
                    status: "completed" as const,
                    waits: [],
                    pendingTools: [],
                    children: [{ executionId: childId, status: "completed" as const }],
                  }
                : executionId === childId
                  ? { turnId: executionId, status: "completed" as const, waits: [], pendingTools: [], children: [] }
                  : undefined,
            ),
          replay: (executionId) =>
            Effect.succeed({
              turnId: executionId,
              status: "completed" as const,
              events: executionId === "turn-synth" ? rootEvents : executionId === childId ? childEvents : [],
            }),
        })
        const context = yield* Layer.build(interactiveLayer(repository, turns, backend, registration))
        const operation = Context.get(context, Operation.Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events = yield* Queue.unbounded<Operation.InteractiveEvent>()
        const feed = yield* Effect.forkChild(session.events((event) => Queue.offerUnsafe(events, event)))

        yield* session.selectThread(selected.id, 1)
        let loaded = yield* Queue.take(events)
        while (loaded._tag !== "SelectionLoaded") loaded = yield* Queue.take(events)

        expect(
          loaded.entries.some(
            (entry) =>
              entry.unit.content._tag === "Block" &&
              entry.unit.content.block._tag === "ToolCall" &&
              entry.unit.content.block.id === childId,
          ),
        ).toBe(true)
        expect(
          loaded.entries.some(
            (entry) =>
              entry.unit.parentId === childId &&
              entry.unit.content._tag === "Block" &&
              entry.unit.content.block._tag === "ToolCall" &&
              entry.unit.content.block.id === `${childId}:read`,
          ),
        ).toBe(true)

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )

  it.effect("creates and adopts a fresh selected thread before the next submission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const previous = thread("previous")
        const repository = yield* ThreadRepository.makeMemory([previous])
        const turns = yield* TurnRepository.makeMemory([
          {
            id: Turn.TurnId.make("queued"),
            threadId: previous.id,
            prompt: "queued",
            executionRoute: Turn.testExecutionRoute(),
            status: "queued",
            createdAt: 1,
            updatedAt: 1,
          },
        ])
        const registration = yield* Deferred.make<Operation.InteractiveSession>()
        const starts = yield* Ref.make<ReadonlyArray<ExecutionBackend.StartInput>>([])
        const backend = ExecutionBackend.Service.of({
          ...baseBackend,
          start: (input) =>
            Ref.update(starts, (values) => [...values, input]).pipe(
              Effect.as({ turnId: input.turnId, status: "completed" as const, events: [] }),
            ),
        })
        const layer = interactiveLayer(
          repository,
          turns,
          backend,
          registration,
          Effect.succeed(Thread.ThreadId.make("fresh")),
          Effect.succeed(Turn.TurnId.make("fresh-turn")),
        )
        const context = yield* Layer.build(layer)
        const operation = Context.get(context, Operation.Service)
        const operationFiber = yield* Effect.forkChild(
          operation.run({ _tag: "Interactive", prompt: [], ephemeral: false }),
        )
        const session = yield* Deferred.await(registration)
        const events = yield* Queue.unbounded<Operation.InteractiveEvent>()
        const feed = yield* Effect.forkChild(session.events((event) => Queue.offerUnsafe(events, event)))

        yield* session.selectThread(previous.id, 4)
        let selected = yield* Queue.take(events)
        while (selected._tag !== "SelectionLoaded") selected = yield* Queue.take(events)
        yield* executeInteractiveCommand(session, { _tag: "NewThread" })
        let fresh = yield* Queue.take(events)
        while (fresh._tag !== "SelectionLoaded" || fresh.thread.id !== "fresh") fresh = yield* Queue.take(events)

        expect(fresh).toMatchObject({
          selectionEpoch: 5,
          thread: { id: "fresh", title: "New thread" },
          entries: [],
          hasOlder: false,
          threadCostUsd: 0,
          queueRevision: 0,
          queuedCount: 0,
          queue: [],
        })
        expect(yield* repository.get(Thread.ThreadId.make("fresh"))).toMatchObject({ title: "New thread" })

        yield* session.submit("lands here")
        while ((yield* Ref.get(starts)).length === 0) yield* Effect.yieldNow
        expect((yield* Ref.get(starts))[0]).toMatchObject({ threadId: "fresh", turnId: "fresh-turn" })
        expect(yield* turns.readQueue(previous.id)).toMatchObject({ queuedCount: 1 })
        expect(yield* turns.readQueue(Thread.ThreadId.make("fresh"))).toMatchObject({ queuedCount: 0, turns: [] })

        yield* Fiber.interrupt(feed)
        yield* Fiber.interrupt(operationFiber)
      }),
    ),
  )
})

import * as Thread from "../src/thread-schema"
import * as TurnRepository from "../src/turn-repository"
import * as Turn from "../src/turn-schema"
import { expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provide(context))
    })

type CurrentCreateInput = Omit<TurnRepository.CreateInput, "executionRoute" | "queueCapacity"> & {
  readonly executionRoute?: Turn.ExecutionRoutePin
  readonly queueCapacity?: number
}

const create = (repository: TurnRepository.Interface, input: CurrentCreateInput) =>
  repository.createForSubmission({
    executionRoute: Turn.testExecutionRoute(),
    ...input,
    queueCapacity: input.queueCapacity ?? 128,
  })

it.effect("memory queue revisions and wake generations stay atomic", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("thread-revisions")
    const active = yield* create(repository, {
      id: Turn.TurnId.make("active"),
      threadId,
      prompt: "active",
      now: 1,
    })
    const first = yield* create(repository, {
      id: Turn.TurnId.make("first"),
      threadId,
      prompt: "first",
      now: 2,
    })
    const second = yield* create(repository, {
      id: Turn.TurnId.make("second"),
      threadId,
      prompt: "second",
      now: 3,
    })
    expect(active.queue).toBeUndefined()
    expect(first.queue).toMatchObject({ revision: 1, queuedCount: 1, becameNonempty: true })
    expect(second.queue).toMatchObject({ revision: 2, queuedCount: 2, becameNonempty: false })
    expect(yield* repository.readQueue(threadId)).toMatchObject({ revision: 2, queuedCount: 2 })

    const wake = yield* repository.requestQueueWake(threadId)
    expect(wake).toEqual({ threadId, generation: 1, queueRevision: 2 })
    expect(yield* repository.requestQueueWake(threadId)).toEqual(wake)
    expect(yield* repository.consumeQueueWake(threadId, 2)).toBe(false)
    expect(yield* repository.consumeQueueWake(threadId, 1)).toBe(true)
    expect(yield* repository.consumeQueueWake(threadId, 1)).toBe(false)
    expect(yield* repository.requestQueueWake(threadId)).toEqual({ threadId, generation: 2, queueRevision: 2 })

    const edited = yield* repository.editQueued(first.id, "edited", 4)
    expect(edited.queue).toMatchObject({ revision: 3, queuedCount: 2, change: { _tag: "Updated" } })
    const removed = yield* repository.dequeue(second.id)
    expect(removed).toMatchObject({ revision: 4, queuedCount: 1, change: { _tag: "Removed", turnId: second.id } })
    expect(yield* repository.readQueue(threadId)).toMatchObject({ revision: 4, queuedCount: 1 })
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory atomically takes a queued turn and reports a typed promotion conflict", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("take-queued-thread")
    const active = yield* create(repository, {
      id: Turn.TurnId.make("take-active"),
      threadId,
      prompt: "active",
      now: 1,
    })
    const queued = yield* create(repository, {
      id: Turn.TurnId.make("take-queued"),
      threadId,
      prompt: "queued",
      now: 2,
    })
    const taken = yield* repository.takeQueued(queued.id)
    expect(taken).toMatchObject({
      turn: { id: queued.id, prompt: "queued" },
      queue: { revision: 2, queuedCount: 0, change: { _tag: "Removed", turnId: queued.id } },
    })
    expect(yield* repository.get(queued.id)).toBeUndefined()
    const conflict = yield* Effect.result(repository.takeQueued(active.id))
    expect(conflict).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "QueuedTurnUnavailable",
        turnId: active.id,
        message: `Turn ${active.id} is not queued`,
      },
    })
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory copies exact queue status and requeues an unowned accepted claim", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("copy-thread")
    const copied = yield* repository.copy(
      {
        id: Turn.TurnId.make("copied-queued"),
        threadId,
        prompt: "copied",
        executionRoute: Turn.testExecutionRoute(),
        status: "queued",
        createdAt: 1,
        updatedAt: 1,
      },
      1,
    )
    expect(copied).toMatchObject({ status: "queued", queue: { revision: 1, queuedCount: 1 } })
    const overflow = yield* Effect.result(
      repository.copy(
        {
          id: Turn.TurnId.make("copied-overflow"),
          threadId,
          prompt: "overflow",
          executionRoute: Turn.testExecutionRoute(),
          status: "queued",
          createdAt: 2,
          updatedAt: 2,
        },
        1,
      ),
    )
    expect(overflow).toMatchObject({ _tag: "Failure", failure: { _tag: "TurnQueueFull", count: 1 } })

    const acceptedThread = Thread.ThreadId.make("requeue-thread")
    const accepted = yield* create(repository, {
      id: Turn.TurnId.make("requeue-accepted"),
      threadId: acceptedThread,
      prompt: "accepted",
      now: 3,
    })
    const requeued = yield* repository.requeueAccepted(accepted.id, 1, 4)
    expect(requeued).toMatchObject({ status: "queued", queue: { revision: 1, queuedCount: 1 } })
    expect((yield* repository.claimNextQueued(acceptedThread, 5))?.turn.id).toBe(accepted.id)
    expect(yield* repository.readQueue(acceptedThread)).toMatchObject({ revision: 1, queuedCount: 1 })
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory rejects concurrent submissions beyond queue capacity without changing queue state", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("bounded-thread")
    const active = yield* create(repository, {
      id: Turn.TurnId.make("active"),
      threadId,
      prompt: "active",
      queueCapacity: 3,
      now: 1,
    })
    const submissions = yield* Effect.forEach(
      Array.from({ length: 10 }, (_, index) => index),
      (index) =>
        Effect.result(
          create(repository, {
            id: Turn.TurnId.make(`queued-${index}`),
            threadId,
            prompt: `queued ${index}`,
            queueCapacity: 3,
            now: index + 2,
          }),
        ),
      { concurrency: "unbounded" },
    )
    const failures = submissions.filter((result) => result._tag === "Failure")
    expect(failures).toHaveLength(7)
    for (const result of failures)
      expect(result._tag === "Failure" ? result.failure : undefined).toEqual(
        TurnRepository.QueueFull.make({ threadId, capacity: 3, count: 3 }),
      )
    expect(yield* repository.readQueue(threadId)).toMatchObject({ revision: 3, queuedCount: 3 })
    expect((yield* repository.list(threadId)).length).toBe(4)

    const removed = (yield* repository.readQueue(threadId)).turns[0]
    if (removed === undefined) return yield* Effect.die("Missing queued turn")
    yield* repository.dequeue(removed.id)
    const replacement = yield* create(repository, {
      id: Turn.TurnId.make("replacement"),
      threadId,
      prompt: "replacement",
      queueCapacity: 3,
      now: 20,
    })
    expect(replacement.queue).toMatchObject({ revision: 5, queuedCount: 3 })
    expect(yield* repository.claimNextQueued(threadId, 21)).toBeUndefined()
    yield* repository.setStatus(active.id, "completed", undefined, 22)
    expect((yield* repository.claimNextQueued(threadId, 23))?.turn.id).not.toBe(replacement.id)
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory lists nonterminal turns and rejects a missing extension pin", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("thread-a")
    expect((yield* repository.listNonterminal).map((turn) => turn.id)).toEqual([
      Turn.TurnId.make("b"),
      Turn.TurnId.make("a"),
    ])
    expect((yield* repository.findActive(threadId))?.id).toBe(Turn.TurnId.make("b"))
    expect(
      (yield* Effect.result(
        repository.setExtensionPin(Turn.TurnId.make("missing"), {
          generation: "g",
          sourceDigest: "s",
          configFingerprint: "c",
          toolSchemaDigest: "t",
          mcpFingerprint: "m",
          resolvedContextDigest: "r",
        }),
      ))._tag,
    ).toBe("Failure")
  }).pipe(
    provideLayer(
      TurnRepository.memoryLayer([
        {
          id: Turn.TurnId.make("b"),
          threadId: Thread.ThreadId.make("thread-a"),
          prompt: "b",
          executionRoute: Turn.testExecutionRoute(),
          status: "waiting",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: Turn.TurnId.make("a"),
          threadId: Thread.ThreadId.make("thread-a"),
          prompt: "a",
          executionRoute: Turn.testExecutionRoute(),
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    ),
  ),
)

it.effect("memory edits and dequeues only queued turns", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("thread-a")
    const active = yield* create(repository, {
      id: Turn.TurnId.make("active"),
      threadId,
      prompt: "active",
      now: 1,
    })
    const queued = yield* create(repository, {
      id: Turn.TurnId.make("queued"),
      threadId,
      prompt: "before",
      now: 2,
    })
    expect(yield* repository.editQueued(queued.id, "after", 3)).toMatchObject({ prompt: "after", updatedAt: 3 })
    expect((yield* Effect.result(repository.editQueued(active.id, "invalid", 4)))._tag).toBe("Failure")
    expect((yield* Effect.result(repository.dequeue(active.id)))._tag).toBe("Failure")
    yield* repository.dequeue(queued.id)
    expect(yield* repository.get(queued.id)).toBeUndefined()
    expect((yield* Effect.result(repository.dequeue(queued.id)))._tag).toBe("Failure")
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory editQueued replaces content and clears stale prompt parts", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("thread-edit")
    yield* create(repository, { id: Turn.TurnId.make("active"), threadId, prompt: "active", now: 1 })
    const queued = yield* create(repository, {
      id: Turn.TurnId.make("queued"),
      threadId,
      prompt: "old",
      promptParts: [{ type: "text", text: "old" }],
      now: 2,
    })
    yield* repository.editQueued(queued.id, "edited", 3)
    const stored = yield* repository.get(queued.id)
    expect(stored?.prompt).toBe("edited")
    expect(stored?.promptParts).toBeUndefined()
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory setStatus forbids transitions into or out of queued", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const threadId = Thread.ThreadId.make("thread-guard")
    const active = yield* create(repository, { id: Turn.TurnId.make("active"), threadId, prompt: "active", now: 1 })
    const queued = yield* create(repository, { id: Turn.TurnId.make("queued"), threadId, prompt: "queued", now: 2 })
    expect((yield* Effect.result(repository.setStatus(active.id, "queued", undefined, 3)))._tag).toBe("Failure")
    const before = yield* repository.readQueue(threadId)
    expect(before.queuedCount).toBe(1)
    expect((yield* Effect.result(repository.setStatus(queued.id, "completed", undefined, 4)))._tag).toBe("Failure")
    const after = yield* repository.readQueue(threadId)
    expect(after).toEqual(before)
    expect((yield* repository.get(queued.id))?.status).toBe("queued")
  }).pipe(provideLayer(TurnRepository.memoryLayer())),
)

it.effect("memory seeds queue revision to match the seeded queued count", () =>
  Effect.gen(function* () {
    const repository = yield* TurnRepository.Service
    const snapshot = yield* repository.readQueue(Thread.ThreadId.make("thread-seed"))
    expect(snapshot.queuedCount).toBe(2)
    expect(snapshot.revision).toBe(2)
  }).pipe(
    provideLayer(
      TurnRepository.memoryLayer([
        {
          id: Turn.TurnId.make("s1"),
          threadId: Thread.ThreadId.make("thread-seed"),
          prompt: "one",
          status: "queued",
          executionRoute: Turn.testExecutionRoute(),
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: Turn.TurnId.make("s2"),
          threadId: Thread.ThreadId.make("thread-seed"),
          prompt: "two",
          status: "queued",
          executionRoute: Turn.testExecutionRoute(),
          createdAt: 2,
          updatedAt: 2,
        },
      ]),
    ),
  ),
)

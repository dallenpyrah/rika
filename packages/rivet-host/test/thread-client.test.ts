import { describe, expect, test } from "bun:test"
import { Action as RivetAction, Actor as RivetActor, Client as RivetClient, RivetError } from "@rivetkit/effect"
import { Common, Event, Ids } from "@rika/schema"
import { Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as RivetkitErrors from "rivetkit/errors"
import { ThreadActor, ThreadClient } from "../src/index"

const threadId = Ids.ThreadId.make("thread_client_test")
const forkThreadId = Ids.ThreadId.make("thread_client_fork_test")

describe("ThreadClient", () => {
  test("preserves non-retryable Rivet errors in the client error channel", async () => {
    const error = RivetError.fromUnknown(new RivetkitErrors.RivetError("actor", "not_found", "actor not found"))
    const exit = await Effect.runPromise(
      ThreadClient.getSnapshot({ thread_id: threadId }).pipe(
        Effect.exit,
        Effect.provide(ThreadClient.layer.pipe(Layer.provide(fakeClientLayer(() => Effect.fail(error))))),
      ),
    )

    expect(errorFromExit(exit)).toBe(error)
  })

  test("retries retryable Rivet errors before returning the snapshot", async () => {
    const retryable = RivetError.fromUnknown(new RivetkitErrors.RivetError("actor", "restarting", "restarting"))
    let attempts = 0
    const exit = await Effect.runPromise(
      ThreadClient.getSnapshot({ thread_id: threadId }).pipe(
        Effect.exit,
        Effect.provide(
          ThreadClient.layer.pipe(
            Layer.provide(
              fakeClientLayer(() => {
                attempts += 1
                return attempts === 1 ? Effect.fail(retryable) : Effect.succeed(snapshot())
              }),
            ),
          ),
        ),
      ),
    )

    expect(exit._tag).toBe("Success")
    expect(attempts).toBe(2)
  })

  test("keeps ordinary retryable Rivet errors on the short retry budget", async () => {
    const retryable = RivetError.fromUnknown(new RivetkitErrors.RivetError("actor", "restarting", "restarting"))
    let attempts = 0
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* ThreadClient.getSnapshot({ thread_id: threadId }).pipe(
            Effect.exit,
            Effect.provide(
              ThreadClient.layer.pipe(
                Layer.provide(
                  fakeClientLayer(() => {
                    attempts += 1
                    return Effect.fail(retryable)
                  }),
                ),
              ),
            ),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Effect.yieldNow
          expect(attempts).toBe(1)
          yield* TestClock.adjust("50 millis")
          yield* Effect.yieldNow
          expect(attempts).toBe(2)
          yield* TestClock.adjust("100 millis")
          yield* Effect.yieldNow
          expect(attempts).toBe(3)
          yield* TestClock.adjust("200 millis")
          return yield* Fiber.join(fiber)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(errorFromExit(exit)).toBe(retryable)
    expect(attempts).toBe(4)
  })

  test("retries Rivet no_envoys startup errors before returning the snapshot", async () => {
    const noEnvoys = RivetError.fromUnknown(
      new RivetkitErrors.RivetError("guard", "actor_runner_failed", "Actor failed to start", {
        metadata: { actorId: "actor_thread_client_test", details: "no_envoys" },
      }),
    )
    let attempts = 0
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* ThreadClient.getSnapshot({ thread_id: threadId }).pipe(
            Effect.exit,
            Effect.provide(
              ThreadClient.layer.pipe(
                Layer.provide(
                  fakeClientLayer(() => {
                    attempts += 1
                    return attempts < 5 ? Effect.fail(noEnvoys) : Effect.succeed(snapshot())
                  }),
                ),
              ),
            ),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Effect.yieldNow
          expect(attempts).toBe(1)
          yield* TestClock.adjust("500 millis")
          yield* Effect.yieldNow
          expect(attempts).toBe(2)
          yield* TestClock.adjust("500 millis")
          yield* Effect.yieldNow
          expect(attempts).toBe(3)
          yield* TestClock.adjust("500 millis")
          yield* Effect.yieldNow
          expect(attempts).toBe(4)
          yield* TestClock.adjust("500 millis")
          return yield* Fiber.join(fiber)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(exit._tag).toBe("Success")
    expect(attempts).toBe(5)
  })

  test("bounds persistent Rivet no_envoys startup retries", async () => {
    const noEnvoys = RivetError.fromUnknown(
      new RivetkitErrors.RivetError("guard", "actor_runner_failed", "Actor failed to start", {
        metadata: { actorId: "actor_thread_client_test", details: "no_envoys" },
      }),
    )
    let attempts = 0
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* ThreadClient.getSnapshot({ thread_id: threadId }).pipe(
            Effect.exit,
            Effect.provide(
              ThreadClient.layer.pipe(
                Layer.provide(
                  fakeClientLayer(() => {
                    attempts += 1
                    return Effect.fail(noEnvoys)
                  }),
                ),
              ),
            ),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* TestClock.adjust("60 seconds")
          return yield* Fiber.join(fiber)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(errorFromExit(exit)).toBe(noEnvoys)
    expect(attempts).toBe(121)
  })

  test("uses an explicit import identity without fabricating source identity", async () => {
    const importIdentity = {
      _tag: "VerifiedUserIdentity" as const,
      user_id: Ids.UserId.make("thread_client_import_user"),
    }
    let imported: ThreadActor.ImportForkThreadPayload | undefined
    const exit = await Effect.runPromise(
      ThreadClient.forkThread({
        thread_id: threadId,
        fork_thread_id: forkThreadId,
        import_identity: importIdentity,
      }).pipe(
        Effect.exit,
        Effect.provide(
          ThreadClient.layer.pipe(
            Layer.provide(
              fakeClientLayerWithHandlers({
                prepareFork: (payload) => {
                  expect(payload.identity).toBeUndefined()
                  return Effect.succeed([])
                },
                importFork: (payload) => {
                  imported = payload
                  return Effect.succeed(snapshot(payload.thread_id))
                },
              }),
            ),
          ),
        ),
      ),
    )

    expect(exit._tag).toBe("Success")
    expect(imported).toMatchObject({ thread_id: forkThreadId, identity: importIdentity })
  })

  test("passes the verified fork identity to the import action", async () => {
    const identity = { _tag: "VerifiedUserIdentity" as const, user_id: Ids.UserId.make("thread_client_user") }
    let imported: ThreadActor.ImportForkThreadPayload | undefined
    const exit = await Effect.runPromise(
      ThreadClient.forkThread({
        thread_id: threadId,
        fork_thread_id: forkThreadId,
        identity,
        import_identity: identity,
      }).pipe(
        Effect.exit,
        Effect.provide(
          ThreadClient.layer.pipe(
            Layer.provide(
              fakeClientLayerWithHandlers({
                prepareFork: (payload) => {
                  expect(payload.identity).toEqual(identity)
                  return Effect.succeed([])
                },
                importFork: (payload) => {
                  imported = payload
                  return Effect.succeed(snapshot(payload.thread_id))
                },
              }),
            ),
          ),
        ),
      ),
    )

    expect(exit._tag).toBe("Success")
    expect(imported).toMatchObject({ thread_id: forkThreadId, identity })
  })

  test("appends mirrored events through the ThreadActor append action", async () => {
    const inputEvents = [event(7)]
    const result = { inserted_events: [event(7)], skipped_count: 0 }
    let appended: ThreadActor.AppendMirroredEventsPayload | undefined
    const exit = await Effect.runPromise(
      ThreadClient.appendMirroredEvents({ thread_id: threadId, events: inputEvents }).pipe(
        Effect.exit,
        Effect.provide(
          ThreadClient.layer.pipe(
            Layer.provide(
              fakeClientLayerWithHandlers({
                appendMirroredEvents: (payload) => {
                  appended = payload
                  return Effect.succeed(result)
                },
              }),
            ),
          ),
        ),
      ),
    )

    expect(exit._tag).toBe("Success")
    expect(appended).toEqual({ thread_id: threadId, events: inputEvents })
    expect(exit._tag === "Success" ? exit.value : undefined).toEqual(result)
  })

  test("uses typed catch-up so live signals cannot outrun replay order", async () => {
    const replayed = event(1)
    const live = event(2)
    let disposed = false
    const getEventsInputs: Array<ThreadActor.GetEventsPayload> = []
    const layer = ThreadClient.layer.pipe(
      Layer.provideMerge(
        fakeClientLayerWithHandlers({
          getEvents: (payload) => {
            getEventsInputs.push(payload)
            return Effect.succeed(
              [replayed, live].filter((current) => current.sequence > (payload.after_sequence ?? 0)),
            )
          },
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(
          ThreadClient.LiveConnection,
          ThreadClient.LiveConnection.of({
            subscribe: () =>
              Stream.make(undefined).pipe(
                Stream.ensuring(
                  Effect.sync(() => {
                    disposed = true
                  }),
                ),
              ),
          }),
        ),
      ),
    )

    const collected = await Effect.runPromise(
      ThreadClient.subscribeEvents({ thread_id: threadId, after_sequence: 0 }).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.provide(layer),
      ),
    )

    expect(collected.map((current) => current.sequence)).toEqual([1, 2])
    expect(getEventsInputs).toEqual([{ thread_id: threadId, after_sequence: 0 }])
    expect(disposed).toBe(true)
  })

  test("runs typed catch-up from the last emitted sequence on later live signals", async () => {
    const first = event(1)
    const second = event(2)
    let visibleEvents: ReadonlyArray<Event.Event> = [first]
    let disposed = false
    const getEventsInputs: Array<ThreadActor.GetEventsPayload> = []
    const layer = ThreadClient.layer.pipe(
      Layer.provideMerge(
        fakeClientLayerWithHandlers({
          getEvents: (payload) => {
            getEventsInputs.push(payload)
            const result = visibleEvents.filter((current) => current.sequence > (payload.after_sequence ?? 0))
            visibleEvents = [first, second]
            return Effect.succeed(result)
          },
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(
          ThreadClient.LiveConnection,
          ThreadClient.LiveConnection.of({
            subscribe: () =>
              Stream.make(undefined, undefined).pipe(
                Stream.ensuring(
                  Effect.sync(() => {
                    disposed = true
                  }),
                ),
              ),
          }),
        ),
      ),
    )

    const collected = await Effect.runPromise(
      ThreadClient.subscribeEvents({ thread_id: threadId, after_sequence: 0 }).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.provide(layer),
      ),
    )

    expect(collected.map((current) => current.sequence)).toEqual([1, 2])
    expect(getEventsInputs).toEqual([
      { thread_id: threadId, after_sequence: 0 },
      { thread_id: threadId, after_sequence: 1 },
    ])
    expect(disposed).toBe(true)
  })

  test("polls typed catch-up when a live broadcast signal is missed", async () => {
    const first = event(1)
    const second = event(2)
    let calls = 0
    const getEventsInputs: Array<ThreadActor.GetEventsPayload> = []
    const layer = ThreadClient.layer.pipe(
      Layer.provideMerge(
        fakeClientLayerWithHandlers({
          getEvents: (payload) => {
            calls += 1
            getEventsInputs.push(payload)
            const visible = calls === 1 ? [first] : [first, second]
            return Effect.succeed(visible.filter((current) => current.sequence > (payload.after_sequence ?? 0)))
          },
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(
          ThreadClient.LiveConnection,
          ThreadClient.LiveConnection.of({
            subscribe: () => Stream.make(undefined),
          }),
        ),
      ),
    )

    const collected = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* ThreadClient.subscribeEvents({ thread_id: threadId, after_sequence: 0 }).pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.provide(layer),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Effect.yieldNow
          yield* TestClock.adjust("500 millis")
          return yield* Fiber.join(fiber)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(collected.map((current) => current.sequence)).toEqual([1, 2])
    expect(getEventsInputs).toEqual([
      { thread_id: threadId, after_sequence: 0 },
      { thread_id: threadId, after_sequence: 1 },
    ])
  })

  test("fails subscribeEvents instead of silently polling when the live connection is missing", async () => {
    let getEventsCalls = 0
    const exit = await Effect.runPromise(
      ThreadClient.subscribeEvents({ thread_id: threadId, after_sequence: 0 }).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.exit,
        Effect.provide(
          ThreadClient.layer.pipe(
            Layer.provideMerge(
              fakeClientLayerWithHandlers({
                getEvents: () => {
                  getEventsCalls += 1
                  return Effect.succeed([event(1)])
                },
              }),
            ),
          ),
        ),
      ),
    )

    expect(exit._tag).toBe("Failure")
    expect(getEventsCalls).toBe(0)
  })

  test("fails the subscription from the typed catch-up error before emitting events", async () => {
    const error = RivetError.fromUnknown(new RivetkitErrors.RivetError("actor", "unauthorized", "unauthorized"))
    let disposed = false
    const exit = await Effect.runPromise(
      ThreadClient.subscribeEvents({ thread_id: threadId, after_sequence: 0 }).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.exit,
        Effect.provide(
          ThreadClient.layer.pipe(
            Layer.provideMerge(
              fakeClientLayerWithHandlers({
                getEvents: () => Effect.fail(error),
              }),
            ),
            Layer.provideMerge(
              Layer.succeed(
                ThreadClient.LiveConnection,
                ThreadClient.LiveConnection.of({
                  subscribe: () =>
                    Stream.make(undefined).pipe(
                      Stream.ensuring(
                        Effect.sync(() => {
                          disposed = true
                        }),
                      ),
                    ),
                }),
              ),
            ),
          ),
        ),
      ),
    )

    expect(errorFromExit(exit)).toBe(error)
    expect(disposed).toBe(true)
  })

  test("disposes the raw live connection when readiness fails before subscription acquisition completes", async () => {
    const readinessFailure = new Error("ready failed")
    const failedReady = Promise.reject(readinessFailure)
    failedReady.catch(() => undefined)
    const cleanup = {
      event: 0,
      open: 0,
      error: 0,
      dispose: 0,
    }
    const rawClient = {
      getOrCreate: () => ({
        connect: () => ({
          ready: failedReady,
          on: () => {
            return () => {
              cleanup.event += 1
            }
          },
          onOpen: () => {
            return () => {
              cleanup.open += 1
            }
          },
          onError: () => {
            return () => {
              cleanup.error += 1
            }
          },
          dispose: async () => {
            cleanup.dispose += 1
          },
        }),
      }),
    }
    const exit = await Effect.runPromise(
      ThreadClient.subscribeEvents({ thread_id: threadId, after_sequence: 0 }).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.exit,
        Effect.provide(
          ThreadClient.layer.pipe(
            Layer.provideMerge(fakeClientLayerWithHandlers({ getEvents: () => Effect.succeed([]) })),
            Layer.provideMerge(ThreadClient.liveConnectionLayerFromClient(rawClient)),
          ),
        ),
      ),
    )

    expect(exit._tag).toBe("Failure")
    expect(cleanup).toEqual({ event: 1, open: 1, error: 1, dispose: 1 })
  })
})

const fakeClientLayer = (
  getSnapshot: (
    payload: ThreadActor.ThreadIdPayload,
  ) => Effect.Effect<ThreadActor.ThreadActorSnapshot, ThreadClient.RunError>,
) => fakeClientLayerWithHandlers({ getSnapshot })

interface FakeClientHandlers {
  readonly getSnapshot?: (
    payload: ThreadActor.ThreadIdPayload,
  ) => Effect.Effect<ThreadActor.ThreadActorSnapshot, ThreadClient.RunError>
  readonly prepareFork?: (
    payload: ThreadActor.PrepareForkThreadPayload,
  ) => Effect.Effect<ReadonlyArray<Event.Event>, ThreadClient.RunError>
  readonly importFork?: (
    payload: ThreadActor.ImportForkThreadPayload,
  ) => Effect.Effect<ThreadActor.ThreadActorSnapshot, ThreadClient.RunError>
  readonly getEvents?: (
    payload: ThreadActor.GetEventsPayload,
  ) => Effect.Effect<ReadonlyArray<Event.Event>, ThreadClient.RunError>
  readonly appendMirroredEvents?: (
    payload: ThreadActor.AppendMirroredEventsPayload,
  ) => Effect.Effect<ThreadActor.AppendMirroredEventsResult, ThreadClient.RunError>
}

const fakeClientLayerWithHandlers = (handlers: FakeClientHandlers) =>
  Layer.succeed(
    RivetClient.Client,
    RivetClient.Client.of({
      "~@rivetkit/effect/Client": "~@rivetkit/effect/Client",
      makeActorAccessor: <Actions extends RivetAction.AnyWithProps>() => fakeAccessor<Actions>(handlers),
    }),
  )

const fakeAccessor = <Actions extends RivetAction.AnyWithProps>(
  handlers: FakeClientHandlers,
): RivetActor.Accessor<Actions> => ({
  getOrCreate: () => {
    const handle: RivetActor.Handle<Actions> = new Proxy(Object.create(null), {
      get: (_target, property) => {
        if (property === "GetSnapshot")
          return (payload: ThreadActor.ThreadIdPayload) =>
            Effect.suspend(() => (handlers.getSnapshot ?? (() => Effect.succeed(snapshot())))(payload))
        if (property === "PrepareForkThread")
          return (payload: ThreadActor.PrepareForkThreadPayload) =>
            Effect.suspend(() => (handlers.prepareFork ?? (() => Effect.succeed([])))(payload))
        if (property === "ImportForkThread")
          return (payload: ThreadActor.ImportForkThreadPayload) =>
            Effect.suspend(() => (handlers.importFork ?? (() => Effect.succeed(snapshot())))(payload))
        if (property === "GetEvents")
          return (payload: ThreadActor.GetEventsPayload) =>
            Effect.suspend(() => (handlers.getEvents ?? (() => Effect.succeed([])))(payload))
        if (property === "AppendMirroredEvents")
          return (payload: ThreadActor.AppendMirroredEventsPayload) =>
            Effect.suspend(() =>
              (handlers.appendMirroredEvents ?? (() => Effect.succeed({ inserted_events: [], skipped_count: 0 })))(
                payload,
              ),
            )
        return () => Effect.succeed(snapshot())
      },
    })
    return handle
  },
})

const errorFromExit = <A, E>(exit: Exit.Exit<A, E>) => Option.getOrUndefined(Exit.findErrorOption(exit))

const snapshot = (targetThreadId: Ids.ThreadId = threadId): ThreadActor.ThreadActorSnapshot => ({
  thread_id: targetThreadId,
  last_sequence: 1,
  message_count: 0,
  archived: false,
  visibility: "private",
  active_turn_status: "idle",
})

const event = (sequence: number): Event.Event => ({
  type: "thread.created",
  id: Ids.EventId.make(`thread_client_event_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: Common.TimestampMillis.make(sequence),
  data: {
    workspace_id: Ids.WorkspaceId.make("thread_client_workspace"),
    title_text: "Thread client test",
  },
})

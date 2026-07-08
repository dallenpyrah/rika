import { Cause, Context, Duration, Effect, Layer, Option, Queue, Stream } from "effect"
import { Client as RivetClient, RivetError } from "@rivetkit/effect"
import { Event } from "@rika/schema"
import { createClient } from "rivetkit/client"
import * as HostConfig from "./host-config"
import {
  AppendMirroredEventsPayload,
  AppendMirroredEventsResult,
  EnsureThreadPayload,
  GetEventsPayload,
  ImportForkThreadPayload,
  InterruptTurnPayload,
  PrepareForkThreadPayload,
  SetVisibilityPayload,
  StartTurnPayload,
  ThreadActor,
  ThreadActorError,
  ThreadActorSnapshot,
  ThreadIdPayload,
  VerifiedUserIdentity,
} from "./thread-actor"

export type RunError = ThreadActorError | RivetError.RivetError

export interface ForkThreadPayload extends PrepareForkThreadPayload {
  readonly import_identity: VerifiedUserIdentity
}

export interface Interface {
  readonly ensureThread: (input: EnsureThreadPayload) => Effect.Effect<ThreadActorSnapshot, RunError>
  readonly startTurn: (
    input: StartTurnPayload,
  ) => Effect.Effect<{ readonly thread_id: StartTurnPayload["thread_id"]; readonly accepted: true }, RunError>
  readonly getEvents: (input: GetEventsPayload) => Effect.Effect<ReadonlyArray<Event.Event>, RunError>
  readonly appendMirroredEvents: (
    input: AppendMirroredEventsPayload,
  ) => Effect.Effect<AppendMirroredEventsResult, RunError>
  readonly subscribeEvents: (input: GetEventsPayload) => Stream.Stream<Event.Event, RunError>
  readonly replayThread: (input: ThreadIdPayload) => Effect.Effect<ThreadActorSnapshot, RunError>
  readonly getSnapshot: (input: ThreadIdPayload) => Effect.Effect<ThreadActorSnapshot, RunError>
  readonly setVisibility: (input: SetVisibilityPayload) => Effect.Effect<ThreadActorSnapshot, RunError>
  readonly forkThread: (input: ForkThreadPayload) => Effect.Effect<ThreadActorSnapshot, RunError>
  readonly archiveThread: (input: ThreadIdPayload) => Effect.Effect<ThreadActorSnapshot, RunError>
  readonly unarchiveThread: (input: ThreadIdPayload) => Effect.Effect<ThreadActorSnapshot, RunError>
  readonly compactThread: (input: ThreadIdPayload) => Effect.Effect<Event.ContextCompacted, RunError>
  readonly interruptTurn: (input: InterruptTurnPayload) => Effect.Effect<Event.TurnTerminal, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/rivet-host/ThreadClient") {}

export interface LiveConnectionInterface {
  readonly subscribe: (input: GetEventsPayload) => Stream.Stream<void, RunError>
}

export class LiveConnection extends Context.Service<LiveConnection, LiveConnectionInterface>()(
  "@rika/rivet-host/ThreadClient/LiveConnection",
) {}

export interface RawLiveClient {
  readonly getOrCreate: (actorName: "ThreadActor", threadId: GetEventsPayload["thread_id"]) => unknown
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const accessor = yield* ThreadActor.client
    const liveConnection = Option.getOrUndefined(yield* Effect.serviceOption(LiveConnection))
    return Service.of({
      ensureThread: Effect.fn("ThreadClient.ensureThread")(function* (input: EnsureThreadPayload) {
        return yield* accessor.getOrCreate(input.thread_id).EnsureThread(input).pipe(retryTransientRivetErrors)
      }),
      startTurn: Effect.fn("ThreadClient.startTurn")(function* (input: StartTurnPayload) {
        return yield* accessor.getOrCreate(input.thread_id).StartTurn(input).pipe(retryTransientRivetErrors)
      }),
      getEvents: Effect.fn("ThreadClient.getEvents")(function* (input: GetEventsPayload) {
        return yield* accessor.getOrCreate(input.thread_id).GetEvents(input).pipe(retryTransientRivetErrors)
      }),
      appendMirroredEvents: Effect.fn("ThreadClient.appendMirroredEvents")(function* (
        input: AppendMirroredEventsPayload,
      ) {
        return yield* accessor.getOrCreate(input.thread_id).AppendMirroredEvents(input).pipe(retryTransientRivetErrors)
      }),
      subscribeEvents: (input: GetEventsPayload) =>
        liveConnection === undefined
          ? Stream.fail(missingLiveConnectionError())
          : threadEventsFromSignals(accessor, input, liveConnection.subscribe(input)),
      replayThread: Effect.fn("ThreadClient.replayThread")(function* (input: ThreadIdPayload) {
        return yield* accessor.getOrCreate(input.thread_id).ReplayThread(input).pipe(retryTransientRivetErrors)
      }),
      getSnapshot: Effect.fn("ThreadClient.getSnapshot")(function* (input: ThreadIdPayload) {
        return yield* accessor.getOrCreate(input.thread_id).GetSnapshot(input).pipe(retryTransientRivetErrors)
      }),
      setVisibility: Effect.fn("ThreadClient.setVisibility")(function* (input: SetVisibilityPayload) {
        return yield* accessor.getOrCreate(input.thread_id).SetVisibility(input).pipe(retryTransientRivetErrors)
      }),
      forkThread: Effect.fn("ThreadClient.forkThread")(function* (input: ForkThreadPayload) {
        const prepare = prepareForkPayload(input)
        const events = yield* accessor
          .getOrCreate(input.thread_id)
          .PrepareForkThread(prepare)
          .pipe(retryTransientRivetErrors)
        return yield* accessor
          .getOrCreate(input.fork_thread_id)
          .ImportForkThread(importForkPayload(input, events))
          .pipe(retryTransientRivetErrors)
      }),
      archiveThread: Effect.fn("ThreadClient.archiveThread")(function* (input: ThreadIdPayload) {
        return yield* accessor.getOrCreate(input.thread_id).ArchiveThread(input).pipe(retryTransientRivetErrors)
      }),
      unarchiveThread: Effect.fn("ThreadClient.unarchiveThread")(function* (input: ThreadIdPayload) {
        return yield* accessor.getOrCreate(input.thread_id).UnarchiveThread(input).pipe(retryTransientRivetErrors)
      }),
      compactThread: Effect.fn("ThreadClient.compactThread")(function* (input: ThreadIdPayload) {
        return yield* accessor.getOrCreate(input.thread_id).CompactThread(input).pipe(retryTransientRivetErrors)
      }),
      interruptTurn: Effect.fn("ThreadClient.interruptTurn")(function* (input: InterruptTurnPayload) {
        return yield* accessor.getOrCreate(input.thread_id).InterruptTurn(input).pipe(retryTransientRivetErrors)
      }),
    })
  }),
)

export const liveConnectionLayer = (options: HostConfig.ResolveOptions = {}) =>
  liveConnectionLayerFromResolved(HostConfig.resolveOptions(options))

export const liveConnectionLayerFromEnv = (
  env: Record<string, string | undefined> = process.env,
  options: HostConfig.ResolveOptions = {},
) => liveConnectionLayerFromResolved(HostConfig.resolveOptions(options, env))

const liveConnectionLayerFromResolved = (resolved: Effect.Effect<HostConfig.Resolved, HostConfig.HostConfigError>) =>
  Layer.effect(
    LiveConnection,
    Effect.gen(function* () {
      const host = yield* resolved
      const client = yield* Effect.acquireRelease(
        Effect.sync(() =>
          createClient({
            endpoint: host.endpoint,
            ...(host.token === undefined ? {} : { token: host.token }),
            ...(host.namespace === undefined ? {} : { namespace: host.namespace }),
          }),
        ),
        (rawClient) => Effect.promise(() => rawClient.dispose()).pipe(Effect.orDie),
      )
      return rawLiveConnection(client)
    }),
  )

export const liveConnectionLayerFromClient = (client: RawLiveClient) =>
  Layer.succeed(LiveConnection, rawLiveConnection(client))

export const ensureThread = Effect.fn("ThreadClient.ensureThread.call")(function* (input: EnsureThreadPayload) {
  const service = yield* Service
  return yield* service.ensureThread(input)
})

export const startTurn = Effect.fn("ThreadClient.startTurn.call")(function* (input: StartTurnPayload) {
  const service = yield* Service
  return yield* service.startTurn(input)
})

export const getEvents = Effect.fn("ThreadClient.getEvents.call")(function* (input: GetEventsPayload) {
  const service = yield* Service
  return yield* service.getEvents(input)
})

export const appendMirroredEvents = Effect.fn("ThreadClient.appendMirroredEvents.call")(function* (
  input: AppendMirroredEventsPayload,
) {
  const service = yield* Service
  return yield* service.appendMirroredEvents(input)
})

export const subscribeEvents = (input: GetEventsPayload) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const service = yield* Service
      return service.subscribeEvents(input)
    }),
  )

export const replayThread = Effect.fn("ThreadClient.replayThread.call")(function* (input: ThreadIdPayload) {
  const service = yield* Service
  return yield* service.replayThread(input)
})

export const getSnapshot = Effect.fn("ThreadClient.getSnapshot.call")(function* (input: ThreadIdPayload) {
  const service = yield* Service
  return yield* service.getSnapshot(input)
})

export const setVisibility = Effect.fn("ThreadClient.setVisibility.call")(function* (input: SetVisibilityPayload) {
  const service = yield* Service
  return yield* service.setVisibility(input)
})

export const forkThread = Effect.fn("ThreadClient.forkThread.call")(function* (input: ForkThreadPayload) {
  const service = yield* Service
  return yield* service.forkThread(input)
})

export const archiveThread = Effect.fn("ThreadClient.archiveThread.call")(function* (input: ThreadIdPayload) {
  const service = yield* Service
  return yield* service.archiveThread(input)
})

export const unarchiveThread = Effect.fn("ThreadClient.unarchiveThread.call")(function* (input: ThreadIdPayload) {
  const service = yield* Service
  return yield* service.unarchiveThread(input)
})

export const compactThread = Effect.fn("ThreadClient.compactThread.call")(function* (input: ThreadIdPayload) {
  const service = yield* Service
  return yield* service.compactThread(input)
})

export const interruptTurn = Effect.fn("ThreadClient.interruptTurn.call")(function* (input: InterruptTurnPayload) {
  const service = yield* Service
  return yield* service.interruptTurn(input)
})

const isNoEnvoysStartupError = (error: RivetError.RivetError) => {
  if (error.group !== "guard" || error.code !== "actor_runner_failed") return false
  if (!isObjectRecord(error.metadata)) return false
  return error.metadata.details === "no_envoys"
}

const isObjectRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null

const retryAfter = (error: unknown) => (RivetError.isRivetError(error) ? error.retryAfter : undefined)

export const retryTransientRivetErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  retryTransientRivetErrorsLoop(effect, 0, 0)

const retryTransientRivetErrorsLoop = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  normalRetries: number,
  noEnvoysRetries: number,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.catchIf(
      () => true,
      (error) => {
        if (RivetError.isRivetError(error) && isNoEnvoysStartupError(error) && noEnvoysRetries < 120) {
          return Effect.sleep(Duration.millis(500)).pipe(
            Effect.flatMap(() => retryTransientRivetErrorsLoop(effect, normalRetries, noEnvoysRetries + 1)),
          )
        }
        if (RivetError.isRivetError(error) && error.isRetryable && normalRetries < 3) {
          return Effect.sleep(retryAfter(error) ?? Duration.millis(50 * 2 ** normalRetries)).pipe(
            Effect.flatMap(() => retryTransientRivetErrorsLoop(effect, normalRetries + 1, noEnvoysRetries)),
          )
        }
        return Effect.fail(error)
      },
    ),
  )

const missingLiveConnectionError = () =>
  RivetError.fromUnknown(new Error("ThreadClient live connection layer is required"))

const threadEventsFromSignals = (
  accessor: {
    readonly getOrCreate: (id: GetEventsPayload["thread_id"]) => {
      readonly GetEvents: (input: GetEventsPayload) => Effect.Effect<ReadonlyArray<Event.Event>, RunError>
    }
  },
  input: GetEventsPayload,
  signals: Stream.Stream<void, RunError>,
): Stream.Stream<Event.Event, RunError> =>
  signals.pipe(
    Stream.mapAccumEffect(
      () => input.after_sequence ?? 0,
      (latest) =>
        accessor
          .getOrCreate(input.thread_id)
          .GetEvents({ ...input, after_sequence: latest })
          .pipe(
            retryTransientRivetErrors,
            Effect.map((events) => {
              const fresh = events.filter((event) => event.sequence > latest)
              const next = fresh.at(-1)?.sequence ?? latest
              return [next, fresh] as const
            }),
          ),
    ),
  )

const rawLiveConnection = (client: RawLiveClient) =>
  LiveConnection.of({
    subscribe: (input) => rawThreadSignals(client, input),
  })

const rawThreadSignals = (client: RawLiveClient, input: GetEventsPayload): Stream.Stream<void, RunError> =>
  Stream.callback<void, RunError>((queue) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const conn = threadEventConnection(client, input.thread_id)
        const offerSignal = () => Queue.offerUnsafe(queue, undefined)
        const unsubscribe = conn.on("threadEvent", offerSignal)
        const unsubscribeOpen = conn.onOpen(offerSignal)
        const unsubscribeError = conn.onError((error) => {
          Queue.failCauseUnsafe(queue, CauseFromUnknown(error))
        })
        const release = cleanupConnection(conn, unsubscribe, unsubscribeOpen, unsubscribeError)
        const ready = yield* Effect.tryPromise({
          try: () => conn.ready,
          catch: RivetError.fromUnknown,
        }).pipe(
          Effect.as(true),
          Effect.catchIf(
            () => true,
            (error) =>
              release.pipe(
                Effect.andThen(Effect.sync(() => Queue.failCauseUnsafe(queue, Cause.fail(error)))),
                Effect.as(false),
              ),
          ),
        )
        if (ready) offerSignal()
        return { release: ready ? release : Effect.void }
      }),
      ({ release }) => release,
    ),
  )

interface ThreadEventConnection {
  readonly ready: PromiseLike<void>
  readonly on: (eventName: "threadEvent", callback: () => void) => () => void
  readonly onOpen: (callback: () => void) => () => void
  readonly onError: (callback: (error: unknown) => void) => () => void
  readonly dispose: () => PromiseLike<void>
}

const cleanupConnection = (
  conn: ThreadEventConnection,
  unsubscribe: () => void,
  unsubscribeOpen: () => void,
  unsubscribeError: () => void,
) =>
  Effect.sync(() => {
    unsubscribe()
    unsubscribeOpen()
    unsubscribeError()
  }).pipe(Effect.andThen(Effect.promise(() => conn.dispose()).pipe(Effect.orDie)))

const threadEventConnection = (client: RawLiveClient, threadId: GetEventsPayload["thread_id"]) => {
  const getOrCreate = Reflect.get(client, "getOrCreate")
  if (typeof getOrCreate !== "function") throw new Error("Rivet client does not expose getOrCreate")
  const handle = getOrCreate.call(client, "ThreadActor", threadId)
  if (!isObjectRecord(handle)) throw new Error("Rivet actor handle does not expose connect")
  const connect = Reflect.get(handle, "connect")
  if (typeof connect !== "function") throw new Error("Rivet actor handle does not expose connect")
  return requireThreadEventConnection(connect.call(handle))
}

const requireThreadEventConnection = (input: unknown): ThreadEventConnection => {
  if (!isObjectRecord(input)) throw new Error("Rivet actor connection does not expose the expected live-tail API")
  const ready = Reflect.get(input, "ready")
  const on = Reflect.get(input, "on")
  const onOpen = Reflect.get(input, "onOpen")
  const onError = Reflect.get(input, "onError")
  const dispose = Reflect.get(input, "dispose")
  if (
    !isPromiseLike(ready) ||
    typeof on !== "function" ||
    typeof onOpen !== "function" ||
    typeof onError !== "function" ||
    typeof dispose !== "function"
  ) {
    throw new Error("Rivet actor connection does not expose the expected live-tail API")
  }
  return {
    ready: Promise.resolve(ready).then(() => undefined),
    on: (eventName, callback) => on.call(input, eventName, callback),
    onOpen: (callback) => onOpen.call(input, callback),
    onError: (callback) => onError.call(input, callback),
    dispose: () => Promise.resolve(dispose.call(input)).then(() => undefined),
  }
}

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "then") === "function"

const CauseFromUnknown = (error: unknown) => Cause.fail(RivetError.fromUnknown(error))

const importForkPayload = (
  input: ForkThreadPayload,
  events: ImportForkThreadPayload["events"],
): ImportForkThreadPayload => ({
  thread_id: input.fork_thread_id,
  identity: input.import_identity,
  events,
})

const prepareForkPayload = (input: ForkThreadPayload): PrepareForkThreadPayload => ({
  thread_id: input.thread_id,
  fork_thread_id: input.fork_thread_id,
  ...(input.identity === undefined ? {} : { identity: input.identity }),
  ...(input.at_turn === undefined ? {} : { at_turn: input.at_turn }),
  ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
  ...(input.title_text === undefined ? {} : { title_text: input.title_text }),
})

export type Requirements = RivetClient.Client

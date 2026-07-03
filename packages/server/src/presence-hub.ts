import { Time } from "@rika/core"
import { Common, Ids, Remote } from "@rika/schema"
import { Context, Effect, Layer, PubSub, Queue, Semaphore, Stream } from "effect"

const ttlMillis = 45_000
const sweepInterval = "1 second"

interface PresenceRecord {
  readonly state: Remote.PresenceState
  readonly last_seen: Common.TimestampMillis
}

interface ThreadState {
  readonly users: Map<Ids.UserId, PresenceRecord>
  readonly topic: PubSub.PubSub<Remote.PresenceFrame>
  subscribers: number
}

export interface Interface {
  readonly heartbeat: (input: Remote.SetThreadPresenceRequest) => Effect.Effect<Remote.PresenceFrame>
  readonly subscribe: (threadId: Ids.ThreadId) => Stream.Stream<Remote.PresenceFrame>
}

export class Service extends Context.Service<Service, Interface>()("@rika/server/PresenceHub") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const time = yield* Time.Service
    const scope = yield* Effect.scope
    const threads = new Map<Ids.ThreadId, ThreadState>()
    const mutex = yield* Semaphore.make(1)

    const expireAll = Effect.fn("PresenceHub.expireAll")(function* () {
      const now = yield* time.nowMillis
      yield* mutex.withPermit(
        Effect.gen(function* () {
          for (const [threadId, state] of threads) {
            if (sweep(state, now)) yield* PubSub.publish(state.topic, snapshot(threadId, state)).pipe(Effect.asVoid)
            if (state.users.size > 0 || state.subscribers > 0) continue
            threads.delete(threadId)
            yield* PubSub.shutdown(state.topic).pipe(Effect.ignore)
          }
        }),
      )
    })

    yield* Effect.forkIn(Effect.forever(Effect.sleep(sweepInterval).pipe(Effect.andThen(expireAll))), scope)

    const stateFor = (threadId: Ids.ThreadId) =>
      Effect.gen(function* () {
        const existing = threads.get(threadId)
        if (existing !== undefined) return existing
        const topic = yield* PubSub.sliding<Remote.PresenceFrame>(1)
        const state: ThreadState = { users: new Map(), topic, subscribers: 0 }
        threads.set(threadId, state)
        return state
      })

    const releaseSubscriber = (threadId: Ids.ThreadId, state: ThreadState) =>
      mutex.withPermit(
        Effect.gen(function* () {
          state.subscribers = Math.max(0, state.subscribers - 1)
          if (state.users.size > 0 || state.subscribers > 0 || threads.get(threadId) !== state) return
          threads.delete(threadId)
          yield* PubSub.shutdown(state.topic).pipe(Effect.ignore)
        }),
      )

    const acquireSubscriber = (threadId: Ids.ThreadId) =>
      mutex.withPermit(
        Effect.gen(function* () {
          const state = yield* stateFor(threadId)
          state.subscribers += 1
          return state
        }),
      )

    const heartbeat = Effect.fn("PresenceHub.heartbeat")(function* (input: Remote.SetThreadPresenceRequest) {
      const now = yield* time.nowMillis
      return yield* mutex.withPermit(
        Effect.gen(function* () {
          const state = yield* stateFor(input.thread_id)
          sweep(state, now)
          state.users.set(input.user_id, { state: input.state, last_seen: now })
          const frame = snapshot(input.thread_id, state)
          yield* PubSub.publish(state.topic, frame).pipe(Effect.asVoid)
          return frame
        }),
      )
    })

    return Service.of({
      heartbeat,
      subscribe: (threadId: Ids.ThreadId) =>
        Stream.callback<Remote.PresenceFrame>(
          (queue) =>
            Effect.gen(function* () {
              const state = yield* Effect.acquireRelease(acquireSubscriber(threadId), (acquired) =>
                releaseSubscriber(threadId, acquired),
              )
              const now = yield* time.nowMillis
              const result = yield* mutex.withPermit(
                Effect.gen(function* () {
                  const expired = sweep(state, now)
                  const subscription = yield* PubSub.subscribe(state.topic)
                  const frame = snapshot(threadId, state)
                  if (expired) yield* PubSub.publish(state.topic, frame).pipe(Effect.asVoid)
                  return { subscription, frame }
                }),
              )
              yield* Queue.offer(queue, result.frame).pipe(Effect.asVoid)
              yield* Effect.forever(
                PubSub.take(result.subscription).pipe(
                  Effect.flatMap((frame) => Queue.offer(queue, frame).pipe(Effect.asVoid)),
                ),
              ).pipe(Effect.ensuring(Queue.end(queue).pipe(Effect.ignore)), Effect.forkScoped)
            }),
          { bufferSize: 1, strategy: "sliding" },
        ),
    })
  }),
)

export const heartbeat = Effect.fn("PresenceHub.heartbeat.call")(function* (input: Remote.SetThreadPresenceRequest) {
  const service = yield* Service
  return yield* service.heartbeat(input)
})

export const subscribe = (threadId: Ids.ThreadId) =>
  Stream.unwrap(Effect.map(Service, (service) => service.subscribe(threadId)))

const sweep = (state: ThreadState, now: Common.TimestampMillis) => {
  let expired = false
  for (const [userId, record] of state.users.entries()) {
    if (now - record.last_seen <= ttlMillis) continue
    state.users.delete(userId)
    expired = true
  }
  return expired
}

const snapshot = (threadId: Ids.ThreadId, state: ThreadState): Remote.PresenceFrame => ({
  presence: {
    thread_id: threadId,
    users: [...state.users.entries()]
      .map(([user_id, record]) => ({ user_id, state: record.state, last_seen: record.last_seen }))
      .toSorted((left, right) => left.user_id.localeCompare(right.user_id)),
  },
})

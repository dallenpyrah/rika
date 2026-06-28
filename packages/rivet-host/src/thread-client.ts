import { Context, Effect, Layer, Schema } from "effect"
import { Client as RivetClient } from "@rivetkit/effect"
import {
  AcceptTurnPayload,
  EnsureThreadPayload,
  ThreadActor,
  ThreadActorActionError,
  ThreadActorSnapshot,
  ThreadIdPayload,
} from "./thread-actor"

export class ThreadClientError extends Schema.TaggedErrorClass<ThreadClientError>()("ThreadClientError", {
  message: Schema.String,
  operation: Schema.String,
}) {}

export type RunError = ThreadActorActionError | ThreadClientError

export interface Interface {
  readonly ensureThread: (input: EnsureThreadPayload) => Effect.Effect<ThreadActorSnapshot, RunError>
  readonly acceptTurn: (input: AcceptTurnPayload) => Effect.Effect<ThreadActorSnapshot, RunError>
  readonly replayThread: (input: ThreadIdPayload) => Effect.Effect<ThreadActorSnapshot, RunError>
  readonly getSnapshot: (input: ThreadIdPayload) => Effect.Effect<ThreadActorSnapshot, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/rivet-host/ThreadClient") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const accessor = yield* ThreadActor.client
    return Service.of({
      ensureThread: Effect.fn("ThreadClient.ensureThread")(function* (input: EnsureThreadPayload) {
        return yield* accessor
          .getOrCreate(input.thread_id)
          .EnsureThread(input)
          .pipe(Effect.mapError(toError("ensureThread")))
      }),
      acceptTurn: Effect.fn("ThreadClient.acceptTurn")(function* (input: AcceptTurnPayload) {
        return yield* accessor
          .getOrCreate(input.thread_id)
          .AcceptTurn(input)
          .pipe(Effect.mapError(toError("acceptTurn")))
      }),
      replayThread: Effect.fn("ThreadClient.replayThread")(function* (input: ThreadIdPayload) {
        return yield* accessor
          .getOrCreate(input.thread_id)
          .ReplayThread(input)
          .pipe(Effect.mapError(toError("replayThread")))
      }),
      getSnapshot: Effect.fn("ThreadClient.getSnapshot")(function* (input: ThreadIdPayload) {
        return yield* accessor
          .getOrCreate(input.thread_id)
          .GetSnapshot(input)
          .pipe(Effect.mapError(toError("getSnapshot")))
      }),
    })
  }),
)

export const ensureThread = Effect.fn("ThreadClient.ensureThread.call")(function* (input: EnsureThreadPayload) {
  const service = yield* Service
  return yield* service.ensureThread(input)
})

export const acceptTurn = Effect.fn("ThreadClient.acceptTurn.call")(function* (input: AcceptTurnPayload) {
  const service = yield* Service
  return yield* service.acceptTurn(input)
})

export const replayThread = Effect.fn("ThreadClient.replayThread.call")(function* (input: ThreadIdPayload) {
  const service = yield* Service
  return yield* service.replayThread(input)
})

export const getSnapshot = Effect.fn("ThreadClient.getSnapshot.call")(function* (input: ThreadIdPayload) {
  const service = yield* Service
  return yield* service.getSnapshot(input)
})

const toError = (operation: string) => (cause: unknown) => {
  if (cause instanceof ThreadActorActionError) return cause
  return new ThreadClientError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
  })
}

export type Requirements = RivetClient.Client

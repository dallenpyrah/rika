import { Agent, TurnPolicy } from "@batonfx/core"
import { Client, Content, Ids, type Resident } from "@relayfx/sdk"
import { Duration, Effect, Schedule, Schema, Semaphore } from "effect"
import * as ThreadHost from "../thread-host"
import type { ThreadQueueWake } from "../execution-contract"
import { addressId, error } from "./execution-codec"
import { failureKind } from "./options"

export const makeThreadHostResident = Effect.fn("ExecutionBackend.makeThreadHostResident")(function* (
  client: Client.Interface,
) {
  const hostInstances = new Map<string, Resident.Instance>()
  const hostReady = yield* Effect.cached(
    Effect.gen(function* () {
      yield* client.agents.register({
        id: ThreadHost.hostAgentId,
        agent: Agent.make({
          name: "rika-thread-host",
          instructions: "Promote pending Rika turns delivered to this thread host.",
          model: ThreadHost.hostSelection,
          toolkit: ThreadHost.toolkit,
          policy: TurnPolicy.forever,
        }),
        permissions: [
          { name: "relay.inbox.wait", value: true },
          { name: "relay.inbox.send", value: true },
        ],
        max_wait_turns: ThreadHost.hostMaxWaitTurns,
        metadata: { steering_enabled: false, inbox_enabled: true },
      })
      yield* client.residents.registerKind({
        kind: ThreadHost.entityKind,
        agent_id: ThreadHost.hostAgentId,
        inbox: { drain: "all" },
        state_enabled: false,
        continue_as_new_after_turns: ThreadHost.continueAsNewAfterTurns,
        metadata: { product: "rika" },
      })
    }),
  )
  const hostGate = yield* Semaphore.make(1)
  const entityFor = Effect.fn("ExecutionBackend.entityFor")(function* (threadId: string, now: number) {
    let recovering = false
    const existing = yield* client.residents.get({ kind: ThreadHost.entityKind, key: Ids.ResidentKey.make(threadId) })
    if (existing?.status === "active") {
      const inspection = yield* client.executions.inspect(existing.execution_id)
      if (inspection.status === "completed" || inspection.status === "failed" || inspection.status === "cancelled") {
        recovering = true
        yield* Effect.logWarning("thread_host.recovery.started").pipe(
          Effect.annotateLogs({
            "rika.thread.id": threadId,
            "rika.execution.id": existing.execution_id,
            "rika.execution.status": inspection.status,
            "rika.thread_host.generation": existing.generation,
          }),
        )
        yield* client.residents.destroy({
          kind: ThreadHost.entityKind,
          key: Ids.ResidentKey.make(threadId),
          reason: "thread host execution ended; recreating a fresh generation",
          destroyed_at: now,
        })
        hostInstances.delete(threadId)
      }
    }
    const instance = yield* client.residents.spawn({
      kind: ThreadHost.entityKind,
      key: Ids.ResidentKey.make(threadId),
      metadata: { rika_thread_id: threadId },
      created_at: now,
    })
    if (recovering)
      yield* Effect.logInfo("thread_host.recovery.completed").pipe(
        Effect.annotateLogs({
          "rika.thread.id": threadId,
          "rika.execution.id": instance.execution_id,
          "rika.thread_host.generation": instance.generation,
        }),
      )
    return instance
  })
  const hostInstance = Effect.fn("ExecutionBackend.hostInstance")(function* (threadId: string, now: number) {
    yield* hostReady
    const cached = hostInstances.get(threadId)
    if (cached !== undefined && cached.status === "active") return cached
    const instance = yield* entityFor(threadId, now)
    hostInstances.set(threadId, instance)
    return instance
  })
  const awaitParkedHost = Effect.fn("ExecutionBackend.awaitParkedHost")(function* (
    threadId: string,
    instance: Resident.Instance,
    now: number,
  ) {
    const outcome = yield* Effect.gen(function* () {
      const inspection = yield* client.executions.inspect(instance.execution_id)
      if (inspection.status === "completed" || inspection.status === "failed" || inspection.status === "cancelled")
        return "terminal" as const
      if (inspection.waiting_on.length === 0)
        return yield* Client.ClientError.make({ message: `Thread host for ${threadId} is not parked yet` })
      return "parked" as const
    }).pipe(
      Effect.retry({ schedule: Schedule.spaced(Duration.millis(50)), times: 100 }),
      Effect.orElseSucceed(() => "unknown" as const),
    )
    if (outcome !== "terminal") return instance
    yield* client.residents.destroy({
      kind: ThreadHost.entityKind,
      key: Ids.ResidentKey.make(threadId),
      reason: "thread host execution ended; recreating a fresh generation",
      destroyed_at: now,
    })
    hostInstances.delete(threadId)
    const recreated = yield* entityFor(threadId, now)
    hostInstances.set(threadId, recreated)
    return recreated
  })
  return Effect.fn("ExecutionBackend.wakeThreadHost")(function* (wake: ThreadQueueWake) {
    yield* hostGate
      .withPermits(1)(
        Effect.gen(function* () {
          const created = yield* hostInstance(wake.threadId, wake.now)
          const instance = yield* awaitParkedHost(wake.threadId, created, wake.now)
          const notification = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
            kind: "queue-ready",
            thread_id: wake.threadId,
            wake_generation: wake.generation,
            queue_revision: wake.queueRevision,
          })
          yield* client.envelopes.send({
            from: addressId,
            to: instance.address_id,
            content: [Content.text(notification)],
            idempotency_key: `rika:queue-wake:${wake.threadId}:${wake.generation}`,
          })
        }),
      )
      .pipe(
        Effect.tapCause((cause) =>
          Effect.logError("thread_host.notification.failed").pipe(
            Effect.annotateLogs({
              "rika.thread.id": wake.threadId,
              "rika.queue.wake_generation": wake.generation,
              "rika.queue.revision": wake.queueRevision,
              "rika.failure.kind": failureKind(cause),
            }),
          ),
        ),
        Effect.mapError(error),
      )
  })
})

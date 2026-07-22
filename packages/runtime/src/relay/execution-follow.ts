import { Client, type Execution, Ids } from "@relayfx/sdk"
import { Cause, Clock, Effect, Queue, Schedule, Scope, Stream } from "effect"
import { BackendError, Event, type ExecutionReference, Status } from "../execution-contract"
import { failureKind, isExecutionNotFound, observableEventTypes, childExecutionIdFromEvent } from "./options"
import { internal as codec, event, statusFromEvents, isActionableWait } from "./execution-codec"
const { executionId } = codec
const followExecution = (
  client: Client.Interface,
  turnId: string,
  afterCursor: string | undefined,
  onEvent: ((item: Event) => void) | undefined,
  stopAtActionableWait = true,
  reference?: ExecutionReference,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      yield* Effect.logInfo("execution.follow.started")
      const rootExecutionId = executionId(turnId, reference)
      const events: Array<Event> = []
      const followed = new Set<string>()
      const tracedDeltas = new Set<string>()
      const updates = yield* Queue.unbounded<
        | {
            readonly _tag: "event"
            readonly event: Event
            readonly actionable: boolean
            readonly terminal?: Status
          }
        | { readonly _tag: "stopped"; readonly status: Status; readonly actionable: boolean }
        | { readonly _tag: "failed"; readonly error: BackendError }
      >()
      const attributedEvent = (item: Execution.ExecutionEvent, childExecutionId: string | undefined) =>
        event(
          childExecutionId === undefined
            ? item
            : {
                ...item,
                data: { ...item.data, execution_id: childExecutionId },
              },
        )
      let launch!: (
        execution: Ids.ExecutionId,
        root: boolean,
        cursor?: string,
      ) => Effect.Effect<void, never, Scope.Scope>
      const followOne = (execution: Ids.ExecutionId, root: boolean, cursor: string | undefined) => {
        const consume = (nextCursor: string | undefined) =>
          Stream.runForEachWhile(
            client.executions.follow({
              execution_id: execution,
              ...(nextCursor === undefined ? {} : { after_cursor: nextCursor }),
            }),
            (item) => {
              if (item._tag === "reconnecting")
                return root
                  ? Effect.logWarning("execution.follow.reconnecting").pipe(
                      Effect.annotateLogs({
                        "rika.reconnect.attempt": item.attempt,
                        "rika.reconnect.message": item.message,
                      }),
                      Effect.as(true),
                    )
                  : Effect.succeed(true)
              if (item._tag === "stopped") {
                if (!root || item.reason._tag === "actionable_wait") {
                  if (item.reason._tag !== "actionable_wait") return Effect.succeed(false)
                  return Queue.offer(updates, { _tag: "stopped", status: "waiting", actionable: true }).pipe(
                    Effect.as(false),
                  )
                }
                return Queue.offer(updates, {
                  _tag: "stopped",
                  status: Status.make(item.reason.status),
                  actionable: false,
                }).pipe(Effect.as(false))
              }
              const spawnedChild = childExecutionIdFromEvent(item.event)
              const mapped = attributedEvent(item.event, root ? undefined : String(execution))
              const terminal =
                mapped.type === "execution.completed"
                  ? Status.make("completed")
                  : mapped.type === "execution.failed"
                    ? Status.make("failed")
                    : mapped.type === "execution.cancelled"
                      ? Status.make("cancelled")
                      : undefined
              const inspectActionable =
                stopAtActionableWait && isActionableWait(mapped) && typeof mapped.data?.wait_id === "string"
                  ? client.executions
                      .inspect(execution)
                      .pipe(
                        Effect.map((inspection) =>
                          inspection.waiting_on.some((wait) => wait.wait_id === mapped.data?.wait_id),
                        ),
                      )
                  : Effect.succeed(false)
              return Effect.gen(function* () {
                const actionable = yield* inspectActionable
                yield* Queue.offer(updates, {
                  _tag: "event",
                  event: mapped,
                  actionable: actionable && !root,
                  ...(root && terminal !== undefined ? { terminal } : {}),
                })
                if (spawnedChild !== undefined) yield* launch(Ids.ExecutionId.make(spawnedChild), false)
                if (actionable && root)
                  yield* Queue.offer(updates, { _tag: "stopped", status: "waiting", actionable: true })
                return terminal === undefined && !actionable
              })
            },
          )
        return Effect.gen(function* () {
          const inspection = yield* client.executions.inspect(execution).pipe(
            Effect.retry({
              while: isExecutionNotFound,
              schedule: Schedule.spaced("10 millis"),
              times: 100,
            }),
          )
          yield* Effect.forEach(
            inspection.child_runs,
            (child) => launch(Ids.ExecutionId.make(String(child.child_execution_id)), false),
            { discard: true },
          )
          yield* consume(cursor).pipe(Effect.catchTag("EventLogCursorNotFound", () => consume(undefined)))
        }).pipe(
          Effect.catchCause((cause) =>
            root
              ? Queue.offer(updates, {
                  _tag: "failed",
                  error: BackendError.make({ message: Cause.pretty(cause) }),
                }).pipe(Effect.asVoid)
              : Effect.logWarning("execution.child.follow.failed").pipe(
                  Effect.annotateLogs({
                    "rika.execution.id": String(execution),
                    "rika.failure.kind": failureKind(cause),
                  }),
                ),
          ),
        )
      }
      launch = (execution, root, cursor) =>
        Effect.suspend(() => {
          const key = String(execution)
          if (followed.has(key)) return Effect.void
          followed.add(key)
          return followOne(execution, root, cursor).pipe(Effect.forkScoped, Effect.asVoid)
        })
      yield* launch(rootExecutionId, true, afterCursor)
      let stoppedAtActionableWait = false
      let stoppedStatus: Status | undefined
      while (stoppedStatus === undefined) {
        const update = yield* Queue.take(updates)
        if (update._tag === "failed") return yield* update.error
        if (update._tag === "stopped") {
          stoppedAtActionableWait = update.actionable
          stoppedStatus = update.status
          continue
        }
        events.push(update.event)
        onEvent?.(update.event)
        const traceDelta =
          update.event.type === "model.reasoning.delta" ||
          update.event.type === "model.output.delta" ||
          update.event.type === "model.toolcall.delta"
        if (!traceDelta || !tracedDeltas.has(update.event.type)) {
          if (traceDelta) tracedDeltas.add(update.event.type)
          if (traceDelta || observableEventTypes.has(update.event.type))
            yield* Effect.logInfo("execution.event.received").pipe(
              Effect.annotateLogs({
                "rika.event.cursor": update.event.cursor,
                "rika.event.sequence": update.event.sequence,
                "rika.event.type": update.event.type,
              }),
            )
        }
        if (update.actionable) {
          stoppedAtActionableWait = true
          stoppedStatus = "waiting"
        } else if (update.terminal !== undefined) stoppedStatus = update.terminal
      }
      const status = stoppedStatus ?? statusFromEvents(events)
      const completedAt = yield* Clock.currentTimeMillis
      yield* Effect.logInfo("execution.follow.completed").pipe(
        Effect.annotateLogs({
          "rika.duration.ms": completedAt - startedAt,
          "rika.event.count": events.length,
          "rika.execution.status": status,
        }),
      )
      return {
        turnId,
        status:
          status === "running" || status === "queued"
            ? stoppedAtActionableWait
              ? Status.make("waiting")
              : status
            : status,
        events,
      }
    }),
  ).pipe(
    Effect.tapCause((cause) =>
      Effect.logError("execution.follow.failed").pipe(Effect.annotateLogs("rika.failure.kind", failureKind(cause))),
    ),
    Effect.annotateLogs({
      "rika.execution.id": String(executionId(turnId, reference)),
      "rika.turn.id": turnId,
    }),
  )

export const internal = { followExecution }

import * as Thread from "@rika/persistence/thread"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Deferred, Effect, Queue, Scope } from "effect"
import * as ThreadActivity from "../thread-activity"
import type { InteractiveEvent } from "../operation-contract"
import { internal as executionProjection } from "./execution-projection"
const { childExecutionId, childTranscriptPatch, normalizeChildExecutionId } = executionProjection

export const makeInteractiveChildFollowers = Effect.fn("Operation.makeInteractiveChildFollowers")(
  function* (dependencies: {
    readonly initialThreadId?: string
    readonly acquiredBackend: ExecutionBackend.Interface
    readonly sessionDispatch: (event: InteractiveEvent) => void
    readonly publishInteractiveActivity: (sessionId: number, event: InteractiveEvent) => void
    readonly sessionId: number
    readonly sessionScope: Scope.Scope
  }) {
    const { initialThreadId, acquiredBackend, sessionDispatch, publishInteractiveActivity, sessionId, sessionScope } =
      dependencies
    type ChildFollowerSelection = {
      readonly generation: number
      readonly threadId: string | undefined
      readonly stopped: Deferred.Deferred<void>
      readonly executions: Set<string>
    }
    type ChildFollowerJob = {
      readonly executionId: string
      readonly threadId: Thread.ThreadId
      readonly rootTurnId: Turn.TurnId
      readonly selection: ChildFollowerSelection
    }
    const childFollowerJobs = yield* Queue.bounded<ChildFollowerJob>(512)
    let childFollowerSelection: ChildFollowerSelection = {
      generation: 0,
      threadId: initialThreadId,
      stopped: yield* Deferred.make<void>(),
      executions: new Set(),
    }
    const activateChildFollowers = Effect.fn("Operation.interactive.activateChildFollowers")(function* (
      threadId: Thread.ThreadId,
    ) {
      const previous = childFollowerSelection
      childFollowerSelection = {
        generation: previous.generation + 1,
        threadId: String(threadId),
        stopped: yield* Deferred.make<void>(),
        executions: new Set(),
      }
      yield* Deferred.succeed(previous.stopped, undefined)
      yield* Queue.clear(childFollowerJobs)
    })
    const enqueueChildFollower = (threadId: Thread.ThreadId, executionId: string, rootTurnId: Turn.TurnId) => {
      const normalizedExecutionId = normalizeChildExecutionId(executionId)
      const selection = childFollowerSelection
      if (selection.threadId !== String(threadId) || selection.executions.has(normalizedExecutionId)) return
      selection.executions.add(normalizedExecutionId)
      if (
        !Queue.offerUnsafe(childFollowerJobs, {
          executionId,
          threadId,
          rootTurnId,
          selection,
        })
      )
        selection.executions.delete(normalizedExecutionId)
    }
    const observeChildSpawn = (event: InteractiveEvent) => {
      if (event._tag !== "TranscriptPatched") return
      const executionId = childExecutionId(event.event)
      if (executionId !== undefined) enqueueChildFollower(event.threadId, executionId, event.rootTurnId ?? event.turnId)
    }
    const followChildExecution = Effect.fn("Operation.interactive.followChildExecution")(function* (
      job: ChildFollowerJob,
    ) {
      const follow = acquiredBackend.follow
      if (follow === undefined) return
      const deliveredCursors = new Set<string>()
      let afterCursor: string | undefined
      while (childFollowerSelection === job.selection) {
        const deliverEvent = (event: ExecutionBackend.Event) => {
          if (childFollowerSelection !== job.selection || deliveredCursors.has(event.cursor)) return
          deliveredCursors.add(event.cursor)
          const patch = childTranscriptPatch(job.threadId, job.executionId, job.rootTurnId, event)
          sessionDispatch(patch)
          if (event.type === "model.usage.reported") publishInteractiveActivity(sessionId, patch)
        }
        const result: ExecutionBackend.Result | undefined = yield* Effect.raceFirst(
          follow(job.executionId, afterCursor, deliverEvent, ExecutionBackend.executionReference),
          Deferred.await(job.selection.stopped).pipe(Effect.as(undefined)),
        )
        if (result === undefined || childFollowerSelection !== job.selection) return
        for (const event of result.events) deliverEvent(event)
        if (result.status === "completed" || result.status === "failed" || result.status === "cancelled") return
        const nextCursor = ThreadActivity.latestCursor(result.events)
        if (nextCursor === undefined || nextCursor === afterCursor) return
        afterCursor = nextCursor
      }
    })
    const runChildFollower = Effect.forever(
      Queue.take(childFollowerJobs).pipe(
        Effect.flatMap((job) =>
          childFollowerSelection === job.selection
            ? followChildExecution(job).pipe(
                Effect.catch((error) =>
                  Effect.logError("child-execution.follow.failed").pipe(
                    Effect.annotateLogs({
                      "rika.execution.id": job.executionId,
                      "rika.thread.id": String(job.threadId),
                      "rika.failure.kind": String(error),
                    }),
                  ),
                ),
              )
            : Effect.void,
        ),
      ),
    )
    yield* Effect.forEach(Array.from({ length: 8 }), () => Effect.forkIn(runChildFollower, sessionScope), {
      discard: true,
    })
    return { activateChildFollowers, enqueueChildFollower, observeChildSpawn }
  },
)

import { ExecutionExtensions } from "@rika/extensions"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as ThreadSummaryRepository from "@rika/persistence/thread-summary-repository"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Clock, Context, Effect, Semaphore } from "effect"
import * as ResolvedContext from "../resolved-context"
import * as ThreadActivity from "../thread-activity"
import type { InteractiveEvent } from "../operation-contract"
import type { ExecutionCoordination } from "./execution-coordination"
import { internal as threadFormat } from "./thread-format"
import { internal as executionProjection } from "./execution-projection"
const { queueItem, queueMutationEvent } = threadFormat
const { transcriptPatch } = executionProjection

type QueueRequirements =
  | ThreadRepository.Service
  | TurnRepository.Service
  | ThreadSummaryRepository.Service
  | TranscriptRepository.Service
  | ResolvedContext.Service
  | ExecutionExtensions.Service
  | ExecutionBackend.Service

interface InteractiveQueueDependencies
  extends Pick<
    ExecutionCoordination,
    "notifyThreadSummaries" | "notifyTurnChanged" | "prepareExecution" | "projectExecutionResult" | "setTurnStatus"
  > {
  readonly emit: (dispatch: (event: InteractiveEvent) => void, event: InteractiveEvent) => void
  readonly flushProjection: Effect.Effect<void>
  readonly appendProjection: (
    turn: Turn.Turn,
    events: ReadonlyArray<ExecutionBackend.Event>,
  ) => Effect.Effect<void, TranscriptRepository.RepositoryError, TranscriptRepository.Service>
  readonly persistProjectionTree: (
    turn: Turn.Turn,
    force: boolean,
  ) => Effect.Effect<
    void,
    TranscriptRepository.RepositoryError | ExecutionBackend.BackendError,
    TranscriptRepository.Service | ExecutionBackend.Service
  >
  readonly isTerminalStatus: (status: Turn.Status) => boolean
  readonly turnObserverAdmission: Semaphore.Semaphore
  readonly observedTurns: Set<string>
  readonly releaseTurnObserver: (turnId: Turn.TurnId) => Effect.Effect<boolean, never, never>
  readonly executionDependencies: Context.Context<QueueRequirements>
  readonly dependencyContext: Context.Context<TurnRepository.Service>
  readonly acquiredBackend: ExecutionBackend.Interface
}

type QueuedClaimAdmission =
  | { readonly _tag: "Claimed"; readonly claim: TurnRepository.QueueClaim }
  | { readonly _tag: "Collision"; readonly claim: TurnRepository.QueueClaim }
  | undefined

export const makeInteractiveQueue = (dependencies: InteractiveQueueDependencies) => {
  const {
    prepareExecution,
    emit,
    notifyThreadSummaries,
    notifyTurnChanged,
    setTurnStatus,
    flushProjection,
    projectExecutionResult,
    appendProjection,
    persistProjectionTree,
    isTerminalStatus,
    turnObserverAdmission,
    observedTurns,
    releaseTurnObserver,
    executionDependencies,
    dependencyContext,
    acquiredBackend,
  } = dependencies
  const readQueue = Effect.fn("Operation.interactive.readQueue")(function* (
    threadId: Thread.ThreadId,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    const turns = yield* TurnRepository.Service
    const queue = yield* turns.readQueue(threadId)
    dispatch({
      _tag: "QueueUpdated",
      selectionEpoch: 0,
      threadId,
      revision: queue.revision,
      queuedCount: queue.queuedCount,
      change: { _tag: "Reset", items: queue.turns.map(queueItem) },
    })
  })
  const drainQueued = Effect.fn("Operation.interactive.drainQueued")(function* (
    thread: Thread.Thread,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    const turns = yield* TurnRepository.Service
    const backend = yield* ExecutionBackend.Service
    let claimed = 0
    const runPromoted = Effect.fn("Operation.interactive.runPromoted")(function* (claim: TurnRepository.QueueClaim) {
      const promotedTurn = claim.turn
      const executionRoute = promotedTurn.executionRoute
      const deliveredCursors = new Set<string>()
      const outcome = yield* Effect.gen(function* () {
        const prepared = yield* prepareExecution(promotedTurn, thread.workspace, false)
        if (prepared.messages.length > 0)
          emit(dispatch, {
            _tag: "ContextDiagnostics",
            selectionEpoch: 0,
            threadId: thread.id,
            turnId: promotedTurn.id,
            messages: prepared.messages,
          })
        const promotedAt = yield* Clock.currentTimeMillis
        const transition = yield* turns.finishQueuedClaim(
          claim,
          "running",
          promotedTurn.lastCursor,
          prepared.extensionPin,
          promotedAt,
        )
        if (transition._tag === "Unavailable") return undefined
        yield* notifyThreadSummaries
        yield* notifyTurnChanged(transition.turn)
        const runningTurn = transition.turn
        emit(dispatch, queueMutationEvent(transition.queue))
        if (runningTurn.status !== "running") return undefined
        emit(dispatch, {
          _tag: "TurnStarted",
          selectionEpoch: 0,
          threadId: thread.id,
          turn: runningTurn,
        })
        const result = yield* backend.start({
          threadId: thread.id,
          turnId: promotedTurn.id,
          prompt: prepared.prompt,
          ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
          startedAt: promotedAt,
          executionRoute,
          onEvent: (event) => {
            deliveredCursors.add(event.cursor)
            emit(dispatch, transcriptPatch(promotedTurn, event))
          },
          ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
        })
        return result
      }).pipe(
        Effect.map((value) => ({ _tag: "Success" as const, value })),
        Effect.catch((error) => Effect.succeed({ _tag: "Failure" as const, error })),
        Effect.onInterrupt(() => turns.releaseQueuedClaim(claim)),
      )
      if (outcome._tag === "Failure") {
        const current = yield* turns.get(promotedTurn.id)
        if (current?.status === "running")
          yield* setTurnStatus(promotedTurn.id, "failed", promotedTurn.lastCursor, yield* Clock.currentTimeMillis)
        else {
          const transition = yield* turns.finishQueuedClaim(
            claim,
            "failed",
            promotedTurn.lastCursor,
            promotedTurn.extensionPin,
            yield* Clock.currentTimeMillis,
          )
          if (transition._tag === "Unavailable") return true
          yield* notifyThreadSummaries
          yield* notifyTurnChanged(transition.turn)
          emit(dispatch, queueMutationEvent(transition.queue))
        }
        yield* flushProjection
        emit(dispatch, {
          _tag: "ExecutionFailed",
          selectionEpoch: 0,
          threadId: thread.id,
          turnId: promotedTurn.id,
          message: String(outcome.error),
        })
        return true
      }
      const result = outcome.value
      if (result === undefined) return true
      for (const event of result.events)
        if (!deliveredCursors.has(event.cursor)) emit(dispatch, transcriptPatch(promotedTurn, event))
      const updatedTurn = yield* setTurnStatus(
        promotedTurn.id,
        result.status,
        ThreadActivity.latestCursor(result.events),
        yield* Clock.currentTimeMillis,
      )
      yield* projectExecutionResult(thread.id, result)
      yield* appendProjection(updatedTurn, result.events)
      yield* persistProjectionTree(updatedTurn, true)
      return isTerminalStatus(result.status)
    })
    const runNext = Effect.fn("Operation.interactive.runNextQueued")(function* () {
      return yield* Effect.uninterruptibleMask((restore) =>
        turnObserverAdmission
          .withPermits(1)(
            Effect.gen(function* () {
              const promoted = yield* turns.claimNextQueued(thread.id, yield* Clock.currentTimeMillis)
              if (promoted === undefined) return undefined
              const key = String(promoted.turn.id)
              if (observedTurns.has(key)) return { _tag: "Collision" as const, claim: promoted }
              observedTurns.add(key)
              return { _tag: "Claimed" as const, claim: promoted }
            }),
          )
          .pipe(
            Effect.flatMap((claim: QueuedClaimAdmission) =>
              claim === undefined
                ? Effect.void
                : claim._tag === "Collision"
                  ? Effect.gen(function* () {
                      yield* turns.releaseQueuedClaim(claim.claim)
                      return false
                    })
                  : restore(runPromoted(claim.claim)).pipe(Effect.ensuring(releaseTurnObserver(claim.claim.turn.id))),
            ),
          ),
      )
    })
    while (true) {
      const keepDraining = yield* runNext()
      if (keepDraining === undefined) break
      claimed += 1
      if (!keepDraining) break
    }
    return claimed
  })
  const promoterFor =
    (dispatch: (event: InteractiveEvent) => void) =>
    (threadId: string, generation: number): Effect.Effect<number> =>
      Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        if (!(yield* turns.consumeQueueWake(Thread.ThreadId.make(threadId), generation))) return 0
        const thread = yield* threads.get(Thread.ThreadId.make(threadId))
        if (thread === undefined) return 0
        return yield* drainQueued(thread, dispatch)
      }).pipe(
        Effect.provide(executionDependencies),
        Effect.scoped,
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            const turns = Context.get(dependencyContext, TurnRepository.Service)
            const wake = yield* turns.requestQueueWake(Thread.ThreadId.make(threadId))
            if (wake !== undefined && acquiredBackend.wakeThreadHost !== undefined)
              yield* acquiredBackend.wakeThreadHost({ ...wake, now: yield* Clock.currentTimeMillis })
          }).pipe(Effect.orElseSucceed(() => undefined)),
        ),
        Effect.catch(() =>
          Effect.gen(function* () {
            const turns = Context.get(dependencyContext, TurnRepository.Service)
            const wake = yield* turns.requestQueueWake(Thread.ThreadId.make(threadId))
            if (wake !== undefined && acquiredBackend.wakeThreadHost !== undefined)
              yield* acquiredBackend.wakeThreadHost({ ...wake, now: yield* Clock.currentTimeMillis })
            return 0
          }).pipe(Effect.orElseSucceed(() => 0)),
        ),
      )
  const promoteThread = Effect.fn("Operation.interactive.promoteThread")(function* (
    thread: Thread.Thread,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    const backend = yield* ExecutionBackend.Service
    if (backend.wakeThreadHost === undefined || backend.registerTurnPromoter === undefined) {
      yield* drainQueued(thread, dispatch)
      return
    }
    const turns = yield* TurnRepository.Service
    const wake = yield* turns.requestQueueWake(thread.id)
    if (wake === undefined) return
    const now = yield* Clock.currentTimeMillis
    yield* backend.wakeThreadHost({ ...wake, now })
  })
  const settleThread = Effect.fn("Operation.interactive.settleThread")(function* (
    thread: Thread.Thread,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    yield* promoteThread(thread, dispatch).pipe(
      Effect.catch(() => drainQueued(thread, dispatch).pipe(Effect.asVoid)),
      Effect.orElseSucceed(() => undefined),
    )
  })
  return { readQueue, drainQueued, promoterFor, promoteThread, settleThread }
}

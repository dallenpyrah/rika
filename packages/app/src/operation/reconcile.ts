import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { ExecutionExtensions, PluginRegistry } from "@rika/extensions"
import { Clock, Effect } from "effect"
import * as ResolvedContext from "../resolved-context"
import * as ThreadActivity from "../thread-activity"
import { OperationError, operationError } from "./options"
const isTerminalStatus = (status: Turn.Status) =>
  status === "completed" || status === "failed" || status === "cancelled"

const reconcileInternal = Effect.fn("Operation.reconcile")(function* (
  extensions?: ExecutionExtensions.Interface,
  prepare?: (
    turn: Turn.Turn,
    workspace: string,
  ) => Effect.Effect<
    {
      readonly prompt: string
      readonly promptParts: ReadonlyArray<Turn.PromptPart> | undefined
      readonly extensionPin: Turn.ExecutionExtensionPin | undefined
    },
    OperationError,
    TurnRepository.Service | ThreadRepository.Service | ResolvedContext.Service | ExecutionExtensions.Service
  >,
  watchReviewOwner?: (
    turn: Turn.Turn,
    inspection: ExecutionBackend.FanOutInspection,
  ) => Effect.Effect<void, OperationError>,
  ownership?: {
    readonly claim: (
      turn: Pick<Turn.Turn, "id" | "status">,
    ) => Effect.Effect<boolean, TurnRepository.RepositoryError, TurnRepository.Service>
    readonly release: (turnId: Turn.TurnId) => Effect.Effect<boolean>
    readonly claimQueued: (
      threadId: Thread.ThreadId,
      now: number,
    ) => Effect.Effect<TurnRepository.QueueClaim | undefined, TurnRepository.RepositoryError, TurnRepository.Service>
  },
  repairQueues: boolean = true,
): Effect.fn.Return<
  void,
  | OperationError
  | ExecutionBackend.BackendError
  | TurnRepository.RepositoryError
  | ThreadRepository.RepositoryError
  | PluginRegistry.GenerationUnavailable,
  | ExecutionBackend.Service
  | TurnRepository.Service
  | ThreadRepository.Service
  | ResolvedContext.Service
  | ExecutionExtensions.Service
> {
  const turns = yield* TurnRepository.Service
  const backend = yield* ExecutionBackend.Service
  const active = yield* turns.listNonterminal
  const skipRepair = (turn: Turn.Turn) =>
    Effect.logInfo("execution.repair.skipped").pipe(
      Effect.annotateLogs({
        "rika.turn.id": String(turn.id),
        "rika.turn.expected_status": turn.status,
        "rika.failure.kind": "turn-status-changed-or-observed",
      }),
    )
  yield* Effect.forEach(
    active.filter((turn) => turn.status !== "queued"),
    (turn) => {
      const repair =
        turn.reviewFanOutId !== undefined
          ? backend.inspectFanOut(turn.reviewFanOutId).pipe(
              Effect.flatMap((inspection) =>
                Effect.gen(function* () {
                  const status =
                    inspection === undefined
                      ? "failed"
                      : inspection.state === "joining"
                        ? "running"
                        : inspection.state === "satisfied"
                          ? "completed"
                          : inspection.state
                  yield* turns.setStatus(turn.id, status, turn.lastCursor, yield* Clock.currentTimeMillis)
                  if (inspection?.state === "joining" && watchReviewOwner !== undefined)
                    yield* watchReviewOwner(turn, inspection)
                }),
              ),
              Effect.catch((error) =>
                Effect.gen(function* () {
                  yield* turns.setStatus(turn.id, "failed", turn.lastCursor, yield* Clock.currentTimeMillis)
                  return yield* error
                }),
              ),
            )
          : backend.inspect(turn.id).pipe(
              Effect.flatMap((inspection) =>
                Effect.gen(function* () {
                  const now = yield* Clock.currentTimeMillis
                  if (inspection === undefined) {
                    if (prepare === undefined && extensions !== undefined && turn.extensionPin === undefined)
                      return yield* operationError(`Turn ${turn.id} has no durable extension pin`)
                    if (prepare === undefined && extensions !== undefined && turn.extensionPin !== undefined)
                      yield* extensions.resume(turn.extensionPin)
                    const prepared =
                      prepare === undefined
                        ? { prompt: turn.prompt, promptParts: turn.promptParts, extensionPin: turn.extensionPin }
                        : yield* (yield* ThreadRepository.Service)
                            .get(turn.threadId)
                            .pipe(
                              Effect.flatMap((thread) =>
                                thread === undefined
                                  ? operationError(`Thread ${turn.threadId} does not exist`)
                                  : prepare(turn, thread.workspace),
                              ),
                            )
                    const result = yield* backend.start({
                      threadId: turn.threadId,
                      turnId: turn.id,
                      prompt: prepared.prompt,
                      ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
                      startedAt: turn.updatedAt,
                      executionRoute: turn.executionRoute,
                      ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
                    })
                    yield* turns.setStatus(
                      turn.id,
                      result.status,
                      ThreadActivity.latestCursor(result.events) ?? turn.lastCursor,
                      now,
                    )
                    return
                  }
                  yield* turns.setStatus(turn.id, inspection.status, inspection.lastCursor ?? turn.lastCursor, now)
                }),
              ),
              Effect.catch((error) =>
                Effect.gen(function* () {
                  yield* turns.setStatus(turn.id, "failed", turn.lastCursor, yield* Clock.currentTimeMillis)
                  return yield* error
                }),
              ),
            )
      if (ownership === undefined)
        return turns
          .get(turn.id)
          .pipe(Effect.flatMap((current) => (current?.status === turn.status ? repair : skipRepair(turn))))
      return Effect.uninterruptibleMask((restore) =>
        ownership
          .claim(turn)
          .pipe(
            Effect.flatMap((claimed) =>
              claimed ? restore(repair).pipe(Effect.ensuring(ownership.release(turn.id))) : skipRepair(turn),
            ),
          ),
      )
    },
    { discard: true },
  )
  const threadIds = [...new Set(active.map((turn) => turn.threadId))]
  if (backend.wakeThreadHost !== undefined) {
    yield* Effect.forEach(
      threadIds,
      (threadId) =>
        Effect.gen(function* () {
          const wake = yield* turns.requestQueueWake(threadId)
          if (wake === undefined) return
          const now = yield* Clock.currentTimeMillis
          yield* backend.wakeThreadHost!({ ...wake, now })
        }),
      { discard: true },
    )
    return
  }
  if (!repairQueues) return
  yield* Effect.forEach(
    threadIds,
    (threadId) =>
      Effect.gen(function* () {
        const thread = prepare === undefined ? undefined : yield* (yield* ThreadRepository.Service).get(threadId)
        if (prepare !== undefined && thread === undefined) return
        const executePromoted = (claim: TurnRepository.QueueClaim) =>
          Effect.gen(function* () {
            const promotedTurn = claim.turn
            const prepared = yield* prepare === undefined
              ? Effect.succeed({
                  prompt: promotedTurn.prompt,
                  promptParts: promotedTurn.promptParts,
                  extensionPin: promotedTurn.extensionPin,
                })
              : prepare(promotedTurn, thread!.workspace)
            const transition = yield* turns.finishQueuedClaim(
              claim,
              "running",
              promotedTurn.lastCursor,
              prepared.extensionPin,
              yield* Clock.currentTimeMillis,
            )
            if (transition._tag === "Unavailable") return undefined
            return yield* backend
              .start({
                threadId,
                turnId: promotedTurn.id,
                prompt: prepared.prompt,
                ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
                startedAt: promotedTurn.updatedAt,
                executionRoute: promotedTurn.executionRoute,
                ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    yield* turns.setStatus(
                      promotedTurn.id,
                      "failed",
                      promotedTurn.lastCursor,
                      yield* Clock.currentTimeMillis,
                    )
                    return yield* error
                  }),
                ),
              )
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                const current = yield* turns.get(claim.turn.id)
                if (current?.status === "queued")
                  yield* turns.finishQueuedClaim(
                    claim,
                    "failed",
                    claim.turn.lastCursor,
                    claim.turn.extensionPin,
                    yield* Clock.currentTimeMillis,
                  )
                return yield* error
              }),
            ),
            Effect.onInterrupt(() => turns.releaseQueuedClaim(claim)),
          )
        while (true) {
          let promotedTurn: TurnRepository.QueueClaim
          let result: ExecutionBackend.Result
          if (ownership === undefined) {
            const promoted = yield* turns.claimNextQueued(threadId, yield* Clock.currentTimeMillis)
            if (promoted === undefined) return
            promotedTurn = promoted
            const executionResult = yield* executePromoted(promoted)
            if (executionResult === undefined) continue
            result = executionResult
          } else {
            const repaired = yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const promoted = yield* ownership.claimQueued(threadId, yield* Clock.currentTimeMillis)
                if (promoted === undefined) return undefined
                const executionResult = yield* restore(executePromoted(promoted)).pipe(
                  Effect.ensuring(ownership.release(promoted.turn.id)),
                )
                return { promoted, result: executionResult }
              }),
            )
            if (repaired === undefined) return
            if (repaired.result === undefined) continue
            promotedTurn = repaired.promoted
            result = repaired.result
          }
          yield* turns.setStatus(
            promotedTurn.turn.id,
            result.status,
            ThreadActivity.latestCursor(result.events),
            yield* Clock.currentTimeMillis,
          )
          if (!isTerminalStatus(result.status)) return
        }
      }),
    { discard: true },
  )
})

export const internal = { reconcileInternal }

export const reconcile = Effect.fn("Operation.reconcilePublic")(function* (
  extensions?: ExecutionExtensions.Interface,
  prepare?: (
    turn: Turn.Turn,
    workspace: string,
  ) => Effect.Effect<
    {
      readonly prompt: string
      readonly promptParts: ReadonlyArray<Turn.PromptPart> | undefined
      readonly extensionPin: Turn.ExecutionExtensionPin | undefined
    },
    OperationError,
    TurnRepository.Service | ThreadRepository.Service | ResolvedContext.Service | ExecutionExtensions.Service
  >,
  watchReviewOwner?: (
    turn: Turn.Turn,
    inspection: ExecutionBackend.FanOutInspection,
  ) => Effect.Effect<void, OperationError>,
): Effect.fn.Return<
  void,
  OperationError,
  | ExecutionBackend.Service
  | TurnRepository.Service
  | ThreadRepository.Service
  | ResolvedContext.Service
  | ExecutionExtensions.Service
> {
  return yield* reconcileInternal(extensions, prepare, watchReviewOwner).pipe(
    Effect.mapError((error) => operationError(String(error))),
  )
})

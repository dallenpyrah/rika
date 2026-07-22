import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { ExecutionExtensions } from "@rika/extensions"
import * as ThreadSummaryRepository from "@rika/persistence/thread-summary-repository"
import { Clock, Console, Context, Deferred, Effect, Fiber } from "effect"
import { Input, type InteractiveEvent } from "../operation-contract"
import * as ResolvedContext from "../resolved-context"
import * as ThreadActivity from "../thread-activity"
import type { ExecutionCoordination } from "./execution-coordination"
import type { ProductLayerOptions } from "./options"
import { operationError } from "./options"
import { internal as executionProjection, rootExecutionEvents } from "./execution-projection"
import { internal as threadFormat } from "./thread-format"
const { persistExecutionTree, transcriptPatch } = executionProjection
const { queueMutationEvent, unavailable } = threadFormat

type RunInput = Extract<Input, { readonly _tag: "Run" }>

type ExecutionServices =
  | ThreadRepository.Service
  | TurnRepository.Service
  | ThreadSummaryRepository.Service
  | TranscriptRepository.Service
  | ResolvedContext.Service
  | ExecutionExtensions.Service
  | ExecutionBackend.Service

interface RunOperationDependencies<
  ThreadError,
  TurnError,
  BackendError,
  ThreadSummaryError,
  TranscriptError,
  OwnerError,
  OwnerRequirements,
> extends Pick<
    ExecutionCoordination,
    "ensureTurnSummary" | "prepareExecution" | "projectExecutionResult" | "resolveExecutionRoute" | "setTurnStatus"
  > {
  readonly options: ProductLayerOptions<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>
  readonly pendingTurnCapacity: number
  readonly executionDependencies: Context.Context<ExecutionServices>
  readonly owner: {
    readonly followClaimed: ((turnId: Turn.TurnId) => Effect.Effect<void, OwnerError, OwnerRequirements>) | undefined
  }
  readonly claimQueuedTurn: (
    threadId: Thread.ThreadId,
    now: number,
  ) => Effect.Effect<TurnRepository.QueueClaim | undefined, TurnRepository.RepositoryError, TurnRepository.Service>
  readonly releaseTurnObserver: (turnId: Turn.TurnId) => Effect.Effect<boolean>
  readonly publishInteractiveActivity: (origin: number, event: InteractiveEvent) => void
  readonly createObservedSubmission: (
    turns: TurnRepository.Interface,
    input: TurnRepository.CreateInput,
  ) => Effect.Effect<
    { readonly turn: TurnRepository.Submission; readonly claimed: boolean },
    TurnRepository.RepositoryError | TurnRepository.QueueFull
  >
}

export const makeRunOperation = <
  ThreadError,
  TurnError,
  BackendError,
  ThreadSummaryError,
  TranscriptError,
  OwnerError,
  OwnerRequirements,
>(
  dependencies: RunOperationDependencies<
    ThreadError,
    TurnError,
    BackendError,
    ThreadSummaryError,
    TranscriptError,
    OwnerError,
    OwnerRequirements
  >,
) => {
  const {
    options,
    pendingTurnCapacity,
    executionDependencies,
    owner,
    claimQueuedTurn,
    releaseTurnObserver,
    publishInteractiveActivity,
    prepareExecution,
    setTurnStatus,
    projectExecutionResult,
    createObservedSubmission,
    ensureTurnSummary,
    resolveExecutionRoute,
  } = dependencies
  return Effect.fn("Operation.run")(function* (input: RunInput) {
    const program = Effect.gen(function* () {
      const threads = yield* ThreadRepository.Service
      const turns = yield* TurnRepository.Service
      const backend = yield* ExecutionBackend.Service
      const now = yield* Clock.currentTimeMillis
      const thread =
        input.threadId === undefined
          ? yield* threads.create({
              id: yield* options.makeThreadId,
              workspace: input.workspace ?? options.defaultWorkspace,
              title: input.prompt.join(" ").slice(0, 80) || "New thread",
              now,
            })
          : yield* threads
              .get(Thread.ThreadId.make(input.threadId))
              .pipe(
                Effect.flatMap((existingThread) =>
                  existingThread === undefined
                    ? operationError(`Thread ${input.threadId} does not exist`)
                    : Effect.succeed(existingThread),
                ),
              )
      const runTurn = Effect.fn("Operation.runTurn")(function* (
        turn: Turn.Turn,
        preparedInput?: {
          readonly prompt: string
          readonly promptParts: ReadonlyArray<Turn.PromptPart> | undefined
          readonly extensionPin: Turn.ExecutionExtensionPin | undefined
        },
      ) {
        const startedAt = yield* Clock.currentTimeMillis
        const deliveredCursors = new Set<string>()
        let directDelivery = true
        let receivedDirectEvent = false
        yield* Effect.logInfo("turn.started").pipe(
          Effect.annotateLogs({
            "rika.thread.id": String(thread.id),
            "rika.turn.id": String(turn.id),
          }),
        )
        const execution = yield* Effect.gen(function* () {
          const prepared = preparedInput ?? (yield* prepareExecution(turn, thread.workspace))
          const runningTurn = yield* setTurnStatus(turn.id, "running", turn.lastCursor, startedAt)
          publishInteractiveActivity(0, {
            _tag: "TurnStarted",
            selectionEpoch: 0,
            threadId: thread.id,
            turn: runningTurn,
          })
          const startCompleted = yield* Deferred.make<void>()
          const started = yield* Effect.forkChild(
            backend
              .start({
                threadId: turn.threadId,
                turnId: turn.id,
                prompt: prepared.prompt,
                startedAt,
                executionRoute: turn.executionRoute,
                onEvent: (event) => {
                  if (!directDelivery) return
                  receivedDirectEvent = true
                  deliveredCursors.add(event.cursor)
                  publishInteractiveActivity(0, transcriptPatch(turn, event))
                },
                ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
              })
              .pipe(Effect.ensuring(Deferred.succeed(startCompleted, undefined))),
          )
          let followed = false
          while (true) {
            if (receivedDirectEvent || (yield* Deferred.isDone(startCompleted))) break
            if ((yield* backend.inspect(turn.id)) !== undefined) {
              for (let attempts = 0; attempts < 100; attempts += 1) {
                if (receivedDirectEvent) break
                yield* Effect.yieldNow
              }
              if (!receivedDirectEvent && !(yield* Deferred.isDone(startCompleted))) directDelivery = false
              break
            }
            yield* Effect.yieldNow
          }
          if (!directDelivery && owner.followClaimed !== undefined)
            while (!(yield* Deferred.isDone(startCompleted))) {
              const outcome = yield* Effect.exit(owner.followClaimed(turn.id))
              if (outcome._tag === "Success") {
                followed = true
                break
              }
              yield* Effect.sleep("10 millis")
            }
          return { result: yield* Fiber.join(started), followed }
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const failedAt = yield* Clock.currentTimeMillis
              yield* Effect.logError("turn.failed").pipe(
                Effect.annotateLogs({
                  "rika.duration.ms": failedAt - startedAt,
                  "rika.failure.kind": error instanceof Error ? error.name : typeof error,
                  "rika.thread.id": String(thread.id),
                  "rika.turn.id": String(turn.id),
                }),
              )
              yield* setTurnStatus(turn.id, "failed", turn.lastCursor, failedAt)
              return yield* error
            }),
          ),
        )
        const { result, followed } = execution
        const completedAt = yield* Clock.currentTimeMillis
        yield* Effect.logInfo("turn.finished").pipe(
          Effect.annotateLogs({
            "rika.duration.ms": completedAt - startedAt,
            "rika.thread.id": String(thread.id),
            "rika.turn.id": String(turn.id),
            "rika.turn.status": result.status,
          }),
        )
        if (!followed) {
          for (const event of result.events)
            if (!directDelivery || !deliveredCursors.has(event.cursor))
              publishInteractiveActivity(0, transcriptPatch(turn, event))
          const updated = yield* setTurnStatus(
            turn.id,
            result.status,
            ThreadActivity.latestCursor(result.events),
            completedAt,
          )
          yield* projectExecutionResult(thread.id, result)
          yield* (yield* TranscriptRepository.Service).appendAll(
            updated,
            rootExecutionEvents(updated.id, result.events),
          )
          yield* persistExecutionTree(updated, true)
        }
        return result
      })
      const drainRunQueue = Effect.fn("Operation.drainRunQueue")(function* () {
        while (true) {
          const promoted = yield* claimQueuedTurn(thread.id, yield* Clock.currentTimeMillis)
          if (promoted === undefined) return
          const prepared = yield* prepareExecution(promoted.turn, thread.workspace, false).pipe(
            Effect.map((value): { readonly _tag: "Success"; readonly value: typeof value } => ({
              _tag: "Success",
              value,
            })),
            Effect.catch((error) =>
              Effect.succeed<{ readonly _tag: "Failure"; readonly error: typeof error }>({
                _tag: "Failure",
                error,
              }),
            ),
            Effect.onInterrupt(() =>
              turns.releaseQueuedClaim(promoted).pipe(Effect.andThen(releaseTurnObserver(promoted.turn.id))),
            ),
          )
          if (prepared._tag === "Failure") {
            const transition = yield* turns.finishQueuedClaim(
              promoted,
              "failed",
              promoted.turn.lastCursor,
              promoted.turn.extensionPin,
              yield* Clock.currentTimeMillis,
            )
            if (transition._tag === "Transitioned") publishInteractiveActivity(0, queueMutationEvent(transition.queue))
            yield* releaseTurnObserver(promoted.turn.id)
            continue
          }
          const transition = yield* turns.finishQueuedClaim(
            promoted,
            "running",
            promoted.turn.lastCursor,
            prepared.value.extensionPin,
            yield* Clock.currentTimeMillis,
          )
          if (transition._tag === "Unavailable") {
            yield* releaseTurnObserver(promoted.turn.id)
            continue
          }
          publishInteractiveActivity(0, queueMutationEvent(transition.queue))
          yield* runTurn(transition.turn, prepared.value).pipe(Effect.ensuring(releaseTurnObserver(transition.turn.id)))
        }
      })
      yield* drainRunQueue()
      const turnId = yield* options.makeTurnId
      const prompt = input.prompt.join(" ")
      const observed = yield* createObservedSubmission(turns, {
        id: turnId,
        threadId: thread.id,
        prompt,
        executionRoute: yield* resolveExecutionRoute(input.mode ?? "medium", undefined, thread.workspace),
        queueCapacity: pendingTurnCapacity,
        now,
      })
      const submitted = observed.turn
      yield* ensureTurnSummary(submitted)
      yield* Effect.logInfo("turn.accepted").pipe(
        Effect.annotateLogs({
          "rika.thread.id": String(thread.id),
          "rika.turn.id": String(submitted.id),
          "rika.turn.status": submitted.status,
        }),
      )
      if (submitted.status === "queued") return
      if (!observed.claimed) return yield* operationError(`Turn ${submitted.id} already has an execution observer`)
      const result = yield* runTurn(submitted).pipe(Effect.ensuring(releaseTurnObserver(submitted.id)))
      yield* drainRunQueue()
      if (input.streamJson) {
        yield* Effect.forEach(result.events, (event) => Console.log(JSON.stringify(event)), { discard: true })
        return
      }
      const text = result.events
        .filter((event) => event.type === "model.output.completed")
        .map((event) => event.text ?? "")
        .join("")
      yield* Console.log(text)
    })
    yield* program.pipe(
      Effect.provide(executionDependencies),
      Effect.scoped,
      Effect.mapError((error) => unavailable(input, String(error))),
    )
    return
  })
}

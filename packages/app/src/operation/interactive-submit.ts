import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as ThreadSummaryRepository from "@rika/persistence/thread-summary-repository"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { ExecutionExtensions } from "@rika/extensions"
import { Cause, Clock, Context, Effect, Ref, Scope, Semaphore } from "effect"
import * as ResolvedContext from "../resolved-context"
import * as ThreadActivity from "../thread-activity"
import type { InteractiveEvent } from "../operation-contract"
import type { ExecutionCoordination } from "./execution-coordination"
import { internal as executionProjection } from "./execution-projection"
import type { ProductLayerOptions } from "./options"
import { operationError } from "./options"
import { internal as threadFormat } from "./thread-format"
const { transcriptPatch } = executionProjection
const { queueMutationEvent } = threadFormat

type ExecutionServices =
  | ThreadRepository.Service
  | TurnRepository.Service
  | ThreadSummaryRepository.Service
  | TranscriptRepository.Service
  | ResolvedContext.Service
  | ExecutionExtensions.Service
  | ExecutionBackend.Service

type CoordinatedSubmissionDependencies = Pick<
  ExecutionCoordination,
  | "notifyThreadSummaries"
  | "resolveExecutionRoute"
  | "ensureTurnSummary"
  | "prepareExecution"
  | "setTurnStatus"
  | "projectExecutionResult"
  | "titleThread"
  | "notifyTurnChanged"
>

interface InteractiveSubmitDependencies<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>
  extends CoordinatedSubmissionDependencies {
  readonly options: ProductLayerOptions<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>
  readonly workspace: string
  readonly interactiveThread: Ref.Ref<Thread.Thread | undefined>
  readonly selectionState: { selectedThreadId: string | undefined }
  readonly activateChildFollowers: (threadId: Thread.ThreadId) => Effect.Effect<void>
  readonly emit: (dispatch: (event: InteractiveEvent) => void, event: InteractiveEvent) => void
  readonly createObservedSubmission: (
    turns: TurnRepository.Interface,
    input: TurnRepository.CreateInput,
  ) => Effect.Effect<
    { readonly turn: TurnRepository.Submission; readonly claimed: boolean },
    TurnRepository.RepositoryError | TurnRepository.QueueFull
  >
  readonly pendingTurnCapacity: number
  readonly appendProjection: (
    turn: Turn.Turn,
    events: ReadonlyArray<ExecutionBackend.Event>,
  ) => Effect.Effect<void, TranscriptRepository.RepositoryError, TranscriptRepository.Service>
  readonly persistProjectionTree: (
    turn: Turn.Turn,
    force: boolean,
  ) => Effect.Effect<
    void,
    ExecutionBackend.BackendError | TranscriptRepository.RepositoryError,
    ExecutionBackend.Service | TranscriptRepository.Service
  >
  readonly settleThread: (
    thread: Thread.Thread,
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<void, never, ExecutionServices>
  readonly flushProjection: Effect.Effect<void>
  readonly executionDependencies: Context.Context<ExecutionServices>
  readonly releaseTurnObserver: (turnId: Turn.TurnId) => Effect.Effect<boolean>
  readonly dispatchFailure: (dispatch: (event: InteractiveEvent) => void, error: unknown) => void
  readonly submissionAdmission: Semaphore.Semaphore
  readonly sessionScope: Scope.Scope
}

const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  if (failure !== null && typeof failure === "object" && "_tag" in failure && typeof failure._tag === "string")
    return failure._tag
  if (failure instanceof Error) return failure.name
  return typeof failure
}

const temporaryThreadTitle = (prompt: string) => [...prompt].slice(0, 80).join("") || "New thread"

export const makeInteractiveSubmit = <ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>(
  dependencies: InteractiveSubmitDependencies<
    ThreadError,
    TurnError,
    BackendError,
    ThreadSummaryError,
    TranscriptError
  >,
) => {
  const {
    options,
    workspace,
    interactiveThread,
    selectionState,
    activateChildFollowers,
    emit,
    notifyThreadSummaries,
    resolveExecutionRoute,
    createObservedSubmission,
    pendingTurnCapacity,
    ensureTurnSummary,
    prepareExecution,
    setTurnStatus,
    projectExecutionResult,
    appendProjection,
    persistProjectionTree,
    settleThread,
    titleThread,
    flushProjection,
    executionDependencies,
    releaseTurnObserver,
    notifyTurnChanged,
    dispatchFailure,
    submissionAdmission,
    sessionScope,
  } = dependencies
  let shellPermissionSequence = 0
  const submit = Effect.fn("Operation.interactive.submit")(function* (
    prompt: string,
    dispatch: (event: InteractiveEvent) => void,
    mode: "low" | "medium" | "high" | "ultra" = "medium",
    promptParts?: ReadonlyArray<Turn.PromptPart>,
    modelTuning?: { readonly fastMode?: boolean },
  ) {
    let observerTurn: Turn.Turn | undefined
    let executionLaunched = false
    const program = Effect.gen(function* () {
      const threads = yield* ThreadRepository.Service
      const turns = yield* TurnRepository.Service
      const backend = yield* ExecutionBackend.Service
      const now = yield* Clock.currentTimeMillis
      let thread = yield* Ref.get(interactiveThread)
      const isNewThread = thread === undefined
      if (thread === undefined) {
        thread = yield* threads.create({
          id: yield* options.makeThreadId,
          workspace,
          title: temporaryThreadTitle(prompt),
          now,
        })
        yield* Ref.set(interactiveThread, thread)
        selectionState.selectedThreadId = String(thread.id)
        yield* activateChildFollowers(thread.id)
      }
      if (isNewThread) dispatch({ _tag: "ThreadActivated", threadId: String(thread.id), title: thread.title })
      const isFirstTurn = (yield* turns.list(thread.id)).length === 0
      const firstTurnTitle = temporaryThreadTitle(prompt)
      if (isFirstTurn && thread.title === "New thread" && firstTurnTitle !== thread.title) {
        const renamed = yield* threads.renameIfTitle(thread.id, "New thread", firstTurnTitle, now)
        if (renamed !== undefined) {
          thread = renamed
          emit(dispatch, { _tag: "ThreadTitled", threadId: String(thread.id), title: thread.title })
          yield* notifyThreadSummaries
        }
      }
      const turnId = yield* options.makeTurnId
      const executionRoute = yield* resolveExecutionRoute(mode, modelTuning, thread.workspace)
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const observed = yield* createObservedSubmission(turns, {
            id: turnId,
            threadId: thread.id,
            prompt,
            ...(promptParts === undefined ? {} : { promptParts }),
            executionRoute,
            queueCapacity: pendingTurnCapacity,
            now,
          })
          const turn = observed.turn
          if (turn.status !== "queued") {
            if (!observed.claimed) return yield* operationError(`Turn ${turn.id} already has an execution observer`)
            observerTurn = turn
          }
          yield* ensureTurnSummary(turn)
          yield* Effect.logInfo("turn.accepted").pipe(
            Effect.annotateLogs({
              "rika.thread.id": String(thread.id),
              "rika.turn.id": String(turn.id),
              "rika.turn.status": turn.status,
            }),
          )
          if (turn.status === "queued") {
            if (turn.queue !== undefined) emit(dispatch, queueMutationEvent(turn.queue))
            return
          }
          const execution = Effect.gen(function* () {
            const startedAt = yield* Clock.currentTimeMillis
            const deliveredCursors = new Set<string>()
            const outcome = yield* Effect.exit(
              Effect.gen(function* () {
                yield* Effect.logInfo("turn.started")
                const prepared = yield* prepareExecution(turn, thread.workspace)
                if (prepared.messages.length > 0)
                  emit(dispatch, {
                    _tag: "ContextDiagnostics",
                    selectionEpoch: 0,
                    threadId: thread.id,
                    turnId: turn.id,
                    messages: prepared.messages,
                  })
                const runningTurn = yield* setTurnStatus(turn.id, "running", turn.lastCursor, startedAt)
                if (runningTurn.status !== "running") return undefined
                emit(dispatch, { _tag: "TurnStarted", selectionEpoch: 0, threadId: thread.id, turn: runningTurn })
                return yield* backend.start({
                  threadId: thread.id,
                  turnId: turn.id,
                  prompt: prepared.prompt,
                  ...(prepared.promptParts === undefined ? {} : { promptParts: prepared.promptParts }),
                  startedAt,
                  executionRoute: turn.executionRoute,
                  ...(modelTuning?.fastMode === undefined ? {} : { fastMode: modelTuning.fastMode }),
                  onEvent: (event) => {
                    deliveredCursors.add(event.cursor)
                    emit(dispatch, transcriptPatch(turn, event))
                  },
                  ...(prepared.extensionPin === undefined ? {} : { extensionPin: prepared.extensionPin }),
                })
              }).pipe(Effect.annotateLogs({ "rika.thread.id": String(thread.id), "rika.turn.id": String(turn.id) })),
            )
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                if (outcome._tag === "Failure") {
                  yield* flushProjection
                  const failedAt = yield* Clock.currentTimeMillis
                  yield* Effect.logError("turn.failed").pipe(
                    Effect.annotateLogs({
                      "rika.duration.ms": failedAt - startedAt,
                      "rika.failure.kind": failureKind(outcome.cause),
                      "rika.thread.id": String(thread.id),
                      "rika.turn.id": String(turn.id),
                    }),
                  )
                  yield* setTurnStatus(turn.id, "failed", turn.lastCursor, failedAt)
                  emit(dispatch, {
                    _tag: "ExecutionFailed",
                    selectionEpoch: 0,
                    threadId: thread.id,
                    turnId: turn.id,
                    message: String(outcome.cause),
                  })
                  yield* settleThread(thread, dispatch)
                  return
                }
                const result = outcome.value
                if (result === undefined) {
                  yield* settleThread(thread, dispatch)
                  return
                }
                for (const event of result.events)
                  if (!deliveredCursors.has(event.cursor)) emit(dispatch, transcriptPatch(turn, event))
                const completedAt = yield* Clock.currentTimeMillis
                yield* Effect.logInfo("turn.finished").pipe(
                  Effect.annotateLogs({
                    "rika.duration.ms": completedAt - startedAt,
                    "rika.thread.id": String(thread.id),
                    "rika.turn.id": String(turn.id),
                    "rika.turn.status": result.status,
                  }),
                )
                const updatedTurn = yield* setTurnStatus(
                  turn.id,
                  result.status,
                  ThreadActivity.latestCursor(result.events),
                  completedAt,
                )
                yield* projectExecutionResult(thread.id, result)
                yield* appendProjection(updatedTurn, result.events)
                yield* persistProjectionTree(updatedTurn, true)
                if (result.status === "completed") {
                  yield* settleThread(thread, dispatch)
                  if (isFirstTurn)
                    yield* Effect.interruptible(
                      titleThread(thread, updatedTurn, (event: InteractiveEvent) => emit(dispatch, event)),
                    )
                  return
                }
                if (result.status === "waiting" || result.status === "running" || result.status === "queued") return
                if (result.status === "failed" && !result.events.some((event) => event.type === "execution.failed"))
                  emit(dispatch, {
                    _tag: "ExecutionFailed",
                    selectionEpoch: 0,
                    threadId: thread.id,
                    turnId: turn.id,
                    message: `Execution ${result.status}`,
                  })
                yield* settleThread(thread, dispatch)
              }),
            )
          }).pipe(
            Effect.provide(executionDependencies),
            Effect.scoped,
            Effect.tapCause((cause) =>
              Effect.logError("interactive.submit.failed").pipe(
                Effect.annotateLogs("rika.failure.kind", failureKind(cause)),
              ),
            ),
            Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error))),
            Effect.ensuring(releaseTurnObserver(turn.id).pipe(Effect.andThen(notifyTurnChanged(turn)))),
          )
          yield* Effect.forkIn(Effect.interruptible(execution), sessionScope)
          executionLaunched = true
        }),
      )
    })
    yield* submissionAdmission
      .withPermits(1)(program)
      .pipe(
        Effect.provide(executionDependencies),
        Effect.scoped,
        Effect.tapCause((cause) =>
          Effect.logError("interactive.submit.failed").pipe(
            Effect.annotateLogs("rika.failure.kind", failureKind(cause)),
          ),
        ),
        Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error))),
        Effect.ensuring(
          Effect.suspend(() =>
            observerTurn === undefined || executionLaunched
              ? Effect.void
              : releaseTurnObserver(observerTurn.id).pipe(Effect.andThen(notifyTurnChanged(observerTurn))),
          ),
        ),
      )
  })
  return { submit, nextShellPermissionId: () => `shell-permission-${shellPermissionSequence++}` }
}

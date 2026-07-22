import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as ThreadSummaryRepository from "@rika/persistence/thread-summary-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { ExecutionExtensions } from "@rika/extensions"
import { Clock, Deferred, Effect, Exit, Fiber, PubSub, Queue, Ref, Schema, Semaphore, Scope } from "effect"
import * as ResolvedContext from "../resolved-context"
import * as ThreadActivity from "../thread-activity"
import { OperationUnavailable } from "../operation-contract"
import type { InteractiveEvent, InteractiveSession } from "../operation-contract"
import { internal as executionProjection, rootExecutionEvents } from "./execution-projection"
const { persistExecutionTree, transcriptPatch } = executionProjection
import { operationError } from "./options"
import { makeInteractiveHistory } from "./interactive-history"
import { interactiveEventThreadId, makeInteractiveFeed } from "./interactive-feed"
import { makeInteractiveChildFollowers } from "./interactive-child-followers"
import { makeInteractiveQueue } from "./interactive-queue"
import { makeInteractiveCommands } from "./interactive-commands"
import { makeInteractiveSubmit } from "./interactive-submit"
import type { InteractiveSessionFactoryDependencies } from "./interactive-session-input"

const isTerminalStatus = (
  status: "accepted" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled",
) => status === "completed" || status === "failed" || status === "cancelled"

const ignoreInteractiveEvent = (_event: InteractiveEvent) => {}

export const makeInteractiveSessionFactory = <
  ThreadError,
  TurnError,
  BackendError,
  ThreadSummaryError,
  TranscriptError,
>(
  dependencies: InteractiveSessionFactoryDependencies<
    ThreadError,
    TurnError,
    BackendError,
    ThreadSummaryError,
    TranscriptError
  >,
) => {
  const {
    options,
    pendingTurnCapacity,
    turnMutationAdmission,
    createForSubmission,
    turnChanges,
    interactiveSinks,
    releaseTurnObserver,
    createObservedSubmission,
    publishInteractiveActivity,
    acquiredBackend,
    executionDependencies,
    currentUsageCosts,
    displayGlobalCostUsd,
    loadUsageCosts,
    notifyThreadSummaries,
    titleThread,
    notifyTurnChanged,
    dispatchThreadSummaries,
    ensureTurnSummary,
    projectExecutionResult,
    setTurnStatus,
    resolveExecutionRoute,
    prepareExecution,
    nextSessionId,
    currentActivitySequence,
    observeUsageCosts,
    turnObserverAdmission,
    observedTurns,
    dependencyContext,
  } = dependencies
  return Effect.fn("Operation.makeInteractiveSession")(function* (
    workspace: string,
    settings: {
      readonly initialThreadId?: string
      readonly registerPromoter?: boolean
    } = {},
  ) {
    const registerPromoter = settings.registerPromoter ?? false
    yield* loadUsageCosts
    const sessionId = nextSessionId()
    const selectionRequest = yield* Ref.make(0)
    const {
      sessionEvents,
      historyState,
      feedState,
      bufferSelectionEvent,
      deliver,
      sessionDispatch,
      selectionDispatch,
      finishSelection,
      setObserveChildSpawn,
    } = yield* makeInteractiveFeed({
      ...(settings.initialThreadId === undefined ? {} : { initialThreadId: settings.initialThreadId }),
      selectionRequest,
      currentUsageCosts,
      displayGlobalCostUsd,
      observeUsageCosts,
    })
    const dispatchFailure = (dispatch: (event: InteractiveEvent) => void, error: unknown) =>
      Schema.is(TurnRepository.QueueFull)(error)
        ? dispatch({
            _tag: "QueueFull",
            selectionEpoch: 0,
            threadId: error.threadId,
            capacity: error.capacity,
            count: error.count,
          })
        : dispatch({ _tag: "ExecutionFailed", selectionEpoch: 0, message: String(error) })
    const emit = (dispatch: (event: InteractiveEvent) => void, event: InteractiveEvent) => {
      dispatch(event)
      publishInteractiveActivity(sessionId, event)
    }
    const submissionAdmission = yield* Semaphore.make(1)
    const shellPermission =
      typeof options.shellPermission === "function"
        ? yield* options.shellPermission(workspace)
        : (options.shellPermission ?? "allow")
    let shellPermissionAlways = shellPermission === "allow"
    const interactiveThread = yield* Ref.make<Thread.Thread | undefined>(undefined)
    const transcriptCursor = yield* Ref.make<TranscriptRepository.PageCursor | undefined>(undefined)
    const projectedTurnCursor = yield* Ref.make<TurnRepository.PageCursor | undefined>(undefined)
    const transcriptHasUnprojectedTurns = yield* Ref.make(false)
    const transcriptHasOlder = yield* Ref.make(false)
    const projectionAdmission = yield* Semaphore.make(1)
    const persistProjectionTree = (turn: Turn.Turn, force: boolean) =>
      projectionAdmission.withPermits(1)(persistExecutionTree(turn, force))
    const appendProjection = (turn: Turn.Turn, events: ReadonlyArray<ExecutionBackend.Event>) =>
      projectionAdmission.withPermits(1)(
        Effect.gen(function* () {
          const transcripts = yield* TranscriptRepository.Service
          yield* transcripts.appendAll(turn, rootExecutionEvents(turn.id, events))
        }),
      )
    const flushProjection = Effect.void
    const shellApprovals = new Map<string, Deferred.Deferred<boolean>>()
    const lifecycleAdmission = yield* Semaphore.make(1)
    const closed = yield* Deferred.make<void>()
    const sessionScope = yield* Scope.make()
    const {
      activateChildFollowers,
      enqueueChildFollower,
      observeChildSpawn: childSpawnObserver,
    } = yield* makeInteractiveChildFollowers({
      ...(settings.initialThreadId === undefined ? {} : { initialThreadId: settings.initialThreadId }),
      acquiredBackend,
      sessionDispatch,
      publishInteractiveActivity,
      sessionId,
      sessionScope,
    })
    const { readQueue, drainQueued, promoterFor, settleThread } = makeInteractiveQueue({
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
    })
    setObserveChildSpawn(childSpawnObserver)
    let lifecycle: "open" | "closed" = "open"
    let feedAttached = false
    const sessionClosed = OperationUnavailable.make({
      operation: "InteractiveSession",
      message: "Interactive session is closed",
    })
    const admit = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | OperationUnavailable, R> =>
      lifecycleAdmission
        .withPermits(1)(
          Effect.suspend(() => (lifecycle === "open" ? Effect.succeed(effect) : Effect.fail(sessionClosed))),
        )
        .pipe(Effect.flatten)
    const runOwned = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.forkIn(effect, sessionScope).pipe(
        Effect.flatMap((fiber) => Fiber.join(fiber).pipe(Effect.ensuring(Fiber.interrupt(fiber)))),
      )
    const admitLocal = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | OperationUnavailable, R> =>
      effect.pipe(runOwned, admit)
    const attachFeed = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | OperationUnavailable, R> =>
      lifecycleAdmission
        .withPermits(1)(
          Effect.suspend(() => {
            if (lifecycle === "closed") return Effect.fail(sessionClosed)
            if (feedAttached)
              return Effect.fail(
                OperationUnavailable.make({
                  operation: "InteractiveSession.events",
                  message: "Interactive session already has an event consumer",
                }),
              )
            feedAttached = true
            const attached = effect.pipe(Effect.ensuring(Effect.sync(() => (feedAttached = false))))
            return Effect.succeed(runOwned(attached))
          }),
        )
        .pipe(Effect.flatten)
    const { submit, nextShellPermissionId } = makeInteractiveSubmit({
      options,
      workspace,
      interactiveThread,
      selectionState: {
        set selectedThreadId(value: string | undefined) {
          historyState.selectedThreadId = value
        },
      },
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
    })
    const safe = <E>(
      dispatch: (event: InteractiveEvent) => void,
      effect: Effect.Effect<
        void,
        E,
        | ThreadRepository.Service
        | TurnRepository.Service
        | ThreadSummaryRepository.Service
        | TranscriptRepository.Service
        | ExecutionBackend.Service
        | ResolvedContext.Service
        | ExecutionExtensions.Service
      >,
    ) =>
      effect.pipe(
        Effect.provide(executionDependencies),
        Effect.scoped,
        Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error))),
      )
    const active = Effect.fn("Operation.interactive.active")(function* () {
      const thread = yield* Ref.get(interactiveThread)
      if (thread === undefined) return yield* operationError("No thread selected")
      const turns = yield* TurnRepository.Service
      const turn = yield* turns.findActive(thread.id)
      if (turn === undefined) return yield* operationError("No active turn")
      return turn
    })
    const threadForTurn = Effect.fn("Operation.interactive.threadForTurn")(function* (turn: Turn.Turn) {
      const thread = yield* (yield* ThreadRepository.Service).get(turn.threadId)
      if (thread === undefined) return yield* operationError(`Thread ${turn.threadId} does not exist`)
      return thread
    })
    const followClaimedTurn = Effect.fn("Operation.interactive.followClaimedTurn")(function* (
      turnId: Turn.TurnId,
      dispatch: (event: InteractiveEvent) => void,
    ) {
      const turns = yield* TurnRepository.Service
      const backend = yield* ExecutionBackend.Service
      if (backend.follow === undefined) return
      const follow = backend.follow
      const turn = yield* turns.get(turnId)
      if (turn === undefined) return yield* operationError(`Turn ${turnId} does not exist`)
      const thread = yield* threadForTurn(turn)
      const deliveredCursors = new Set<string>()
      const result = yield* follow(turn.id, turn.lastCursor, (event) => {
        deliveredCursors.add(event.cursor)
        emit(dispatch, transcriptPatch(turn, event))
      })
      for (const event of result.events)
        if (!deliveredCursors.has(event.cursor)) {
          emit(dispatch, transcriptPatch(turn, event))
        }
      const updatedTurn = yield* setTurnStatus(
        turn.id,
        result.status,
        ThreadActivity.latestCursor(result.events) ?? turn.lastCursor,
        yield* Clock.currentTimeMillis,
      )
      yield* projectExecutionResult(turn.threadId, result)
      yield* appendProjection(updatedTurn, result.events)
      yield* persistProjectionTree(updatedTurn, true)
      if (isTerminalStatus(result.status)) {
        yield* settleThread(thread, dispatch)
        if (result.status === "completed" && (yield* turns.list(thread.id))[0]?.id === updatedTurn.id)
          yield* titleThread(thread, updatedTurn, (event) => emit(dispatch, event))
      } else if (result.status !== "waiting" && result.status !== "running" && result.status !== "queued")
        emit(dispatch, {
          _tag: "ExecutionFailed",
          selectionEpoch: 0,
          threadId: turn.threadId,
          turnId: turn.id,
          message: `Execution ${result.status}`,
        })
    })
    const followTurn = Effect.fn("Operation.interactive.followTurn")(function* (
      turnId: Turn.TurnId,
      dispatch: (event: InteractiveEvent) => void,
    ) {
      return yield* Effect.uninterruptibleMask((restore) =>
        turnObserverAdmission
          .withPermits(1)(
            Effect.gen(function* () {
              const key = String(turnId)
              if (observedTurns.has(key)) return undefined
              const turns = yield* TurnRepository.Service
              const current = yield* turns.get(turnId)
              if (current === undefined || current.status === "queued" || isTerminalStatus(current.status))
                return undefined
              observedTurns.add(key)
              return current
            }),
          )
          .pipe(
            Effect.flatMap((current) =>
              current === undefined
                ? Effect.succeed(false)
                : restore(followClaimedTurn(current.id, dispatch)).pipe(
                    Effect.as(true),
                    Effect.ensuring(releaseTurnObserver(current.id)),
                  ),
            ),
          ),
      )
    })
    const observeTurn = Effect.fn("Operation.interactive.observeTurn")(function* (
      turn: Turn.Turn,
      dispatch: (event: InteractiveEvent) => void,
    ) {
      const backend = yield* ExecutionBackend.Service
      if ((yield* backend.inspect(turn.id)) === undefined) return false
      return yield* Effect.uninterruptibleMask((restore) =>
        turnObserverAdmission
          .withPermits(1)(
            Effect.gen(function* () {
              const key = String(turn.id)
              if (observedTurns.has(key)) return undefined
              const turns = yield* TurnRepository.Service
              const current = yield* turns.get(turn.id)
              if (current === undefined || current.status === "queued" || isTerminalStatus(current.status))
                return undefined
              observedTurns.add(key)
              return current
            }),
          )
          .pipe(
            Effect.flatMap((current) =>
              current === undefined
                ? Effect.succeed(false)
                : restore(followClaimedTurn(current.id, dispatch)).pipe(
                    Effect.as(true),
                    Effect.ensuring(releaseTurnObserver(current.id)),
                  ),
            ),
          ),
      )
    })
    const { loadTranscriptPage, loadThread, createAndSelectThread } = makeInteractiveHistory({
      options,
      workspace,
      state: historyState,
      selectionRequest,
      transcriptCursor,
      projectedTurnCursor,
      transcriptHasUnprojectedTurns,
      transcriptHasOlder,
      interactiveThread,
      projectionAdmission,
      appendProjection,
      persistProjectionTree,
      activateChildFollowers,
      enqueueChildFollower,
      currentUsageCosts,
      displayGlobalCostUsd,
      currentActivitySequence,
      notifyThreadSummaries,
      sessionDispatch,
    })
    const supervise =
      acquiredBackend.follow === undefined
        ? Effect.void
        : Effect.scoped(
            Effect.gen(function* () {
              const changes = yield* PubSub.subscribe(turnChanges)
              const turns = yield* TurnRepository.Service
              const launch = (turn: Turn.Turn) =>
                Effect.forkChild(
                  observeTurn(turn, () => undefined).pipe(
                    Effect.flatMap((observed) => {
                      if (!observed) return Effect.void
                      return turns
                        .get(turn.id)
                        .pipe(
                          Effect.flatMap((current) =>
                            current !== undefined && !isTerminalStatus(current.status) && current.status !== "queued"
                              ? Effect.sleep("50 millis").pipe(Effect.andThen(notifyTurnChanged(current)))
                              : Effect.void,
                          ),
                        )
                    }),
                    Effect.catch((error) =>
                      Effect.logError("turn.observer.failed").pipe(
                        Effect.annotateLogs({
                          "rika.thread.id": String(turn.threadId),
                          "rika.turn.id": String(turn.id),
                          "rika.failure.kind": String(error),
                        }),
                        Effect.andThen(Effect.sleep("50 millis")),
                        Effect.andThen(notifyTurnChanged(turn)),
                      ),
                    ),
                  ),
                )
              const scan = Effect.gen(function* () {
                for (const turn of yield* turns.listNonterminal) if (turn.status !== "queued") yield* launch(turn)
              })
              yield* scan
              while (true) {
                yield* PubSub.take(changes)
                yield* scan
              }
            }),
          ).pipe(Effect.provide(executionDependencies))
    if (!registerPromoter)
      interactiveSinks.set(sessionId, (_origin, event) => {
        const threadId = interactiveEventThreadId(event)
        if (threadId !== undefined && bufferSelectionEvent(event)) return
        if (
          threadId === undefined ||
          threadId === historyState.selectedThreadId ||
          event._tag === "TitleCostUpdated" ||
          (event._tag === "TranscriptPatched" && event.event.type === "model.usage.reported")
        )
          deliver(event, { selectedThreadOnly: threadId !== undefined && event._tag !== "TitleCostUpdated" })
      })
    const commandDependencies = {
      options,
      workspace,
      dispatchThreadSummaries,
      sessionDispatch,
      executionDependencies,
      feedState,
      sessionEvents,
      selectionRequest,
      interactiveEventThreadId,
      historyState,
      submit,
      safe,
      submissionAdmission,
      createAndSelectThread,
      shellState: {
        permission: shellPermission,
        get permissionAlways() {
          return shellPermissionAlways
        },
        set permissionAlways(value) {
          shellPermissionAlways = value
        },
      },
      shellApprovals,
      closed,
      createForSubmission,
      resolveExecutionRoute,
      pendingTurnCapacity,
      nextShellPermissionId,
      ensureTurnSummary,
      emit,
      setTurnStatus,
      dispatchFailure,
      sessionScope,
      turnMutationAdmission,
      active,
      threadForTurn,
      drainQueued,
      projectExecutionResult,
      activateChildFollowers,
      settleThread,
      followTurn,
      loadThread,
      selectionDispatch,
      finishSelection,
      readQueue,
      transcriptHasOlder,
      interactiveThread,
      transcriptCursor,
      loadTranscriptPage,
    }
    const implementation = makeInteractiveCommands(commandDependencies)
    const session: InteractiveSession = {
      events: (dispatch) => attachFeed(implementation.events(dispatch)),
      submit: (prompt, mode, parts, tuning) => admit(implementation.submit(prompt, mode, parts, tuning)),
      newThread: admitLocal(implementation.newThread),
      shell: (command, incognito) => admitLocal(implementation.shell(command, incognito)),
      editQueued: (turnId, prompt) => admitLocal(implementation.editQueued(turnId, prompt)),
      dequeue: (turnId) => admitLocal(implementation.dequeue(turnId)),
      steerQueued: (turnId, text) => admitLocal(implementation.steerQueued(turnId, text)),
      steer: (text) => admitLocal(implementation.steer(text)),
      interruptAndSend: (prompt) => admitLocal(implementation.interruptAndSend(prompt)),
      cancel: admitLocal(implementation.cancel),
      resolvePermission: (waitId, kind, decision) =>
        admitLocal(implementation.resolvePermission(waitId, kind, decision)),
      selectThread: (threadId, epoch) => admitLocal(implementation.selectThread(threadId, epoch)),
      readQueue: (threadId) => admitLocal(implementation.readQueue(threadId)),
      loadOlder: admitLocal(implementation.loadOlder),
      previewThread: (threadId) => admitLocal(implementation.previewThread(threadId)),
      reopenThread: (epoch) => admitLocal(implementation.reopenThread(epoch)),
      replay: (turnId, afterCursor) => admitLocal(implementation.replay(turnId, afterCursor)),
    }
    const backend = acquiredBackend
    if (registerPromoter && backend.registerTurnPromoter !== undefined)
      yield* backend.registerTurnPromoter(promoterFor(() => undefined))
    return {
      session,
      supervise,
      followClaimed:
        acquiredBackend.follow === undefined
          ? undefined
          : (turnId: Turn.TurnId) => followClaimedTurn(turnId, ignoreInteractiveEvent),
      close: lifecycleAdmission.withPermits(1)(
        Effect.suspend(() => {
          if (lifecycle === "closed") return Effect.void
          lifecycle = "closed"
          interactiveSinks.delete(sessionId)
          const approvals = [...shellApprovals.values()]
          shellApprovals.clear()
          return Effect.forEach(approvals, (approval) => Deferred.succeed(approval, false), { discard: true }).pipe(
            Effect.andThen(Deferred.succeed(closed, undefined)),
            Effect.andThen(Queue.shutdown(sessionEvents)),
            Effect.andThen(Scope.close(sessionScope, Exit.void)),
          )
        }),
      ),
    }
  })
}

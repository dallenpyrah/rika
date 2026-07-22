import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Runtime as ToolRuntime } from "@rika/tools"
import { Clock, Context, Deferred, Effect, Layer, Queue, Ref, Schema } from "effect"
import * as InteractiveFeedOverflow from "../interactive-feed-overflow"
import * as ThreadActivity from "../thread-activity"
import { OperationUnavailable } from "../operation-contract"
import type { InteractiveSession } from "../operation-contract"
import { internal as executionProjection } from "./execution-projection"
import { operationError } from "./options"
import { internal as threadFormat } from "./thread-format"
const { activeDescendantExecutionIds, childTranscriptPatch } = executionProjection
const { queueMutationEvent } = threadFormat
import type { InteractiveCommandInput } from "./interactive-command-input"

const isTerminalStatus = (
  status: "accepted" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled",
) => status === "completed" || status === "failed" || status === "cancelled"

const noExecutionEvents: ReadonlyArray<ExecutionBackend.Event> = []

export const makeInteractiveCommands = <ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>(
  dependencies: InteractiveCommandInput<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>,
): InteractiveSession => {
  const {
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
    shellState,
    shellApprovals,
    closed,
    createForSubmission,
    resolveExecutionRoute,
    pendingTurnCapacity,
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
    nextShellPermissionId,
  } = dependencies
  return {
    events: (dispatch) =>
      Effect.gen(function* () {
        yield* dispatchThreadSummaries(sessionDispatch)
        while (true) {
          if (feedState.overflow !== undefined) {
            const state = feedState.overflow
            for (const discarded of yield* Queue.takeAll(sessionEvents))
              InteractiveFeedOverflow.remember(state, discarded.event)
            feedState.overflow = undefined
            if (state.criticalOverflowed)
              return yield* OperationUnavailable.make({
                operation: "InteractiveSession.events",
                message: "Interactive event feed exceeded its bounded non-recoverable event capacity",
              })
            for (const event of InteractiveFeedOverflow.events(
              state,
              yield* Ref.get(selectionRequest),
              "Interactive event feed exceeded its bounded live window",
            ))
              dispatch(event)
            continue
          }
          const envelope = yield* Queue.take(sessionEvents)
          if (feedState.overflow !== undefined) {
            InteractiveFeedOverflow.remember(feedState.overflow, envelope.event)
            continue
          }
          if (
            envelope.selectionRequest !== undefined &&
            envelope.selectionRequest !== (yield* Ref.get(selectionRequest))
          )
            continue
          if (envelope.selectedThreadOnly === true) {
            const threadId = interactiveEventThreadId(envelope.event)
            if (threadId !== undefined && threadId !== historyState.selectedThreadId) continue
          }
          dispatch(envelope.event)
        }
      }).pipe(
        Effect.provide(executionDependencies),
        Effect.mapError((error) =>
          Schema.is(OperationUnavailable)(error)
            ? error
            : OperationUnavailable.make({ operation: "InteractiveSession.events", message: String(error) }),
        ),
      ),
    submit: (prompt, mode, parts, tuning) => submit(prompt, sessionDispatch, mode, parts, tuning),
    newThread: safe(
      sessionDispatch,
      submissionAdmission.withPermits(1)(Effect.uninterruptible(createAndSelectThread(undefined))),
    ),
    shell: (command, incognito) => {
      const dispatch = sessionDispatch
      if (shellState.permission === "deny") {
        dispatch({ _tag: "ExecutionFailed", selectionEpoch: 0, message: "Shell command denied" })
        return Effect.void
      }
      const toolRuntimeLayer = options.toolRuntimeLayer?.(workspace)
      if (toolRuntimeLayer === undefined) {
        dispatch({ _tag: "ExecutionFailed", selectionEpoch: 0, message: "Shell runtime is unavailable" })
        return Effect.void
      }
      const program = Effect.gen(function* () {
        if (!shellState.permissionAlways) {
          const permissionId = nextShellPermissionId()
          const approval = yield* Deferred.make<boolean>()
          shellApprovals.set(permissionId, approval)
          dispatch({ _tag: "ShellPermissionRequested", id: permissionId, command })
          const approved = yield* Effect.raceFirst(
            Deferred.await(approval),
            Deferred.await(closed).pipe(Effect.as(false)),
          ).pipe(Effect.ensuring(Effect.sync(() => shellApprovals.delete(permissionId))))
          if (!approved) {
            dispatch({ _tag: "ExecutionFailed", selectionEpoch: 0, message: "Shell command denied" })
            return
          }
        }
        const tools = yield* ToolRuntime.Service
        const result = yield* tools.run({
          _tag: "Shell",
          command: "sh",
          args: ["-lc", command],
          waitMillis: 120_000,
        })
        const text = result.text
        if (!incognito) {
          const threads = yield* ThreadRepository.Service
          const turns = yield* TurnRepository.Service
          const now = yield* Clock.currentTimeMillis
          let thread = yield* Ref.get(interactiveThread)
          if (thread === undefined) {
            thread = yield* threads.create({
              id: yield* options.makeThreadId,
              workspace,
              title: `$ ${command}`.slice(0, 80),
              now,
            })
            yield* Ref.set(interactiveThread, thread)
            historyState.selectedThreadId = String(thread.id)
          }
          const turn = yield* createForSubmission(turns, {
            id: yield* options.makeTurnId,
            threadId: thread.id,
            prompt: `$ ${command}\n\n<shell-result>\n${text}\n</shell-result>`,
            executionRoute: yield* resolveExecutionRoute("medium", undefined, thread.workspace),
            queueCapacity: pendingTurnCapacity,
            now,
          })
          yield* ensureTurnSummary(turn)
          if (turn.status === "queued") {
            if (turn.queue !== undefined) emit(dispatch, queueMutationEvent(turn.queue))
          } else yield* setTurnStatus(turn.id, "completed", undefined, yield* Clock.currentTimeMillis)
        }
        dispatch({ _tag: "ShellCompleted", command, text, incognito })
      })
      return Effect.gen(function* () {
        const toolContext = yield* Layer.build(toolRuntimeLayer)
        yield* program.pipe(
          Effect.provide(Context.merge(executionDependencies, toolContext)),
          Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error))),
        )
      }).pipe(
        Effect.scoped,
        Effect.catch((error) => Effect.sync(() => dispatchFailure(dispatch, error))),
        Effect.forkIn(sessionScope),
        Effect.asVoid,
      )
    },
    editQueued: (id, prompt) =>
      safe(
        sessionDispatch,
        Effect.gen(function* () {
          const turns = yield* TurnRepository.Service
          const turn = yield* turns.editQueued(Turn.TurnId.make(id), prompt, yield* Clock.currentTimeMillis)
          emit(sessionDispatch, queueMutationEvent(turn.queue))
        }),
      ),
    dequeue: (id) =>
      safe(
        sessionDispatch,
        Effect.gen(function* () {
          const turns = yield* TurnRepository.Service
          emit(sessionDispatch, queueMutationEvent(yield* turns.dequeue(Turn.TurnId.make(id))))
        }),
      ),
    steerQueued: (id, text) =>
      safe(
        sessionDispatch,
        turnMutationAdmission.withPermits(1)(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const turns = yield* TurnRepository.Service
              const backend = yield* ExecutionBackend.Service
              const turn = yield* active(undefined)
              const candidate = yield* turns.get(Turn.TurnId.make(id))
              if (
                candidate?.status === "queued" &&
                candidate.promptParts !== undefined &&
                candidate.promptParts.some((part) => part.type === "image")
              )
                return yield* operationError("Queued turns with images cannot be steered")
              const taken = yield* turns.takeQueued(Turn.TurnId.make(id))
              const queued = taken.turn
              const steeringText =
                queued.promptParts
                  ?.filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("") ??
                queued.prompt ??
                text
              emit(sessionDispatch, queueMutationEvent(taken.queue))
              const outcome = yield* Effect.exit(
                restore(backend.steer(turn.id, steeringText, yield* Clock.currentTimeMillis)),
              )
              if (outcome._tag === "Failure") {
                const requeued = yield* turns.copy(queued, pendingTurnCapacity)
                if (requeued.queue === undefined)
                  return yield* operationError(`Turn ${queued.id} was not restored to its queue`)
                emit(sessionDispatch, queueMutationEvent(requeued.queue))
                return yield* Effect.failCause(outcome.cause)
              }
              emit(sessionDispatch, {
                _tag: "ExecutionControlled",
                selectionEpoch: 0,
                threadId: turn.threadId,
                turnId: turn.id,
                action: "steered",
              })
            }),
          ),
        ),
      ),
    steer: (text) =>
      safe(
        sessionDispatch,
        Effect.gen(function* () {
          const backend = yield* ExecutionBackend.Service
          const turn = yield* active(undefined)
          yield* backend.steer(turn.id, text, yield* Clock.currentTimeMillis)
          emit(sessionDispatch, {
            _tag: "ExecutionControlled",
            selectionEpoch: 0,
            threadId: turn.threadId,
            turnId: turn.id,
            action: "steered",
          })
        }),
      ),
    interruptAndSend: (prompt) =>
      safe(
        sessionDispatch,
        Effect.gen(function* () {
          const turns = yield* TurnRepository.Service
          const backend = yield* ExecutionBackend.Service
          const turn = yield* active(undefined)
          const thread = yield* threadForTurn(turn)
          const pending = yield* createForSubmission(turns, {
            id: yield* options.makeTurnId,
            threadId: turn.threadId,
            prompt,
            executionRoute: turn.executionRoute,
            queueCapacity: pendingTurnCapacity,
            now: yield* Clock.currentTimeMillis,
          })
          yield* ensureTurnSummary(pending)
          if (pending.status === "accepted") {
            const requeued = yield* turns.requeueAccepted(
              pending.id,
              pendingTurnCapacity,
              yield* Clock.currentTimeMillis,
            )
            emit(sessionDispatch, queueMutationEvent(requeued.queue))
            yield* drainQueued(thread, sessionDispatch)
            return
          }
          if (pending.status !== "queued") return yield* operationError("Pending turn was not queued")
          if (pending.queue !== undefined) emit(sessionDispatch, queueMutationEvent(pending.queue))
          if (turn.status !== "accepted") yield* backend.cancel(turn.id, yield* Clock.currentTimeMillis)
          yield* setTurnStatus(turn.id, "cancelled", turn.lastCursor, yield* Clock.currentTimeMillis)
          yield* drainQueued(thread, sessionDispatch)
        }),
      ),
    cancel: safe(
      sessionDispatch,
      Effect.gen(function* () {
        const localApprovals = [...shellApprovals.entries()]
        if (localApprovals.length > 0) {
          for (const [id, approval] of localApprovals) {
            shellApprovals.delete(id)
            yield* Deferred.succeed(approval, false)
            sessionDispatch({ _tag: "ShellPermissionCancelled", id })
          }
          sessionDispatch({ _tag: "ExecutionControlled", selectionEpoch: 0, action: "cancelled" })
          return
        }
        const backend = yield* ExecutionBackend.Service
        const turn = yield* active(undefined).pipe(Effect.orElseSucceed(() => undefined))
        if (turn === undefined) {
          sessionDispatch({ _tag: "ExecutionControlled", selectionEpoch: 0, action: "cancelled" })
          return
        }
        const thread = yield* threadForTurn(turn)
        const cancelledAt = yield* Clock.currentTimeMillis
        const childIds =
          turn.status === "accepted"
            ? []
            : yield* activeDescendantExecutionIds(backend, turn.id).pipe(Effect.orElseSucceed(() => []))
        const result: ExecutionBackend.Result =
          turn.status === "accepted"
            ? { turnId: turn.id, status: "cancelled", events: noExecutionEvents }
            : yield* backend.cancel(turn.id, cancelledAt)
        const cancellationOrder = childIds.toReversed()
        const childOutcomes = yield* Effect.forEach(
          cancellationOrder,
          (childId) => Effect.result(backend.cancel(childId, cancelledAt, ExecutionBackend.executionReference)),
          { concurrency: "unbounded" },
        )
        for (const [index, outcome] of childOutcomes.entries()) {
          const childId = cancellationOrder[index]!
          if (outcome._tag === "Success") {
            for (const event of outcome.success.events)
              sessionDispatch(childTranscriptPatch(thread.id, childId, turn.id, event))
          } else
            yield* Effect.logError("child-execution.cancel.failed").pipe(
              Effect.annotateLogs({
                "rika.execution.id": childId,
                "rika.failure.kind": String(outcome.failure),
              }),
            )
        }
        yield* setTurnStatus(
          turn.id,
          result.status,
          ThreadActivity.latestCursor(result.events) ?? turn.lastCursor,
          yield* Clock.currentTimeMillis,
        )
        yield* projectExecutionResult(turn.threadId, result)
        if (isTerminalStatus(result.status)) yield* activateChildFollowers(thread.id)
        emit(sessionDispatch, {
          _tag: "ExecutionControlled",
          selectionEpoch: 0,
          threadId: turn.threadId,
          turnId: turn.id,
          action: "cancelled",
        })
        if (isTerminalStatus(result.status)) yield* settleThread(thread, sessionDispatch)
      }),
    ),
    resolvePermission: (waitId, kind, decision) =>
      shellApprovals.has(waitId)
        ? Effect.gen(function* () {
            const approval = shellApprovals.get(waitId)
            if (decision === "always") shellState.permissionAlways = true
            if (approval !== undefined) yield* Deferred.succeed(approval, decision !== "deny")
            sessionDispatch({ _tag: "ExecutionControlled", selectionEpoch: 0, action: "permission-resolved" })
          })
        : safe(
            sessionDispatch,
            Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              const activeTurn = yield* active(undefined)
              const resolvedAt = yield* Clock.currentTimeMillis
              if (kind === "tool-approval") yield* backend.resolveToolApproval(waitId, decision !== "deny", resolvedAt)
              else
                yield* backend.resolvePermission(
                  waitId,
                  decision === "allow" ? "Approved" : decision === "deny" ? "Denied" : "Always",
                  resolvedAt,
                )
              emit(sessionDispatch, {
                _tag: "ExecutionControlled",
                selectionEpoch: 0,
                threadId: activeTurn.threadId,
                turnId: activeTurn.id,
                action: "permission-resolved",
              })
              yield* followTurn(activeTurn.id, sessionDispatch)
            }),
          ),
    selectThread: (id, epoch) =>
      safe(
        sessionDispatch,
        Effect.gen(function* () {
          if (epoch <= historyState.currentSelectionEpoch) return
          const previousThread = yield* Ref.get(interactiveThread)
          const previousEpoch = historyState.currentSelectionEpoch
          historyState.currentSelectionEpoch = epoch
          historyState.selectedThreadId = id
          const joined =
            historyState.selectionLoad?.epoch === 0 && historyState.selectionLoad.threadId === id
              ? historyState.selectionLoad
              : undefined
          historyState.selectionLoad = {
            epoch,
            threadId: id,
            previousEpoch,
            previousThreadId: previousThread === undefined ? undefined : String(previousThread.id),
            events: joined?.events ?? [],
            committed: false,
            ...(joined?.overflow === undefined ? {} : { overflow: joined.overflow }),
          }
          yield* Ref.set(selectionRequest, epoch)
          const threads = yield* ThreadRepository.Service
          const thread = yield* threads.get(Thread.ThreadId.make(id))
          if (thread === undefined) return yield* operationError(`Thread ${id} does not exist`)
          yield* loadThread(thread, epoch, selectionDispatch(epoch))
        }).pipe(Effect.ensuring(finishSelection(epoch))),
      ),
    readQueue: (id) =>
      safe(
        sessionDispatch,
        Ref.get(selectionRequest).pipe(
          Effect.flatMap((request) => readQueue(Thread.ThreadId.make(id), selectionDispatch(request))),
        ),
      ),
    loadOlder: safe(
      sessionDispatch,
      Effect.gen(function* () {
        if (!(yield* Ref.get(transcriptHasOlder))) return
        const thread = yield* Ref.get(interactiveThread)
        const before = yield* Ref.get(transcriptCursor)
        if (thread === undefined || before === undefined) return
        const request = yield* Ref.get(selectionRequest)
        yield* loadTranscriptPage(thread, request, selectionDispatch(request), before)
      }),
    ),
    previewThread: (id) =>
      Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        const backend = yield* ExecutionBackend.Service
        const thread = yield* threads.get(Thread.ThreadId.make(id))
        if (thread === undefined) return
        const history = yield* turns.list(thread.id)
        const recent = history.filter((turn) => turn.status !== "queued").slice(-4)
        const previewTurns = yield* Effect.forEach(recent, (turn) =>
          backend.inspect(turn.id).pipe(
            Effect.flatMap((execution) =>
              execution === undefined
                ? Effect.succeed({ prompt: turn.prompt, events: noExecutionEvents })
                : backend
                    .replay(turn.id)
                    .pipe(Effect.map((result) => ({ prompt: turn.prompt, events: result.events }))),
            ),
            Effect.orElseSucceed(() => ({
              prompt: turn.prompt,
              events: noExecutionEvents,
            })),
          ),
        )
        sessionDispatch({ _tag: "ThreadPreviewLoaded", threadId: id, turns: previewTurns })
      }).pipe(
        Effect.provide(executionDependencies),
        Effect.scoped,
        Effect.orElseSucceed(() => undefined),
      ),
    reopenThread: (epoch) =>
      safe(
        sessionDispatch,
        Effect.gen(function* () {
          if (epoch <= historyState.currentSelectionEpoch) return
          const threads = yield* ThreadRepository.Service
          const thread = (yield* threads.list({ limit: 1 }))[0]
          if (thread === undefined || epoch <= historyState.currentSelectionEpoch) return
          const previousThread = yield* Ref.get(interactiveThread)
          const previousEpoch = historyState.currentSelectionEpoch
          historyState.currentSelectionEpoch = epoch
          yield* Ref.set(selectionRequest, epoch)
          historyState.selectedThreadId = String(thread.id)
          historyState.selectionLoad = {
            epoch,
            threadId: String(thread.id),
            previousEpoch,
            previousThreadId: previousThread === undefined ? undefined : String(previousThread.id),
            events: [],
            committed: false,
          }
          yield* loadThread(thread, epoch, selectionDispatch(epoch))
        }).pipe(Effect.ensuring(finishSelection(epoch))),
      ),
    replay: (id, cursor) =>
      safe(
        sessionDispatch,
        Effect.gen(function* () {
          const backend = yield* ExecutionBackend.Service
          const turnId = Turn.TurnId.make(id)
          const thread = yield* Ref.get(interactiveThread)
          if (thread === undefined) return yield* operationError("No thread selected")
          const result = yield* backend.replay(id, cursor)
          for (const event of result.events)
            sessionDispatch({
              _tag: "TranscriptPatched",
              selectionEpoch: yield* Ref.get(selectionRequest),
              threadId: thread.id,
              turnId,
              event,
              revision: event.sequence,
            })
        }),
      ),
  }
}

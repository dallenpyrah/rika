import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as ThreadSummaryRepository from "@rika/persistence/thread-summary-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { ExecutionExtensions } from "@rika/extensions"
import * as ExtensionOperations from "../extension-operations"
import { Catalog as ToolCatalog } from "@rika/tools"
import { Cause, Console, Context, Deferred, Effect, Layer, PubSub, Ref, Schema, Semaphore } from "effect"
import * as ConfigOperations from "../config-operations"
import * as ResolvedContext from "../resolved-context"
import {
  Input,
  InteractiveEventSchema,
  InvalidInput,
  OperationUnavailable,
  Service,
  unavailableLayer,
} from "../operation-contract"
import type {
  Interface,
  InteractiveCommand,
  InteractiveEvent,
  InteractiveSession,
  QueueChange,
  QueueItem,
} from "../operation-contract"

export { Input, InteractiveEventSchema, InvalidInput, OperationUnavailable, Service, unavailableLayer }
export type { Interface, InteractiveCommand, InteractiveEvent, InteractiveSession, QueueChange, QueueItem }

const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  if (failure !== null && typeof failure === "object" && "_tag" in failure && typeof failure._tag === "string")
    return failure._tag
  if (failure instanceof Error) return failure.name
  return typeof failure
}

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)
export { runAuth } from "./auth"
export { reconcile } from "./reconcile"
export { rootExecutionEvents } from "./execution-projection"
export { testLayer } from "./test-layer"
export type { AuthOperationOptions, ProductLayerOptions } from "./options"
import type { ProductLayerOptions } from "./options"
import { operationError } from "./options"
import { runAuth } from "./auth"
import { internal as reconciliation } from "./reconcile"
import { internal as threadFormat } from "./thread-format"
const { reconcileInternal } = reconciliation
const { unavailable } = threadFormat
import { makeInteractiveSessionFactory } from "./interactive-session"
import { makeThreadOperation } from "./thread-operation"
import { makeRunOperation } from "./run-operation"
import { makeReviewOperation } from "./review-operation"
import { internal as executionCoordination } from "./execution-coordination"

export const makeProductLayer = <
  ThreadError,
  TurnError,
  BackendError,
  ThreadSummaryError = never,
  TranscriptError = never,
>(
  options: ProductLayerOptions<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>,
) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const ownerScope = yield* Effect.scope
      const pendingTurnCapacity = Math.max(0, Math.floor(options.pendingTurnCapacity ?? 64))
      const reviewSettlementAdmission = yield* Semaphore.make(1)
      const turnMutationAdmission = yield* Semaphore.make(1)
      const createForSubmission = (turns: TurnRepository.Interface, input: TurnRepository.CreateInput) =>
        turnMutationAdmission.withPermits(1)(turns.createForSubmission(input))
      const turnChanges = yield* PubSub.sliding<void>(1)
      let interactiveSessionSequence = 0
      let activitySequence = 0
      const interactiveSinks = new Map<number, (origin: number, event: InteractiveEvent) => void>()
      const turnObserverAdmission = yield* Semaphore.make(1)
      const observedTurns = new Set<string>()
      const claimTurnObserver = (turnId: Turn.TurnId, expectedStatus?: Turn.Status) =>
        turnObserverAdmission.withPermits(1)(
          Effect.gen(function* () {
            const key = String(turnId)
            if (observedTurns.has(key)) return false
            if (expectedStatus !== undefined) {
              const turns = yield* TurnRepository.Service
              const current = yield* turns.get(turnId)
              if (current?.status !== expectedStatus) return false
            }
            observedTurns.add(key)
            return true
          }),
        )
      const releaseTurnObserver = (turnId: Turn.TurnId) =>
        turnObserverAdmission.withPermits(1)(Effect.sync(() => observedTurns.delete(String(turnId))))
      const createObservedSubmission = (turns: TurnRepository.Interface, input: TurnRepository.CreateInput) =>
        Effect.gen(function* () {
          const turn = yield* turns.createForSubmission(input)
          if (turn.status === "queued") return { turn, claimed: false }
          const key = String(turn.id)
          if (observedTurns.has(key)) return { turn, claimed: false }
          observedTurns.add(key)
          return { turn, claimed: true }
        }).pipe(turnObserverAdmission.withPermits(1), turnMutationAdmission.withPermits(1))
      const claimQueuedTurn = (threadId: Thread.ThreadId, now: number) =>
        turnObserverAdmission.withPermits(1)(
          Effect.gen(function* () {
            const turns = yield* TurnRepository.Service
            const promoted = yield* turns.claimNextQueued(threadId, now)
            if (promoted === undefined) return undefined
            const key = String(promoted.turn.id)
            if (observedTurns.has(key)) {
              yield* turns.releaseQueuedClaim(promoted)
              return undefined
            }
            observedTurns.add(key)
            return promoted
          }),
        )
      const publishInteractiveActivity = (origin: number, event: InteractiveEvent) => {
        activitySequence += 1
        for (const [sessionId, sink] of interactiveSinks) if (sessionId !== origin) sink(origin, event)
      }
      const resolvedContextLayer =
        options.resolvedContextLayer ??
        ResolvedContext.testLayer({
          resolve: () => Effect.succeed({ sources: [], diagnostics: [], digest: "" }),
        })
      const repositories = Layer.merge(options.repositoryLayer, options.turnRepositoryLayer)
      const threadSummaryRepositoryLayer =
        options.threadSummaryRepositoryLayer ?? ThreadSummaryRepository.memoryLayer.pipe(Layer.provide(repositories))
      const dependencies = Layer.mergeAll(
        repositories,
        threadSummaryRepositoryLayer,
        options.transcriptRepositoryLayer ?? TranscriptRepository.memoryLayer,
        resolvedContextLayer,
        ...(options.executionExtensions === undefined ? [] : [options.executionExtensions.layer]),
      )
      const dependencyContext = yield* Layer.buildWithScope(dependencies, ownerScope)
      const acquiredDependencies = Layer.succeedContext(dependencyContext)
      const acquiredBackend = Context.get(
        yield* Layer.buildWithScope(options.backendLayer, ownerScope),
        ExecutionBackend.Service,
      )
      const backendLayer = Layer.succeed(ExecutionBackend.Service, acquiredBackend)
      const extensionService =
        options.executionExtensions === undefined
          ? undefined
          : Context.get(dependencyContext, ExecutionExtensions.Service)
      const executionDependencies = Context.merge(
        dependencyContext,
        Context.make(ExecutionBackend.Service, acquiredBackend),
      )
      yield* Effect.provide(
        Context.get(dependencyContext, TurnRepository.Service).resetQueueClaims,
        executionDependencies,
      )
      const usageCostAdmission = yield* Semaphore.make(1)
      const {
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
        repairThreadSummaries,
        startReviewSettlement,
        resolveExecutionRoute,
        prepareExecution,
        observeUsageCosts,
      } = executionCoordination.makeExecutionCoordination({
        options,
        acquiredBackend,
        executionDependencies,
        ownerScope,
        reviewSettlementAdmission,
        usageCostAdmission,
        turnChanges,
        publishInteractiveActivity,
      })
      const reconcileExecutions = reconcileInternal(
        extensionService,
        (turn, workspace) =>
          prepareExecution(turn, workspace, false).pipe(Effect.mapError((error) => operationError(String(error)))),
        (turn, inspection) =>
          startReviewSettlement(turn, inspection.fanOutId, inspection).pipe(
            Effect.asVoid,
            Effect.mapError((error) => operationError(String(error))),
          ),
        {
          claim: (turn) => claimTurnObserver(turn.id, turn.status),
          release: releaseTurnObserver,
          claimQueued: claimQueuedTurn,
        },
        false,
      ).pipe(
        Effect.provide(executionDependencies),
        Effect.scoped,
        Effect.mapError((error) => operationError(String(error))),
      )
      const makeInteractiveSession = makeInteractiveSessionFactory({
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
        nextSessionId: () => (interactiveSessionSequence += 1),
        currentActivitySequence: () => activitySequence,
        observeUsageCosts,
        turnObserverAdmission,
        observedTurns,
        dependencyContext,
      })
      const owner = yield* makeInteractiveSession(options.defaultWorkspace, { registerPromoter: true })
      yield* Effect.forkIn(owner.supervise, ownerScope)
      const repairSummariesOnce = yield* Effect.cached(
        repairThreadSummaries().pipe(
          Effect.provide(executionDependencies),
          Effect.catch((error) =>
            Effect.logError("thread-summary.repair.failed").pipe(
              Effect.annotateLogs("rika.failure.kind", String(error)),
            ),
          ),
        ),
      )
      const repairThreadTitles = Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        for (const thread of yield* threads.listAll) {
          const firstTurn = (yield* turns.list(thread.id))[0]
          if (firstTurn?.status === "completed")
            yield* titleThread(thread, firstTurn, (event) => publishInteractiveActivity(0, event))
        }
      }).pipe(
        Effect.provide(executionDependencies),
        Effect.catchCause((cause) =>
          Effect.logError("thread-title.repair.failed").pipe(
            Effect.annotateLogs("rika.failure.kind", failureKind(cause)),
          ),
        ),
      )
      type ReconcileSchedule =
        | { readonly running: false }
        | { readonly running: true; readonly rescan: boolean; readonly completed: Deferred.Deferred<void> }
      const reconcileSchedule = yield* Ref.make<ReconcileSchedule>({ running: false })
      const runScheduledReconcile = Effect.fn("Operation.runScheduledReconcile")(function* (
        completed: Deferred.Deferred<void>,
      ) {
        while (true) {
          yield* reconcileExecutions.pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logError("execution.repair.failed").pipe(
                    Effect.annotateLogs({
                      "rika.failure.kind": failureKind(cause),
                      "rika.failure.message": String(Cause.squash(cause)),
                    }),
                  ),
            ),
          )
          yield* repairThreadTitles
          const repeat = yield* Ref.modify(reconcileSchedule, (state) => {
            if (!state.running) return [false, state] as const
            return state.rescan
              ? [true, { running: true, rescan: false, completed: state.completed } as const]
              : [false, { running: false } as const]
          })
          if (!repeat) {
            yield* Deferred.succeed(completed, undefined)
            return
          }
        }
      })
      const scheduleReconcile = Effect.gen(function* () {
        const candidate = yield* Deferred.make<void>()
        const scheduled = yield* Ref.modify(reconcileSchedule, (state) =>
          state.running
            ? [
                { launch: false, completed: state.completed },
                { running: true, rescan: true, completed: state.completed },
              ]
            : [
                { launch: true, completed: candidate },
                { running: true, rescan: false, completed: candidate },
              ],
        )
        if (scheduled.launch) yield* Effect.forkIn(runScheduledReconcile(scheduled.completed), ownerScope)
        return scheduled.completed
      })
      const runOperation = makeRunOperation({
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
      })
      const threadOperation = makeThreadOperation({
        options,
        pendingTurnCapacity,
        turnMutationAdmission,
        acquiredBackend,
        dependencyContext,
        notifyThreadSummaries,
      })
      const reviewOperation = makeReviewOperation({
        options,
        pendingTurnCapacity,
        backendLayer,
        acquiredDependencies,
        createObservedSubmission,
        ensureTurnSummary,
        setTurnStatus,
        resolveExecutionRoute,
        startReviewSettlement,
        releaseTurnObserver,
      })
      return Service.of({
        run: Effect.fn("Operation.product.run")(function* (input) {
          if (
            input._tag === "Interactive" ||
            input._tag === "Run" ||
            input._tag === "Review" ||
            input._tag === "Workflow"
          ) {
            const reconciled = yield* scheduleReconcile
            if (input._tag !== "Interactive") yield* Deferred.await(reconciled)
            yield* repairSummariesOnce
          }
          if (input._tag === "Interactive" && options.interactive !== undefined) {
            if (input.threadId !== undefined) {
              const thread = yield* Context.get(dependencyContext, ThreadRepository.Service)
                .get(Thread.ThreadId.make(input.threadId))
                .pipe(Effect.mapError((error) => unavailable(input, String(error))))
              if (thread === undefined) return yield* unavailable(input, `Thread ${input.threadId} does not exist`)
            }
            const made = yield* makeInteractiveSession(
              input.workspace ?? options.defaultWorkspace,
              input.threadId === undefined ? {} : { initialThreadId: input.threadId },
            )
            yield* options.interactive(input, made.session).pipe(Effect.ensuring(made.close))
            return
          }
          if (input._tag === "Run") return yield* runOperation(input)
          if (input._tag === "Review") return yield* reviewOperation(input)
          if (input._tag === "ToolCatalog") {
            if (input.action === "list") {
              yield* Console.log(encodeJson(ToolCatalog.definitions))
              return
            }
            const definition = ToolCatalog.get(input.name)
            if (definition === undefined) return yield* unavailable(input, `Tool ${input.name} does not exist`)
            yield* Console.log(encodeJson(definition))
            return
          }
          if (input._tag === "Auth" && options.authOperations !== undefined) {
            return yield* Effect.scoped(runAuth(input, options.authOperations, options.defaultWorkspace))
          }
          if (
            (input._tag === "Skill" || input._tag === "Mcp" || input._tag === "Extension") &&
            options.extensionOperations !== undefined
          ) {
            const extensionOperationsLayer = options.extensionOperations.layer
            yield* Effect.gen(function* () {
              const extensionContext = yield* Layer.build(extensionOperationsLayer).pipe(
                Effect.mapError((error) => unavailable(input, String(error))),
              )
              yield* ExtensionOperations.run(input).pipe(
                Effect.provide(extensionContext),
                Effect.mapError((error) => unavailable(input, error instanceof Error ? error.message : String(error))),
              )
            }).pipe(Effect.scoped)
            return
          }
          if (
            (input._tag === "Config" ||
              input._tag === "Doctor" ||
              (input._tag === "Mcp" && input.action === "doctor")) &&
            options.configOperations !== undefined
          ) {
            const workspaceConfig =
              options.configOperations.forWorkspace === undefined
                ? options.configOperations
                : yield* options.configOperations
                    .forWorkspace(input.clientWorkspace ?? options.defaultWorkspace)
                    .pipe(Effect.mapError((error) => unavailable(input, String(error))))
            yield* Effect.gen(function* () {
              const configContext = yield* Layer.build(workspaceConfig.layer)
              yield* ConfigOperations.run(input, workspaceConfig.options).pipe(Effect.provide(configContext))
            }).pipe(
              Effect.scoped,
              Effect.mapError((error) => unavailable(input, String(error))),
            )
            return
          }
          if (input._tag === "Workflow") {
            const program = Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              if (input.action === "start") {
                yield* backend.registerWorkflows()
                yield* Console.log(
                  encodeJson(
                    yield* backend.startWorkflow(
                      input.name,
                      input.runId,
                      input.revision,
                      undefined,
                      input.clientWorkspace,
                    ),
                  ),
                )
                return
              }
              const inspection =
                input.action === "inspect"
                  ? yield* backend.inspectWorkflow(input.runId, undefined, input.clientWorkspace)
                  : yield* backend.cancelWorkflow(input.runId, undefined, input.clientWorkspace)
              if (inspection === undefined) return yield* operationError(`Workflow run ${input.runId} does not exist`)
              yield* Console.log(encodeJson(inspection))
            })
            yield* program.pipe(
              Effect.provide(Context.make(ExecutionBackend.Service, acquiredBackend)),
              Effect.mapError((error) => unavailable(input, error instanceof Error ? error.message : String(error))),
            )
            return
          }
          if (input._tag === "Thread") return yield* threadOperation(input)
          return yield* unavailable(input)
        }),
      })
    }),
  )

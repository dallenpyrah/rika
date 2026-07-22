import * as TurnRepository from "@rika/persistence/turn-repository"
import type { Effect, PubSub, Semaphore } from "effect"
import type { InteractiveEvent } from "../operation-contract"
import type { ExecutionCoordination } from "./execution-coordination"
import type { makeInteractiveQueue } from "./interactive-queue"
import type { makeInteractiveSubmit } from "./interactive-submit"

type QueueDependencies = Parameters<typeof makeInteractiveQueue>[0]
type SubmitDependencies<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError> = Parameters<
  typeof makeInteractiveSubmit<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>
>[0]

type CoordinationDependencies = Pick<
  ExecutionCoordination,
  | "currentUsageCosts"
  | "displayGlobalCostUsd"
  | "loadUsageCosts"
  | "notifyThreadSummaries"
  | "titleThread"
  | "notifyTurnChanged"
  | "dispatchThreadSummaries"
  | "ensureTurnSummary"
  | "projectExecutionResult"
  | "setTurnStatus"
  | "resolveExecutionRoute"
  | "prepareExecution"
  | "observeUsageCosts"
>

export type InteractiveSessionFactoryDependencies<
  ThreadError,
  TurnError,
  BackendError,
  ThreadSummaryError,
  TranscriptError,
> = CoordinationDependencies &
  Pick<
    QueueDependencies,
    | "acquiredBackend"
    | "dependencyContext"
    | "executionDependencies"
    | "observedTurns"
    | "releaseTurnObserver"
    | "turnObserverAdmission"
  > &
  Pick<
    SubmitDependencies<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>,
    "createObservedSubmission" | "options" | "pendingTurnCapacity"
  > & {
    readonly turnMutationAdmission: Semaphore.Semaphore
    readonly createForSubmission: (
      turns: TurnRepository.Interface,
      input: TurnRepository.CreateInput,
    ) => Effect.Effect<TurnRepository.Submission, TurnRepository.RepositoryError | TurnRepository.QueueFull>
    readonly turnChanges: PubSub.PubSub<void>
    readonly interactiveSinks: Map<number, (origin: number, event: InteractiveEvent) => void>
    readonly publishInteractiveActivity: (origin: number, event: InteractiveEvent) => void
    readonly nextSessionId: () => number
    readonly currentActivitySequence: () => number
  }

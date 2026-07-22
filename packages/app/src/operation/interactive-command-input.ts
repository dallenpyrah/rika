import { ExecutionExtensions } from "@rika/extensions"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as ThreadSummaryRepository from "@rika/persistence/thread-summary-repository"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Context, Deferred, Effect, Queue, Ref, Scope, Semaphore } from "effect"
import * as InteractiveFeedOverflow from "../interactive-feed-overflow"
import type { InteractiveEvent, InteractiveSession } from "../operation-contract"
import * as ResolvedContext from "../resolved-context"
import type { ExecutionCoordination } from "./execution-coordination"
import type { SessionEnvelope } from "./interactive-feed"
import type { SelectionLoad } from "./interactive-history"
import type { OperationError, ProductLayerOptions } from "./options"

type CommandServices =
  | ThreadRepository.Service
  | TurnRepository.Service
  | ThreadSummaryRepository.Service
  | TranscriptRepository.Service
  | ExecutionBackend.Service
  | ResolvedContext.Service
  | ExecutionExtensions.Service
type CommandError =
  | ThreadRepository.RepositoryError
  | TurnRepository.RepositoryError
  | TurnRepository.QueueFull
  | ThreadSummaryRepository.RepositoryError
  | TranscriptRepository.RepositoryError
  | ExecutionBackend.BackendError
  | OperationError

export interface InteractiveCommandInput<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>
  extends Pick<
    ExecutionCoordination,
    | "dispatchThreadSummaries"
    | "ensureTurnSummary"
    | "projectExecutionResult"
    | "setTurnStatus"
    | "resolveExecutionRoute"
  > {
  readonly options: ProductLayerOptions<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>
  readonly workspace: string
  readonly sessionDispatch: (event: InteractiveEvent) => void
  readonly executionDependencies: Context.Context<CommandServices>
  readonly feedState: { overflow: InteractiveFeedOverflow.State | undefined }
  readonly sessionEvents: Queue.Queue<SessionEnvelope>
  readonly selectionRequest: Ref.Ref<number>
  readonly interactiveEventThreadId: (event: InteractiveEvent) => string | undefined
  readonly historyState: {
    currentSelectionEpoch: number
    selectedThreadId: string | undefined
    selectionLoad: SelectionLoad | undefined
  }
  readonly submit: (
    prompt: string,
    dispatch: (event: InteractiveEvent) => void,
    mode?: Parameters<InteractiveSession["submit"]>[1],
    parts?: Parameters<InteractiveSession["submit"]>[2],
    tuning?: Parameters<InteractiveSession["submit"]>[3],
  ) => ReturnType<InteractiveSession["submit"]>
  readonly safe: <E>(
    dispatch: (event: InteractiveEvent) => void,
    effect: Effect.Effect<void, E, CommandServices>,
  ) => Effect.Effect<void>
  readonly submissionAdmission: Semaphore.Semaphore
  readonly createAndSelectThread: (_input: void) => Effect.Effect<void, CommandError, CommandServices>
  readonly shellState: { readonly permission: "ask" | "allow" | "deny"; permissionAlways: boolean }
  readonly shellApprovals: Map<string, Deferred.Deferred<boolean>>
  readonly closed: Deferred.Deferred<void>
  readonly createForSubmission: (
    turns: TurnRepository.Interface,
    input: TurnRepository.CreateInput,
  ) => Effect.Effect<TurnRepository.Submission, TurnRepository.RepositoryError | TurnRepository.QueueFull>
  readonly pendingTurnCapacity: number
  readonly emit: (dispatch: (event: InteractiveEvent) => void, event: InteractiveEvent) => void
  readonly dispatchFailure: (dispatch: (event: InteractiveEvent) => void, error: unknown) => void
  readonly sessionScope: Scope.Scope
  readonly turnMutationAdmission: Semaphore.Semaphore
  readonly active: (_input: void) => Effect.Effect<Turn.Turn, CommandError, CommandServices>
  readonly threadForTurn: (turn: Turn.Turn) => Effect.Effect<Thread.Thread, CommandError, CommandServices>
  readonly drainQueued: (
    thread: Thread.Thread,
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<void, CommandError, CommandServices>
  readonly activateChildFollowers: (threadId: Thread.ThreadId) => Effect.Effect<void>
  readonly settleThread: (
    thread: Thread.Thread,
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<void, CommandError, CommandServices>
  readonly followTurn: (
    turnId: Turn.TurnId,
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<boolean, CommandError, CommandServices>
  readonly loadThread: (
    thread: Thread.Thread,
    epoch: number,
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<void, CommandError, CommandServices>
  readonly selectionDispatch: (request: number) => (event: InteractiveEvent) => void
  readonly finishSelection: (request: number) => Effect.Effect<void>
  readonly readQueue: (
    threadId: Thread.ThreadId,
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<void, CommandError, TurnRepository.Service>
  readonly transcriptHasOlder: Ref.Ref<boolean>
  readonly interactiveThread: Ref.Ref<Thread.Thread | undefined>
  readonly transcriptCursor: Ref.Ref<TranscriptRepository.PageCursor | undefined>
  readonly loadTranscriptPage: (
    thread: Thread.Thread,
    request: number,
    dispatch: (event: InteractiveEvent) => void,
    before: TranscriptRepository.PageCursor,
  ) => Effect.Effect<void, CommandError, CommandServices>
  readonly nextShellPermissionId: () => string
}

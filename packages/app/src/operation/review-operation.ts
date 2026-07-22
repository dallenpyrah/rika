import * as ThreadRepository from "@rika/persistence/repository"
import * as ThreadSummaryRepository from "@rika/persistence/thread-summary-repository"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import { ExecutionExtensions } from "@rika/extensions"
import * as ProductAgent from "../product-agent"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Runtime as ToolRuntime } from "@rika/tools"
import { Clock, Console, Effect, Fiber, Layer, Schema } from "effect"
import { Input } from "../operation-contract"
import * as ResolvedContext from "../resolved-context"
import type { ExecutionCoordination } from "./execution-coordination"
import type { ProductLayerOptions } from "./options"
import { operationError } from "./options"
import { internal as threadFormat } from "./thread-format"
const { unavailable } = threadFormat

type ReviewInput = Extract<Input, { readonly _tag: "Review" }>

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)

interface ReviewOperationDependencies<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>
  extends Pick<
    ExecutionCoordination,
    "ensureTurnSummary" | "resolveExecutionRoute" | "setTurnStatus" | "startReviewSettlement"
  > {
  readonly options: ProductLayerOptions<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>
  readonly pendingTurnCapacity: number
  readonly backendLayer: Layer.Layer<ExecutionBackend.Service>
  readonly acquiredDependencies: Layer.Layer<
    | ThreadRepository.Service
    | TurnRepository.Service
    | ThreadSummaryRepository.Service
    | TranscriptRepository.Service
    | ResolvedContext.Service
    | ExecutionExtensions.Service
  >
  readonly createObservedSubmission: (
    turns: TurnRepository.Interface,
    input: TurnRepository.CreateInput,
  ) => Effect.Effect<
    { readonly turn: TurnRepository.Submission; readonly claimed: boolean },
    TurnRepository.RepositoryError | TurnRepository.QueueFull
  >
  readonly releaseTurnObserver: (turnId: Turn.TurnId) => Effect.Effect<boolean>
}

export const makeReviewOperation = <ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>(
  dependencies: ReviewOperationDependencies<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>,
) => {
  const {
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
  } = dependencies
  const review = Effect.fn("Operation.review")(function* (input: ReviewInput) {
    if (options.toolRuntimeLayer === undefined)
      return yield* unavailable(input, "Review requires the local tool runtime")
    const workspace = input.workspace ?? options.defaultWorkspace
    const program = Effect.gen(function* () {
      const tools = yield* ToolRuntime.Service
      const agents = yield* ProductAgent.Service
      if (input.staged && input.base !== undefined)
        return yield* operationError("Review cannot combine --staged with --base")
      if (input.base !== undefined && (input.base.length === 0 || input.base.startsWith("-")))
        return yield* operationError("Review --base must name a Git revision")
      const args = ["diff", "--no-ext-diff", "--no-color"]
      if (input.staged) args.push("--cached")
      else if (input.base !== undefined) args.push("--end-of-options", `${input.base}...HEAD`)
      if (input.paths.length > 0) args.push("--", ...input.paths)
      const diffResult = yield* tools.run({ _tag: "Shell", command: "git", args, waitMillis: 120_000 })
      if (diffResult.exitCode === undefined)
        return yield* operationError("Git diff did not finish before the review timeout")
      if (diffResult.exitCode !== 0) return yield* operationError(diffResult.text || "Git diff failed")
      if (diffResult.truncated) return yield* operationError("Git diff exceeded the review output limit")
      const diff = diffResult.text.trim()
      if (diff.length === 0) {
        yield* Console.log(input.json ? encodeJson({ status: "no-changes", findings: [] }) : "No changes to review.")
        return
      }
      const now = yield* Clock.currentTimeMillis
      const threads = yield* ThreadRepository.Service
      const turns = yield* TurnRepository.Service
      const thread = yield* threads.create({
        id: yield* options.makeThreadId,
        workspace,
        title: "Code review",
        now,
      })
      const parentTurnId = yield* options.makeTurnId
      const executionRoute = yield* resolveExecutionRoute("medium", undefined, thread.workspace)
      const fanOutId = `review:${parentTurnId}`
      const focus: ReadonlyArray<readonly [string, string]> = [
        ["correctness", "Find correctness defects, regressions, and edge cases."],
        ["security", "Find security, privacy, and unsafe-input defects."],
        ["quality", "Find missing tests, maintainability risks, and contract violations."],
      ]
      let reviewObserverClaimed = false
      const settled = yield* Effect.gen(function* () {
        const settlement = yield* Effect.gen(function* () {
          const observed = yield* createObservedSubmission(turns, {
            id: parentTurnId,
            threadId: thread.id,
            prompt: "Review workspace changes",
            executionRoute,
            reviewFanOutId: fanOutId,
            queueCapacity: pendingTurnCapacity,
            now,
          })
          const parentTurn = observed.turn
          if (!observed.claimed) return yield* operationError(`Turn ${parentTurn.id} already has an execution observer`)
          reviewObserverClaimed = true
          yield* ensureTurnSummary(parentTurn)
          yield* setTurnStatus(parentTurnId, "running", undefined, now)
          const inspection = yield* agents.runReviewLanes({
            parentTurnId,
            fanOutId,
            workspace: thread.workspace,
            executionRoute,
            checks: focus.map(([id, instruction]) => ({
              id: `${fanOutId}:${id}`,
              prompt: `${instruction}\nReturn concise actionable findings with file and line references. If none, say no findings.\n\n${diff}`,
            })),
            maxConcurrency: focus.length,
            join: "best-effort",
            createdAt: now,
          })
          return yield* startReviewSettlement({ id: parentTurnId }, fanOutId, inspection)
        }).pipe(
          Effect.catch((error) =>
            setTurnStatus(parentTurnId, "failed", undefined, now).pipe(Effect.andThen(Effect.fail(error))),
          ),
          Effect.uninterruptible,
        )
        return yield* Fiber.join(settlement)
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            reviewObserverClaimed ? releaseTurnObserver(parentTurnId).pipe(Effect.asVoid) : Effect.void,
          ),
        ),
      )
      const lanes = agents.projectChildren(settled).map((lane) => ({
        id: lane.childId.slice(fanOutId.length + 1),
        status: lane.state,
        output: lane.output,
        error: lane.error,
      }))
      if (settled.state === "failed" || lanes.every((lane) => lane.status !== "completed"))
        return yield* operationError(
          lanes
            .map((lane) => lane.error)
            .filter((error): error is string => error !== undefined && error.length > 0)
            .join("; ") || "Review failed",
        )
      if (input.json) {
        yield* Console.log(encodeJson({ status: settled.state, lanes }))
        return
      }
      yield* Console.log(
        lanes
          .map(
            (lane) =>
              `## ${lane.id}\n${lane.output === undefined ? `Review lane ${lane.status}${lane.error === undefined ? "" : `: ${lane.error}`}` : typeof lane.output === "string" ? lane.output : encodeJson(lane.output)}`,
          )
          .join("\n\n"),
      )
    })
    const agentLayer = options.productAgentLayer ?? ProductAgent.layer
    const reviewToolRuntimeLayer = options.toolRuntimeLayer(workspace)
    yield* Effect.gen(function* () {
      const reviewContext = yield* Layer.build(
        Layer.mergeAll(
          reviewToolRuntimeLayer,
          agentLayer.pipe(Layer.provide(backendLayer)),
          backendLayer,
          acquiredDependencies,
        ),
      ).pipe(Effect.mapError((error) => unavailable(input, String(error))))
      yield* program.pipe(
        Effect.provide(reviewContext),
        Effect.mapError((error) => unavailable(input, error instanceof Error ? error.message : String(error))),
      )
    }).pipe(Effect.scoped)
  })
  return review
}

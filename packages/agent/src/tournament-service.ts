import { Config } from "@rika/core"
import { Event, Ids, Message, Remote } from "@rika/schema"
import { Context, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import * as JudgeService from "./judge-service"
import * as ThreadService from "./thread-service"

const defaultTimeoutMs = 120_000

export const TournamentErrorReason = Schema.Literals(["invalid_input", "insufficient_survivors"]).annotate({
  identifier: "Rika.Agent.TournamentService.TournamentErrorReason",
})
export type TournamentErrorReason = typeof TournamentErrorReason.Type

export interface BranchOutcome extends Schema.Schema.Type<typeof BranchOutcome> {}
export const BranchOutcome = Schema.Struct({
  index: Schema.Int,
  thread_id: Ids.ThreadId,
  mode: Config.Mode,
  status: Schema.Literals(["completed", "failed"]),
  candidate_id: Schema.optional(Schema.String),
  turn_id: Schema.optional(Ids.TurnId),
  content: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Agent.TournamentService.BranchOutcome" })

export class TournamentError extends Schema.TaggedErrorClass<TournamentError>()("TournamentError", {
  message: Schema.String,
  reason: TournamentErrorReason,
  thread_id: Schema.optional(Ids.ThreadId),
  outcomes: Schema.optional(Schema.Array(BranchOutcome)),
}) {}

export class TournamentTurnError extends Schema.TaggedErrorClass<TournamentTurnError>()("TournamentTurnError", {
  message: Schema.String,
  operation: Schema.String,
  thread_id: Schema.optional(Ids.ThreadId),
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface RunInput extends Schema.Schema.Type<typeof RunInput> {}
export const RunInput = Schema.Struct({
  thread_id: Ids.ThreadId,
  message: Schema.String,
  branch_count: Schema.Int,
  modes: Schema.optional(Schema.Array(Config.Mode)),
  rubric: Schema.optional(Schema.String),
  timeout_ms: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Agent.TournamentService.RunInput" })

export interface RankingRow extends Schema.Schema.Type<typeof RankingRow> {}
export const RankingRow = Schema.Struct({
  rank: Schema.Int,
  candidate_id: Schema.String,
  thread_id: Ids.ThreadId,
  mode: Config.Mode,
  median_score: Schema.Number,
  first_place_votes: Schema.Int,
  strengths: Schema.String,
}).annotate({ identifier: "Rika.Agent.TournamentService.RankingRow" })

export interface TournamentResult extends Schema.Schema.Type<typeof TournamentResult> {}
export const TournamentResult = Schema.Struct({
  source_thread_id: Ids.ThreadId,
  task: Schema.String,
  branches: Schema.Array(BranchOutcome),
  ranking: Schema.Array(RankingRow),
  winner_thread_id: Ids.ThreadId,
  verdict: JudgeService.Verdict,
}).annotate({ identifier: "Rika.Agent.TournamentService.TournamentResult" })

export interface TurnControl {
  readonly startTurn: (input: Remote.StartTurnRequest) => Effect.Effect<Remote.StartTurnResponse, TournamentTurnError>
  readonly subscribeThreadEvents: (
    input: Remote.SubscribeThreadEventsRequest,
  ) => Stream.Stream<Event.Event, TournamentTurnError>
}

export class TurnControlService extends Context.Service<TurnControlService, TurnControl>()(
  "@rika/agent/TournamentService/TurnControl",
) {}

export type RunError = TournamentError | TournamentTurnError | ThreadService.Error | JudgeService.CompareError

export interface Interface {
  readonly run: (input: RunInput) => Effect.Effect<TournamentResult, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/TournamentService") {}

interface Dependencies {
  readonly config: Config.Interface
  readonly judge: JudgeService.Interface
  readonly threads: ThreadService.Interface
  readonly turnControl: TurnControl
}

interface BranchInput {
  readonly sourceThreadId: Ids.ThreadId
  readonly branchIndex: number
  readonly branchCount: number
  readonly mode: Config.Mode
  readonly message: string
  readonly timeoutMs: number
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const judge = yield* JudgeService.Service
    const threads = yield* ThreadService.Service
    const turnControl = yield* TurnControlService
    const dependencies: Dependencies = { config, judge, threads, turnControl }

    return Service.of({
      run: Effect.fn("TournamentService.run")(function* (input: RunInput) {
        return yield* runTournament(dependencies, input)
      }),
    })
  }),
)

export const turnControlLayer = (implementation: TurnControl) =>
  Layer.succeed(TurnControlService, TurnControlService.of(implementation))

export const run = Effect.fn("TournamentService.run.call")(function* (input: RunInput) {
  const service = yield* Service
  return yield* service.run(input)
})

const runTournament = (dependencies: Dependencies, input: RunInput) =>
  Effect.gen(function* () {
    const normalized = yield* normalizeInput(dependencies, input)
    const branches = yield* Effect.forEach(
      Array.from({ length: normalized.branch_count }, (_, index) => index),
      (index) =>
        runBranch(dependencies, {
          sourceThreadId: normalized.thread_id,
          branchIndex: index,
          branchCount: normalized.branch_count,
          mode: normalized.modes[index] ?? normalized.modes[0] ?? "smart",
          message: normalized.message,
          timeoutMs: normalized.timeout_ms,
        }),
      { concurrency: "unbounded" },
    )
    const survivors = branches.filter(isCompleted)
    if (survivors.length < 2) {
      return yield* new TournamentError({
        message: "Tournament requires at least two completed branches",
        reason: "insufficient_survivors",
        thread_id: normalized.thread_id,
        outcomes: branches,
      })
    }
    const candidates = survivors.map((branch) => ({
      id: branch.candidate_id,
      label: `branch ${branch.index} (${branch.mode})`,
      content: branch.content,
    }))
    const verdict = yield* dependencies.judge.compare({
      task: normalized.message,
      content_kind: "answer",
      candidates,
      ...(normalized.rubric === undefined ? {} : { rubric: normalized.rubric }),
      thread_id: normalized.thread_id,
    })
    const ranking = rankingRows(verdict, survivors)
    const winner = survivors.find((branch) => branch.candidate_id === verdict.winner_id) ?? survivors[0]
    if (winner === undefined) {
      return yield* new TournamentError({
        message: "Tournament requires at least two completed branches",
        reason: "insufficient_survivors",
        thread_id: normalized.thread_id,
        outcomes: branches,
      })
    }
    return {
      source_thread_id: normalized.thread_id,
      task: normalized.message,
      branches,
      ranking,
      winner_thread_id: winner.thread_id,
      verdict,
    }
  })

const normalizeInput = (dependencies: Dependencies, input: RunInput) =>
  Effect.gen(function* () {
    const message = input.message.trim()
    if (message.length === 0) {
      return yield* invalidInput("Tournament message is required", input.thread_id)
    }
    if (!Number.isInteger(input.branch_count) || input.branch_count < 2 || input.branch_count > 4) {
      return yield* invalidInput("Tournament branch_count must be between 2 and 4", input.thread_id)
    }
    if (input.modes !== undefined && input.modes.length !== input.branch_count) {
      return yield* invalidInput("Tournament modes count must equal branch_count", input.thread_id)
    }
    const values = yield* dependencies.config.get
    const modes = input.modes ?? Array.from({ length: input.branch_count }, () => values.default_mode)
    return {
      thread_id: input.thread_id,
      message,
      branch_count: input.branch_count,
      modes,
      ...(input.rubric === undefined ? {} : { rubric: input.rubric }),
      timeout_ms: input.timeout_ms ?? defaultTimeoutMs,
    }
  })

const invalidInput = (message: string, threadId: Ids.ThreadId) =>
  Effect.fail(new TournamentError({ message, reason: "invalid_input", thread_id: threadId }))

const runBranch = (dependencies: Dependencies, input: BranchInput): Effect.Effect<BranchOutcome, RunError> =>
  Effect.gen(function* () {
    const forked = yield* dependencies.threads.fork({
      thread_id: input.sourceThreadId,
      title_text: branchTitle(input.sourceThreadId, input.branchIndex),
    })
    const record = yield* dependencies.threads.open({ thread_id: forked.thread_id })
    const afterSequence = record.events.at(-1)?.sequence ?? 0
    const outcomeFiber = yield* awaitBranch(dependencies, {
      threadId: forked.thread_id,
      branchIndex: input.branchIndex,
      mode: input.mode,
      afterSequence,
      timeoutMs: input.timeoutMs,
    }).pipe(Effect.forkChild)
    const start = yield* dependencies.turnControl
      .startTurn({
        thread_id: forked.thread_id,
        content: input.message,
        mode: input.mode,
        tool_access: "read-only",
      })
      .pipe(
        Effect.match({
          onFailure: (error) => ({ status: "failed" as const, error }),
          onSuccess: () => ({ status: "started" as const }),
        }),
      )
    if (start.status === "failed") {
      yield* Fiber.interrupt(outcomeFiber).pipe(Effect.ignore)
      return failedBranch(forked.thread_id, input.branchIndex, input.mode, failureMessage(start.error))
    }
    return yield* Fiber.join(outcomeFiber)
  })

const awaitBranch = (
  dependencies: Dependencies,
  input: {
    readonly threadId: Ids.ThreadId
    readonly branchIndex: number
    readonly mode: Config.Mode
    readonly afterSequence: number
    readonly timeoutMs: number
  },
): Effect.Effect<BranchOutcome> =>
  Effect.gen(function* () {
    let turnId: Ids.TurnId | undefined
    const collected = yield* dependencies.turnControl
      .subscribeThreadEvents({ thread_id: input.threadId, after_sequence: input.afterSequence })
      .pipe(
        Stream.takeUntil((event) => {
          if (turnId === undefined && event.type === "turn.started") turnId = event.turn_id
          return turnId !== undefined && isTerminalFor(event, turnId)
        }),
        Stream.runCollect,
        Effect.timeoutOption(`${input.timeoutMs} millis`),
        Effect.match({
          onFailure: (error) => ({ status: "failed" as const, error }),
          onSuccess: (events) => ({ status: "collected" as const, events }),
        }),
      )
    if (collected.status === "failed") {
      return failedBranch(input.threadId, input.branchIndex, input.mode, failureMessage(collected.error))
    }
    if (Option.isNone(collected.events)) {
      return failedBranch(input.threadId, input.branchIndex, input.mode, "Branch timed out before a terminal event")
    }
    const events = Array.from(collected.events.value)
    const started = events.find((event): event is Event.TurnStarted => event.type === "turn.started")
    if (started === undefined) {
      return failedBranch(input.threadId, input.branchIndex, input.mode, "Branch ended before turn.started")
    }
    const terminal = events.find((event) => isTerminalFor(event, started.turn_id))
    if (terminal === undefined) {
      return failedBranch(input.threadId, input.branchIndex, input.mode, "Branch ended before a terminal event")
    }
    if (terminal.type === "turn.failed") {
      return failedBranch(
        input.threadId,
        input.branchIndex,
        input.mode,
        terminal.data.error.message ?? terminal.data.error.kind,
        started.turn_id,
      )
    }
    const content = assistantContent(events, started.turn_id)
    if (content === undefined) {
      return failedBranch(input.threadId, input.branchIndex, input.mode, "Branch completed without assistant output")
    }
    return {
      index: input.branchIndex + 1,
      thread_id: input.threadId,
      mode: input.mode,
      status: "completed",
      candidate_id: candidateId(input.branchIndex),
      turn_id: started.turn_id,
      content,
    }
  })

const isCompleted = (
  outcome: BranchOutcome,
): outcome is BranchOutcome & {
  readonly status: "completed"
  readonly candidate_id: string
  readonly content: string
} => outcome.status === "completed" && outcome.candidate_id !== undefined && outcome.content !== undefined

const isTerminalFor = (event: Event.Event, turnId: Ids.TurnId) =>
  (event.type === "turn.completed" || event.type === "turn.failed") && event.turn_id === turnId

const assistantContent = (events: ReadonlyArray<Event.Event>, turnId: Ids.TurnId): string | undefined => {
  const message = events
    .toReversed()
    .find(
      (event): event is Event.MessageAdded =>
        event.type === "message.added" && event.turn_id === turnId && event.data.message.role === "assistant",
    )
  const text = message === undefined ? "" : Message.displayText(message.data.message).trim()
  return text.length === 0 ? undefined : text
}

const failedBranch = (
  threadId: Ids.ThreadId,
  branchIndex: number,
  mode: Config.Mode,
  error: string,
  turnId?: Ids.TurnId,
): BranchOutcome => ({
  index: branchIndex + 1,
  thread_id: threadId,
  mode,
  status: "failed",
  ...(turnId === undefined ? {} : { turn_id: turnId }),
  error,
})

const rankingRows = (
  verdict: JudgeService.Verdict,
  branches: ReadonlyArray<BranchOutcome & { readonly status: "completed"; readonly candidate_id: string }>,
): ReadonlyArray<RankingRow> =>
  verdict.ranking.flatMap((entry, index) => {
    const branch = branches.find((candidate) => candidate.candidate_id === entry.candidate_id)
    if (branch === undefined) return []
    return [
      {
        rank: index + 1,
        candidate_id: entry.candidate_id,
        thread_id: branch.thread_id,
        mode: branch.mode,
        median_score: entry.median_score,
        first_place_votes: entry.first_place_votes,
        strengths: strengthsFor(verdict, entry.candidate_id),
      },
    ]
  })

const strengthsFor = (verdict: JudgeService.Verdict, candidateId: string) =>
  verdict.judges
    .flatMap((judge) => judge.scores)
    .find((score) => score.candidate_id === candidateId && score.strengths.trim().length > 0)
    ?.strengths.trim() ?? ""

const branchTitle = (sourceThreadId: Ids.ThreadId, branchIndex: number) =>
  `tournament:${shortThreadId(sourceThreadId)}/${branchIndex + 1}`

const shortThreadId = (threadId: Ids.ThreadId) => {
  const value = String(threadId)
  const body = value.startsWith("thread_") ? value.slice("thread_".length) : value
  const parts = body.split("_").filter((part) => part.length > 0)
  return parts.at(-1) ?? body
}

const candidateId = (branchIndex: number) => `branch-${branchIndex + 1}`

const failureMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

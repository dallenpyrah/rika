import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as ThreadSummaryRepository from "@rika/persistence/thread-summary-repository"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { ExecutionExtensions, PluginRegistry } from "@rika/extensions"
import { Cause, Clock, Context, Effect, Fiber, PubSub, Scope, Semaphore } from "effect"
import * as FileMentions from "../file-mentions"
import * as ContextMentions from "../context-mentions"
import * as ResolvedContext from "../resolved-context"
import * as ThreadActivity from "../thread-activity"
import * as UsageCost from "../usage-cost"
import type { InteractiveEvent } from "../operation-contract"
import type { ProductLayerOptions } from "./options"
import { OperationError, operationError } from "./options"
import { internal as threadFormat } from "./thread-format"
const { markdownExport } = threadFormat

export type ExecutionCoordinationGenerationError = PluginRegistry.GenerationUnavailable

const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  if (failure !== null && typeof failure === "object" && "_tag" in failure && typeof failure._tag === "string")
    return failure._tag
  if (failure instanceof Error) return failure.name
  return typeof failure
}

const isTerminalStatus = (
  status: "accepted" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled",
) => status === "completed" || status === "failed" || status === "cancelled"

const temporaryThreadTitle = (prompt: string) => [...prompt].slice(0, 80).join("") || "New thread"
const titleExecutionId = (turnId: Turn.TurnId) => `title:${turnId}`
const sanitizeThreadTitle = (text: string) =>
  [
    ...(text.split(/\r?\n/, 1)[0] ?? "")
      .replace(/\p{C}+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^["'#\s]+/, "")
      .replace(/["'\s]+$/, ""),
  ]
    .slice(0, 80)
    .join("")
    .trimEnd()
const untrustedData = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c")

const produceExecutionCoordination = <ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>({
  options,
  acquiredBackend,
  executionDependencies,
  ownerScope,
  reviewSettlementAdmission,
  usageCostAdmission,
  turnChanges,
  publishInteractiveActivity,
}: {
  readonly options: ProductLayerOptions<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>
  readonly acquiredBackend: ExecutionBackend.Interface
  readonly executionDependencies: Context.Context<
    | ThreadRepository.Service
    | TurnRepository.Service
    | ThreadSummaryRepository.Service
    | TranscriptRepository.Service
    | ResolvedContext.Service
    | ExecutionExtensions.Service
    | ExecutionBackend.Service
  >
  readonly ownerScope: Scope.Scope
  readonly reviewSettlementAdmission: Semaphore.Semaphore
  readonly usageCostAdmission: Semaphore.Semaphore
  readonly turnChanges: PubSub.PubSub<void>
  readonly publishInteractiveActivity: (origin: number, event: InteractiveEvent) => void
}) => {
  const reviewSettlements = new Map<string, Fiber.Fiber<ExecutionBackend.FanOutInspection, OperationError>>()
  let persistedGlobalCostUsd = 0
  const readUsageCosts = Effect.fn("Operation.readUsageCosts")(function* () {
    const threads = yield* ThreadRepository.Service
    const turns = yield* TurnRepository.Service
    persistedGlobalCostUsd = yield* (yield* TranscriptRepository.Service).globalCostUsd
    const roots = (yield* Effect.forEach(
      yield* threads.list({ includeArchived: true, limit: UsageCost.maximumGlobalThreads }),
      (thread) =>
        turns.list(thread.id).pipe(
          Effect.map((values) => {
            const threadRoots: Array<UsageCost.RootExecution> = values.map((turn) => ({
              threadId: String(thread.id),
              turnId: String(turn.id),
            }))
            const first = values[0]
            if (first?.executionRoute.title !== undefined)
              threadRoots.push({
                threadId: String(thread.id),
                turnId: String(first.id),
                executionId: titleExecutionId(first.id),
                optional: true,
              })
            return threadRoots
          }),
        ),
    )).flat()
    return yield* UsageCost.collect(acquiredBackend, roots)
  })
  let usageSnapshot: UsageCost.Snapshot | undefined
  const currentUsageCosts = (): UsageCost.Snapshot => usageSnapshot ?? UsageCost.empty
  const displayGlobalCostUsd = (totals: UsageCost.Snapshot): number =>
    totals.complete ? totals.globalCostUsd : persistedGlobalCostUsd
  const loadUsageCosts = usageCostAdmission.withPermits(1)(
    Effect.suspend(() => {
      if (usageSnapshot !== undefined) return Effect.void
      return readUsageCosts().pipe(
        Effect.provide(executionDependencies),
        Effect.tap((snapshot) => Effect.sync(() => (usageSnapshot = snapshot))),
        Effect.catchCause((cause) =>
          Effect.logWarning("usage-cost.read.failed").pipe(
            Effect.annotateLogs("rika.failure.kind", failureKind(cause)),
          ),
        ),
        Effect.asVoid,
      )
    }),
  )
  const notifyThreadSummaries = Effect.gen(function* () {
    const summaries = yield* ThreadSummaryRepository.Service
    publishInteractiveActivity(0, { _tag: "ThreadsListed", threads: yield* summaries.list() })
  })
  const settledTitleExecutions = new Set<string>()
  const titleThread = Effect.fn("Operation.titleThread")(function* (
    thread: Thread.Thread,
    firstTurn: Turn.Turn,
    announce: (event: InteractiveEvent) => void,
  ) {
    const program = Effect.gen(function* () {
      if (firstTurn.executionRoute.title === undefined) return
      const backend = yield* ExecutionBackend.Service
      const threads = yield* ThreadRepository.Service
      const current = yield* threads.get(thread.id)
      if (current === undefined || current.title !== temporaryThreadTitle(firstTurn.prompt)) return
      const executionId = titleExecutionId(firstTurn.id)
      if (settledTitleExecutions.has(executionId)) return
      yield* loadUsageCosts
      const inspection = yield* backend.inspect(executionId)
      if (inspection?.status === "failed" || inspection?.status === "cancelled") {
        settledTitleExecutions.add(executionId)
        return
      }
      const titleExecutionRoute = {
        ...firstTurn.executionRoute,
        main: { ...firstTurn.executionRoute.title, role: "main" as const },
      }
      const result =
        inspection === undefined
          ? yield* backend.start({
              threadId: thread.id,
              sessionKey: executionId,
              turnId: executionId,
              prompt: `Generate a concise 3-6 word title for a conversation that starts with the following user message. Reply with only the title, no quotes, no punctuation.\n\n${firstTurn.prompt.slice(0, 2000)}`,
              startedAt: firstTurn.updatedAt,
              executionRoute: titleExecutionRoute,
            })
          : isTerminalStatus(inspection.status)
            ? yield* backend.replay(executionId)
            : backend.follow === undefined
              ? undefined
              : yield* backend.follow(executionId, undefined)
      if (result === undefined) return
      const previousGlobalCostUsd = currentUsageCosts().globalCostUsd
      for (const event of result.events)
        usageSnapshot = UsageCost.observe(currentUsageCosts(), {
          threadId: String(thread.id),
          turnId: String(firstTurn.id),
          event,
        })
      const totals = currentUsageCosts()
      if (totals.globalCostUsd !== previousGlobalCostUsd)
        announce({
          _tag: "TitleCostUpdated",
          threadId: thread.id,
          turnId: firstTurn.id,
          turnCostUsd: totals.turnCostUsd.get(firstTurn.id) ?? 0,
          threadCostUsd: totals.threadCostUsd.get(thread.id) ?? 0,
          globalCostUsd: displayGlobalCostUsd(totals),
        })
      if (!isTerminalStatus(result.status)) return
      settledTitleExecutions.add(executionId)
      if (result.status !== "completed") return
      const text = result.events
        .filter((event) => event.type === "model.output.completed")
        .map((event) => event.text ?? "")
        .join("")
      const title = sanitizeThreadTitle(text)
      if (title.length === 0) return
      const renamed = yield* threads.renameIfTitle(
        thread.id,
        temporaryThreadTitle(firstTurn.prompt),
        title,
        yield* Clock.currentTimeMillis,
      )
      if (renamed === undefined) return
      announce({ _tag: "ThreadTitled", threadId: String(thread.id), title })
      yield* notifyThreadSummaries
    })
    yield* program.pipe(Effect.orElseSucceed(() => undefined))
  })
  const notifyTurnChanged = (_turn: Pick<Turn.Turn, "id" | "threadId">) =>
    PubSub.publish(turnChanges, undefined).pipe(Effect.asVoid)
  const dispatchThreadSummaries = Effect.fn("Operation.dispatchThreadSummaries")(function* (
    dispatch: (event: InteractiveEvent) => void,
  ) {
    const summaries = yield* ThreadSummaryRepository.Service
    dispatch({ _tag: "ThreadsListed", threads: yield* summaries.list() })
  })
  const ensureTurnSummary = Effect.fn("Operation.ensureTurnSummary")(function* (turn: Turn.Turn) {
    const summaries = yield* ThreadSummaryRepository.Service
    yield* summaries.ensureTurn(turn.id, turn.threadId, turn.updatedAt)
    yield* notifyThreadSummaries
    yield* notifyTurnChanged(turn)
  })
  const projectExecutionResult = Effect.fn("Operation.projectExecutionResult")(function* (
    threadId: Thread.ThreadId,
    result: ExecutionBackend.Result,
  ) {
    const summaries = yield* ThreadSummaryRepository.Service
    yield* summaries.replaceTurn(ThreadActivity.projectionInput(threadId, result, yield* Clock.currentTimeMillis))
    yield* notifyThreadSummaries
  })
  const setTurnStatus = Effect.fn("Operation.setTurnStatus")(function* (
    id: Turn.TurnId,
    status: Turn.Status,
    lastCursor: string | undefined,
    now: number,
  ) {
    const turns = yield* TurnRepository.Service
    const turn = yield* turns.setStatus(id, status, lastCursor, now)
    yield* notifyThreadSummaries
    yield* notifyTurnChanged(turn)
    return turn
  })
  const repairThreadSummaries = Effect.fn("Operation.repairThreadSummaries")(function* () {
    const summaries = yield* ThreadSummaryRepository.Service
    const backend = yield* ExecutionBackend.Service
    let previousBatch: ReadonlyArray<readonly [string, string, string | undefined]> = []
    while (true) {
      const candidates = yield* summaries.listRepairCandidates(100)
      if (candidates.length === 0) return
      const batch = candidates.map((candidate) => [candidate.turnId, candidate.status, candidate.lastCursor] as const)
      if (
        batch.length === previousBatch.length &&
        batch.every(
          (candidate, index) =>
            candidate[0] === previousBatch[index]?.[0] &&
            candidate[1] === previousBatch[index]?.[1] &&
            candidate[2] === previousBatch[index]?.[2],
        )
      )
        return
      previousBatch = batch
      yield* Effect.forEach(
        candidates,
        (candidate) =>
          Effect.gen(function* () {
            if (candidate.status === "queued") {
              yield* summaries.ensureTurn(candidate.turnId, candidate.threadId, yield* Clock.currentTimeMillis)
              return
            }
            const inspection = yield* backend.inspect(candidate.turnId)
            if (inspection === undefined) {
              yield* summaries.ensureTurn(candidate.turnId, candidate.threadId, yield* Clock.currentTimeMillis)
              return
            }
            const result = yield* backend.replay(candidate.turnId)
            const turns = yield* TurnRepository.Service
            const current = yield* turns.get(candidate.turnId)
            if (
              current === undefined ||
              current.status !== candidate.status ||
              current.lastCursor !== candidate.lastCursor
            )
              return
            if (
              result.status !== candidate.status ||
              !(yield* turns.repairCursor(
                candidate.turnId,
                candidate.status,
                candidate.lastCursor,
                ThreadActivity.latestCursor(result.events) ?? candidate.lastCursor,
              ))
            )
              return
            yield* projectExecutionResult(candidate.threadId, result)
          }).pipe(
            Effect.catch((error) =>
              Effect.logError("thread-summary.repair.failed").pipe(
                Effect.annotateLogs("rika.turn.id", candidate.turnId),
                Effect.annotateLogs("rika.failure.kind", String(error)),
              ),
            ),
          ),
        { concurrency: 4, discard: true },
      )
    }
  })
  const settleReviewOwner = Effect.fn("Operation.settleReviewOwner")(function* (
    turn: Pick<Turn.Turn, "id" | "lastCursor">,
    fanOutId: string,
    initial?: ExecutionBackend.FanOutInspection,
  ) {
    const backend = yield* ExecutionBackend.Service
    let inspection = initial
    while (inspection?.state === "joining" || inspection === undefined) {
      inspection = yield* backend.inspectFanOut(fanOutId)
      if (inspection === undefined) {
        yield* setTurnStatus(turn.id, "failed", turn.lastCursor, yield* Clock.currentTimeMillis)
        return yield* operationError(`Review ${fanOutId} disappeared`)
      }
      if (inspection.state === "joining") yield* Effect.sleep("50 millis")
    }
    yield* setTurnStatus(
      turn.id,
      inspection.state === "satisfied" ? "completed" : inspection.state,
      turn.lastCursor,
      yield* Clock.currentTimeMillis,
    )
    return inspection
  })
  const startReviewSettlement = Effect.fn("Operation.startReviewSettlement")(function* (
    turn: Pick<Turn.Turn, "id" | "lastCursor">,
    fanOutId: string,
    initial?: ExecutionBackend.FanOutInspection,
  ) {
    return yield* reviewSettlementAdmission.withPermits(1)(
      Effect.gen(function* () {
        const existing = reviewSettlements.get(fanOutId)
        if (existing !== undefined) return existing
        const fiber = yield* Effect.forkIn(
          settleReviewOwner(turn, fanOutId, initial).pipe(
            Effect.provide(executionDependencies),
            Effect.mapError((error) => operationError(String(error))),
            Effect.ensuring(Effect.sync(() => reviewSettlements.delete(fanOutId))),
          ),
          ownerScope,
        )
        reviewSettlements.set(fanOutId, fiber)
        return fiber
      }),
    )
  })
  const testRoute = (mode: "low" | "medium" | "high" | "ultra") => Effect.succeed(Turn.testExecutionRoute(mode))
  const resolveExecutionRoute = options.resolveExecutionRoute ?? testRoute
  const executionPrompt = Effect.fn("Operation.executionPrompt")(function* (workspace: string, prompt: string) {
    const context = yield* ResolvedContext.Service
    const threads = yield* ThreadRepository.Service
    const structured = ContextMentions.parse(prompt)
    const bareMentions = [...new Set(FileMentions.parse(prompt))].filter(
      (value) => !/^(?:file|ref|guidance|image):/.test(value),
    )
    const mentionKinds = yield* Effect.forEach(
      bareMentions,
      (value) =>
        threads
          .get(Thread.ThreadId.make(value))
          .pipe(Effect.map((thread) => ({ value, isThread: thread !== undefined }))),
      { concurrency: 1 },
    )
    const files = [
      ...new Set([
        ...mentionKinds.filter(({ isThread }) => !isThread).map(({ value }) => value),
        ...structured.files,
        ...structured.images,
      ]),
    ].toSorted()
    const threadIds = [...new Set(mentionKinds.filter(({ isThread }) => isThread).map(({ value }) => value))]
    const resolved = yield* context.resolve({
      workspace,
      targetPaths: files,
      references: [...files, ...structured.references],
    })
    const turns = yield* TurnRepository.Service
    const threadBlocks = yield* Effect.forEach(
      threadIds,
      (id) =>
        Effect.gen(function* () {
          const thread = yield* threads.get(Thread.ThreadId.make(id))
          if (thread === undefined) return `Thread ${id} was not found`
          const history = yield* turns.list(thread.id)
          return `<thread-data format="json">${untrustedData({ id, content: markdownExport(thread, history) })}</thread-data>`
        }),
      { concurrency: 1 },
    )
    const messages = resolved.diagnostics.map((diagnostic) => diagnostic.message + `: ${diagnostic.path}`)
    if (resolved.sources.length === 0 && threadBlocks.length === 0) return { prompt, digest: resolved.digest, messages }
    const block = [
      ...resolved.sources.map((source) =>
        source.kind === "guidance"
          ? `<guidance-instructions path=${JSON.stringify(source.path)}>\n${source.content}\n</guidance-instructions>`
          : `<reference-data format="json">${untrustedData({ path: source.path, content: source.content })}</reference-data>`,
      ),
      ...threadBlocks,
    ].join("\n\n")
    return {
      prompt: `${prompt}\n\n<resolved-context>\n${block}\n</resolved-context>`,
      digest: resolved.digest,
      messages,
    }
  })
  const prepareExecution = Effect.fn("Operation.prepareExecution")(function* (
    turn: Turn.Turn,
    workspace: string,
    persistExtensionPin: boolean = true,
  ) {
    const resolved = yield* executionPrompt(workspace, turn.prompt)
    const promptParts =
      turn.promptParts === undefined
        ? undefined
        : resolved.prompt === turn.prompt
          ? turn.promptParts
          : [...turn.promptParts, { type: "text" as const, text: resolved.prompt.slice(turn.prompt.length) }]
    if (options.executionExtensions === undefined)
      return { prompt: resolved.prompt, promptParts, extensionPin: turn.extensionPin, messages: resolved.messages }
    const extensions = yield* ExecutionExtensions.Service
    if (turn.extensionPin !== undefined) {
      yield* extensions.resume(turn.extensionPin)
      return { prompt: resolved.prompt, promptParts, extensionPin: turn.extensionPin, messages: resolved.messages }
    }
    const activated = yield* extensions.future(yield* options.executionExtensions.mcpFingerprint, resolved.digest)
    if (persistExtensionPin) {
      const turns = yield* TurnRepository.Service
      yield* turns.setExtensionPin(turn.id, activated.pin)
    }
    return { prompt: resolved.prompt, promptParts, extensionPin: activated.pin, messages: resolved.messages }
  })
  return {
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
    observeUsageCosts: (snapshot: UsageCost.Snapshot) => (usageSnapshot = snapshot),
  }
}

type ExecutionCoordinationInput<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError> = Parameters<
  typeof produceExecutionCoordination<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>
>[0]

export type ExecutionCoordination<
  ThreadError = never,
  TurnError = never,
  BackendError = never,
  ThreadSummaryError = never,
  TranscriptError = never,
> = ReturnType<
  typeof produceExecutionCoordination<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>
>

const makeExecutionCoordination = <ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>(
  input: ExecutionCoordinationInput<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError>,
): ExecutionCoordination<ThreadError, TurnError, BackendError, ThreadSummaryError, TranscriptError> =>
  produceExecutionCoordination(input)

export const internal = { makeExecutionCoordination }

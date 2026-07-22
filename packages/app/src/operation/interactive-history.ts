import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as ThreadSummaryRepository from "@rika/persistence/thread-summary-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import * as Transcript from "@rika/transcript"
import { Clock, Effect, Ref, Semaphore } from "effect"
import type { InteractiveEvent } from "../operation-contract"
import * as InteractiveFeedOverflow from "../interactive-feed-overflow"
import * as UsageCost from "../usage-cost"
import { internal as executionProjection, rootExecutionEvents } from "./execution-projection"
import { operationError } from "./options"
import { internal as threadFormat } from "./thread-format"
const { rootCheckpointCursor, sourceProjection } = executionProjection
const { queueItem } = threadFormat

const isTerminalStatus = (
  status: "accepted" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled",
) => status === "completed" || status === "failed" || status === "cancelled"

export type SelectionLoad = {
  readonly epoch: number
  readonly threadId: string
  readonly previousEpoch: number
  readonly previousThreadId: string | undefined
  readonly events: Array<InteractiveEvent>
  committed: boolean
  overflow?: InteractiveFeedOverflow.State
}

type HistoryDependencies<AppendE, AppendR, PersistE, PersistR, ActivateE, ActivateR, NotifyE, NotifyR, IdE, IdR> = {
  options: { makeThreadId: Effect.Effect<Thread.ThreadId, IdE, IdR> }
  workspace: string
  state: {
    currentSelectionEpoch: number
    selectedThreadId: string | undefined
    selectionLoad: SelectionLoad | undefined
  }
  selectionRequest: Ref.Ref<number>
  transcriptCursor: Ref.Ref<TranscriptRepository.PageCursor | undefined>
  projectedTurnCursor: Ref.Ref<TurnRepository.PageCursor | undefined>
  transcriptHasUnprojectedTurns: Ref.Ref<boolean>
  transcriptHasOlder: Ref.Ref<boolean>
  interactiveThread: Ref.Ref<Thread.Thread | undefined>
  projectionAdmission: Semaphore.Semaphore
  appendProjection: (
    turn: Turn.Turn,
    events: ReadonlyArray<ExecutionBackend.Event>,
  ) => Effect.Effect<void, AppendE, AppendR>
  persistProjectionTree: (turn: Turn.Turn, force: boolean) => Effect.Effect<void, PersistE, PersistR>
  activateChildFollowers: (threadId: Thread.ThreadId) => Effect.Effect<void, ActivateE, ActivateR>
  enqueueChildFollower: (threadId: Thread.ThreadId, executionId: string, rootTurnId: Turn.TurnId) => void
  currentUsageCosts: () => UsageCost.Snapshot
  displayGlobalCostUsd: (costs: UsageCost.Snapshot) => number
  currentActivitySequence: () => number
  notifyThreadSummaries: Effect.Effect<void, NotifyE, NotifyR>
  sessionDispatch: (event: InteractiveEvent) => void
}

export const makeInteractiveHistory = <
  AppendE,
  AppendR,
  PersistE,
  PersistR,
  ActivateE,
  ActivateR,
  NotifyE,
  NotifyR,
  IdE,
  IdR,
>(
  dependencies: HistoryDependencies<
    AppendE,
    AppendR,
    PersistE,
    PersistR,
    ActivateE,
    ActivateR,
    NotifyE,
    NotifyR,
    IdE,
    IdR
  >,
) => {
  const {
    options,
    workspace,
    state,
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
  } = dependencies
  const projectExecutionPages = Effect.fn("Operation.interactive.projectExecutionPages")(function* (
    backend: ExecutionBackend.Interface,
    turn: Turn.Turn,
    status: Turn.Status,
  ) {
    const transcripts = yield* TranscriptRepository.Service
    const current = yield* transcripts.get(turn.id)
    const boundary = rootCheckpointCursor(turn.id, current?.checkpointCursor)
    if (backend.pageEvents === undefined) {
      const result = yield* backend.replay(turn.id, boundary)
      yield* appendProjection({ ...turn, status }, result.events)
      return
    }
    const cursors = new Set<string>()
    let after = boundary
    while (true) {
      const page = yield* backend.pageEvents(turn.id, "forward", after, 200)
      yield* appendProjection({ ...turn, status }, page.events)
      if (!page.hasMore) return
      const next = page.newestCursor
      if (next === undefined || cursors.has(next)) {
        return yield* operationError(`Transcript event cursor did not advance for Turn ${turn.id}`)
      }
      cursors.add(next)
      after = next
    }
  })
  const replayRootProjection = Effect.fn("Operation.interactive.replayRootProjection")(function* (
    backend: ExecutionBackend.Interface,
    turn: Turn.Turn,
  ) {
    let projection = Transcript.empty(turn.id, turn.prompt)
    const apply = (events: ReadonlyArray<ExecutionBackend.Event>) => {
      for (const event of rootExecutionEvents(turn.id, events).toSorted(
        (left, right) => left.sequence - right.sequence,
      ))
        projection = Transcript.applyEvent(projection, event)
    }
    if (backend.pageEvents === undefined) {
      const result = yield* backend.replay(turn.id)
      apply(result.events)
      return { ...projection, pricingVersion: Transcript.pricingVersion }
    }
    let after: string | undefined
    const cursors = new Set<string>()
    while (true) {
      const page = yield* backend.pageEvents(turn.id, "forward", after, 200)
      apply(page.events)
      if (!page.hasMore) return { ...projection, pricingVersion: Transcript.pricingVersion }
      const next = page.newestCursor
      if (next === undefined || cursors.has(next))
        return yield* operationError(`Transcript event cursor did not advance for Turn ${turn.id}`)
      cursors.add(next)
      after = next
    }
  })
  const healedTurns = new Set<string>()
  const healTerminalTurn = Effect.fn("Operation.interactive.healTerminalTurn")(function* (turn: Turn.Turn) {
    if (!isTerminalStatus(turn.status) || healedTurns.has(String(turn.id))) return
    healedTurns.add(String(turn.id))
    const transcripts = yield* TranscriptRepository.Service
    const backend = yield* ExecutionBackend.Service
    const current = yield* transcripts.get(turn.id)
    if (current === undefined) return
    if (Transcript.hasRunningBlocks(sourceProjection(current))) {
      yield* persistProjectionTree(turn, true)
      const settled = yield* transcripts.get(turn.id)
      if (settled !== undefined) {
        const source = sourceProjection(settled)
        if (Transcript.hasRunningBlocks(source)) {
          const leftover = turn.status === "failed" ? ("failed" as const) : ("cancelled" as const)
          yield* projectionAdmission.withPermits(1)(
            transcripts.replace(turn, Transcript.settleRunning(source, leftover, source.revision)),
          )
        }
      }
    }
    if (current.pricingVersion === Transcript.pricingVersion) return
    const replayed = yield* replayRootProjection(backend, turn)
    const stored = yield* transcripts.get(turn.id)
    if (stored === undefined || stored.pricingVersion === Transcript.pricingVersion) return
    const source = sourceProjection(stored)
    const { costUsd: _costUsd, usageCursors: _usageCursors, pricingVersion: _pricingVersion, ...preserved } = source
    yield* projectionAdmission.withPermits(1)(
      transcripts.replace(turn, {
        ...preserved,
        ...(replayed.costUsd === undefined ? {} : { costUsd: replayed.costUsd }),
        ...(replayed.usageCursors === undefined ? {} : { usageCursors: replayed.usageCursors }),
        pricingVersion: Transcript.pricingVersion,
      }),
    )
  })
  const projectTurnPage = Effect.fn("Operation.interactive.projectTurnPage")(function* (
    thread: Thread.Thread,
    request: number,
    before?: TurnRepository.PageCursor,
  ) {
    const turns = yield* TurnRepository.Service
    const transcripts = yield* TranscriptRepository.Service
    const backend = yield* ExecutionBackend.Service
    const page = yield* turns.page(thread.id, { ...(before === undefined ? {} : { before }), limit: 50 })
    yield* Effect.forEach(
      page.turns,
      (turn) =>
        Effect.gen(function* () {
          const projected = yield* transcripts.get(turn.id)
          if (
            projected !== undefined &&
            isTerminalStatus(turn.status) &&
            projected.checkpointCursor === turn.lastCursor
          ) {
            yield* persistProjectionTree(turn, false)
            yield* healTerminalTurn(turn)
            return
          }
          if (turn.status === "queued") {
            return
          }
          const execution = yield* backend.inspect(turn.id)
          if (execution === undefined) {
            yield* projectionAdmission.withPermits(1)(transcripts.replace(turn, Transcript.empty(turn.id, turn.prompt)))
            return
          }
          yield* projectExecutionPages(backend, turn, execution.status)
          yield* persistProjectionTree({ ...turn, status: execution.status }, true)
          yield* healTerminalTurn({ ...turn, status: execution.status })
        }),
      { concurrency: 4, discard: true },
    )
    if ((yield* Ref.get(selectionRequest)) !== request) return false
    yield* Ref.set(projectedTurnCursor, page.oldestCursor)
    yield* Ref.set(transcriptHasUnprojectedTurns, page.hasOlder)
    return true
  })
  const loadTranscriptPage = Effect.fn("Operation.interactive.loadTranscriptPage")(function* (
    thread: Thread.Thread,
    request: number,
    dispatch: (event: InteractiveEvent) => void,
    before?: TranscriptRepository.PageCursor,
  ) {
    const loadedAt = yield* Clock.currentTimeMillis
    const turns = yield* TurnRepository.Service
    const transcripts = yield* TranscriptRepository.Service
    const backend = yield* ExecutionBackend.Service
    if (before === undefined) {
      if (!(yield* projectTurnPage(thread, request))) return
      while (yield* Ref.get(transcriptHasUnprojectedTurns)) {
        const available = yield* transcripts.page(thread.id, { limit: 200 })
        if (available.entries.length >= 200) break
        const turnBefore = yield* Ref.get(projectedTurnCursor)
        if (turnBefore === undefined || !(yield* projectTurnPage(thread, request, turnBefore))) return
      }
    } else {
      const available = yield* transcripts.page(thread.id, { before, limit: 50 })
      if (!available.hasOlder && (yield* Ref.get(transcriptHasUnprojectedTurns))) {
        const turnBefore = yield* Ref.get(projectedTurnCursor)
        if (turnBefore !== undefined && !(yield* projectTurnPage(thread, request, turnBefore))) return
      }
    }
    if ((yield* Ref.get(selectionRequest)) !== request) return
    const page = yield* transcripts.page(thread.id, { ...(before === undefined ? {} : { before }), limit: 50 })
    const olderPages: Array<typeof page.entries> = []
    let entryCount = page.entries.length
    let oldestCursor = page.oldestCursor
    let storedHasOlder = page.hasOlder
    let initialBoundary = -1
    if (before === undefined) {
      const locateInitialBoundary = () => {
        const loaded = olderPages.toReversed().flat().concat(page.entries)
        const latestAllowed = loaded.length - 200
        return latestAllowed < 0
          ? -1
          : loaded.findLastIndex(
              (entry, index) => index <= latestAllowed && entry.unit.key === `turn:${entry.turn.id}:user`,
            )
      }
      initialBoundary = locateInitialBoundary()
      while (storedHasOlder && oldestCursor !== undefined && initialBoundary < 0) {
        const older = yield* transcripts.page(thread.id, {
          before: oldestCursor,
          limit: entryCount < 200 ? Math.min(50, 200 - entryCount) : 50,
        })
        if (older.entries.length === 0) break
        olderPages.push(older.entries)
        entryCount += older.entries.length
        oldestCursor = older.oldestCursor
        storedHasOlder = older.hasOlder
        initialBoundary = locateInitialBoundary()
      }
    }
    const loadedEntries = olderPages.length === 0 ? page.entries : olderPages.toReversed().flat().concat(page.entries)
    const storedEntries = initialBoundary <= 0 ? loadedEntries : loadedEntries.slice(initialBoundary)
    if (initialBoundary > 0) {
      const oldest = storedEntries[0]
      if (oldest !== undefined)
        oldestCursor = {
          createdAt: oldest.turn.createdAt,
          turnId: oldest.turn.id,
          sequence: oldest.unit.order.sequence,
          part: oldest.unit.order.part,
          key: oldest.unit.key,
        }
      storedHasOlder = true
    }
    const usageCosts = currentUsageCosts()
    const entries = storedEntries.map((entry) => {
      const costUsd = usageCosts.turnCostUsd.get(entry.turn.id)
      return costUsd === undefined || (costUsd === 0 && entry.projectionCostUsd === undefined)
        ? entry
        : Object.assign({}, entry, { projectionCostUsd: costUsd })
    })
    const hasOlder = storedHasOlder || (yield* Ref.get(transcriptHasUnprojectedTurns))
    const completedAt = yield* Clock.currentTimeMillis
    if ((yield* Ref.get(selectionRequest)) !== request) return
    yield* Ref.set(transcriptCursor, oldestCursor)
    yield* Ref.set(transcriptHasOlder, hasOlder)
    const observedThreadCostUsd = usageCosts.threadCostUsd.get(thread.id)
    const threadCostUsd =
      observedThreadCostUsd === undefined || !usageCosts.complete ? page.threadCostUsd : observedThreadCostUsd
    if (before === undefined) {
      const queue = yield* turns.readQueue(thread.id)
      const activeTurn = yield* turns.findActive(thread.id)
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          if ((yield* Ref.get(selectionRequest)) !== request) return
          yield* activateChildFollowers(thread.id)
          yield* Ref.set(interactiveThread, thread)
          state.selectedThreadId = String(thread.id)
          const loading = state.selectionLoad
          if (loading !== undefined && loading.epoch === request && loading.threadId === String(thread.id))
            loading.committed = true
          dispatch({
            _tag: "SelectionLoaded",
            selectionEpoch: request,
            activitySequence: currentActivitySequence(),
            thread,
            entries,
            hasOlder,
            threadCostUsd,
            globalCostUsd: displayGlobalCostUsd(usageCosts),
            ...(oldestCursor === undefined ? {} : { oldestCursor }),
            queueRevision: queue.revision,
            queuedCount: queue.queuedCount,
            queue: queue.turns.map(queueItem),
            ...(activeTurn === undefined ? {} : { activeTurn }),
          })
        }),
      )
      if (activeTurn !== undefined) {
        const inspection = yield* backend.inspect(activeTurn.id)
        for (const child of inspection?.children ?? [])
          enqueueChildFollower(thread.id, child.executionId, activeTurn.id)
      }
    } else
      dispatch({
        _tag: "TranscriptPagePrepended",
        selectionEpoch: request,
        threadId: thread.id,
        entries,
        hasOlder,
        threadCostUsd,
        globalCostUsd: displayGlobalCostUsd(usageCosts),
        ...(oldestCursor === undefined ? {} : { oldestCursor }),
      })
    yield* Effect.logInfo("transcript.page.loaded").pipe(
      Effect.annotateLogs({
        "rika.thread.id": String(thread.id),
        "rika.transcript.page.kind": before === undefined ? "initial" : "prepend",
        "rika.transcript.page.units": entries.length,
        "rika.transcript.page.has_older": hasOlder,
        "rika.duration.ms": completedAt - loadedAt,
      }),
    )
  })
  const loadThread = Effect.fn("Operation.interactive.loadThread")(function* (
    thread: Thread.Thread,
    request: number,
    dispatch: (event: InteractiveEvent) => void,
  ) {
    if ((yield* Ref.get(selectionRequest)) !== request) return
    yield* Ref.set(transcriptCursor, undefined)
    yield* Ref.set(projectedTurnCursor, undefined)
    yield* Ref.set(transcriptHasUnprojectedTurns, false)
    yield* Ref.set(transcriptHasOlder, false)
    yield* loadTranscriptPage(thread, request, dispatch)
    if ((yield* Ref.get(selectionRequest)) !== request) return
    const summaries = yield* ThreadSummaryRepository.Service
    yield* summaries.markRead(thread.id, yield* Clock.currentTimeMillis)
    yield* notifyThreadSummaries
  })
  const createAndSelectThread = Effect.fn("Operation.interactive.createAndSelectThread")(function* () {
    const threads = yield* ThreadRepository.Service
    const turns = yield* TurnRepository.Service
    const thread = yield* threads.create({
      id: yield* options.makeThreadId,
      workspace,
      title: "New thread",
      now: yield* Clock.currentTimeMillis,
    })
    const epoch = state.currentSelectionEpoch + 1
    const queue = yield* turns.readQueue(thread.id)
    yield* activateChildFollowers(thread.id)
    state.currentSelectionEpoch = epoch
    state.selectedThreadId = String(thread.id)
    state.selectionLoad = undefined
    yield* Ref.set(selectionRequest, epoch)
    yield* Ref.set(interactiveThread, thread)
    yield* Ref.set(transcriptCursor, undefined)
    yield* Ref.set(projectedTurnCursor, undefined)
    yield* Ref.set(transcriptHasUnprojectedTurns, false)
    yield* Ref.set(transcriptHasOlder, false)
    sessionDispatch({ _tag: "ThreadActivated", threadId: String(thread.id), title: thread.title })
    sessionDispatch({
      _tag: "SelectionLoaded",
      selectionEpoch: epoch,
      activitySequence: currentActivitySequence(),
      thread,
      entries: [],
      hasOlder: false,
      threadCostUsd: 0,
      globalCostUsd: displayGlobalCostUsd(currentUsageCosts()),
      queueRevision: queue.revision,
      queuedCount: queue.queuedCount,
      queue: queue.turns.map(queueItem),
    })
    yield* notifyThreadSummaries
  })
  return { loadTranscriptPage, loadThread, createAndSelectThread }
}

import { Operation } from "@rika/app"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as Turn from "@rika/persistence/turn"
import * as Transcript from "@rika/transcript"
import { ViewState } from "@rika/tui"
import { create as createTui } from "@rika/tui/adapter"
import { Effect, Fiber } from "effect"
import * as InteractiveController from "./interactive-controller"
import { internal as terminalTitleInternal } from "./terminal-title"

const tracedEventTypes = new Set([
  "model.reasoning.delta",
  "model.output.delta",
  "model.toolcall.delta",
  "tool.call.requested",
  "tool.result.received",
])

const traceTuiModelEvent = (seenDeltas: Set<string>, event: Operation.InteractiveEvent) => {
  if (event._tag !== "TranscriptPatched" || !tracedEventTypes.has(event.event.type)) return Effect.void
  const delta = event.event.type.endsWith(".delta")
  const key = `${event.turnId}:${event.event.type}`
  if (delta && seenDeltas.has(key)) return Effect.void
  if (delta) seenDeltas.add(key)
  return Effect.logInfo("tui.model.event_applied").pipe(
    Effect.annotateLogs({
      "rika.event.cursor": event.event.cursor,
      "rika.event.type": event.event.type,
      "rika.thread.id": String(event.threadId),
      "rika.turn.id": String(event.turnId),
    }),
  )
}
const { terminalTitleSequence } = terminalTitleInternal

interface TuiEventDispatchTarget {
  model: ViewState.Model
  renderer: Effect.Success<ReturnType<typeof createTui>> | undefined
  closed: boolean
  renderSuppressed: boolean
  requestSelectionResync: (threadId: string, selectionEpoch: number) => void
  readonly fork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>
  readonly session: Operation.InteractiveSession
}

export const makeTuiEventDispatch = (target: TuiEventDispatchTarget) => {
  let renderTimer: Fiber.Fiber<void, never> | undefined
  let feedTimer: Fiber.Fiber<void, never> | undefined
  let applyingFeedBatch = false
  let feedPreserveAnchor = false
  let replayTurns = new Map<string, Turn.Turn>()
  let loadedTranscriptEntries: ReadonlyArray<TranscriptRepository.Entry> = []
  let projectionRevisions = new Map<string, number>()
  let transcriptProjections = new Map<string, Transcript.Projection>()
  let threadCostUsd = 0
  const appliedDeltas = new Set<string>()
  let activeSelectionEpoch = 0
  const render = (immediate = false) => {
    if (applyingFeedBatch || target.renderer === undefined || target.renderSuppressed) return
    if (immediate) {
      if (renderTimer !== undefined) target.fork(Fiber.interrupt(renderTimer))
      renderTimer = undefined
      target.renderer.surface.update(target.model)
      return
    }
    if (renderTimer !== undefined) return
    renderTimer = target.fork(
      Effect.sleep("16 millis").pipe(
        Effect.andThen(
          Effect.sync(() => {
            renderTimer = undefined
            target.renderer?.surface.update(target.model)
          }),
        ),
      ),
    )
  }
  const dispatch = (event: Operation.InteractiveEvent) => {
    if (target.closed) return
    if (
      event._tag === "SelectionLoaded" ||
      event._tag === "TranscriptPagePrepended" ||
      event._tag === "TranscriptPatched" ||
      event._tag === "TranscriptResyncRequired"
    ) {
      const previousThreadId = target.model.currentThreadId
      const previousThreadTitle = target.model.currentThreadTitle
      const controlled = InteractiveController.update(
        {
          model: target.model,
          selectionEpoch: activeSelectionEpoch,
          replayTurns,
          entries: loadedTranscriptEntries,
          revisions: projectionRevisions,
          projections: transcriptProjections,
          threadCostUsd,
        },
        event,
      )
      target.model = controlled.state.model
      activeSelectionEpoch = controlled.state.selectionEpoch
      replayTurns = new Map(controlled.state.replayTurns)
      loadedTranscriptEntries = controlled.state.entries
      projectionRevisions = new Map(controlled.state.revisions)
      transcriptProjections = new Map(controlled.state.projections)
      threadCostUsd = controlled.state.threadCostUsd
      if (
        event._tag === "SelectionLoaded" &&
        target.model.currentThreadId === event.thread.id &&
        (target.model.currentThreadId !== previousThreadId || target.model.currentThreadTitle !== previousThreadTitle)
      )
        process.stdout.write(terminalTitleSequence(event.thread.title, target.model.workspace))
      if (event._tag === "TranscriptPatched") target.fork(traceTuiModelEvent(appliedDeltas, event))
      if (event._tag === "TranscriptResyncRequired" && target.model.currentThreadId !== undefined)
        target.requestSelectionResync(target.model.currentThreadId, event.selectionEpoch)
      if (controlled.preserveAnchor) {
        if (applyingFeedBatch) feedPreserveAnchor = true
        else target.renderer?.surface.update(target.model, true)
      } else
        render(
          event._tag === "TranscriptResyncRequired" ||
            (event._tag === "TranscriptPatched" &&
              (event.event.type === "execution.completed" ||
                event.event.type === "execution.failed" ||
                event.event.type === "execution.cancelled" ||
                event.event.type === "permission.ask.requested" ||
                event.event.type === "tool.approval.requested")),
        )
      return
    }
    if (event._tag === "QueueUpdated") {
      if (
        event.selectionEpoch === activeSelectionEpoch &&
        (target.model.currentThreadId === undefined || target.model.currentThreadId === event.threadId)
      ) {
        const updated = InteractiveController.updateQueue(target.model, event)
        target.model = updated.model
        if (updated.resync) target.requestSelectionResync(event.threadId, event.selectionEpoch)
      }
    } else if (event._tag === "QueueResyncRequired") {
      if (
        event.selectionEpoch === activeSelectionEpoch &&
        (target.model.currentThreadId === undefined || target.model.currentThreadId === event.threadId)
      )
        target.requestSelectionResync(event.threadId, event.selectionEpoch)
    } else if (event._tag === "TurnStarted") {
      if (
        event.selectionEpoch === activeSelectionEpoch &&
        (target.model.currentThreadId === undefined || target.model.currentThreadId === event.threadId)
      ) {
        const known = replayTurns.get(event.turn.id)
        if (
          known?.status === "completed" ||
          known?.status === "failed" ||
          known?.status === "cancelled" ||
          target.model.activeTurnId === event.turn.id
        )
          return
        if (target.model.queue.some((item) => item.id === event.turn.id)) {
          target.model = InteractiveController.removePromotedTurn(target.model, event.threadId, event.turn.id)
          target.fork(target.session.readQueue(event.threadId))
        }
        replayTurns.set(event.turn.id, event.turn)
        transcriptProjections.set(event.turn.id, Transcript.empty(event.turn.id, event.turn.prompt))
        target.model = ViewState.update(target.model, {
          _tag: "TurnStarted",
          turnId: event.turn.id,
          prompt: event.turn.prompt,
        })
      }
    } else if (event._tag === "ThreadsListed") {
      target.model = ViewState.update(target.model, {
        _tag: "ThreadsReplaced",
        threads: event.threads.map((thread) => ({
          id: thread.id,
          title: thread.title,
          workspace: thread.workspace,
          pinned: thread.pinned,
          archived: thread.archived,
          status: thread.status,
          unread: thread.unread,
          lastActivityAt: thread.lastActivityAt,
          ...(thread.editTotals === undefined ? {} : { editTotals: thread.editTotals }),
        })),
      })
    } else if (event._tag === "ExecutionControlled") {
      if (event.threadId !== undefined && event.selectionEpoch !== activeSelectionEpoch) return
      if (event.threadId !== undefined && target.model.currentThreadId !== event.threadId) return
      if (event.action === "cancelled" && target.model.busy)
        target.model = ViewState.update(target.model, {
          _tag: "ExecutionCancelled",
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        })
    } else if (event._tag === "ContextDiagnostics") {
      if (event.selectionEpoch !== activeSelectionEpoch || target.model.currentThreadId !== event.threadId) return
      target.model = ViewState.update(target.model, {
        _tag: "BlockAdded",
        block: { _tag: "Notification", title: "Context resolution", detail: event.messages.join("\n") },
      })
    } else if (event._tag === "ExecutionFailed") {
      if (event.threadId !== undefined && event.selectionEpoch !== activeSelectionEpoch) return
      if (event.threadId !== undefined && target.model.currentThreadId !== event.threadId) return
      target.model = ViewState.update(target.model, {
        _tag: "ExecutionFailed",
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        message: event.message,
      })
    } else if (event._tag === "QueueFull") {
      if (event.selectionEpoch !== activeSelectionEpoch) return
      if (target.model.currentThreadId !== undefined && target.model.currentThreadId !== event.threadId) return
      target.model = InteractiveController.updateQueue(target.model, event).model
    } else if (event._tag === "ShellPermissionRequested") {
      target.model = ViewState.update(target.model, {
        _tag: "BlockAdded",
        block: {
          _tag: "Permission",
          id: event.id,
          kind: "permission",
          title: "Run shell command",
          detail: event.command,
          status: "pending",
        },
      })
    } else if (event._tag === "ShellPermissionCancelled") {
      target.model = ViewState.update(target.model, { _tag: "PermissionCancelled", id: event.id })
    } else if (event._tag === "ShellCompleted") {
      target.model = ViewState.update(target.model, { _tag: "AssistantCompleted", text: event.text })
      target.model = ViewState.update(target.model, { _tag: "ExecutionCompleted" })
    } else if (event._tag === "TitleCostUpdated") {
      if (target.model.currentThreadId === event.threadId) {
        threadCostUsd = event.threadCostUsd
        target.model = { ...target.model, costUsd: event.threadCostUsd }
      }
    } else if (event._tag === "ThreadTitled") {
      target.model = ViewState.update(target.model, {
        _tag: "ThreadTitleChanged",
        threadId: event.threadId,
        title: event.title,
      })
      if (target.model.currentThreadId === event.threadId)
        process.stdout.write(terminalTitleSequence(event.title, target.model.workspace))
    } else if (event._tag === "ThreadActivated") {
      target.model = ViewState.update(target.model, {
        _tag: "ThreadActivated",
        threadId: event.threadId,
        title: event.title,
      })
      if (target.model.currentThreadId === event.threadId)
        process.stdout.write(terminalTitleSequence(event.title, target.model.workspace))
    } else if (event._tag === "ThreadPreviewLoaded") {
      if (target.model.threadSwitcher.open && ViewState.selectedThreadMetadata(target.model)?.id === event.threadId)
        target.model = ViewState.update(target.model, {
          _tag: "ThreadPreviewLoaded",
          threadId: event.threadId,
          turns: event.turns,
        })
    } else target.model = ViewState.update(target.model, event)
    render(
      event._tag === "ContextDiagnostics" ||
        event._tag === "ExecutionFailed" ||
        event._tag === "QueueFull" ||
        event._tag === "ExecutionControlled",
    )
  }
  const feedBatcher = InteractiveController.makeFeedFrameBatcher<Operation.InteractiveEvent>({
    schedule: (flush) => {
      feedTimer = target.fork(
        Effect.sleep("16 millis").pipe(
          Effect.andThen(
            Effect.sync(() => {
              feedTimer = undefined
              flush()
            }),
          ),
        ),
      )
    },
    apply: (events) => {
      applyingFeedBatch = true
      try {
        for (const event of events) dispatch(event)
      } finally {
        applyingFeedBatch = false
      }
    },
    render: () => {
      if (target.renderer !== undefined && !target.renderSuppressed)
        target.renderer.surface.update(target.model, feedPreserveAnchor)
      feedPreserveAnchor = false
    },
  })
  return Object.assign(target, {
    get selectionEpoch() {
      return activeSelectionEpoch
    },
    dispatch,
    feedBatcher,
    interruptTimers: Effect.gen(function* () {
      if (renderTimer !== undefined) yield* Fiber.interrupt(renderTimer)
      renderTimer = undefined
      if (feedTimer !== undefined) yield* Fiber.interrupt(feedTimer)
      feedTimer = undefined
    }),
  })
}

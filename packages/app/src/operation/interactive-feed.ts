import * as Thread from "@rika/persistence/thread"
import { Effect, Queue, Ref } from "effect"
import * as InteractiveFeedOverflow from "../interactive-feed-overflow"
import type { InteractiveEvent } from "../operation-contract"
import * as UsageCost from "../usage-cost"
import type { SelectionLoad } from "./interactive-history"

const capacity = 8192
const ignoreInteractiveEvent = (_event: InteractiveEvent) => {}

export type SessionEnvelope = {
  readonly event: InteractiveEvent
  readonly selectionRequest?: number
  readonly selectedThreadOnly?: boolean
}

export const interactiveEventThreadId = (event: InteractiveEvent): string | undefined =>
  event._tag === "SelectionLoaded"
    ? String(event.thread.id)
    : "threadId" in event && event.threadId !== undefined
      ? String(event.threadId)
      : undefined

const withSelectionEpoch = (event: InteractiveEvent, selectionEpoch: number): InteractiveEvent => {
  switch (event._tag) {
    case "SelectionLoaded":
    case "TranscriptPagePrepended":
    case "TranscriptPatched":
    case "TranscriptResyncRequired":
    case "QueueUpdated":
    case "QueueResyncRequired":
    case "QueueFull":
    case "TurnStarted":
    case "ContextDiagnostics":
    case "ExecutionFailed":
    case "ExecutionControlled":
      return { ...event, selectionEpoch }
    default:
      return event
  }
}

export const makeInteractiveFeed = Effect.fn("Operation.makeInteractiveFeed")(function* (dependencies: {
  readonly initialThreadId?: string
  readonly selectionRequest: Ref.Ref<number>
  readonly currentUsageCosts: () => UsageCost.Snapshot
  readonly displayGlobalCostUsd: (costs: UsageCost.Snapshot) => number
  readonly observeUsageCosts: (costs: UsageCost.Snapshot) => void
}) {
  const sessionEvents = yield* Queue.bounded<SessionEnvelope>(capacity)
  let selectedThreadId = dependencies.initialThreadId
  let currentSelectionEpoch = 0
  let overflow: InteractiveFeedOverflow.State | undefined
  let selectionLoad: SelectionLoad | undefined =
    dependencies.initialThreadId === undefined
      ? undefined
      : {
          epoch: 0,
          threadId: dependencies.initialThreadId,
          previousEpoch: 0,
          previousThreadId: undefined,
          events: [],
          committed: false,
        }
  let observeChildSpawn = ignoreInteractiveEvent
  const historyState = {
    get currentSelectionEpoch() {
      return currentSelectionEpoch
    },
    set currentSelectionEpoch(value: number) {
      currentSelectionEpoch = value
    },
    get selectedThreadId() {
      return selectedThreadId
    },
    set selectedThreadId(value: string | undefined) {
      selectedThreadId = value
    },
    get selectionLoad() {
      return selectionLoad
    },
    set selectionLoad(value: SelectionLoad | undefined) {
      selectionLoad = value
    },
  }
  const feedState = {
    get overflow() {
      return overflow
    },
    set overflow(value: InteractiveFeedOverflow.State | undefined) {
      overflow = value
    },
  }
  const bufferSelectionEvent = (event: InteractiveEvent) => {
    if (InteractiveFeedOverflow.isCritical(event)) return false
    const loading = selectionLoad
    if (loading === undefined || interactiveEventThreadId(event) !== loading.threadId) return false
    const selectedEvent = withSelectionEpoch(event, loading.epoch)
    if (loading.overflow !== undefined) {
      InteractiveFeedOverflow.remember(loading.overflow, selectedEvent)
      return true
    }
    if (loading.events.length < capacity) {
      loading.events.push(selectedEvent)
      return true
    }
    loading.overflow = InteractiveFeedOverflow.make()
    for (const buffered of loading.events) InteractiveFeedOverflow.remember(loading.overflow, buffered)
    loading.events.length = 0
    InteractiveFeedOverflow.remember(loading.overflow, selectedEvent)
    return true
  }
  const withUsageCosts = (event: InteractiveEvent): InteractiveEvent => {
    if (event._tag !== "TranscriptPatched" || event.event.type !== "model.usage.reported") return event
    const rootTurnId = event.rootTurnId ?? event.turnId
    dependencies.observeUsageCosts(
      UsageCost.observe(dependencies.currentUsageCosts(), {
        threadId: String(event.threadId),
        turnId: String(rootTurnId),
        event: event.event,
      }),
    )
    const totals = dependencies.currentUsageCosts()
    return {
      ...event,
      rootTurnId,
      rootTurnCostUsd: totals.turnCostUsd.get(rootTurnId) ?? 0,
      threadCostUsd: totals.threadCostUsd.get(event.threadId) ?? 0,
      globalCostUsd: dependencies.displayGlobalCostUsd(totals),
    }
  }
  const deliver = (
    event: InteractiveEvent,
    options?: { readonly selectionRequest?: number; readonly selectedThreadOnly?: boolean },
  ) => {
    const selectedEvent = withSelectionEpoch(withUsageCosts(event), options?.selectionRequest ?? currentSelectionEpoch)
    const envelope: SessionEnvelope = {
      event: selectedEvent,
      ...(options?.selectionRequest === undefined ? {} : { selectionRequest: options.selectionRequest }),
      ...(options?.selectedThreadOnly === undefined ? {} : { selectedThreadOnly: options.selectedThreadOnly }),
    }
    if (overflow !== undefined) {
      InteractiveFeedOverflow.remember(overflow, selectedEvent)
      return false
    }
    if (Queue.offerUnsafe(sessionEvents, envelope)) {
      observeChildSpawn(selectedEvent)
      return true
    }
    overflow = InteractiveFeedOverflow.make()
    InteractiveFeedOverflow.remember(overflow, selectedEvent)
    return false
  }
  const sessionDispatch = (event: InteractiveEvent) => {
    if (!bufferSelectionEvent(event)) deliver(event)
  }
  const selectionDispatch = (request: number) => (event: InteractiveEvent) =>
    deliver(event, { selectionRequest: request })
  const finishSelection = (epoch: number) =>
    Effect.gen(function* () {
      const loading = selectionLoad
      if (loading === undefined || loading.epoch !== epoch) return
      selectionLoad = undefined
      if (!loading.committed) {
        const restored = yield* Ref.modify(dependencies.selectionRequest, (current) =>
          current === epoch ? [true, loading.previousEpoch] : [false, current],
        )
        if (!restored) return
        selectedThreadId = loading.previousThreadId
        currentSelectionEpoch = loading.previousEpoch
        return
      }
      if (loading.overflow === undefined) {
        for (const event of loading.events) deliver(event, { selectionRequest: epoch, selectedThreadOnly: true })
        return
      }
      const threadId = Thread.ThreadId.make(loading.threadId)
      if (loading.overflow.transcriptThreadIds.size > 0)
        deliver(
          {
            _tag: "TranscriptResyncRequired",
            selectionEpoch: epoch,
            threadId,
            reason: "Selection activity exceeded its bounded live window",
          },
          { selectionRequest: epoch, selectedThreadOnly: true },
        )
      if (loading.overflow.queueThreadIds.size > 0)
        deliver(
          {
            _tag: "QueueResyncRequired",
            selectionEpoch: epoch,
            threadId,
            reason: "Selection queue activity exceeded its bounded live window",
          },
          { selectionRequest: epoch, selectedThreadOnly: true },
        )
    })
  return {
    sessionEvents,
    historyState,
    feedState,
    bufferSelectionEvent,
    deliver,
    sessionDispatch,
    selectionDispatch,
    finishSelection,
    setObserveChildSpawn: (observer: (event: InteractiveEvent) => void) => {
      observeChildSpawn = observer
    },
  }
})

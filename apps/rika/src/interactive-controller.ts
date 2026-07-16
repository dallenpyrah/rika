import type * as Operation from "@rika/app/operation"
import type * as TranscriptRepository from "@rika/persistence/transcript-repository"
import type * as Turn from "@rika/persistence/turn"
import * as Transcript from "@rika/transcript"
import { ExecutionEvents, ViewState } from "@rika/tui"
import { Function } from "effect"

type TranscriptEvent = Extract<
  Operation.InteractiveEvent,
  | { readonly _tag: "TranscriptPageReceived" }
  | { readonly _tag: "TranscriptPagePrepended" }
  | { readonly _tag: "TranscriptPatched" }
  | { readonly _tag: "TranscriptResyncRequired" }
>

export interface State {
  readonly model: ViewState.Model
  readonly replayTurns: ReadonlyMap<string, Turn.Turn>
  readonly entries: ReadonlyArray<TranscriptRepository.Entry>
  readonly revisions: ReadonlyMap<string, number>
  readonly projections: ReadonlyMap<string, Transcript.Projection>
  readonly threadCostUsd: number
}

export interface Update {
  readonly state: State
  readonly preserveAnchor: boolean
}

const cleared = (model: ViewState.Model): ViewState.Model => ({
  ...model,
  entries: [],
  blocks: [],
  items: [],
  seenEventIds: [],
  seenExecutionEventKeys: [],
  eventCursor: undefined,
})

const project = (model: ViewState.Model, entries: ReadonlyArray<TranscriptRepository.Entry>, threadCostUsd: number) => {
  const next = ExecutionEvents.projectUnits(
    model,
    entries.map((entry) => entry.unit),
  )
  return { ...next, costUsd: threadCostUsd }
}

const projections = (
  entries: ReadonlyArray<TranscriptRepository.Entry>,
): ReadonlyMap<string, Transcript.Projection> => {
  const grouped = new Map<string, Array<TranscriptRepository.Entry>>()
  for (const entry of entries) grouped.set(entry.turn.id, [...(grouped.get(entry.turn.id) ?? []), entry])
  return new Map(
    [...grouped].map(([turnId, values]) => {
      const latest = values.reduce((left, right) =>
        right.projectionRevision >= left.projectionRevision ? right : left,
      )
      const cost = values.find((entry) => entry.projectionCostUsd !== undefined)?.projectionCostUsd
      return [
        turnId,
        {
          units: values.map((entry) => entry.unit),
          revision: latest.projectionRevision,
          modelPhase: latest.projectionModelPhase,
          ...(cost === undefined ? {} : { costUsd: cost }),
        },
      ] as const
    }),
  )
}

const prependProjection = (
  model: ViewState.Model,
  entries: ReadonlyArray<TranscriptRepository.Entry>,
  threadCostUsd: number,
): ViewState.Model => {
  const older = project(
    cleared({
      ...model,
      activeTurnId: undefined,
      busy: false,
      busyStatus: undefined,
      costUsd: threadCostUsd,
    }),
    entries,
    threadCostUsd,
  )
  const mergedEntries = [...older.entries]
  const mergedBlocks = [...older.blocks] as Array<ViewState.TranscriptBlock>
  const mergedItems = [...older.items] as Array<ViewState.TranscriptItem>
  const mutableBlocks = new Map<string, number>()
  for (const [index, block] of mergedBlocks.entries())
    if (block._tag === "ToolCall" || block._tag === "Permission")
      mutableBlocks.set(`${block._tag}\u0000${block.id}`, index)
  for (const item of model.items as ReadonlyArray<ViewState.TranscriptItem>) {
    if (item._tag === "Entry") {
      const entry = model.entries[item.index]
      if (entry === undefined) continue
      mergedItems.push({ ...item, index: mergedEntries.length })
      mergedEntries.push(entry)
      continue
    }
    const block = model.blocks[item.index] as ViewState.TranscriptBlock | undefined
    if (block === undefined) continue
    if (block._tag === "ToolResult") {
      const index = mutableBlocks.get(`ToolCall\u0000${block.id}`)
      const requested = index === undefined ? undefined : mergedBlocks[index]
      if (index !== undefined && requested?._tag === "ToolCall") {
        mergedBlocks[index] = {
          ...requested,
          output: block.output,
          status: block.failed ? "failed" : "complete",
        }
        continue
      }
    }
    if (block._tag === "ToolCall" || block._tag === "Permission") {
      const key = `${block._tag}\u0000${block.id}`
      const index = mutableBlocks.get(key)
      const current = index === undefined ? undefined : mergedBlocks[index]
      if (index !== undefined && current?._tag === block._tag) {
        mergedBlocks[index] = { ...current, ...block } as ViewState.TranscriptBlock
        continue
      }
      mutableBlocks.set(key, mergedBlocks.length)
    }
    mergedItems.push({ ...item, index: mergedBlocks.length })
    mergedBlocks.push(block)
  }
  return {
    ...model,
    entries: mergedEntries,
    blocks: mergedBlocks,
    items: mergedItems,
    costUsd: threadCostUsd,
  }
}

const updateState = (state: State, event: TranscriptEvent): Update => {
  if (event._tag === "TranscriptPageReceived") {
    if (
      state.model.currentThreadId === event.thread.id &&
      event.entries.some((entry) => entry.projectionRevision < (state.revisions.get(entry.turn.id) ?? -1))
    )
      return { state, preserveAnchor: false }
    const activeTurn = event.entries
      .map((entry) => entry.turn)
      .find((turn) => turn.status === "accepted" || turn.status === "running" || turn.status === "waiting")
    const model = cleared({
      ...state.model,
      activeTurnId: activeTurn?.id,
      busy: activeTurn !== undefined,
      busyStatus: activeTurn === undefined ? undefined : "Working",
      currentThreadId: String(event.thread.id),
      currentThreadTitle: event.thread.title,
      threadSidebar: {
        ...state.model.threadSidebar,
        selected: Math.max(
          0,
          (state.model.threads as ReadonlyArray<ViewState.ThreadItem>).findIndex(
            (thread) => thread.id === event.thread.id,
          ),
        ),
      },
      threadPreview: ViewState.idle,
    })
    return {
      state: {
        model: project(model, event.entries, event.threadCostUsd),
        replayTurns: new Map(event.entries.map((entry) => [entry.turn.id, entry.turn])),
        entries: event.entries,
        revisions: new Map(event.entries.map((entry) => [entry.turn.id, entry.projectionRevision])),
        projections: projections(event.entries),
        threadCostUsd: event.threadCostUsd,
      },
      preserveAnchor: false,
    }
  }
  if (event._tag === "TranscriptPagePrepended") {
    if (state.model.currentThreadId !== event.threadId) return { state, preserveAnchor: false }
    const known = new Set(state.entries.map((entry) => entry.unit.key))
    const prepended = event.entries.filter((entry) => !known.has(entry.unit.key))
    const entries = [...prepended, ...state.entries]
    const revisions = new Map(state.revisions)
    for (const entry of prepended)
      revisions.set(entry.turn.id, Math.max(entry.projectionRevision, revisions.get(entry.turn.id) ?? -1))
    return {
      state: {
        model: prependProjection(state.model, prepended, event.threadCostUsd),
        replayTurns: new Map([...prepended.map((entry) => [entry.turn.id, entry.turn] as const), ...state.replayTurns]),
        entries,
        revisions,
        projections: new Map([...projections(prepended), ...state.projections]),
        threadCostUsd: event.threadCostUsd,
      },
      preserveAnchor: true,
    }
  }
  if (event._tag === "TranscriptPatched") {
    if (state.model.currentThreadId !== undefined && state.model.currentThreadId !== event.threadId)
      return { state, preserveAnchor: false }
    if (event.revision <= (state.revisions.get(event.turnId) ?? -1)) return { state, preserveAnchor: false }
    const turn = state.replayTurns.get(event.turnId)
    if (turn === undefined) return { state, preserveAnchor: false }
    const previous = state.projections.get(event.turnId) ?? Transcript.empty(turn.id, turn.prompt)
    const next = Transcript.applyEvent(previous, event.event)
    const previousCost = previous.costUsd ?? 0
    const nextCost = next.costUsd ?? 0
    const threadCostUsd = state.threadCostUsd + nextCost - previousCost
    const projectedModel = ExecutionEvents.projectUnits(state.model, next.units)
    const terminal =
      event.event.type === "execution.completed" ||
      event.event.type === "execution.failed" ||
      event.event.type === "execution.cancelled"
    const model = terminal
      ? { ...projectedModel, activeTurnId: undefined, busy: false, busyStatus: undefined }
      : projectedModel
    const known = new Map(state.entries.map((entry, index) => [entry.unit.key, index] as const))
    const entries = [...state.entries]
    for (const unit of next.units) {
      const entry: TranscriptRepository.Entry = {
        turn,
        unit,
        projectionRevision: next.revision,
        projectionModelPhase: next.modelPhase,
        ...(next.costUsd === undefined ? {} : { projectionCostUsd: next.costUsd }),
      }
      const index = known.get(unit.key)
      if (index === undefined) {
        known.set(unit.key, entries.length)
        entries.push(entry)
      } else entries[index] = entry
    }
    return {
      state: {
        ...state,
        model: { ...model, costUsd: threadCostUsd },
        entries,
        revisions: new Map([...state.revisions, [event.turnId, event.revision]]),
        projections: new Map([...state.projections, [event.turnId, next]]),
        threadCostUsd,
      },
      preserveAnchor: false,
    }
  }
  if (state.model.currentThreadId !== event.threadId) return { state, preserveAnchor: false }
  return {
    state: {
      ...state,
      model: ViewState.update(state.model, { _tag: "ExecutionFailed", message: event.reason }),
    },
    preserveAnchor: false,
  }
}

export const update: {
  (event: TranscriptEvent): (state: State) => Update
  (state: State, event: TranscriptEvent): Update
} = Function.dual(2, updateState)

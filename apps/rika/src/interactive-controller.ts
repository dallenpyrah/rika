import type * as Operation from "@rika/app/operation"
import type * as TranscriptRepository from "@rika/persistence/transcript-repository"
import type * as Turn from "@rika/persistence/turn"
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

const project = (model: ViewState.Model, entries: ReadonlyArray<TranscriptRepository.Entry>) =>
  entries.reduce(
    (state, entry) => ExecutionEvents.projectTurn(state, entry.turn.id, entry.turn.prompt, entry.events),
    model,
  )

const updateState = (state: State, event: TranscriptEvent): Update => {
  if (event._tag === "TranscriptPageReceived") {
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
        model: project(model, event.entries),
        replayTurns: new Map(event.entries.map((entry) => [entry.turn.id, entry.turn])),
        entries: event.entries,
      },
      preserveAnchor: false,
    }
  }
  if (event._tag === "TranscriptPagePrepended") {
    if (state.model.currentThreadId !== event.threadId) return { state, preserveAnchor: false }
    const known = new Set(state.entries.map((entry) => entry.turn.id))
    const entries = [...event.entries.filter((entry) => !known.has(entry.turn.id)), ...state.entries]
    return {
      state: {
        model: project(cleared(state.model), entries),
        replayTurns: new Map(entries.map((entry) => [entry.turn.id, entry.turn])),
        entries,
      },
      preserveAnchor: true,
    }
  }
  if (event._tag === "TranscriptPatched") {
    if (state.model.currentThreadId !== undefined && state.model.currentThreadId !== event.threadId)
      return { state, preserveAnchor: false }
    return {
      state: {
        ...state,
        model: ExecutionEvents.project(state.model, [{ ...event.event, turnId: event.turnId }]),
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

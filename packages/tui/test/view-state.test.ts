import { describe, expect, test } from "bun:test"
import { Common, Event, Ids } from "@rika/schema"
import { ViewState } from "../src/index"

const threadId = Ids.ThreadId.make("thread_view_state")
const turnId = Ids.TurnId.make("turn_view_state")

const base = (): ViewState.ViewState =>
  ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "smart" })

describe("ViewState input editing", () => {
  test("insertText, cursor movement, and backspace are pure", () => {
    let state = base()
    state = ViewState.insertText(state, "hello")
    expect(state.input).toEqual({ text: "hello", cursor: 5 })
    state = ViewState.moveCursorLeft(ViewState.moveCursorLeft(state))
    expect(state.input.cursor).toBe(3)
    state = ViewState.insertText(state, "X")
    expect(state.input.text).toBe("helXlo")
    state = ViewState.backspace(state)
    expect(state.input.text).toBe("hello")
    state = ViewState.moveCursorHome(state)
    expect(state.input.cursor).toBe(0)
    state = ViewState.moveCursorEnd(state)
    expect(state.input.cursor).toBe(5)
    state = ViewState.newline(state)
    expect(state.input.text).toBe("hello\n")
    state = ViewState.clearInput(state)
    expect(state.input).toEqual({ text: "", cursor: 0 })
  })
})

describe("ViewState focus + expansion", () => {
  test("focus walks cards and toggleDetails expands the focused card", () => {
    const state = withCards()
    expect(state.cards.length).toBe(2)
    const focused = ViewState.focusNext(state)
    expect(focused.focus_index).toBe(0)
    const card = state.cards[0]!
    expect(ViewState.isCardCollapsed(focused, card)).toBe(true)
    const expanded = ViewState.toggleDetails(focused)
    expect(ViewState.isCardCollapsed(expanded, card)).toBe(false)
    expect(expanded.expanded_ids.has(card.id)).toBe(true)
  })

  test("toggleDetails with no focus flips session details and thinking", () => {
    const state = withCards()
    const toggled = ViewState.toggleDetails(state)
    expect(toggled.details_expanded).toBe(true)
    expect(toggled.thinking.visible).toBe(true)
    const card = state.cards[0]!
    expect(ViewState.isCardCollapsed(toggled, card)).toBe(false)
  })
})

describe("ViewState queue + thinking", () => {
  test("enqueue and dequeue messages in order", () => {
    let state = ViewState.enqueueMessage(ViewState.enqueueMessage(base(), "one"), "two")
    expect(state.queued).toEqual(["one", "two"])
    const first = ViewState.dequeueMessage(state)
    expect(first.next).toBe("one")
    state = first.state
    expect(state.queued).toEqual(["two"])
    expect(ViewState.dequeueMessage(ViewState.dequeueMessage(state).state).next).toBeUndefined()
  })

  test("queueUp/queueDown select queued messages and dequeueSelected removes the focused one", () => {
    let state = ViewState.enqueueMessage(ViewState.enqueueMessage(base(), "a"), "b")
    expect(state.queue_selected).toBe(-1)
    state = ViewState.queueUp(state)
    expect(state.queue_selected).toBe(1)
    state = ViewState.queueUp(state)
    expect(state.queue_selected).toBe(0)
    state = ViewState.queueDown(state)
    expect(state.queue_selected).toBe(1)
    expect(ViewState.selectedQueued(state)).toBe("b")
    state = ViewState.dequeueSelected(state)
    expect(state.queued).toEqual(["a"])
    expect(state.queue_selected).toBe(0)
  })

  test("Tab message nav: navPrevMessage selects prior user messages, editNavMessage loads into input", () => {
    const state: ViewState.ViewState = {
      ...base(),
      entries: [
        { kind: "message", message: { id: "u1", role: "user", text: "first prompt" } },
        { kind: "message", message: { id: "a1", role: "assistant", text: "ok" } },
        { kind: "message", message: { id: "u2", role: "user", text: "second prompt" } },
      ],
    }
    const one = ViewState.navPrevMessage(state)
    expect(one.nav_index).toBe(0)
    expect(ViewState.selectedNavId(one)).toBe("u2")
    const two = ViewState.navPrevMessage(one)
    expect(ViewState.selectedNavId(two)).toBe("u1")
    const edited = ViewState.editNavMessage(two)
    expect(edited.input.text).toBe("first prompt")
    expect(edited.nav_index).toBe(-1)
  })

  test("prompt history: pushHistory stores and historyPrev/Next cycle", () => {
    let state = ViewState.pushHistory(ViewState.pushHistory(base(), "first"), "second")
    expect(state.history).toEqual(["first", "second"])
    state = ViewState.historyPrev(state)
    expect(state.input.text).toBe("second")
    state = ViewState.historyPrev(state)
    expect(state.input.text).toBe("first")
    state = ViewState.historyNext(state)
    expect(state.input.text).toBe("second")
    state = ViewState.historyNext(state)
    expect(state.input.text).toBe("")
    expect(state.history_index).toBe(-1)
  })

  test("withReasoningDelta appends and toggleThinking flips visibility", () => {
    let state = ViewState.withReasoningDelta(ViewState.withReasoningDelta(base(), "abc"), "def")
    expect(state.thinking.text).toBe("abcdef")
    expect(state.thinking.visible).toBe(false)
    state = ViewState.toggleThinking(state)
    expect(state.thinking.visible).toBe(true)
  })

  test("applyEvent handles a model.reasoning.delta event when present", () => {
    const reasoning: Event.ModelReasoningDelta = {
      id: Ids.EventId.make("event_reasoning_1"),
      thread_id: threadId,
      turn_id: turnId,
      sequence: 1,
      version: 1,
      created_at: Common.TimestampMillis.make(1),
      type: "model.reasoning.delta",
      data: { text: "pondering", provider: "fake", model: "fake" },
    }
    const state = ViewState.applyEvent(base(), reasoning)
    expect(state.thinking.text).toBe("pondering")
  })
})

describe("ViewState palette", () => {
  test("open/insert/move/close keep palette_open mirrored", () => {
    let state = ViewState.openPalette(base())
    expect(state.palette.open).toBe(true)
    expect(state.palette_open).toBe(true)
    state = ViewState.paletteInsert(state, "m")
    expect(state.palette.query).toBe("m")
    state = ViewState.paletteMove(state, 1, 3)
    expect(state.palette.selected).toBe(1)
    state = ViewState.paletteMove(state, -2, 3)
    expect(state.palette.selected).toBe(2)
    state = ViewState.closePalette(state)
    expect(state.palette.open).toBe(false)
    expect(state.palette_open).toBe(false)
  })
})

describe("ViewState pickers", () => {
  test("file picker: acceptSelected inserts @<path>", () => {
    let state = ViewState.openFilePicker(base(), ["a.ts", "b.ts"])
    expect(state.filepicker.kind).toBe("file")
    state = ViewState.acceptSelected(state)
    expect(state.input.text).toBe("@a.ts ")
    expect(state.filepicker.open).toBe(false)
  })

  test("thread picker: openThreadPicker filters by label and acceptSelected inserts @<thread_id>", () => {
    let state = ViewState.openThreadPicker(base(), [
      { label: "thread_abc: hello", insert: "thread_abc" },
      { label: "thread_def: world", insert: "thread_def" },
    ])
    expect(state.filepicker.kind).toBe("thread")
    expect(ViewState.filteredFiles(state)).toEqual(["thread_abc: hello", "thread_def: world"])
    state = ViewState.filePickerInsert(state, "world")
    expect(ViewState.filteredFiles(state)).toEqual(["thread_def: world"])
    state = ViewState.acceptSelected(state)
    expect(state.input.text).toBe("@thread_def ")
    expect(state.filepicker.open).toBe(false)
  })
})

const withCards = (): ViewState.ViewState =>
  ViewState.initial({
    thread_id: threadId,
    workspace_path: "/workspace/rika",
    mode: "smart",
    events: [toolRequested(1, "tool_a"), toolCompleted(2, "tool_a"), toolRequested(3, "tool_b"), toolCompleted(4, "tool_b")],
  })

const eventBase = (sequence: number): Omit<Event.Event, "type" | "data"> => ({
  id: Ids.EventId.make(`event_view_state_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: Common.TimestampMillis.make(sequence),
})

const toolRequested = (sequence: number, id: string): Event.ToolCallRequested => ({
  ...eventBase(sequence),
  type: "tool.call.requested",
  data: { call: { id: Ids.ToolCallId.make(id), name: "write", input: { path: "a.ts" } } },
})

const toolCompleted = (sequence: number, id: string): Event.ToolCallCompleted => ({
  ...eventBase(sequence),
  type: "tool.call.completed",
  data: {
    result: { id: Ids.ToolCallId.make(id), name: "write", status: "success", output: { ok: true } },
  },
})

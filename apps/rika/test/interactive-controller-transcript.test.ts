import * as InteractiveController from "../src/interactive-controller"
import * as Thread from "@rika/persistence/thread"
import * as Turn from "@rika/persistence/turn"
import * as Transcript from "@rika/transcript"
import { Keys, Palette, ViewState } from "@rika/tui"
import { expect, it } from "vitest"

const thread: Thread.Thread = {
  id: Thread.ThreadId.make("thread-a"),
  workspace: "/work",
  title: "Thread A",
  labels: [],
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
}

const entries = (
  id: string,
  createdAt: number,
  events: ReadonlyArray<{
    readonly cursor: string
    readonly sequence: number
    readonly type: string
    readonly createdAt: number
    readonly text?: string
    readonly data?: Readonly<Record<string, unknown>>
  }> = [],
) => {
  const turn = {
    id: Turn.TurnId.make(id),
    threadId: thread.id,
    prompt: id,
    executionRoute: Turn.testExecutionRoute(),
    status: "completed" as const,
    createdAt,
    updatedAt: createdAt,
  }
  const projection = Transcript.project(id, id, events)
  return projection.units.map((unit) =>
    Object.assign(
      {
        turn,
        unit,
        projectionRevision: projection.revision,
        projectionModelPhase: projection.modelPhase,
      },
      projection.costUsd === undefined ? {} : { projectionCostUsd: projection.costUsd },
    ),
  )
}

const initialState = (): InteractiveController.State => ({
  model: ViewState.initial("/work", "medium"),
  replayTurns: new Map(),
  entries: [],
  revisions: new Map(),
  projections: new Map(),
  threadCostUsd: 0,
  selectionEpoch: 0,
})

const key = (input: Partial<Keys.Key> & Pick<Keys.Key, "name">): Keys.Key => ({
  name: input.name,
  ctrl: input.ctrl ?? false,
  alt: input.alt ?? false,
  meta: input.meta ?? false,
  shift: input.shift ?? false,
  sequence: input.sequence ?? "",
  eventType: input.eventType ?? "press",
})

it("projects prepended pages without rebuilding the loaded transcript", () => {
  const initial = initialState()
  const page = InteractiveController.update(initial, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: [
      ...entries("new", 2, [
        {
          cursor: "new-answer",
          sequence: 1,
          type: "model.output.completed",
          createdAt: 2,
          text: "new answer",
        },
      ]),
    ],
    hasOlder: true,
    threadCostUsd: 0,
  })
  const loadedAnswer = page.state.model.entries.at(-1)
  const prepended = InteractiveController.update(page.state, {
    _tag: "TranscriptPagePrepended",
    selectionEpoch: 1,
    threadId: thread.id,
    entries: [
      ...entries("old", 1, [
        {
          cursor: "old-answer",
          sequence: 1,
          type: "model.output.completed",
          createdAt: 1,
          text: "old answer",
        },
      ]),
    ],
    hasOlder: false,
    threadCostUsd: 0,
  })

  expect(prepended.state.model.entries.map((value) => value.text)).toEqual(["old", "old answer", "new", "new answer"])
  expect(prepended.state.model.entries.some((value) => value === loadedAnswer)).toBe(true)
})

it("clears queue edit mode when a selection loads a thread", () => {
  const initial: InteractiveController.State = {
    ...initialState(),
    model: {
      ...ViewState.initial("/work", "medium"),
      editingTurnId: "old-turn",
      editReturn: { input: "draft", attachments: [] },
      input: "half edited",
      cursor: 11,
    },
  }
  const loaded = InteractiveController.update(initial, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: [],
    hasOlder: false,
    threadCostUsd: 0,
  })
  expect(loaded.state.model.editingTurnId).toBeUndefined()
  expect(loaded.state.model.editReturn).toBeUndefined()
})

it("forgets live child outcomes when SelectionLoaded replaces the transcript", () => {
  const remembered = {
    ...initialState(),
    model: {
      ...ViewState.initial("/work", "medium"),
      childExecutionOutcomes: { "turn:agent": { status: "complete" } },
    },
  }
  const loaded = InteractiveController.update(remembered, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("turn", 1, [
      {
        cursor: "agent",
        sequence: 0,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "work" } },
      },
      { cursor: "failed", sequence: 1, type: "execution.failed", createdAt: 2, text: "replacement failed" },
    ]),
    hasOlder: false,
    threadCostUsd: 0,
  })

  expect(loaded.state.model.childExecutionOutcomes).toEqual({})
  expect(loaded.state.model.blocks).toContainEqual(
    expect.objectContaining({ _tag: "Error", detail: "replacement failed" }),
  )
})

it("maps the new-thread palette action to a command and resets the transcript from the fresh selection", () => {
  const populated = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 1,
    queue: [{ id: Turn.TurnId.make("queued"), prompt: "queued" }],
    thread,
    entries: entries("old", 1, [
      { cursor: "answer", sequence: 1, type: "model.output.completed", createdAt: 1, text: "old answer" },
    ]),
    hasOlder: false,
    threadCostUsd: 1,
  }).state

  expect(InteractiveController.paletteCommand({ _tag: "NewThread" })).toEqual({ _tag: "NewThread" })
  expect(InteractiveController.paletteCommands).toContainEqual({
    id: "new-thread",
    category: "thread",
    label: "New thread",
    action: { _tag: "NewThread" },
  })
  const palette: Array<InteractiveController.PaletteCommand> = []
  InteractiveController.installPaletteCommands(palette)
  InteractiveController.installPaletteCommands(palette)
  expect(palette).toEqual(InteractiveController.paletteCommands)
  InteractiveController.installPaletteCommands(Palette.commands as Array<InteractiveController.PaletteCommand>)
  let paletteModel = ViewState.update(ViewState.initial("/work"), {
    _tag: "KeyPressed",
    key: key({ name: "o", ctrl: true }),
  })
  paletteModel = ViewState.update(paletteModel, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(paletteModel.pendingAction).toEqual({ _tag: "NewThread" })
  const freshThread = { ...thread, id: Thread.ThreadId.make("fresh"), title: "New thread" }
  const reset = InteractiveController.update(populated, {
    _tag: "SelectionLoaded",
    selectionEpoch: 2,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread: freshThread,
    entries: [],
    hasOlder: false,
    threadCostUsd: 0,
  }).state

  expect(reset.model).toMatchObject({
    currentThreadId: "fresh",
    currentThreadTitle: "New thread",
    entries: [],
    blocks: [],
    items: [],
    queue: [],
    queueRevision: 0,
    costUsd: 0,
  })
  expect(reset.replayTurns.size).toBe(0)
  expect(reset.projections.size).toBe(0)
  expect(reset.revisions.size).toBe(0)
})

it("defaults the queue selection to the newest item when the prior selection is gone", () => {
  const initial: InteractiveController.State = {
    ...initialState(),
    model: { ...ViewState.initial("/work", "medium"), queueSelection: "vanished" },
  }
  const loaded = InteractiveController.update(initial, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [
      { id: Turn.TurnId.make("q1"), prompt: "one" },
      { id: Turn.TurnId.make("q2"), prompt: "two" },
    ],
    thread,
    entries: [],
    hasOlder: false,
    threadCostUsd: 0,
  })
  expect(loaded.state.model.queueSelection).toBe("q2")
})

it("preserves repository order across Turns with overlapping event sequences", () => {
  const initial = initialState()
  const page = InteractiveController.update(initial, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: [
      ...entries("old", 1, [
        { cursor: "old-1", sequence: 1, type: "model.output.completed", createdAt: 1, text: "old answer" },
      ]),
      ...entries("new", 2, [
        { cursor: "new-1", sequence: 1, type: "model.output.completed", createdAt: 2, text: "new answer" },
      ]),
    ],
    hasOlder: false,
    threadCostUsd: 0,
  })

  expect(page.state.model.entries.map((entry) => entry.text)).toEqual(["old", "old answer", "new", "new answer"])
})

it("rejects duplicate patches and stale units with the same semantic identity", () => {
  const initial = initialState()
  const page = InteractiveController.update(initial, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("new", 2, [
      { cursor: "page-1", sequence: 1, type: "model.output.completed", createdAt: 1, text: "page answer" },
    ]),
    hasOlder: false,
    threadCostUsd: 0,
  })
  const liveEvent = {
    cursor: "live-2",
    sequence: 2,
    type: "model.output.completed",
    createdAt: 2,
    text: "live answer",
  }
  const patched = InteractiveController.update(page.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("new"),
    event: liveEvent,
    revision: 2,
  })
  const duplicate = InteractiveController.update(patched.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("new"),
    event: liveEvent,
    revision: 2,
  })
  const stale = InteractiveController.update(duplicate.state, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("new", 2, [
      { cursor: "page-1", sequence: 1, type: "model.output.completed", createdAt: 1, text: "page answer" },
    ]),
    hasOlder: false,
    threadCostUsd: 0,
  })
  const staleOlderEntry = entries("new", 2, [
    { cursor: "older-0", sequence: 0, type: "model.output.completed", createdAt: 0, text: "older answer" },
  ]).find((entry) => entry.unit.content._tag === "Entry" && entry.unit.content.role === "assistant")
  expect(staleOlderEntry).toBeDefined()
  if (staleOlderEntry === undefined) return
  const prepended = InteractiveController.update(duplicate.state, {
    _tag: "TranscriptPagePrepended",
    selectionEpoch: 1,
    threadId: thread.id,
    entries: [staleOlderEntry],
    hasOlder: false,
    threadCostUsd: 0,
  })

  expect(patched.state.model.entries.at(-1)?.text).toBe("live answer")
  expect(duplicate.state).toBe(patched.state)
  expect(stale.state).toBe(patched.state)
  expect(prepended.state.model.entries.map((entry) => entry.text)).not.toContain("older answer")
  expect(prepended.state.revisions.get("new")).toBe(2)
})

it("reconciles a stale prepended tool call with its newer retained result", () => {
  const initial = initialState()
  const resultPage = entries("new", 2, [
    {
      cursor: "result-2",
      sequence: 2,
      type: "tool.result.received",
      createdAt: 2,
      data: { tool_call_id: "call-1", output: "ok" },
    },
  ])
  const staleCall = entries("new", 2, [
    {
      cursor: "call-1",
      sequence: 1,
      type: "tool.call.requested",
      createdAt: 1,
      data: { tool_call_id: "call-1", tool_name: "read", input: "a.ts" },
    },
  ]).find((entry) => entry.unit.content._tag === "Block")
  expect(staleCall).toBeDefined()
  if (staleCall === undefined) return
  const page = InteractiveController.update(initial, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: resultPage,
    hasOlder: true,
    threadCostUsd: 0,
  })
  const prepended = InteractiveController.update(page.state, {
    _tag: "TranscriptPagePrepended",
    selectionEpoch: 1,
    threadId: thread.id,
    entries: [staleCall],
    hasOlder: false,
    threadCostUsd: 0,
  })

  expect(prepended.state.model.blocks).toEqual([
    expect.objectContaining({ _tag: "ToolCall", id: "new:call-1", status: "complete", output: "ok" }),
  ])
  expect(prepended.state.revisions.get("new")).toBe(2)
})

it("owns transcript page, prepend, and patch reduction", () => {
  const initial = initialState()
  const page = InteractiveController.update(initial, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("new", 2),
    hasOlder: true,
    threadCostUsd: 0,
  })
  const prepended = InteractiveController.update(page.state, {
    _tag: "TranscriptPagePrepended",
    selectionEpoch: 1,
    threadId: thread.id,
    entries: entries("old", 1),
    hasOlder: false,
    threadCostUsd: 0,
  })
  const patched = InteractiveController.update(prepended.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("new"),
    event: {
      cursor: "cursor-1",
      sequence: 1,
      type: "model.output.completed",
      createdAt: 3,
      text: "answer",
    },
    revision: 2,
  })
  expect(page.state.entries.map((value) => value.turn.id)).toEqual([Turn.TurnId.make("new")])
  expect(prepended.state.entries.map((value) => value.turn.id)).toEqual([
    Turn.TurnId.make("old"),
    Turn.TurnId.make("new"),
  ])
  expect(prepended.preserveAnchor).toBe(true)
  expect(patched.state.model.entries.at(-1)).toMatchObject({ role: "assistant", text: "answer" })
})

it("normalizes malformed page order and duplicate units across selection and prepend", () => {
  const oldEntries = entries("old", 1, [
    { cursor: "old-answer", sequence: 1, type: "model.output.completed", createdAt: 1, text: "old answer" },
  ])
  const newEntries = entries("new", 2, [
    { cursor: "new-answer", sequence: 1, type: "model.output.completed", createdAt: 2, text: "new answer" },
  ])
  const selected = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: [...newEntries.toReversed(), ...oldEntries.toReversed(), ...newEntries],
    hasOlder: true,
    threadCostUsd: 0,
  })
  const prepended = InteractiveController.update(selected.state, {
    _tag: "TranscriptPagePrepended",
    selectionEpoch: 1,
    threadId: thread.id,
    entries: [...oldEntries, ...oldEntries],
    hasOlder: false,
    threadCostUsd: 0,
  })

  expect(selected.state.entries.map((entry) => entry.unit.key)).toEqual([
    "turn:old:user",
    "assistant:old:0",
    "turn:new:user",
    "assistant:new:0",
  ])
  expect(prepended.state.entries).toEqual(selected.state.entries)
  expect(prepended.state.model.entries.map((entry) => entry.text)).toEqual(["old", "old answer", "new", "new answer"])
})

it("projects replayed child execution tools beneath the matching subagent", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("parent", 2),
    hasOlder: false,
    threadCostUsd: 0,
  })
  const requested = InteractiveController.update(page.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("parent"),
    event: {
      cursor: "agent",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 3,
      data: { tool_call_id: "agent", tool_name: "oracle", input: { prompt: "Review the code" } },
    },
    revision: 0,
  })
  const spawned = InteractiveController.update(requested.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("parent"),
    event: {
      cursor: "spawned",
      sequence: 1,
      type: "child_run.spawned",
      createdAt: 4,
      data: {
        tool_call_id: "agent",
        child_execution_id: "execution:parent:child:agent",
      },
    },
    revision: 1,
  })
  const child = InteractiveController.update(spawned.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("parent:child:agent"),
    event: {
      cursor: "child-read",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 5,
      data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts" } },
    },
    revision: 0,
  })
  const response = InteractiveController.update(child.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("parent:child:agent"),
    event: {
      cursor: "child-response",
      sequence: 1,
      type: "model.output.completed",
      createdAt: 6,
      text: "## Review complete\n\n**No defects found.**",
    },
    revision: 1,
  })

  expect(child.state.model.blocks).toEqual([
    expect.objectContaining({ _tag: "ToolCall", id: "parent:agent", childId: "execution:parent:child:agent" }),
    expect.objectContaining({ _tag: "ToolCall", id: "parent:child:agent:read" }),
  ])
  expect(child.state.model.items[2]).toMatchObject({
    id: "tool:parent:child:agent:read",
    parentId: "parent:agent",
  })
  expect(child.state.revisions.get("parent:child:agent")).toBe(0)
  expect(response.state.model.entries).toContainEqual(
    expect.objectContaining({ role: "assistant", text: "## Review complete\n\n**No defects found.**" }),
  )
  expect(response.state.model.items).toContainEqual(
    expect.objectContaining({
      _tag: "Entry",
      id: "assistant:parent:child:agent:0",
      parentId: "parent:agent",
    }),
  )
  expect(response.state.revisions.get("parent:child:agent")).toBe(1)
})

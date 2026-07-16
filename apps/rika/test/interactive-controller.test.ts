import * as InteractiveController from "../src/interactive-controller"
import * as Thread from "@rika/persistence/thread"
import * as Turn from "@rika/persistence/turn"
import * as Transcript from "@rika/transcript"
import { ViewState } from "@rika/tui"
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
})

it("projects prepended pages without rebuilding the loaded transcript", () => {
  const initial = initialState()
  const page = InteractiveController.update(initial, {
    _tag: "TranscriptPageReceived",
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

it("preserves repository order across Turns with overlapping event sequences", () => {
  const initial = initialState()
  const page = InteractiveController.update(initial, {
    _tag: "TranscriptPageReceived",
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
    _tag: "TranscriptPageReceived",
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
    threadId: thread.id,
    turnId: Turn.TurnId.make("new"),
    event: liveEvent,
    revision: 2,
  })
  const duplicate = InteractiveController.update(patched.state, {
    _tag: "TranscriptPatched",
    threadId: thread.id,
    turnId: Turn.TurnId.make("new"),
    event: liveEvent,
    revision: 2,
  })
  const stale = InteractiveController.update(duplicate.state, {
    _tag: "TranscriptPageReceived",
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
    _tag: "TranscriptPageReceived",
    thread,
    entries: resultPage,
    hasOlder: true,
    threadCostUsd: 0,
  })
  const prepended = InteractiveController.update(page.state, {
    _tag: "TranscriptPagePrepended",
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
    _tag: "TranscriptPageReceived",
    thread,
    entries: entries("new", 2),
    hasOlder: true,
    threadCostUsd: 0,
  })
  const prepended = InteractiveController.update(page.state, {
    _tag: "TranscriptPagePrepended",
    threadId: thread.id,
    entries: entries("old", 1),
    hasOlder: false,
    threadCostUsd: 0,
  })
  const patched = InteractiveController.update(prepended.state, {
    _tag: "TranscriptPatched",
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

it("updates one typed apply-patch row while its diff is streaming", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "TranscriptPageReceived",
    thread,
    entries: entries("new", 2),
    hasOlder: false,
    threadCostUsd: 0,
  })
  const first = InteractiveController.update(page.state, {
    _tag: "TranscriptPatched",
    threadId: thread.id,
    turnId: Turn.TurnId.make("new"),
    event: {
      cursor: "patch-0",
      sequence: 0,
      type: "model.toolcall.delta",
      createdAt: 3,
      data: {
        tool_call_id: "call-1",
        tool_name: "apply_patch",
        delta: '{"patchText":"*** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-old\\n+new',
      },
    },
    revision: 0,
  })
  const second = InteractiveController.update(first.state, {
    _tag: "TranscriptPatched",
    threadId: thread.id,
    turnId: Turn.TurnId.make("new"),
    event: {
      cursor: "patch-1",
      sequence: 1,
      type: "model.toolcall.delta",
      createdAt: 4,
      data: { tool_call_id: "call-1", tool_name: "apply_patch", delta: '\\n*** End Patch"}' },
    },
    revision: 1,
  })

  expect(first.state.model.blocks).toEqual([
    expect.objectContaining({
      _tag: "ToolCall",
      id: "new:call-1",
      files: [expect.objectContaining({ path: "src/a.ts", preview: true, additions: 1, deletions: 1 })],
    }),
  ])
  expect(second.state.model.blocks).toHaveLength(1)
  expect(second.state.model.items).toHaveLength(2)
})

it("keeps the authoritative thread cost stable while older pages are prepended", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "TranscriptPageReceived",
    thread,
    entries: entries("new", 2),
    hasOlder: true,
    threadCostUsd: 3.75,
  })
  const prepended = InteractiveController.update(page.state, {
    _tag: "TranscriptPagePrepended",
    threadId: thread.id,
    entries: entries("old", 1),
    hasOlder: false,
    threadCostUsd: 3.75,
  })

  expect(page.state.model.costUsd).toBe(3.75)
  expect(prepended.state.model.costUsd).toBe(3.75)
})

it("clears working state when the semantic event stream reaches a terminal event", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "TranscriptPageReceived",
    thread,
    entries: entries("new", 2),
    hasOlder: false,
    threadCostUsd: 0,
  })
  const completed = InteractiveController.update(
    {
      ...page.state,
      model: { ...page.state.model, activeTurnId: "new", busy: true, busyStatus: "Waiting" },
    },
    {
      _tag: "TranscriptPatched",
      threadId: thread.id,
      turnId: Turn.TurnId.make("new"),
      event: { cursor: "terminal", sequence: 0, type: "execution.completed", createdAt: 3 },
      revision: 0,
    },
  )

  expect(completed.state.model).toMatchObject({ busy: false, busyStatus: undefined, activeTurnId: undefined })
})

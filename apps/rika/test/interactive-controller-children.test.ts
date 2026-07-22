import * as InteractiveController from "../src/interactive-controller"
import type * as Operation from "@rika/app/operation"
import * as Thread from "@rika/persistence/thread"
import * as Turn from "@rika/persistence/turn"
import * as Transcript from "@rika/transcript"
import { ExecutionEvents, ViewState } from "@rika/tui"
import { renderTranscriptStyled } from "@rika/tui/adapter"
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

it("attaches parallel child streams when task rows lack explicit spawn links", () => {
  const turnId = "parallel"
  const childIds = ["one", "two", "three", "four"].map(
    (callId) => `child:execution%3A${turnId}:rika:execution%3A${turnId}:${callId}`,
  )
  let state = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries(turnId, 2),
    hasOlder: false,
    threadCostUsd: 0,
  }).state

  for (const [sequence, callId] of ["one", "two", "three", "four"].entries())
    state = InteractiveController.update(state, {
      _tag: "TranscriptPatched",
      selectionEpoch: 1,
      threadId: thread.id,
      turnId: Turn.TurnId.make(turnId),
      event: {
        cursor: `task-${callId}`,
        sequence,
        type: "tool.call.requested",
        createdAt: 3,
        data: { tool_call_id: callId, tool_name: "task", input: { prompt: `Explore ${callId}` } },
      },
      revision: sequence,
    }).state

  for (const [index, childId] of childIds.entries()) {
    state = InteractiveController.update(state, {
      _tag: "TranscriptPatched",
      selectionEpoch: 1,
      threadId: thread.id,
      turnId: Turn.TurnId.make(childId),
      event: {
        cursor: `child-tool-${index}`,
        sequence: 0,
        type: "tool.call.requested",
        createdAt: 4,
        data: { tool_call_id: "read", tool_name: "read", input: { path: `src/${index}.ts` } },
      },
      revision: 0,
    }).state
    state = InteractiveController.update(state, {
      _tag: "TranscriptPatched",
      selectionEpoch: 1,
      threadId: thread.id,
      turnId: Turn.TurnId.make(childId),
      event: {
        cursor: `child-response-${index}`,
        sequence: 1,
        type: "model.output.completed",
        createdAt: 5,
        text: `## Agent ${index + 1}\n\n**Complete.**`,
      },
      revision: 1,
    }).state
  }

  const toolRows = (state.model.items as ReadonlyArray<ViewState.TranscriptItem>).filter(
    (item) => item._tag === "Block" && item.id?.startsWith("tool:"),
  )
  expect(toolRows).toHaveLength(8)
  expect(toolRows.filter((item) => item.parentId !== undefined)).toHaveLength(4)
  expect(state.model.entries.filter((entry) => entry.text.startsWith("## Agent"))).toHaveLength(4)
})

it("reloads one completed subagent tree with rendered markdown and no serialized result", () => {
  const target = entries("durable-parent", 2)[0]!.turn
  const childId = "durable-parent:child:agent"
  const serialized =
    '{"status":"completed","output":[{"type":"text","text":"## Review complete\\n\\n**No defects found.**"}]}'
  const parent = Transcript.project(target.id, target.prompt, [
    {
      cursor: "agent",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 2,
      data: {
        tool_call_id: "agent",
        tool_name: "transfer_to_oracle",
        input: { input: [{ type: "text", text: "Review the projection" }] },
      },
    },
    {
      cursor: "spawned",
      sequence: 1,
      type: "child_run.spawned",
      createdAt: 3,
      data: { tool_call_id: "agent", child_execution_id: `execution:${childId}` },
    },
    {
      cursor: "result",
      sequence: 2,
      type: "tool.result.received",
      createdAt: 4,
      data: { tool_call_id: "agent", output: serialized },
    },
    { cursor: "done", sequence: 3, type: "execution.completed", createdAt: 5 },
  ])
  const child = Transcript.project(childId, "", [
    {
      cursor: "read",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 3,
      data: { tool_call_id: "read", tool_name: "read", input: { path: "src/projection.ts" } },
    },
    {
      cursor: "answer",
      sequence: 1,
      type: "model.output.completed",
      createdAt: 4,
      text: "## Review complete\n\n**No defects found.**",
    },
    { cursor: "child-done", sequence: 2, type: "execution.completed", createdAt: 5 },
  ])
  const durable = Transcript.withNestedProjections(parent, [{ parentId: `${target.id}:agent`, projection: child }])
  const persistedEntries = durable.units.map((unit) => ({
    turn: target,
    unit,
    projectionRevision: durable.revision,
    projectionModelPhase: durable.modelPhase,
  }))
  const base = initialState()
  const initial = { ...base, model: { ...base.model, expandedRowKeys: [`tool:${target.id}:agent`] } }

  const loaded = InteractiveController.update(initial, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: persistedEntries,
    hasOlder: false,
    threadCostUsd: 0,
  })
  let liveModel = ExecutionEvents.projectUnits(ViewState.initial("/work", "medium"), parent.units)
  liveModel = ExecutionEvents.projectChildUnits(liveModel, `${target.id}:agent`, child.units)
  liveModel = { ...liveModel, expandedRowKeys: [`tool:${target.id}:agent`] }
  const rendered = renderTranscriptStyled(loaded.state.model)
  const text = rendered.chunks.map((chunk) => chunk.text).join("")
  const liveText = renderTranscriptStyled(liveModel)
    .chunks.map((chunk) => chunk.text)
    .join("")
  const blocks = loaded.state.model.blocks as ReadonlyArray<ViewState.TranscriptBlock>
  const agents = blocks.filter((block) => block._tag === "ToolCall" && block.presentation.family === "agent")

  expect(agents).toHaveLength(1)
  expect(blocks.filter((block) => block._tag === "ChildAgent")).toHaveLength(0)
  expect(loaded.state.model.items).toContainEqual(
    expect.objectContaining({
      _tag: "Entry",
      id: `assistant:${childId}:0`,
      parentId: `${target.id}:agent`,
    }),
  )
  expect(text).toBe(liveText)
  expect(text).toContain("Review the projection")
  expect(text).toContain("Review complete")
  expect(text).toContain("No defects found.")
  expect(text).not.toContain("##")
  expect(text).not.toContain("**")
  expect(text).not.toContain("\\n")
  expect(text).not.toContain('"}]}')
  expect(text).not.toContain(serialized)
})

it("keeps cancelled child tools terminal in live and reloaded projections", () => {
  const target = { ...entries("cancel-parent", 2)[0]!.turn, status: "running" as const }
  const childId = "child:execution%3Acancel-parent:agent"
  const parent = Transcript.project(target.id, target.prompt, [
    {
      cursor: "agent",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 2,
      data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Run the checks" } },
    },
    {
      cursor: "spawned",
      sequence: 1,
      type: "child_run.spawned",
      createdAt: 3,
      data: { child_execution_id: childId },
    },
    { cursor: "root-cancelled", sequence: 2, type: "execution.cancelled", createdAt: 6 },
  ])
  const child = Transcript.project(childId, "", [
    {
      cursor: "bash",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 4,
      data: { tool_call_id: "bash", tool_name: "bash", input: { command: "sleep 60" } },
    },
  ])
  const durable = Transcript.withNestedProjections(parent, [{ parentId: `${target.id}:agent`, projection: child }])
  const persistedEntries = durable.units.map((unit) => ({
    turn: { ...target, status: "cancelled" as const },
    unit,
    projectionRevision: durable.revision,
    projectionModelPhase: durable.modelPhase,
  }))
  const base = initialState()
  const loaded = InteractiveController.update(base, {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: persistedEntries,
    hasOlder: false,
    threadCostUsd: 0,
  }).state.model
  let live = ExecutionEvents.projectUnits(ViewState.initial("/work", "medium"), parent.units)
  live = ExecutionEvents.projectChildUnits(live, `${target.id}:agent`, child.units)

  for (const model of [live, loaded]) {
    expect(model.blocks).toEqual([
      expect.objectContaining({ id: `${target.id}:agent`, status: "cancelled" }),
      expect.objectContaining({ id: `${childId}:bash`, status: "cancelled" }),
    ])
    expect(model.entries.filter((entry) => entry.role === "notice")).toEqual([])
    expect(
      renderTranscriptStyled(model)
        .chunks.map((chunk) => chunk.text)
        .join(""),
    ).toContain("⊘ Subagent cancelled")
  }
})

it("buffers live child patches until the parent subagent link arrives", () => {
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
  const child = InteractiveController.update(page.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("parent:child:agent"),
    event: {
      cursor: "child-read",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 3,
      data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts" } },
    },
    revision: 0,
  })
  const requested = InteractiveController.update(child.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("parent"),
    event: {
      cursor: "agent",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 4,
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
      createdAt: 5,
      data: { tool_call_id: "agent", child_execution_id: "execution:parent:child:agent" },
    },
    revision: 1,
  })

  expect(child.state.projections.get("parent:child:agent")?.units).toHaveLength(2)
  expect(child.state.model.blocks).not.toContainEqual(expect.objectContaining({ id: "parent:child:agent:read" }))
  expect(spawned.state.model.blocks).toEqual([
    expect.objectContaining({ _tag: "ToolCall", id: "parent:agent" }),
    expect.objectContaining({ _tag: "ToolCall", id: "parent:child:agent:read" }),
  ])
  expect(spawned.state.model.items[2]).toMatchObject({
    id: "tool:parent:child:agent:read",
    parentId: "parent:agent",
  })
})

it("surfaces a child projection whose parent tool has not arrived instead of dropping it", () => {
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
  const child = InteractiveController.update(page.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("parent:child:agent"),
    event: {
      cursor: "child-read",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 3,
      data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts" } },
    },
    revision: 0,
  })
  const requested = InteractiveController.update(child.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("parent"),
    event: {
      cursor: "agent",
      sequence: 0,
      type: "tool.call.requested",
      createdAt: 4,
      data: { tool_call_id: "agent", tool_name: "oracle", input: { prompt: "Review" } },
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
      createdAt: 5,
      data: { tool_call_id: "agent", child_execution_id: "execution:parent:child:agent" },
    },
    revision: 1,
  })

  expect(child.unattached).toContain("parent:child:agent")
  expect(child.state.model.blocks).not.toContainEqual(expect.objectContaining({ id: "parent:child:agent:read" }))
  expect(spawned.unattached ?? []).not.toContain("parent:child:agent")
  expect(spawned.state.model.blocks).toContainEqual(expect.objectContaining({ id: "parent:child:agent:read" }))
})

it("keeps one of five status labels from submit until the turn completes", () => {
  const turn = { ...entries("active", 2)[0]!.turn, status: "running" as const }
  const submitted = ViewState.update(
    { ...ViewState.initial("/work", "medium"), input: "run it", cursor: 6 },
    { _tag: "Submitted" },
  )
  let state: InteractiveController.State = {
    ...initialState(),
    selectionEpoch: 1,
    model: { ...submitted, currentThreadId: thread.id, activeTurnId: turn.id },
    replayTurns: new Map([[turn.id, turn]]),
    projections: new Map([[turn.id, Transcript.empty(turn.id, turn.prompt)]]),
  }
  const labels = ["Sending", "Waiting", "Thinking 2 tok", "Streaming 2 tok", "Running tools"]
  const expectStatus = (expected: string) => {
    const label = ViewState.formatActivity(state.model.activity)
    expect(label).toBe(expected)
    expect(labels).toContain(label)
  }
  const patch = (sequence: number, type: string, text?: string, data?: Readonly<Record<string, unknown>>) => {
    state = InteractiveController.update(state, {
      _tag: "TranscriptPatched",
      selectionEpoch: 1,
      threadId: thread.id,
      turnId: Turn.TurnId.make("active"),
      event: {
        cursor: `event-${sequence}`,
        sequence,
        type,
        createdAt: sequence,
        ...(text === undefined ? {} : { text }),
        ...(data === undefined ? {} : { data }),
      },
      revision: sequence,
    }).state
  }

  expectStatus("Sending")
  patch(0, "execution.accepted")
  expectStatus("Waiting")
  patch(1, "execution.started")
  expectStatus("Waiting")
  patch(2, "model.input.prepared")
  expectStatus("Waiting")
  patch(3, "model.reasoning.delta", "12345678")
  expectStatus("Thinking 2 tok")
  patch(4, "tool.call.requested", undefined, {
    tool_call_id: "read",
    tool_name: "read",
    input: { path: "src/a.ts" },
  })
  expectStatus("Running tools")
  patch(5, "tool.call.requested", undefined, {
    tool_call_id: "status",
    tool_name: "bash",
    input: { command: "git --no-optional-locks status --short --branch" },
  })
  expectStatus("Running tools")
  patch(6, "tool.result.received", undefined, { tool_call_id: "read", output: "contents" })
  expectStatus("Running tools")
  patch(7, "tool.result.received", undefined, { tool_call_id: "status", output: "clean" })
  expectStatus("Waiting")
  patch(8, "model.output.delta", "abcdefgh")
  expectStatus("Streaming 2 tok")
  patch(9, "model.output.completed", "abcdefgh")
  expectStatus("Waiting")
  patch(10, "execution.completed")
  expect(ViewState.formatActivity(state.model.activity)).toBeUndefined()
  expect(state.model.busy).toBe(false)
})

it("keeps 200ms tool lifecycle events in distinct TUI frames", () => {
  type TranscriptPatched = Extract<Operation.InteractiveEvent, { readonly _tag: "TranscriptPatched" }>
  const turn = { ...entries("timed", 2)[0]!.turn, status: "running" as const }
  let state: InteractiveController.State = {
    ...initialState(),
    selectionEpoch: 1,
    model: {
      ...initialState().model,
      currentThreadId: thread.id,
      activeTurnId: turn.id,
      busy: true,
      activity: { _tag: "Waiting" },
    },
    replayTurns: new Map([[turn.id, turn]]),
    projections: new Map([[turn.id, Transcript.empty(turn.id, turn.prompt)]]),
  }
  let now = 0
  const scheduled: Array<{ readonly at: number; readonly flush: () => void }> = []
  const applied: Array<{ readonly at: number; readonly type: string; readonly activity: string | undefined }> = []
  const batcher = InteractiveController.makeFeedFrameBatcher<TranscriptPatched>({
    schedule: (flush) => scheduled.push({ at: now + 16, flush }),
    apply: (events) => {
      for (const event of events) {
        state = InteractiveController.update(state, event).state
        applied.push({ at: now, type: event.event.type, activity: ViewState.formatActivity(state.model.activity) })
      }
    },
    render: () => {},
  })
  const advance = (target: number) => {
    while (scheduled[0] !== undefined && scheduled[0].at <= target) {
      const next = scheduled.shift()!
      now = next.at
      next.flush()
    }
    now = target
  }
  const event = (
    sequence: number,
    type: "tool.call.requested" | "tool.result.received",
    callId: string,
  ): TranscriptPatched => ({
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: turn.id,
    event: {
      cursor: `timed-${sequence}`,
      sequence,
      type,
      createdAt: now,
      data:
        type === "tool.call.requested"
          ? { tool_call_id: callId, tool_name: "read", input: { path: `${callId}.ts` } }
          : { tool_call_id: callId, output: callId },
    },
    revision: sequence,
  })

  batcher.offer(event(0, "tool.call.requested", "first"))
  batcher.offer(event(1, "tool.call.requested", "second"))
  advance(200)
  batcher.offer(event(2, "tool.result.received", "first"))
  advance(400)
  batcher.offer(event(3, "tool.result.received", "second"))
  advance(500)

  expect(applied.map(({ at }) => at)).toEqual([16, 16, 216, 416])
  expect(applied.map(({ activity }) => activity)).toEqual([
    "Running tools",
    "Running tools",
    "Running tools",
    "Waiting",
  ])
})

import * as InteractiveController from "../src/interactive-controller"
import type * as Operation from "@rika/app/operation"
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

it("keeps the authoritative thread cost stable while older pages are prepended", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("new", 2),
    hasOlder: true,
    threadCostUsd: 3.75,
  })
  const prepended = InteractiveController.update(page.state, {
    _tag: "TranscriptPagePrepended",
    selectionEpoch: 1,
    threadId: thread.id,
    entries: entries("old", 1),
    hasOlder: false,
    threadCostUsd: 3.75,
  })

  expect(page.state.model.costUsd).toBe(3.75)
  expect(prepended.state.model.costUsd).toBe(3.75)
})

it("shows the session total and updates it when child usage arrives", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("parent", 2, [
      {
        cursor: "parent-usage",
        sequence: 0,
        type: "model.usage.reported",
        createdAt: 2,
        data: { cost_usd: 0.5 },
      },
    ]),
    hasOlder: false,
    threadCostUsd: 0.5,
    globalCostUsd: 10,
  })
  const child = InteractiveController.update(page.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("parent:child:worker"),
    rootTurnId: Turn.TurnId.make("parent"),
    rootTurnCostUsd: 0.75,
    threadCostUsd: 0.75,
    globalCostUsd: 10.25,
    event: {
      cursor: "child-usage",
      sequence: 0,
      type: "model.usage.reported",
      createdAt: 3,
      data: { cost_usd: 0.25 },
    },
    revision: 0,
  })

  expect(page.state.model.costUsd).toBe(0.5)
  expect(child.state.model.costUsd).toBe(0.75)
  expect(child.state.threadCostUsd).toBe(0.75)
  expect(child.state.projections.get("parent")?.costUsd).toBe(0.75)
})

it("clears working state when the semantic event stream reaches a terminal event", () => {
  const page = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("new", 2),
    hasOlder: false,
    threadCostUsd: 0,
  })
  const completed = InteractiveController.update(
    {
      ...page.state,
      model: { ...page.state.model, activeTurnId: "new", busy: true, activity: { _tag: "Sending" } },
    },
    {
      _tag: "TranscriptPatched",
      selectionEpoch: 1,
      threadId: thread.id,
      turnId: Turn.TurnId.make("new"),
      event: { cursor: "terminal", sequence: 0, type: "execution.completed", createdAt: 3 },
      revision: 0,
    },
  )

  expect(completed.state.model).toMatchObject({ busy: false, activity: undefined, activeTurnId: undefined })
})

it("keeps the newest logical selection when delayed A to B to A work arrives", () => {
  const threadB = { ...thread, id: Thread.ThreadId.make("thread-b"), title: "Thread B" }
  const load = (
    state: InteractiveController.State,
    selected: Thread.Thread,
    selectionEpoch: number,
    values: ReturnType<typeof entries>,
  ) =>
    InteractiveController.update(state, {
      _tag: "SelectionLoaded",
      selectionEpoch,
      activitySequence: selectionEpoch,
      thread: selected,
      entries: values,
      hasOlder: false,
      threadCostUsd: 0,
      queueRevision: selectionEpoch,
      queue: [],
    })
  const a1 = load(initialState(), thread, 1, entries("a-1", 1))
  const b2 = load(a1.state, threadB, 2, [])
  const a3 = load(b2.state, thread, 3, entries("a-3", 3))
  const delayedA1 = load(a3.state, thread, 1, entries("stale-a", 4))
  const delayedPatch = InteractiveController.update(delayedA1.state, {
    _tag: "TranscriptPatched",
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("a-1"),
    event: { cursor: "stale", sequence: 9, type: "model.output.completed", createdAt: 9, text: "stale" },
    revision: 9,
  })

  expect(delayedA1.state).toBe(a3.state)
  expect(delayedPatch.state).toBe(a3.state)
  expect(delayedPatch.state.selectionEpoch).toBe(3)
  expect(delayedPatch.state.model).toMatchObject({ currentThreadId: "thread-a", currentThreadTitle: "Thread A" })
  expect(delayedPatch.state.model.entries.map((entry) => entry.text)).toEqual(["a-3"])
})

it("requests a queue resync when the durable count disagrees with an otherwise contiguous delta", () => {
  const model = {
    ...initialState().model,
    currentThreadId: "thread-a",
    queueThreadId: "thread-a",
    queueRevision: 1,
  }
  const updated = InteractiveController.updateQueue(model, {
    _tag: "QueueUpdated",
    selectionEpoch: 1,
    threadId: Thread.ThreadId.make("thread-a"),
    revision: 2,
    queuedCount: 2,
    change: { _tag: "Added", item: { id: Turn.TurnId.make("queued"), prompt: "queued" } },
  })

  expect(updated.model.queue).toEqual([{ id: "queued", prompt: "queued" }])
  expect(updated.resync).toBe(true)
})

it("restores the rejected composer and reports the pending count when the queue is full", () => {
  const submitted = ViewState.update(
    ViewState.update(initialState().model, { _tag: "ComposerReplaced", text: "retry this prompt" }),
    { _tag: "Submitted" },
  )
  const updated = InteractiveController.updateQueue(submitted, {
    _tag: "QueueFull",
    selectionEpoch: 0,
    threadId: Thread.ThreadId.make("thread-a"),
    capacity: 2,
    count: 2,
  })

  expect(updated.model.input).toBe("retry this prompt")
  expect(updated.model.blocks.at(-1)).toMatchObject({
    _tag: "Error",
    detail: "Queue full: 2 pending prompts",
  })
})

it("removes a promoted turn and exits queue edit mode synchronously", () => {
  const queued = ViewState.resetQueue(
    {
      ...initialState().model,
      currentThreadId: "thread-a",
      editingTurnId: "promoted",
      editReturn: { input: "keep this draft", attachments: [] },
      input: "edited queued prompt",
      cursor: 20,
    },
    "thread-a",
    4,
    [{ id: "promoted", prompt: "edited queued prompt" }],
  )

  const promoted = InteractiveController.removePromotedTurn(queued, "thread-a", "promoted")

  expect(promoted.queue).toEqual([])
  expect(promoted.queueRevision).toBe(5)
  expect(promoted.editingTurnId).toBeUndefined()
  expect(promoted.input).toBe("keep this draft")
})

it("eagerly consumes more than one frame of events while bounding reducer work per render frame", () => {
  type TranscriptPatched = Extract<Operation.InteractiveEvent, { readonly _tag: "TranscriptPatched" }>
  const scheduled: Array<() => void> = []
  let received = 0
  let applied = 0
  let renders = 0
  let state = InteractiveController.update(initialState(), {
    _tag: "SelectionLoaded",
    selectionEpoch: 1,
    activitySequence: 0,
    queueRevision: 0,
    queue: [],
    thread,
    entries: entries("stream", 2),
    hasOlder: false,
    threadCostUsd: 0,
  }).state
  const events: ReadonlyArray<TranscriptPatched> = Array.from({ length: 257 }, (_, index) => ({
    _tag: "TranscriptPatched" as const,
    selectionEpoch: 1,
    threadId: thread.id,
    turnId: Turn.TurnId.make("stream"),
    event: {
      cursor: `chunk-${index}`,
      sequence: index,
      type: "model.output.delta",
      createdAt: index,
      text: index === 256 ? "FINAL-CHUNK" : "x",
    },
    revision: index,
  }))
  const batcher = InteractiveController.makeFeedFrameBatcher<TranscriptPatched>({
    schedule: (flush) => scheduled.push(flush),
    apply: (batch) => {
      for (const event of batch) {
        state = InteractiveController.update(state, event).state
        applied += 1
      }
    },
    render: () => {
      renders += 1
    },
  })
  const consume = (dispatch: (event: TranscriptPatched) => void) => {
    for (const event of events) {
      received += 1
      dispatch(event)
    }
  }

  consume(batcher.offer)

  expect(received).toBe(257)
  expect(applied).toBe(0)
  expect(scheduled).toHaveLength(1)
  scheduled.shift()?.()
  expect(applied).toBe(256)
  expect(scheduled).toHaveLength(1)
  while (scheduled.length > 0) scheduled.shift()?.()
  expect(applied).toBe(257)
  expect(renders).toBe(2)
  expect(state.model.entries.some((entry) => entry.text.includes("FINAL-CHUNK"))).toBe(true)

  batcher.offer(events[0]!)
  expect(scheduled).toHaveLength(1)
})

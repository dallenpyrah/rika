import * as InteractiveController from "../src/interactive-controller"
import * as Thread from "@rika/persistence/thread"
import * as Turn from "@rika/persistence/turn"
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

const entry = (id: string, createdAt: number) => ({
  turn: {
    id: Turn.TurnId.make(id),
    threadId: thread.id,
    prompt: id,
    status: "completed" as const,
    createdAt,
    updatedAt: createdAt,
  },
  events: [],
  revision: 1,
  projectionVersion: 1 as const,
  oldestCursor: undefined,
  checkpointCursor: undefined,
})

it("owns transcript page, prepend, and patch reduction", () => {
  const initial: InteractiveController.State = {
    model: ViewState.initial("/work", "medium"),
    replayTurns: new Map(),
    entries: [],
  }
  const page = InteractiveController.update(initial, {
    _tag: "TranscriptPageReceived",
    thread,
    entries: [entry("new", 2)],
    hasOlder: true,
    oldestCursor: { createdAt: 2, id: Turn.TurnId.make("new") },
  })
  const prepended = InteractiveController.update(page.state, {
    _tag: "TranscriptPagePrepended",
    threadId: thread.id,
    entries: [entry("old", 1)],
    hasOlder: false,
    oldestCursor: { createdAt: 1, id: Turn.TurnId.make("old") },
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

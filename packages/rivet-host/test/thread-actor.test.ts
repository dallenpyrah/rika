import { describe, expect, test } from "bun:test"
import { Event, Ids, Message } from "@rika/schema"
import { Schema } from "effect"
import { ThreadActor } from "../src/index"

const threadId = Ids.ThreadId.make("thread_state_test")
const turnId = Ids.TurnId.make("turn_state_test")
const workspaceId = Ids.WorkspaceId.make("workspace_state_test")
const userId = Ids.UserId.make("user_state_test")

describe("ThreadActor state projection", () => {
  test("rebuilds hot actor state from persisted thread events", () => {
    const state = ThreadActor.stateFromEvents(threadId, [
      threadCreated(1),
      turnStarted(2),
      messageAdded(3, "hello from the log"),
    ])

    expect(ThreadActor.snapshotFromState(state, threadId)).toMatchObject({
      thread_id: threadId,
      last_sequence: 3,
      message_count: 1,
      active_turn_id: turnId,
      active_turn_status: "active",
      active_user_id: userId,
      latest_message_text: "hello from the log",
    })
  })

  test("clears active user after terminal turn events", () => {
    const state = ThreadActor.stateFromEvents(threadId, [threadCreated(1), turnStarted(2), turnCompleted(3)])

    expect(ThreadActor.snapshotFromState(state, threadId)).toMatchObject({
      active_turn_id: turnId,
      active_turn_status: "completed",
    })
    expect(ThreadActor.snapshotFromState(state, threadId).active_user_id).toBeUndefined()
  })

  test("declares workspace access denial as a typed action error", () => {
    const error = {
      _tag: "WorkspaceAccessDenied",
      message: "denied",
      action: "read",
      workspace_id: workspaceId,
      user_id: userId,
    }

    const decoded = Schema.decodeUnknownSync(ThreadActor.GetSnapshot.errorSchema)(error)

    expect(decoded).toMatchObject({
      _tag: "WorkspaceAccessDenied",
      action: "read",
      workspace_id: workspaceId,
      user_id: userId,
    })
  })

  test("exposes actor-native turn and event actions", () => {
    expect(ThreadActor.ThreadActor.actions.map((action) => action._tag)).toEqual([
      "EnsureThread",
      "StartTurn",
      "GetEvents",
      "AppendMirroredEvents",
      "ReplayThread",
      "GetSnapshot",
      "SetVisibility",
      "PrepareForkThread",
      "ImportForkThread",
      "ArchiveThread",
      "UnarchiveThread",
      "CompactThread",
      "InterruptTurn",
    ])
  })

  test("rebuilds archive and visibility lifecycle state from actor events", () => {
    const state = ThreadActor.stateFromEvents(threadId, [
      threadCreated(1),
      threadVisibilitySet(2, "unlisted"),
      threadArchived(3),
      threadUnarchived(4),
    ])

    expect(ThreadActor.snapshotFromState(state, threadId)).toMatchObject({
      archived: false,
      visibility: "unlisted",
      last_sequence: 4,
    })
  })
})

const threadCreated = (sequence: number): Event.ThreadCreated => ({
  id: Ids.EventId.make(`state_event_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

const turnStarted = (sequence: number): Event.TurnStarted => ({
  id: Ids.EventId.make(`state_event_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "turn.started",
  data: { user_id: userId },
})

const turnCompleted = (sequence: number): Event.TurnCompleted => ({
  id: Ids.EventId.make(`state_event_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "turn.completed",
  data: { provider: "test", model: "test" },
})

const messageAdded = (sequence: number, content: string): Event.MessageAdded => ({
  id: Ids.EventId.make(`state_event_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make("state_message_1"),
      thread_id: threadId,
      turn_id: turnId,
      content,
      created_at: sequence,
    }),
  },
})

const threadArchived = (sequence: number): Event.ThreadArchived => ({
  id: Ids.EventId.make(`state_event_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "thread.archived",
  data: {},
})

const threadUnarchived = (sequence: number): Event.ThreadUnarchived => ({
  id: Ids.EventId.make(`state_event_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "thread.unarchived",
  data: {},
})

const threadVisibilitySet = (sequence: number, visibility: Event.ThreadVisibility): Event.ThreadVisibilitySet => ({
  id: Ids.EventId.make(`state_event_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "thread.visibility.set",
  data: { visibility },
})

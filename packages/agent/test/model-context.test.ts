import { describe, expect, test } from "bun:test"
import { Common, Event, Ids, Message, Tool } from "@rika/schema"
import { ModelContext } from "../src/index"

const threadId = Ids.ThreadId.make("thread_model_context")
const turnId = Ids.TurnId.make("turn_model_context")
const now = Common.TimestampMillis.make(1_970_000_000_001)

describe("ModelContext", () => {
  test("folds the latest compaction into a summary plus tail for both prompt paths", () => {
    const events: ReadonlyArray<Event.Event> = [
      threadCreated(1),
      messageAdded(2, "old user message"),
      toolCompleted(3, Ids.ToolCallId.make("tool_old"), "old_tool", { old: true }),
      compacted(4, "Superseded summary", 5),
      messageAdded(5, "superseded tail"),
      compacted(6, "Goal\n- Keep this summary", 8),
      messageAdded(7, "skip before tail"),
      messageAdded(8, "tail user message"),
      toolRequested(9, Ids.ToolCallId.make("tool_tail"), "read", { path: "README.md" }),
      toolCompleted(10, Ids.ToolCallId.make("tool_tail"), "read", { content: "tail result" }),
    ]

    const messages = ModelContext.messagesFromEvents(events)
    const prompt = ModelContext.promptMessagesFromEvents(events)

    expect(messages.map((message) => message.role)).toEqual(["user", "user", "tool"])
    expect(messages[0]?.content).toBe(
      "[Conversation summary — earlier context was compacted]\nGoal\n- Keep this summary",
    )
    expect(messages[1]?.content).toBe("tail user message")
    expect(messages[2]?.content).toContain("tail result")
    expect(JSON.stringify(messages)).not.toContain("old user message")
    expect(JSON.stringify(messages)).not.toContain("superseded tail")
    expect(JSON.stringify(messages)).not.toContain("skip before tail")

    expect(prompt.map((message) => message.role)).toEqual(["user", "user", "assistant", "tool"])
    expect(prompt[0]).toMatchObject({
      role: "user",
      content: "[Conversation summary — earlier context was compacted]\nGoal\n- Keep this summary",
    })
    expect(JSON.stringify(prompt)).toContain("tail result")
    expect(JSON.stringify(prompt)).not.toContain("old user message")
    expect(JSON.stringify(prompt)).not.toContain("skip before tail")
  })
})

const fields = (sequence: number): Omit<Event.TurnStarted, "type" | "data"> => ({
  id: Ids.EventId.make(`event_model_context_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: now,
})

const threadCreated = (sequence: number): Event.ThreadCreated => ({
  id: Ids.EventId.make(`event_model_context_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: now,
  type: "thread.created",
  data: { workspace_id: Ids.WorkspaceId.make("workspace_model_context") },
})

const messageAdded = (sequence: number, content: string): Event.MessageAdded => ({
  ...fields(sequence),
  type: "message.added",
  data: {
    message: Message.user({
      id: Ids.MessageId.make(`message_model_context_${sequence}`),
      thread_id: threadId,
      turn_id: turnId,
      content,
      created_at: now,
    }),
  },
})

const compacted = (sequence: number, summary: string, tailStartSequence: number): Event.ContextCompacted => ({
  id: Ids.EventId.make(`event_model_context_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: now,
  type: "context.compacted",
  data: {
    summary,
    tail_start_sequence: tailStartSequence,
    trigger: "manual",
    model: "gpt-5.5",
  },
})

const toolRequested = (
  sequence: number,
  id: Ids.ToolCallId,
  name: string,
  input: Tool.Call["input"],
): Event.ToolCallRequested => ({
  ...fields(sequence),
  type: "tool.call.requested",
  data: { call: { id, name, input } },
})

const toolCompleted = (
  sequence: number,
  id: Ids.ToolCallId,
  name: string,
  output: NonNullable<Tool.Result["output"]>,
): Event.ToolCallCompleted => ({
  ...fields(sequence),
  type: "tool.call.completed",
  data: {
    result: {
      id,
      name,
      status: "success",
      output,
    },
  },
})

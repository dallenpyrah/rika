import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { Artifact, Codec, ErrorEnvelope, Event, Ids, Message, PierreDiff, Tool, Workspace } from "../src/index"

const now = 1_765_000_000_000
const threadId = Ids.ThreadId.make("thread_1")
const turnId = Ids.TurnId.make("turn_1")
const messageId = Ids.MessageId.make("message_1")
const eventId = Ids.EventId.make("event_1")
const toolCallId = Ids.ToolCallId.make("tool_1")
const artifactId = Ids.ArtifactId.make("artifact_1")
const workspaceId = Ids.WorkspaceId.make("workspace_1")
const userId = Ids.UserId.make("user_1")

describe("Rika protocol schemas", () => {
  test("round-trips messages", () => {
    const message = Message.user({
      id: messageId,
      thread_id: threadId,
      turn_id: turnId,
      content: "Build Rika",
      created_at: now,
    })

    const encoded = Schema.encodeSync(Message.Message)(message)
    const decoded = Schema.decodeUnknownSync(Message.Message)(encoded)

    expect(decoded).toEqual(message)
  })

  test("round-trips image message parts with display text", () => {
    const message = Message.user({
      id: messageId,
      thread_id: threadId,
      turn_id: turnId,
      content: [
        Message.text("Look at "),
        Message.image({
          media_type: "image/png",
          data: "cG5n",
          filename: ".rika/pasted/test.png",
          metadata: { label: "[Image 1]" },
        }),
        Message.text(" please"),
      ],
      created_at: now,
    })

    const decoded = Schema.decodeUnknownSync(Message.Message)(Schema.encodeSync(Message.Message)(message))

    expect(decoded).toEqual(message)
    expect(Message.displayText(decoded)).toBe("Look at [Image 1] please")
  })

  test("exports a Pierre file diff decoder with language hints", () => {
    const decoded = PierreDiff.decodeFileDiffMetadata({ ...fileDiff("component.view", 1, 0), lang: "tsx" })

    expect(Option.isSome(decoded)).toBe(true)
    expect(Option.getOrUndefined(decoded)?.lang).toBe("tsx")
  })

  test("round-trips tool calls and results", () => {
    const call: Tool.Call = {
      id: toolCallId,
      name: "read",
      input: { path: "README.md" },
    }
    const result: Tool.Result = {
      id: toolCallId,
      name: "read",
      status: "success",
      output: { lines: 3 },
    }

    expect(Codec.decode(Tool.Call)(Schema.encodeSync(Tool.Call)(call))).toEqual(call)
    expect(Codec.decode(Tool.Result)(Schema.encodeSync(Tool.Result)(result))).toEqual(result)
  })

  test("round-trips typed events", () => {
    const event: Event.Event = {
      id: eventId,
      thread_id: threadId,
      turn_id: turnId,
      sequence: 1,
      version: 1,
      created_at: now,
      type: "message.added",
      data: {
        message: Message.user({
          id: messageId,
          thread_id: threadId,
          turn_id: turnId,
          content: [Message.text("Hello")],
          created_at: now,
        }),
      },
    }

    const encoded = Codec.encode(Event.Event)(event)
    const decoded = Codec.decode(Event.Event)(encoded)

    expect(decoded).toEqual(event)
    expect(Event.references(decoded)).toEqual({ message_id: messageId })
  })

  test("round-trips artifacts and error envelopes", () => {
    const artifact: Artifact.Artifact = {
      id: artifactId,
      thread_id: threadId,
      turn_id: turnId,
      kind: "research",
      title: "Amp surface",
      content: { source: "manual" },
      created_at: now,
    }
    const error: ErrorEnvelope.Envelope = {
      kind: "tool",
      message: "Tool failed",
      retryable: true,
      details: { tool: "read" },
    }

    expect(Codec.decode(Artifact.Artifact)(Codec.encode(Artifact.Artifact)(artifact))).toEqual(artifact)
    expect(Codec.decode(ErrorEnvelope.Envelope)(Codec.encode(ErrorEnvelope.Envelope)(error))).toEqual(error)
  })

  test("round-trips verdict artifacts", () => {
    const artifact: Artifact.Artifact = {
      id: artifactId,
      thread_id: threadId,
      kind: "verdict",
      title: "Judge verdict",
      content: { winner_id: "candidate_a", ranking: [{ candidate_id: "candidate_a", median_score: 9 }] },
      created_at: now,
      metadata: { winner_id: "candidate_a", candidate_count: 2, judge_count: 3 },
    }

    expect(Codec.decode(Artifact.Artifact)(Codec.encode(Artifact.Artifact)(artifact))).toEqual(artifact)
  })

  test("round-trips thread-created event", () => {
    const event: Event.Event = {
      id: eventId,
      thread_id: threadId,
      sequence: 1,
      version: 1,
      created_at: now,
      type: "thread.created",
      data: { workspace_id: workspaceId },
    }

    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(event))).toEqual(event)
  })

  test("round-trips forked thread-created lineage", () => {
    const event: Event.Event = {
      id: eventId,
      thread_id: Ids.ThreadId.make("thread_fork"),
      sequence: 1,
      version: 1,
      created_at: now,
      type: "thread.created",
      data: {
        workspace_id: workspaceId,
        forked_from: { thread_id: threadId, sequence: 5 },
        title_text: "tournament:source/1",
      },
    }

    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(event))).toEqual(event)
  })

  test("round-trips thread archive lifecycle events", () => {
    const archived: Event.Event = {
      id: Ids.EventId.make("event_archived"),
      thread_id: threadId,
      sequence: 2,
      version: 1,
      created_at: now,
      type: "thread.archived",
      data: {},
    }
    const unarchived: Event.Event = {
      id: Ids.EventId.make("event_unarchived"),
      thread_id: threadId,
      sequence: 3,
      version: 1,
      created_at: now,
      type: "thread.unarchived",
      data: {},
    }

    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(archived))).toEqual(archived)
    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(unarchived))).toEqual(unarchived)
  })

  test("round-trips model stream chunk events", () => {
    const event: Event.Event = {
      id: eventId,
      thread_id: threadId,
      turn_id: turnId,
      sequence: 2,
      version: 1,
      created_at: now,
      type: "model.stream.chunk",
      data: { text: "delta", provider: "openai", model: "gpt-5.5" },
    }

    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(event))).toEqual(event)
  })

  test("round-trips turn completion usage", () => {
    const usage: Event.TokenUsage = {
      input_tokens: 123,
      output_tokens: 45,
      total_tokens: 168,
    }
    const event: Event.Event = {
      id: eventId,
      thread_id: threadId,
      turn_id: turnId,
      sequence: 3,
      version: 1,
      created_at: now,
      type: "turn.completed",
      data: {
        provider: "openai",
        model: "gpt-5.5",
        usage,
      },
    }

    expect(Schema.decodeUnknownSync(Event.TokenUsage)(Schema.encodeSync(Event.TokenUsage)(usage))).toEqual(usage)
    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(event))).toEqual(event)
  })

  test("round-trips user attribution", () => {
    const started: Event.Event = {
      id: Ids.EventId.make("event_turn_started_user"),
      thread_id: threadId,
      turn_id: turnId,
      sequence: 2,
      version: 1,
      created_at: now,
      type: "turn.started",
      data: { user_id: userId, mode: "deep2" },
    }
    const message: Event.Event = {
      id: Ids.EventId.make("event_message_user"),
      thread_id: threadId,
      turn_id: turnId,
      sequence: 3,
      version: 1,
      created_at: now,
      type: "message.added",
      data: {
        message: Message.user({
          id: messageId,
          thread_id: threadId,
          turn_id: turnId,
          content: "Hello from a user",
          created_at: now,
          metadata: { user_id: userId },
        }),
      },
    }

    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(started))).toEqual(started)
    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(message))).toEqual(message)
  })

  test("round-trips tool input delta events", () => {
    const event: Event.Event = {
      id: eventId,
      thread_id: threadId,
      turn_id: turnId,
      sequence: 3,
      version: 1,
      created_at: now,
      type: "tool.call.input.delta",
      data: { id: toolCallId, text: '{"path":"README.md"}' },
    }

    const decoded = Codec.decode(Event.Event)(Codec.encode(Event.Event)(event))

    expect(decoded).toEqual(event)
    expect(Event.references(decoded)).toEqual({ tool_call_id: toolCallId })
  })

  test("round-trips resolved context events", () => {
    const event: Event.Event = {
      id: eventId,
      thread_id: threadId,
      turn_id: turnId,
      sequence: 3,
      version: 1,
      created_at: now,
      type: "context.resolved",
      data: {
        entries: [
          {
            kind: "guidance",
            source: "agents-md",
            reason: "workspace guidance",
            trusted: false,
            path: "AGENTS.md",
            content: "Use tests",
          },
        ],
        rendered: "<rika_context>Use tests</rika_context>",
        total_chars: 38,
      },
    }

    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(event))).toEqual(event)
  })

  test("round-trips context compaction events", () => {
    const event: Event.Event = {
      id: Ids.EventId.make("event_context_compacted"),
      thread_id: threadId,
      sequence: 5,
      version: 1,
      created_at: now,
      type: "context.compacted",
      data: {
        summary: "Goal\n- Ship compaction",
        tail_start_sequence: 3,
        trigger: "manual",
        tokens_before: 80_000,
        model: "gpt-5.5",
      },
    }

    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(event))).toEqual(event)
  })

  test("round-trips context pruning events", () => {
    const event: Event.Event = {
      id: Ids.EventId.make("event_context_pruned"),
      thread_id: threadId,
      sequence: 6,
      version: 1,
      created_at: now,
      type: "context.pruned",
      data: {
        tool_call_ids: [toolCallId],
        estimated_tokens_freed: 24_000,
      },
    }

    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(event))).toEqual(event)
  })

  test("round-trips skill loaded events", () => {
    const event: Event.Event = {
      id: eventId,
      thread_id: threadId,
      turn_id: turnId,
      sequence: 4,
      version: 1,
      created_at: now,
      type: "skill.loaded",
      data: {
        name: "deploy",
        description: "Deploy safely",
        source: "project",
        skill_file: ".agents/skills/deploy/SKILL.md",
        resource_paths: ["scripts/deploy.ts"],
      },
    }

    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(event))).toEqual(event)
  })

  test("round-trips read-only turn started events", () => {
    const event: Event.Event = {
      id: eventId,
      thread_id: threadId,
      turn_id: turnId,
      sequence: 5,
      version: 1,
      created_at: now,
      type: "turn.started",
      data: { tool_access: "read-only" },
    }

    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(event))).toEqual(event)
  })

  test("round-trips subagent summary events", () => {
    const event: Event.Event = {
      id: eventId,
      thread_id: threadId,
      turn_id: turnId,
      sequence: 5,
      version: 1,
      created_at: now,
      type: "subagent.completed",
      data: {
        subagent_id: "subagent_1",
        name: "searcher",
        status: "completed",
        summary: "Found the relevant code.",
        evidence: ["packages/agent/src/agent-loop.ts"],
        tool_access: "read-only",
        tool_names: ["semantic_search"],
        started_at: now,
        completed_at: now,
      },
    }

    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(event))).toEqual(event)

    const readWriteEvent: Event.Event = {
      ...event,
      data: { ...event.data, tool_access: "read-write", tool_names: ["shell_command"] },
    }

    expect(Codec.decode(Event.Event)(Codec.encode(Event.Event)(readWriteEvent))).toEqual(readWriteEvent)
  })

  test("round-trips workspace membership payloads", () => {
    const membership: Workspace.Membership = {
      workspace_id: workspaceId,
      user_id: Ids.UserId.make("user_schema_member"),
      role: "owner",
      created_at: now,
    }
    const decision: Workspace.AccessDecision = {
      allowed: true,
      action: "write",
      workspace_id: workspaceId,
      user_id: membership.user_id,
    }

    expect(Codec.decode(Workspace.Membership)(Codec.encode(Workspace.Membership)(membership))).toEqual(membership)
    expect(Codec.decode(Workspace.AccessDecision)(Codec.encode(Workspace.AccessDecision)(decision))).toEqual(decision)
  })
})

const fileDiff = (name: string, additions: number, deletions: number) => ({
  name,
  type: "change" as const,
  splitLineCount: additions + deletions,
  unifiedLineCount: additions + deletions,
  isPartial: false,
  deletionLines: Array.from({ length: deletions }, (_, index) => `before ${index}`),
  additionLines: Array.from({ length: additions }, (_, index) => `after ${index}`),
  hunks: [
    {
      collapsedBefore: 0,
      additionStart: 1,
      additionCount: additions,
      additionLines: additions,
      additionLineIndex: 0,
      deletionStart: 1,
      deletionCount: deletions,
      deletionLines: deletions,
      deletionLineIndex: 0,
      hunkContent: [{ type: "change" as const, deletions, deletionLineIndex: 0, additions, additionLineIndex: 0 }],
      splitLineStart: 0,
      splitLineCount: additions + deletions,
      unifiedLineStart: 0,
      unifiedLineCount: additions + deletions,
      noEOFCRDeletions: false,
      noEOFCRAdditions: false,
    },
  ],
})

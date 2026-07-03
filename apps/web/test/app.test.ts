import { Event, Ids, Message as RikaMessage, Remote } from "@rika/schema"
import { describe, expect, test } from "bun:test"
import {
  ChangedDraft,
  CancelledKillOrb,
  ClickedThread,
  ClickedKillOrb,
  ClickedNewThread,
  ClickedPauseOrb,
  ConfirmedKillOrb,
  GotOrbTabsMessage,
  LoadedThreads,
  OpenedThread,
  ReceivedThreadEvent,
  SubmittedDraft,
  UpdatedSelectedOrb,
  contextUsage,
  eventRows,
  init,
  initialModel,
  update,
} from "../src/app"

const threadId = Ids.ThreadId.make("thread-web")
const workspaceId = Ids.WorkspaceId.make("workspace-web")
const messageId = Ids.MessageId.make("message-web")
const orbId = Ids.OrbId.make("orb-web")
const projectId = Ids.ProjectId.make("project-web")

describe("web app state", () => {
  test("imports only browser-safe LLM modules", async () => {
    const source = await Bun.file(new URL("../src/app.ts", import.meta.url)).text()

    expect(source).not.toContain('from "@rika/llm"')
    expect(source).toContain('from "@rika/llm/model-info"')
  })

  test("initializes by loading backend state and the requested thread", () => {
    const [model, commands] = init({ api_base_url: "/api/rika", thread_id: threadId })

    expect(model.api_base_url).toBe("/api/rika")
    expect(model.selected_thread_id).toBe(threadId)
    expect(model.selected_orb_tab).toBe("transcript")
    expect(model.orb_tabs.activeIndex).toBe(0)
    expect(commands.map((command) => command.name)).toEqual(["LoadBackendHealth", "LoadThreads", "OpenThread"])
  })

  test("routes orb tab selections through Foldkit tab state", () => {
    const [next, commands] = update(
      initialModel({ api_base_url: "/api/rika" }),
      GotOrbTabsMessage({ message: { _tag: "SelectedTab", value: "files", index: 1 } }),
    )

    expect(next.selected_orb_tab).toBe("files")
    expect(next.orb_tabs.activeIndex).toBe(1)
    expect(next.orb_tabs.focusedIndex).toBe(1)
    expect(commands.map((command) => command.name)).toEqual(["FocusTab"])
  })

  test("resets orb tab state when changing thread scope", () => {
    const activeFiles = {
      ...initialModel({ api_base_url: "/api/rika" }),
      selected_thread_id: threadId,
      selected_orb_tab: "files" as const,
      orb_tabs: tabModel(1),
    }

    const [newThread] = update(activeFiles, ClickedNewThread())
    const [opened] = update(
      activeFiles,
      OpenedThread({ record: { summary: summary(Ids.ThreadId.make("thread-next")), events: [] } }),
    )

    expect(newThread.selected_orb_tab).toBe("transcript")
    expect(newThread.orb_tabs.activeIndex).toBe(0)
    expect(opened.selected_orb_tab).toBe("transcript")
    expect(opened.orb_tabs.activeIndex).toBe(0)
  })

  test("opens a thread from durable events before starting the live subscription", () => {
    const event = messageAdded(4, "assistant", "hello from the CLI")
    const [next, commands] = update(
      initialModel({ api_base_url: "/api/rika" }),
      OpenedThread({ record: { summary: summary(threadId), events: [event] } }),
    )

    expect(commands).toEqual([])
    expect(next.events).toEqual([event])
    expect(next.last_sequence).toBe(4)
    expect(next.subscription_after_sequence).toBe(4)
    expect(next.subscribed_thread_id).toBe(threadId)
    expect(next.connection).toBe("connected")
  })

  test("submitting a turn never appends optimistic transcript events", () => {
    const event = messageAdded(4, "assistant", "already rendered")
    const [opened] = update(
      initialModel({ api_base_url: "/api/rika" }),
      OpenedThread({ record: { summary: summary(threadId), events: [event] } }),
    )
    const [drafted] = update(opened, ChangedDraft({ value: "run tests" }))
    const [next, commands] = update(drafted, SubmittedDraft())

    expect(next.events).toEqual([event])
    expect(next.draft).toBe("")
    expect(next.pending_turn).toBe(true)
    expect(commands.map((command) => command.name)).toEqual(["StartTurn"])
  })

  test("applies live events once by sequence", () => {
    const event = messageAdded(5, "assistant", "streamed everywhere")
    const model = {
      ...initialModel({ api_base_url: "/api/rika" }),
      selected_thread_id: threadId,
      subscribed_thread_id: threadId,
      last_sequence: 4,
      subscription_after_sequence: 4,
    }

    const [next] = update(model, ReceivedThreadEvent({ event }))
    const [deduped] = update(next, ReceivedThreadEvent({ event }))

    expect(next.events).toEqual([event])
    expect(next.last_sequence).toBe(5)
    expect(deduped.events).toEqual([event])
    expect(deduped.last_sequence).toBe(5)
  })

  test("renders message events into readable transcript rows", () => {
    expect(eventRows([messageAdded(1, "user", "hi"), messageAdded(2, "assistant", "hello")])).toEqual([
      { id: "event-1", sequence: 1, kind: "message", title: "User", body: "hi" },
      { id: "event-2", sequence: 2, kind: "message", title: "Rika", body: "hello" },
    ])
  })

  test("renders context compaction into a concise event row", () => {
    expect(eventRows([contextCompacted(3)])).toEqual([
      {
        id: "event-3",
        sequence: 3,
        kind: "event",
        title: "Context compacted",
        body: "manual · tail starts at 2",
      },
    ])
  })

  test("renders context pruning into a concise event row", () => {
    expect(eventRows([contextPruned(4)])).toEqual([
      {
        id: "event-4",
        sequence: 4,
        kind: "event",
        title: "Context pruned",
        body: "2 tools · 24000 tokens",
      },
    ])
  })

  test("renders completed hashline edit Pierre payloads as structured diff rows", () => {
    const payload = pierreDiff("src/app.ts", 2, 1)
    const rows = eventRows([toolCallCompleted(5, "edit", { type: "hashline.edit", diff: payload })])

    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe("pierre-diff")
    expect(rows).not.toContainEqual({
      id: "event-5",
      sequence: 5,
      kind: "tool",
      title: "Tool: edit",
      body: "success",
    })

    const row = rows[0]
    if (row?.kind !== "pierre-diff") throw new Error("expected Pierre diff row")
    expect(row.title).toBe("Tool: edit")
    expect(row.expanded).toBe(false)
    expect(row.diff).toMatchObject({
      payload_id: "event-5:diff:0",
      file_name: "src/app.ts",
      additions: 2,
      deletions: 1,
    })
    expect(row.diff.file_diff).toEqual(payload.file_diff)
  })

  test("renders nested artifact Pierre payloads in encounter order", () => {
    const rows = eventRows([
      artifactCreated(6, {
        sections: [
          { first: pierreDiff("src/first.ts", 1, 0) },
          { nested: { second: pierreDiff("src/second.ts", 0, 2) } },
        ],
      }),
    ])

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.kind)).toEqual(["pierre-diff", "pierre-diff"])
    expect(rows.map((row) => (row.kind === "pierre-diff" ? row.diff.file_name : row.title))).toEqual([
      "src/first.ts",
      "src/second.ts",
    ])
    expect(rows.map((row) => row.id)).toEqual(["event-6:diff:0", "event-6:diff:1"])
  })

  test("renders malformed Pierre payloads as a fallback row", () => {
    expect(eventRows([toolCallCompleted(7, "edit", { diff: malformedPierreDiff("src/broken.ts") })])).toEqual([
      {
        id: "event-7:diff-unavailable:0",
        sequence: 7,
        kind: "tool",
        title: "Tool: edit",
        body: "src/broken.ts · diff unavailable",
      },
    ])
  })

  test("computes context usage from summary and latest turn events", () => {
    const hidden = initialModel({ api_base_url: "/api/rika" })
    const fromSummary = {
      ...hidden,
      selected_thread_id: threadId,
      threads: [summary(threadId, { context_tokens: 280_000, context_window: 400_000 })],
    }
    const fromEvent = {
      ...fromSummary,
      events: [turnCompletedWithUsage(5, 360_000)],
    }

    expect(contextUsage(hidden)).toBeUndefined()
    expect(contextUsage(fromSummary)).toEqual({ tokens: 280_000, window: 400_000, percent: 70, tone: "warning" })
    expect(contextUsage(fromEvent)).toEqual({ tokens: 360_000, window: 400_000, percent: 90, tone: "danger" })
  })

  test("auto-opens the newest thread after loading the thread list", () => {
    const [next, commands] = update(
      initialModel({ api_base_url: "/api/rika" }),
      LoadedThreads({ threads: [summary(threadId)] }),
    )

    expect(next.selected_thread_id).toBe(threadId)
    expect(commands.map((command) => command.name)).toEqual(["OpenThread"])
  })

  test("clicking a thread resets subscription state until its durable record opens", () => {
    const otherThreadId = Ids.ThreadId.make("thread-other")
    const [model] = update(
      {
        ...initialModel({ api_base_url: "/api/rika" }),
        selected_thread_id: threadId,
        subscribed_thread_id: threadId,
        last_sequence: 9,
        subscription_after_sequence: 9,
      },
      ClickedThread({ thread_id: otherThreadId }),
    )

    expect(model.selected_thread_id).toBe(otherThreadId)
    expect(model.subscribed_thread_id).toBeUndefined()
    expect(model.events).toEqual([])
    expect(model.last_sequence).toBe(0)
  })

  test("opens an orb-backed thread by loading its selected orb summary", () => {
    const [model, commands] = update(
      initialModel({ api_base_url: "/api/rika" }),
      OpenedThread({ record: { summary: summary(threadId, { orb_status: "running" }), events: [] } }),
    )

    expect(model.selected_thread_id).toBe(threadId)
    expect(model.selected_orb).toBeUndefined()
    expect(commands.map((command) => command.name)).toEqual(["LoadSelectedOrb"])
  })

  test("orb lifecycle actions update selected orb state and thread badges", () => {
    const running = orbSummary("running")
    const paused = { ...running, status: "paused" as const }
    const model = {
      ...initialModel({ api_base_url: "/api/rika" }),
      selected_thread_id: threadId,
      selected_orb: running,
      threads: [summary(threadId, { orb_status: "running" })],
    }

    const [requested, commands] = update(model, ClickedPauseOrb())
    const [updated] = update(requested, UpdatedSelectedOrb({ orb: paused }))

    expect(commands.map((command) => command.name)).toEqual(["PauseSelectedOrb"])
    expect(updated.selected_orb).toEqual(paused)
    expect(updated.threads[0]?.orb_status).toBe("paused")
  })

  test("kill requires a confirmation before sending the lifecycle command", () => {
    const running = orbSummary("running")
    const model = {
      ...initialModel({ api_base_url: "/api/rika" }),
      selected_thread_id: threadId,
      selected_orb: running,
      threads: [summary(threadId, { orb_status: "running" })],
    }

    const [confirming, firstCommands] = update(model, ClickedKillOrb())
    const [cancelled] = update(confirming, CancelledKillOrb())
    const [confirmed, secondCommands] = update(confirming, ConfirmedKillOrb())

    expect(firstCommands).toEqual([])
    expect(confirming.confirm_kill_orb_id).toBe(orbId)
    expect(cancelled.confirm_kill_orb_id).toBeUndefined()
    expect(secondCommands.map((command) => command.name)).toEqual(["KillSelectedOrb"])
    expect(confirmed.confirm_kill_orb_id).toBeUndefined()
  })
})

const summary = (id: Ids.ThreadId, input: Partial<Remote.ThreadSummary> = {}): Remote.ThreadSummary => ({
  thread_id: id,
  workspace_id: workspaceId,
  title_text: "Web thread",
  latest_message_text: "Latest",
  diff: { additions: 0, modifications: 0, deletions: 0 },
  archived: false,
  created_at: 1,
  updated_at: 2,
  ...input,
})

const tabModel = (activeIndex: number) => ({
  id: "orb-tabs",
  activeIndex,
  focusedIndex: activeIndex,
  activationMode: "Automatic" as const,
})

const orbSummary = (status: Remote.OrbSummary["status"]): Remote.OrbSummary => ({
  orb_id: orbId,
  thread_id: threadId,
  project_id: projectId,
  status,
  base_commit: "abc123",
  created_at: 1,
  last_active_at: 121_001,
})

const messageAdded = (sequence: number, role: RikaMessage.Role, text: string): Event.MessageAdded => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "message.added",
  data: {
    message: {
      id: messageId,
      thread_id: threadId,
      role,
      content: [RikaMessage.text(text)],
      created_at: sequence,
    },
  },
})

const contextCompacted = (sequence: number): Event.ContextCompacted => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "context.compacted",
  data: {
    summary: "earlier context summary",
    model: "gpt-5.5",
    trigger: "manual",
    tokens_before: 4096,
    tail_start_sequence: 2,
  },
})

const contextPruned = (sequence: number): Event.ContextPruned => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: sequence,
  type: "context.pruned",
  data: {
    tool_call_ids: [Ids.ToolCallId.make("tool-web-a"), Ids.ToolCallId.make("tool-web-b")],
    estimated_tokens_freed: 24_000,
  },
})

const turnCompletedWithUsage = (sequence: number, inputTokens: number): Event.TurnCompleted => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  turn_id: Ids.TurnId.make("turn-web"),
  sequence,
  version: 1,
  created_at: sequence,
  type: "turn.completed",
  data: {
    provider: "openai",
    model: "gpt-5.5",
    usage: { input_tokens: inputTokens, output_tokens: 100, total_tokens: inputTokens + 100 },
  },
})

const toolCallCompleted = (
  sequence: number,
  name: string,
  output: NonNullable<Event.ToolCallCompleted["data"]["result"]["output"]>,
): Event.ToolCallCompleted => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  turn_id: Ids.TurnId.make("turn-web"),
  sequence,
  version: 1,
  created_at: sequence,
  type: "tool.call.completed",
  data: {
    result: {
      id: Ids.ToolCallId.make(`tool-web-${sequence}`),
      name,
      status: "success",
      output,
    },
  },
})

const artifactCreated = (
  sequence: number,
  content: Event.ArtifactCreated["data"]["artifact"]["content"],
): Event.ArtifactCreated => ({
  id: Ids.EventId.make(`event-${sequence}`),
  thread_id: threadId,
  turn_id: Ids.TurnId.make("turn-web"),
  sequence,
  version: 1,
  created_at: sequence,
  type: "artifact.created",
  data: {
    artifact: {
      id: Ids.ArtifactId.make(`artifact-web-${sequence}`),
      thread_id: threadId,
      turn_id: Ids.TurnId.make("turn-web"),
      kind: "patch",
      title: "Patch bundle",
      content,
      created_at: sequence,
    },
  },
})

const pierreDiff = (name: string, additions: number, deletions: number) => ({
  kind: "diff",
  renderer: "@pierre/diffs",
  collapsed: true,
  file_diff: fileDiff(name, additions, deletions),
})

const malformedPierreDiff = (name: string) => ({
  kind: "diff",
  renderer: "@pierre/diffs",
  file_diff: { name },
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

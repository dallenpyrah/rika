import { describe, expect, it } from "@effect/vitest"
import { applyEvent, empty, project, type SourceEvent } from "../src"

describe("Transcript projection", () => {
  it("collapses a long output stream into stable semantic units", () => {
    const events = Array.from(
      { length: 600 },
      (_, index): SourceEvent => ({
        cursor: `cursor-${index}`,
        sequence: index,
        type: "model.output.delta",
        createdAt: index,
        text: `line ${index}\n`,
      }),
    )
    const projection = project("turn-a", "prompt", events)

    expect(projection.units).toHaveLength(2)
    expect(projection.units[0]).toMatchObject({ key: "turn:turn-a:user", content: { role: "user", text: "prompt" } })
    expect(projection.units[1]).toMatchObject({ content: { role: "assistant" } })
    expect(projection.units[1]?.content._tag).toBe("Entry")
    expect(projection.units[1]?.content._tag === "Entry" ? projection.units[1].content.text : "").toContain("line 599")
    expect(projection.checkpointCursor).toBe("cursor-599")
    expect(projection.revision).toBe(599)
  })

  it("preserves prose and activity order while reconciling tool results", () => {
    const projection = project("turn-a", "prompt", [
      { cursor: "0", sequence: 0, type: "model.input.prepared", createdAt: 0 },
      { cursor: "1", sequence: 1, type: "model.output.delta", createdAt: 1, text: "first" },
      { cursor: "1b", sequence: 2, type: "model.output.completed", createdAt: 2, text: "first" },
      {
        cursor: "2",
        sequence: 3,
        type: "tool.call.requested",
        createdAt: 3,
        data: { tool_call_id: "call", tool_name: "read", input: "a" },
      },
      {
        cursor: "3",
        sequence: 4,
        type: "tool.result.received",
        createdAt: 4,
        data: { tool_call_id: "call", output: "ok" },
      },
      { cursor: "4", sequence: 5, type: "model.input.prepared", createdAt: 5 },
      { cursor: "5", sequence: 6, type: "model.output.delta", createdAt: 6, text: "final" },
      { cursor: "6", sequence: 7, type: "model.output.completed", createdAt: 7, text: "final" },
      { cursor: "7", sequence: 8, type: "execution.completed", createdAt: 8 },
    ])

    expect(projection.units.map((unit) => unit.content._tag)).toEqual(["Entry", "Entry", "Block", "Entry"])
    expect(projection.units.find((unit) => unit.key === "turn:turn-a:user")).toMatchObject({
      executionOutcome: { status: "complete" },
    })
    expect(projection.units[2]).toMatchObject({
      key: "tool:turn-a:call",
      revision: 4,
      content: { _tag: "Block", block: { _tag: "ToolCall", output: "ok", status: "complete" } },
    })
    expect(projection.units[3]).toMatchObject({ content: { _tag: "Entry", text: "final" } })
    expect(
      projection.units.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "user"),
    ).toHaveLength(1)
  })

  it("does not replay the execution-wide completion text into the final assistant phase", () => {
    const projection = project("turn-a", "prompt", [
      { cursor: "0", sequence: 0, type: "model.input.prepared", createdAt: 0 },
      { cursor: "1", sequence: 1, type: "model.output.delta", createdAt: 1, text: "first" },
      {
        cursor: "2",
        sequence: 2,
        type: "tool.call.requested",
        createdAt: 2,
        data: { tool_call_id: "read", tool_name: "read", input: { path: "a.ts" } },
      },
      {
        cursor: "3",
        sequence: 3,
        type: "tool.result.received",
        createdAt: 3,
        data: { tool_call_id: "read", output: { text: "contents" } },
      },
      { cursor: "4", sequence: 4, type: "model.output.delta", createdAt: 4, text: "final" },
      {
        cursor: "5",
        sequence: 5,
        type: "model.output.completed",
        createdAt: 5,
        text: "firstfinal",
        data: { model_output: "firstfinal" },
      },
    ])
    expect(
      projection.units.flatMap((unit) =>
        unit.content._tag === "Entry" && unit.content.role === "assistant" ? [unit.content.text] : [],
      ),
    ).toEqual(["first", "final"])
  })

  it("projects completed unified diffs from any tool result", () => {
    const projection = project("turn-a", "change files", [
      {
        cursor: "1",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "change-1", tool_name: "bash", input: { command: "make changes" } },
      },
      {
        cursor: "2",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: {
          tool_call_id: "change-1",
          output: {
            text: "changed 2 files",
            diff:
              "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n\n" +
              "diff --git a/src/b.ts b/src/b.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1 @@\n+hello",
          },
        },
      },
    ])
    expect(projection.units[1]).toMatchObject({
      key: "tool:turn-a:change-1",
      content: {
        _tag: "Block",
        block: {
          status: "complete",
          files: [
            { path: "src/a.ts", preview: false },
            { path: "src/b.ts", preview: false },
          ],
        },
      },
    })
  })

  it("uses child payload status and keeps one stable child row", () => {
    const projection = project("turn-a", "delegate", [
      {
        cursor: "1",
        sequence: 1,
        type: "child_run.spawned",
        createdAt: 1,
        data: { child_execution_id: "child-1", preset_name: "Oracle" },
      },
      {
        cursor: "2",
        sequence: 2,
        type: "child_run.event",
        createdAt: 2,
        data: { child_execution_id: "child-1", preset_name: "Oracle", status: "failed", error: "no result" },
      },
    ])
    expect(projection.units).toHaveLength(2)
    expect(projection.units[1]).toMatchObject({
      key: "child:turn-a:child-1",
      content: { _tag: "Block", block: { _tag: "ChildAgent", id: "child-1", status: "failed" } },
    })
  })

  it("merges a correlated spawn and child lifecycle into one named tool unit", () => {
    const childId = "execution:turn-a:child:oracle"
    const projection = project("turn-a", "delegate", [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: {
          tool_call_id: "agent",
          tool_name: "spawn_child_run",
          input: { profile: "oracle", prompt: "Find the projection defect" },
        },
      },
      {
        cursor: "spawned",
        sequence: 2,
        type: "child_run.spawned",
        createdAt: 2,
        data: { tool_call_id: "agent", child_execution_id: childId },
      },
      {
        cursor: "started",
        sequence: 3,
        type: "child_run.started",
        createdAt: 3,
        data: { child_execution_id: childId, profile: "oracle" },
      },
      {
        cursor: "completed",
        sequence: 4,
        type: "child_run.completed",
        createdAt: 4,
        data: { child_execution_id: childId, profile: "oracle" },
      },
    ])

    expect(projection.units).toHaveLength(2)
    expect(projection.units[1]).toMatchObject({
      key: "tool:turn-a:agent",
      revision: 4,
      content: {
        _tag: "Block",
        block: {
          _tag: "ToolCall",
          childId,
          status: "complete",
          detail: "Find the projection defect",
          presentation: { activeLabel: "Oracle exploring", completeLabel: "Oracle has spoken" },
        },
      },
    })
  })

  it("labels a spawn call Subagent working before any child metadata arrives", () => {
    const projection = project("turn-a", "delegate", [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "agent", tool_name: "transfer_to_task", input: { prompt: "Inspect the projection" } },
      },
    ])
    const block =
      projection.units[1]?.content._tag === "Block" && projection.units[1].content.block._tag === "ToolCall"
        ? projection.units[1].content.block
        : undefined
    expect(block?.presentation).toMatchObject({
      family: "agent",
      activeLabel: "Subagent working",
      completeLabel: "Subagent finished",
    })
    expect(block?.presentation.activeLabel).not.toContain("(task)")
  })

  it("uses a later durable child completion instead of an earlier subagent tool error", () => {
    const events: ReadonlyArray<SourceEvent> = [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: {
          tool_call_id: "agent",
          tool_name: "spawn_child_run",
          input: { profile: "task", prompt: "Inspect the projection" },
        },
      },
      {
        cursor: "result",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: { tool_call_id: "agent", error: "AgentToolError: Model gpt-5.6-luna is not available" },
      },
      {
        cursor: "completed",
        sequence: 3,
        type: "child_run.completed",
        createdAt: 3,
        data: {
          tool_call_id: "agent",
          child_execution_id: "child:agent",
          profile: "task",
          summary: "The child recovered and returned an answer.",
        },
      },
    ]
    const live = project("turn-a", "delegate", events)
    const replayed = events.reduce((current, event) => applyEvent(current, event), empty("turn-a", "delegate"))
    for (const projection of [live, replayed])
      expect(projection.units[1]).toMatchObject({
        key: "tool:turn-a:agent",
        content: {
          _tag: "Block",
          block: {
            _tag: "ToolCall",
            status: "complete",
            detail: "Inspect the projection",
            output: "The child recovered and returned an answer.",
          },
        },
      })
  })

  it("keeps a terminal child result from presenting a failed or cancelled subagent as finished", () => {
    for (const status of ["failed", "cancelled"] as const) {
      const projection = project("turn-a", "delegate", [
        {
          cursor: `call-${status}`,
          sequence: 1,
          type: "tool.call.requested",
          createdAt: 1,
          data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Inspect the projection" } },
        },
        {
          cursor: `result-${status}`,
          sequence: 2,
          type: "tool.result.received",
          createdAt: 2,
          data: { tool_call_id: "agent", output: { childExecutionId: "child:agent", status, output: [] } },
        },
      ])
      expect(projection.units[1]).toMatchObject({
        content: { _tag: "Block", block: { _tag: "ToolCall", status } },
      })
    }
  })

  it("treats a completed final assistant response as the child outcome despite a later execution failure", () => {
    const events: ReadonlyArray<SourceEvent> = [
      {
        cursor: "tool",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "read", tool_name: "read" },
      },
      {
        cursor: "tool-error",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: { tool_call_id: "read", error: "file missing" },
      },
      { cursor: "answer", sequence: 3, type: "model.output.completed", createdAt: 3, text: "Usable final response" },
      { cursor: "failed", sequence: 4, type: "execution.failed", createdAt: 4, text: "internal tool failed" },
    ]

    for (const projection of [
      project("child", "delegate", events),
      events.reduce((current, event) => applyEvent(current, event), empty("child", "delegate")),
    ]) {
      expect(projection.units.find((unit) => unit.executionOutcome !== undefined)?.executionOutcome).toEqual({
        status: "complete",
      })
      expect(projection.units).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            content: expect.objectContaining({ block: expect.objectContaining({ _tag: "Error" }) }),
          }),
        ]),
      )
      expect(projection.units).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            content: expect.objectContaining({
              block: expect.objectContaining({ _tag: "ToolCall", status: "failed" }),
            }),
          }),
        ]),
      )
    }
  })

  it.each([
    [
      "partial output without completion",
      [{ cursor: "partial", sequence: 3, type: "model.output.delta", createdAt: 3, text: "Partial response" }],
    ],
    [
      "an empty completion after partial output",
      [
        { cursor: "partial", sequence: 3, type: "model.output.delta", createdAt: 3, text: "Partial response" },
        { cursor: "empty", sequence: 4, type: "model.output.completed", createdAt: 4, text: "" },
      ],
    ],
    [
      "a completed response before later tool activity",
      [
        { cursor: "answer", sequence: 1, type: "model.output.completed", createdAt: 1, text: "Stale response" },
        {
          cursor: "tool",
          sequence: 2,
          type: "tool.call.requested",
          createdAt: 2,
          data: { tool_call_id: "read", tool_name: "read" },
        },
        {
          cursor: "tool-error",
          sequence: 3,
          type: "tool.result.received",
          createdAt: 3,
          data: { tool_call_id: "read", error: "file missing" },
        },
      ],
    ],
  ] as const)("keeps execution failure after %s", (_name, precedingEvents) => {
    const events: ReadonlyArray<SourceEvent> = [
      ...precedingEvents,
      { cursor: "failed", sequence: 5, type: "execution.failed", createdAt: 5, text: "internal tool failed" },
    ]

    for (const projection of [
      project("child", "delegate", events),
      events.reduce((current, event) => applyEvent(current, event), empty("child", "delegate")),
    ]) {
      expect(projection.units.find((unit) => unit.executionOutcome !== undefined)?.executionOutcome).toEqual({
        status: "failed",
        reason: "internal tool failed",
      })
    }
  })

  it("keeps the ToolError message as the output of a failed tool result", () => {
    const projection = project("turn-a", "prompt", [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "call", tool_name: "read", input: "a" },
      },
      {
        cursor: "result",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: { tool_call_id: "call", output: { _tag: "ToolError", tool: "read", message: "file missing" } },
      },
    ])
    expect(projection.units[1]).toMatchObject({
      content: { _tag: "Block", block: { _tag: "ToolCall", status: "failed", output: "file missing" } },
    })
  })

  it("links a Relay handoff spawn to its encoded tool call and keeps the supplied prompt", () => {
    const callId = "rika:execution%3Aparent:spawn-oracle"
    const childId = `execution:parent:child:${callId}`
    const projection = project("turn-a", "delegate", [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: {
          tool_call_id: callId,
          tool_name: "transfer_to_oracle",
          input: {
            input: [{ type: "text", text: "Inspect AGENTS.md and report the evidence." }],
          },
        },
      },
      {
        cursor: "spawned",
        sequence: 2,
        type: "child_run.spawned",
        createdAt: 2,
        data: { child_execution_id: childId, preset_name: "Oracle" },
      },
    ])

    expect(projection.units).toHaveLength(2)
    expect(projection.units[1]).toMatchObject({
      key: `tool:turn-a:${callId}`,
      revision: 2,
      content: {
        _tag: "Block",
        block: {
          _tag: "ToolCall",
          childId,
          detail: "Inspect AGENTS.md and report the evidence.",
          presentation: { activeLabel: "Oracle exploring", completeLabel: "Oracle has spoken" },
        },
      },
    })
  })

  it("keeps a process wait as its own row and names it from the parent command", () => {
    const projection = project("turn-a", "run tests", [
      {
        cursor: "bash",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "bash-1", tool_name: "bash", input: { command: "bun test" } },
      },
      {
        cursor: "shell-result",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: { tool_call_id: "bash-1", output: { text: "", processId: "process-1", running: true } },
      },
      {
        cursor: "wait",
        sequence: 3,
        type: "tool.call.requested",
        createdAt: 3,
        data: {
          tool_call_id: "wait-1",
          tool_name: "shell_command_status",
          input: { processId: "process-1" },
        },
      },
      {
        cursor: "wait-result",
        sequence: 4,
        type: "tool.result.received",
        createdAt: 4,
        data: {
          tool_call_id: "wait-1",
          output: { text: "failed", processId: "process-1", running: false, exitCode: 7 },
        },
      },
    ])
    expect(projection.units).toHaveLength(3)
    expect(projection.units[2]).toMatchObject({
      key: "tool:turn-a:wait-1",
      content: {
        _tag: "Block",
        block: {
          _tag: "ToolCall",
          parentId: "turn-a:bash-1",
          detail: "bun test",
          status: "failed",
          process: { exitCode: 7 },
          presentation: { activeLabel: "Waiting for", completeLabel: "Waited for" },
        },
      },
    })
  })

  it("preserves hidden web output with its presentation metadata", () => {
    const projection = project("turn-a", "prompt", [
      {
        cursor: "web-call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: {
          tool_call_id: "web-1",
          tool_name: "web_search",
          input: { objective: "Find current documentation" },
        },
      },
      {
        cursor: "web-result",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: { tool_call_id: "web-1", output: "SEARCH RESULT BODY" },
      },
    ])
    const block = projection.units.find((unit) => unit.key === "tool:turn-a:web-1")?.content

    expect(block).toMatchObject({
      _tag: "Block",
      block: {
        _tag: "ToolCall",
        output: "SEARCH RESULT BODY",
        presentation: { outputDisplay: "hidden" },
      },
    })
  })
})

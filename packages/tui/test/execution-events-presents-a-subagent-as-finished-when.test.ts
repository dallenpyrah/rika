import * as Transcript from "@rika/transcript"
import { expect, it } from "vitest"
import { ExecutionEvents, ViewState } from "../src"
import { renderTranscriptStyled } from "../src/adapter"
import { unitId as transcriptUnitId, rows as transcriptUnits } from "../src/transcript-presenter"

const event = (
  cursor: string,
  sequence: number,
  type: string,
  fields: Partial<Transcript.SourceEvent> = {},
): Transcript.SourceEvent => ({ cursor, sequence, type, createdAt: sequence, ...fields })

it("presents a subagent as finished when its durable child lifecycle completes after a tool error", () => {
  const childId = "execution:child:turn:task"
  const projection = Transcript.project("turn", "prompt", [
    event("agent", 0, "tool.call.requested", {
      data: {
        tool_call_id: "agent",
        tool_name: "task",
        input: { prompt: "Use an unavailable model", model: "gpt-5.6-luna" },
      },
    }),
    event("agent-spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: childId },
    }),
    event("agent-failed", 2, "tool.result.received", {
      data: { tool_call_id: "agent", error: "AgentToolError: Model gpt-5.6-luna is not available" },
    }),
    event("child-completed", 3, "child_run.completed", {
      data: { child_execution_id: childId, profile: "task" },
    }),
  ])

  const model = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)

  expect(model.blocks).toEqual([
    expect.objectContaining({
      _tag: "ToolCall",
      status: "complete",
    }),
  ])
  expect(
    renderTranscriptStyled(model)
      .chunks.map((chunk) => chunk.text)
      .join(""),
  ).toContain("Subagent finished")
})

it("merges Relay child ids that encode the uncorrelated tool call", () => {
  const turnId = "turn"
  const toolCallId = "rika:execution%3Aturn:cancel-agent"
  const childId = "child:execution%3Aturn:rika:execution%3Aturn:cancel-agent"
  const projection = Transcript.project(turnId, "delegate", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: toolCallId, tool_name: "task", input: { prompt: "Wait until cancelled." } },
    }),
    event("spawned", 1, "child_run.spawned", { data: { child_execution_id: childId } }),
  ])

  const model = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)

  expect(model.blocks).toEqual([
    expect.objectContaining({
      _tag: "ToolCall",
      id: `${turnId}:${toolCallId}`,
      childId,
      status: "running",
    }),
  ])
})

it("uses Subagent as the fallback descriptor instead of Task", () => {
  const childId = "execution:child:turn:task"
  const projection = Transcript.project("turn", "prompt", [
    event("agent", 0, "tool.call.requested", {
      data: {
        tool_call_id: "agent",
        tool_name: "spawn_child_run",
        input: { profile: "task", prompt: "Run the checks" },
      },
    }),
    event("agent-spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: childId },
    }),
    event("agent-started", 2, "child_run.started", {
      data: { child_execution_id: childId, profile: "task" },
    }),
  ])

  const model = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)

  expect(model.blocks).toEqual([
    expect.objectContaining({
      _tag: "ToolCall",
      presentation: expect.objectContaining({ activeLabel: "Subagent working" }),
    }),
  ])
  expect(JSON.stringify(model.blocks)).not.toContain("Task working")
})

it("moves a live child row expansion onto the stable subagent unit key", () => {
  const childId = "execution:child:turn:task"
  let projection = Transcript.project("turn", "prompt", [
    event("agent", 0, "tool.call.requested", {
      data: {
        tool_call_id: "agent",
        tool_name: "spawn_child_run",
        input: { profile: "task", prompt: "Run the checks" },
      },
    }),
    event("agent-started", 1, "child_run.started", {
      data: { child_execution_id: childId, profile: "task" },
    }),
  ])
  let model = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)
  const childRow = "block:child:turn:execution:child:turn:task"
  model = { ...model, detailSelection: childRow, expandedRowKeys: [childRow] }
  projection = Transcript.applyEvent(
    projection,
    event("agent-spawned", 2, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: childId },
    }),
  )

  model = ExecutionEvents.projectUnits(model, projection.units)

  expect(transcriptUnits(model)).toHaveLength(2)
  expect(model.detailSelection).toBe("tool:turn:agent")
  expect(model.expandedRowKeys).toEqual(["tool:turn:agent"])
})

it("projects a durable nested projection to the same tree as live child events", () => {
  const childId = "turn:child:oracle"
  const parent = Transcript.project("turn", "delegate", [
    event("agent", 0, "tool.call.requested", {
      data: {
        tool_call_id: "agent",
        tool_name: "transfer_to_oracle",
        input: { input: [{ type: "text", text: "Review the projection" }] },
      },
    }),
    event("spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: `execution:${childId}` },
    }),
  ])
  const childProjection = Transcript.project(childId, "", [
    event("read", 0, "tool.call.requested", {
      data: { tool_call_id: "read", tool_name: "read", input: { path: "src/projection.ts" } },
    }),
    event("answer", 1, "model.output.completed", { text: "## Review complete\n\n**No defects found.**" }),
  ])
  const durable = Transcript.withNestedProjections(parent, [{ parentId: "turn:agent", projection: childProjection }])

  let liveModel = ExecutionEvents.projectUnits(ViewState.initial("/work"), parent.units)
  liveModel = ExecutionEvents.projectChildUnits(liveModel, "turn:agent", childProjection.units)
  const reloadedModel = ExecutionEvents.projectUnits(ViewState.initial("/work"), durable.units)

  const shape = (model: ViewState.Model) =>
    transcriptUnits(model).map((unit) =>
      unit.kind === "tool"
        ? {
            kind: unit.kind,
            id: transcriptUnitId(model, unit),
            children: unit.children?.map((child) => transcriptUnitId(model, child)),
            response:
              unit.terminal?.kind === "answer"
                ? (model.entries[unit.terminal.entry]?.text ?? "").replaceAll("\n", "\\n")
                : undefined,
          }
        : { kind: unit.kind },
    )

  expect(shape(reloadedModel)).toEqual(shape(liveModel))
})

it.each([1, 4])(
  "uses a completed child execution instead of parent tool result ordering at parent sequence %i",
  (resultSequence) => {
    const parent = Transcript.project("turn", "delegate", [
      event("agent", 0, "tool.call.requested", {
        data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Inspect the child" } },
      }),
      event("spawned", 2, "child_run.spawned", {
        data: { tool_call_id: "agent", child_execution_id: "execution:child" },
      }),
      event("parent-result", resultSequence, "tool.result.received", {
        data: { tool_call_id: "agent", error: "stale parent failure" },
      }),
    ])
    const child = Transcript.project("child", "", [
      event("inner", 0, "tool.call.requested", {
        data: { tool_call_id: "inner", tool_name: "read", input: { path: "missing.ts" } },
      }),
      event("inner-result", 1, "tool.result.received", {
        data: { tool_call_id: "inner", error: "File not found" },
      }),
      event("answer", 2, "model.output.completed", { text: "Recovered final answer" }),
      event("child-done", 3, "execution.completed"),
    ])

    let live = ExecutionEvents.projectUnits(ViewState.initial("/work"), parent.units)
    live = ExecutionEvents.projectChildUnits(live, "turn:agent", child.units)
    live = ExecutionEvents.projectUnits(live, parent.units)
    const reloaded = ExecutionEvents.projectUnits(
      ViewState.initial("/work"),
      Transcript.withNestedProjections(parent, [{ parentId: "turn:agent", projection: child }]).units,
    )

    for (const projected of [live, reloaded]) {
      const model = { ...projected, expandedRowKeys: ["tool:turn:agent", "tool:child:inner"] }
      const rendered = renderTranscriptStyled(model)
        .chunks.map((chunk) => chunk.text)
        .join("")
      expect(model.blocks).toEqual([
        expect.objectContaining({ _tag: "ToolCall", id: "turn:agent", status: "complete" }),
        expect.objectContaining({ _tag: "ToolCall", id: "child:inner", status: "failed" }),
      ])
      expect(rendered).toContain("Subagent finished")
      expect(rendered).toContain("Recovered final answer")
      expect(rendered).toContain("missing.ts")
      expect(rendered).toContain("File not found")
      expect(rendered).not.toContain("stale parent failure")
    }
  },
)

it("replays a child with an internal tool error and completed final response as finished", () => {
  const parent = Transcript.project("turn", "delegate", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: "agent", tool_name: "oracle", input: { prompt: "Review" } },
    }),
    event("spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: "execution:child", profile: "oracle" },
    }),
  ])
  const child = Transcript.project("child", "", [
    event("inner", 0, "tool.call.requested", {
      data: { tool_call_id: "inner", tool_name: "read", input: { path: "missing.ts" } },
    }),
    event("inner-error", 1, "tool.result.received", {
      data: { tool_call_id: "inner", error: "File not found" },
    }),
    event("answer", 2, "model.output.completed", { text: "Usable Oracle response" }),
    event("failed", 3, "execution.failed", { text: "internal tool failed" }),
  ])

  const projected = ExecutionEvents.projectUnits(
    ViewState.initial("/work"),
    Transcript.withNestedProjections(parent, [{ parentId: "turn:agent", projection: child }]).units,
  )
  const rendered = renderTranscriptStyled({ ...projected, expandedRowKeys: ["tool:turn:agent"] })
    .chunks.map((chunk) => chunk.text)
    .join("")

  expect(projected.blocks[0]).toMatchObject({ _tag: "ToolCall", status: "complete" })
  expect(rendered).toContain("Oracle has spoken")
  expect(rendered).toContain("Usable Oracle response")
  expect(rendered).not.toContain("Oracle failed")
})

it("projects cancelled root and child tools as terminal without a duplicate notice", () => {
  const childId = "turn:child:task"
  const parent = Transcript.project("turn", "delegate", [
    event("agent", 0, "tool.call.requested", {
      data: {
        tool_call_id: "agent",
        tool_name: "task",
        input: { prompt: "Run the checks" },
      },
    }),
    event("spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: `execution:${childId}` },
    }),
  ])
  const child = Transcript.project(childId, "", [
    event("shell", 0, "tool.call.requested", {
      data: { tool_call_id: "shell", tool_name: "bash", input: { command: "sleep 60" } },
    }),
    event("child-cancelled", 1, "execution.cancelled"),
  ])
  const root = Transcript.applyEvent(parent, event("root-cancelled", 2, "execution.cancelled"))

  let live = ExecutionEvents.projectUnits(ViewState.initial("/work"), parent.units)
  live = ExecutionEvents.projectChildUnits(live, "turn:agent", child.units)
  live = ExecutionEvents.projectUnits(live, root.units)
  const durable = Transcript.withNestedProjections(root, [{ parentId: "turn:agent", projection: child }])
  const reloaded = ExecutionEvents.projectUnits(ViewState.initial("/work"), durable.units)

  for (const model of [live, reloaded]) {
    expect(model.blocks).toEqual([
      expect.objectContaining({ _tag: "ToolCall", id: "turn:agent", status: "cancelled" }),
      expect.objectContaining({ _tag: "ToolCall", id: `${childId}:shell`, status: "cancelled" }),
    ])
    expect(model.entries.filter((entry) => entry.role === "notice")).toEqual([])
  }
})

it("lets a reasoned nested cancellation override a stale failed parent in live and flattened replay", () => {
  const parent = Transcript.project("turn", "delegate", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "work" } },
    }),
    event("stale-failure", 1, "tool.result.received", {
      data: { tool_call_id: "agent", error: "stale parent failure" },
    }),
  ])
  const child = Transcript.project("child", "", [
    event("shell", 2, "tool.call.requested", {
      data: { tool_call_id: "shell", tool_name: "bash", input: { command: "sleep 60" } },
    }),
    event("child-cancelled", 3, "execution.cancelled", { data: { reason: "parent stopped this child" } }),
  ])
  let live = ExecutionEvents.projectUnits(ViewState.initial("/work"), parent.units)
  live = ExecutionEvents.projectChildUnits(live, "turn:agent", child.units)
  const replay = ExecutionEvents.projectUnits(
    ViewState.initial("/work"),
    Transcript.withNestedProjections(parent, [{ parentId: "turn:agent", projection: child }]).units,
  )

  for (const projected of [live, replay]) {
    const model = { ...projected, expandedRowKeys: ["tool:turn:agent"] }
    const rendered = renderTranscriptStyled(model)
      .chunks.map((chunk) => chunk.text)
      .join("")
    expect(model.blocks).toEqual([
      expect.objectContaining({
        _tag: "ToolCall",
        id: "turn:agent",
        status: "cancelled",
        output: "parent stopped this child",
      }),
      expect.objectContaining({ _tag: "ToolCall", id: "child:shell", status: "cancelled" }),
    ])
    expect(model.entries.filter((entry) => entry.role === "notice")).toEqual([])
    expect(rendered).toContain("parent stopped this child")
    expect(rendered).not.toContain("stale parent failure")
  }
})

it("projects one durable cancellation marker when no parent row can carry it", () => {
  const projection = Transcript.project("turn", "wait", [event("cancelled", 0, "execution.cancelled")])
  const once = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)
  const twice = ExecutionEvents.projectUnits(once, projection.units)

  expect(twice.entries.filter((entry) => entry.role === "notice")).toEqual([
    { _tag: "Entry", role: "notice", text: "cancelled", turnId: "turn" },
  ])
  expect(twice.items).toContainEqual(
    expect.objectContaining({ _tag: "Entry", id: "execution:turn:cancelled", turnId: "turn" }),
  )
})

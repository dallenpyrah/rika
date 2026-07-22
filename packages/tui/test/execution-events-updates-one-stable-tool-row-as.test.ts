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

it("updates one stable tool row as input and output arrive", () => {
  let projection = Transcript.empty("turn", "prompt")
  let model = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)
  projection = Transcript.applyEvent(
    projection,
    event("call", 0, "tool.call.requested", {
      data: { tool_call_id: "call", tool_name: "read", input: { path: "src/a.ts" } },
    }),
  )
  model = ExecutionEvents.projectUnits(model, projection.units)
  projection = Transcript.applyEvent(
    projection,
    event("result", 1, "tool.result.received", {
      data: { tool_call_id: "call", output: "contents" },
    }),
  )
  model = ExecutionEvents.projectUnits(model, projection.units)

  expect(model.blocks).toEqual([
    expect.objectContaining({ _tag: "ToolCall", id: "turn:call", status: "complete", output: "contents" }),
  ])
  expect(model.items).toHaveLength(2)
})

it("keeps user, assistant, tool, and final assistant order", () => {
  const projection = Transcript.project("turn", "prompt", [
    event("input-0", 0, "model.input.prepared"),
    event("assistant-0", 1, "model.output.completed", { text: "I will inspect it." }),
    event("call", 2, "tool.call.requested", {
      data: { tool_call_id: "call", tool_name: "read", input: { path: "src/a.ts" } },
    }),
    event("result", 3, "tool.result.received", { data: { tool_call_id: "call", output: "contents" } }),
    event("input-1", 4, "model.input.prepared"),
    event("assistant-1", 5, "model.output.completed", { text: "Done." }),
  ])
  const model = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)

  expect(model.items.map((item) => (item as ViewState.TranscriptItem).id)).toEqual([
    "turn:turn:user",
    "assistant:turn:0",
    "tool:turn:call",
    "assistant:turn:1",
  ])
})

it("keeps overlapping tool ids separate across turns", () => {
  const first = Transcript.project("turn-1", "first", [
    event("call", 0, "tool.call.requested", {
      data: { tool_call_id: "call", tool_name: "read", input: { path: "a.ts" } },
    }),
  ])
  const second = Transcript.project("turn-2", "second", [
    event("call", 0, "tool.call.requested", {
      data: { tool_call_id: "call", tool_name: "read", input: { path: "b.ts" } },
    }),
  ])
  const model = ExecutionEvents.projectUnits(ViewState.initial("/work"), [...first.units, ...second.units])

  expect(model.blocks).toEqual([
    expect.objectContaining({ id: "turn-1:call", detail: "a.ts" }),
    expect.objectContaining({ id: "turn-2:call", detail: "b.ts" }),
  ])
})

it("updates one child row through its lifecycle", () => {
  let projection = Transcript.empty("turn", "prompt")
  projection = Transcript.applyEvent(
    projection,
    event("child-start", 0, "child_run.started", {
      data: { child_run_id: "child", profile: "oracle", summary: "Inspecting" },
    }),
  )
  let model = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)
  projection = Transcript.applyEvent(
    projection,
    event("child-done", 1, "child_run.completed", {
      data: { child_run_id: "child", profile: "oracle", summary: "Finished" },
    }),
  )
  model = ExecutionEvents.projectUnits(model, projection.units)

  expect(model.blocks).toEqual([expect.objectContaining({ _tag: "ChildAgent", id: "child", status: "complete" })])
})

it("projects child execution tools beneath their subagent with stable nested keys", () => {
  const parent = Transcript.project("turn", "prompt", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: "agent", tool_name: "oracle", input: { prompt: "Review the code" } },
    }),
    event("agent-spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: "child:turn:oracle" },
    }),
  ])
  const child = Transcript.project("child:turn:oracle", "", [
    event("read", 0, "tool.call.requested", {
      data: { tool_call_id: "read", tool_name: "read", input: { path: "src/a.ts", offset: 3, limit: 4 } },
    }),
    event("read-result", 1, "tool.result.received", {
      data: { tool_call_id: "read", output: "contents" },
    }),
    event("shell", 2, "tool.call.requested", {
      data: { tool_call_id: "shell", tool_name: "bash", input: { command: "bun test" } },
    }),
    event("shell-result", 3, "tool.result.received", {
      data: { tool_call_id: "shell", output: { text: "passed", exitCode: 0 } },
    }),
  ])
  let model = ExecutionEvents.projectUnits(ViewState.initial("/work"), parent.units)
  model = ExecutionEvents.projectChildUnits(model, "turn:agent", child.units)
  model = { ...model, expandedRowKeys: ["tool:turn:agent"] }

  const units = transcriptUnits(model)
  expect(units).toMatchObject([
    { kind: "entry" },
    {
      kind: "tool",
      blocks: [0],
      children: [
        { kind: "tool", blocks: [1] },
        { kind: "tool", blocks: [2] },
      ],
    },
  ])
  const parentUnit = units[1]!
  expect(transcriptUnitId(model, parentUnit)).toBe("tool:turn:agent")
  if (parentUnit.kind !== "tool") throw new Error("Expected tool unit")
  expect(parentUnit.children?.map((unit) => transcriptUnitId(model, unit))).toEqual([
    "tool:child:turn:oracle:read",
    "tool:child:turn:oracle:shell",
  ])
})

it("reconciles parallel subagents spawned by a child execution", () => {
  const orchestratorId = "child:execution%3Aturn:rika:execution%3Aturn:call-orchestrator"
  const nestedIds = ["one", "two", "three", "four"].map(
    (callId) => `child:${encodeURIComponent(orchestratorId)}:rika:${encodeURIComponent(orchestratorId)}:${callId}`,
  )
  const parent = Transcript.project("turn", "prompt", [
    event("orchestrator", 0, "tool.call.requested", {
      data: { tool_call_id: "call-orchestrator", tool_name: "task", input: { prompt: "Explore in parallel" } },
    }),
    event("orchestrator-spawned", 1, "child_run.spawned", {
      data: { child_execution_id: orchestratorId },
    }),
  ])
  const orchestrator = Transcript.project(
    orchestratorId,
    "",
    nestedIds.flatMap((childId, index) => [
      event(`task-${index}`, index * 2, "tool.call.requested", {
        data: {
          tool_call_id: ["one", "two", "three", "four"][index],
          tool_name: "task",
          input: { prompt: `Explore area ${index + 1}` },
        },
      }),
      event(`spawn-${index}`, index * 2 + 1, "child_run.spawned", {
        data: { child_execution_id: childId, profile: "task" },
      }),
    ]),
  )

  let model = ExecutionEvents.projectUnits(ViewState.initial("/work"), parent.units)
  model = ExecutionEvents.projectChildUnits(model, "turn:call-orchestrator", orchestrator.units)
  for (const [index, childId] of nestedIds.entries()) {
    const child = Transcript.project(childId, "", [
      event(`read-${index}`, 0, "tool.call.requested", {
        data: { tool_call_id: "read", tool_name: "read", input: { path: `src/${index}.ts` } },
      }),
      event(`answer-${index}`, 1, "model.output.completed", {
        text: `## Area ${index + 1}\n\n**Complete.**`,
      }),
    ])
    model = ExecutionEvents.projectChildUnits(
      model,
      `${orchestratorId}:${["one", "two", "three", "four"][index]}`,
      child.units,
    )
  }

  const orchestratorUnit = transcriptUnits(model)[1]
  if (orchestratorUnit?.kind !== "tool") throw new Error("Expected orchestrator tool")
  expect(orchestratorUnit.children).toHaveLength(4)
  expect(orchestratorUnit.children?.map((unit) => unit.children?.length)).toEqual([1, 1, 1, 1])
  const nestedToolIds = orchestratorUnit.children?.map(
    (unit) =>
      (unit.kind === "tool" ? model.blocks[unit.blocks[0]!] : undefined) as ViewState.TranscriptBlock | undefined,
  )
  const answerParentIds = (model.items as ReadonlyArray<ViewState.TranscriptItem>)
    .filter(
      (item) =>
        item._tag === "Entry" && (model.entries[item.index] as ViewState.Entry | undefined)?.role === "assistant",
    )
    .map((item) => item.parentId)
  expect(
    nestedToolIds?.map(
      (block) => answerParentIds.filter((parentId) => parentId === (block as { id?: string })?.id).length,
    ),
  ).toEqual([1, 1, 1, 1])
  expect(model.blocks.filter((block) => (block as ViewState.TranscriptBlock)._tag === "ChildAgent")).toHaveLength(0)
})

it("attaches each cross-scope child under its own turn's subagent when call ids collide", () => {
  const alpha = Transcript.project("alpha", "a", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Explore A" } },
    }),
    event("alpha-started", 1, "child_run.started", {
      data: { child_execution_id: "child:execution%3Aalpha:agent", profile: "task" },
    }),
  ])
  const beta = Transcript.project("beta", "b", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Explore B" } },
    }),
    event("beta-started", 1, "child_run.started", {
      data: { child_execution_id: "child:execution%3Abeta:agent", profile: "task" },
    }),
  ])
  const model = ExecutionEvents.projectUnits(ViewState.initial("/work"), [...alpha.units, ...beta.units])
  const tools = model.blocks.filter(
    (block): block is Extract<Transcript.Block, { _tag: "ToolCall" }> =>
      (block as ViewState.TranscriptBlock)._tag === "ToolCall",
  )

  expect(tools.find((tool) => tool.id === "alpha:agent")?.childId).toBe("child:execution%3Aalpha:agent")
  expect(tools.find((tool) => tool.id === "beta:agent")?.childId).toBe("child:execution%3Abeta:agent")
  expect(model.blocks.some((block) => (block as ViewState.TranscriptBlock)._tag === "ChildAgent")).toBe(false)
})

it("merges spawn and child lifecycle events into one named subagent with its prompt and tools", () => {
  const childId = "execution:child:turn:oracle"
  const parent = Transcript.project("turn", "prompt", [
    event("agent", 0, "tool.call.requested", {
      data: {
        tool_call_id: "agent",
        tool_name: "spawn_child_run",
        input: { profile: "oracle", prompt: "Find the projection defect" },
      },
    }),
    event("agent-spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: childId },
    }),
    event("agent-started", 2, "child_run.started", {
      data: { child_execution_id: childId, profile: "oracle" },
    }),
    event("agent-completed", 3, "child_run.completed", {
      data: { child_execution_id: childId, profile: "oracle" },
    }),
  ])
  const child = Transcript.project("child:turn:oracle", "", [
    event("read", 0, "tool.call.requested", {
      data: { tool_call_id: "read", tool_name: "read", input: { path: "src/projection.ts" } },
    }),
    event("answer", 1, "model.output.completed", { text: "## Projection fixed\n\n**All checks pass.**" }),
  ])

  let model = ExecutionEvents.projectUnits(ViewState.initial("/work"), parent.units)
  model = ExecutionEvents.projectChildUnits(model, "turn:agent", child.units)
  model = { ...model, expandedRowKeys: ["tool:turn:agent"] }

  const units = transcriptUnits(model)
  expect(units).toHaveLength(2)
  expect(model.blocks.filter((block) => (block as ViewState.TranscriptBlock)._tag === "ChildAgent")).toHaveLength(0)
  expect(model.blocks[0]).toMatchObject({
    _tag: "ToolCall",
    id: "turn:agent",
    detail: "Find the projection defect",
    childId,
    status: "complete",
    presentation: { activeLabel: "Oracle exploring", completeLabel: "Oracle has spoken" },
  })
  expect(units[1]).toMatchObject({
    kind: "tool",
    children: [{ kind: "tool" }],
    terminal: { kind: "answer", entry: 1 },
  })
  expect(model.entries[1]).toMatchObject({ role: "assistant", text: "## Projection fixed\n\n**All checks pass.**" })
  expect(model.items).toContainEqual(
    expect.objectContaining({
      _tag: "Entry",
      id: "assistant:child:turn:oracle:0",
      parentId: "turn:agent",
    }),
  )
})

it("renders a failed linked child as failed instead of finished", () => {
  const childId = "execution:child:turn:failed"
  const projection = Transcript.project("turn", "prompt", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Attempt the work" } },
    }),
    event("agent-spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: childId },
    }),
    event("agent-failed", 2, "child_run.failed", {
      data: { child_execution_id: childId, profile: "task", error: "Child model failed" },
    }),
    event("agent-result", 3, "tool.result.received", {
      data: {
        tool_call_id: "agent",
        output: { childExecutionId: childId, status: "failed", output: [] },
      },
    }),
  ])
  const model = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)
  const rendered = renderTranscriptStyled(model)
    .chunks.map((chunk) => chunk.text)
    .join("")

  expect(rendered).toContain("Subagent failed")
  expect(rendered).not.toContain("Subagent finished")
})

it("shows the durable execution failure on a nested subagent instead of a failed child tool", () => {
  const parent = Transcript.project("turn", "delegate", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Coordinate the work" } },
    }),
    event("spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: "child:turn:agent" },
    }),
  ])
  const child = Transcript.project("child:turn:agent", "", [
    event("nested", 0, "tool.call.requested", {
      data: { tool_call_id: "nested", tool_name: "task", input: { prompt: "Run the nested check" } },
    }),
    event("nested-result", 1, "tool.result.received", {
      data: { tool_call_id: "nested", error: "AgentToolError: unrelated wrapper failure" },
    }),
    event("failed", 2, "execution.failed", {
      data: { message: "Model route luna-low was not registered" },
    }),
  ])
  let live = ExecutionEvents.projectUnits(ViewState.initial("/work"), parent.units)
  live = ExecutionEvents.projectChildUnits(live, "turn:agent", child.units)
  const durable = ExecutionEvents.projectUnits(
    ViewState.initial("/work"),
    Transcript.withNestedProjections(parent, [{ parentId: "turn:agent", projection: child }]).units,
  )

  for (const projected of [live, durable]) {
    const model = { ...projected, expandedRowKeys: ["tool:turn:agent"] }
    const rendered = renderTranscriptStyled(model)
      .chunks.map((chunk) => chunk.text)
      .join("")
    expect(model.blocks[0]).toMatchObject({
      _tag: "ToolCall",
      id: "turn:agent",
      status: "failed",
      output: "Model route luna-low was not registered",
    })
    expect(model.blocks).toContainEqual(
      expect.objectContaining({ _tag: "Error", detail: "Model route luna-low was not registered" }),
    )
    expect(model.items).toContainEqual(
      expect.objectContaining({
        _tag: "Block",
        id: "execution:child:turn:agent:failed",
        parentId: "turn:agent",
      }),
    )
    expect(rendered).toContain("Subagent failed")
    expect(rendered).toContain("Model route luna-low was not registered")
    expect(rendered).not.toContain("AgentToolError: unrelated wrapper failure")
  }
})

it("keeps nested reasoning and non-assistant entries out of a subagent projection", () => {
  const parent = Transcript.project("turn", "delegate", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Coordinate the work" } },
    }),
    event("spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: "child:turn:agent" },
    }),
  ])
  const child = Transcript.project("child:turn:agent", "hidden prompt", [
    event("thinking", 0, "model.reasoning.delta", { text: "internal reasoning" }),
    event("nested", 1, "tool.call.requested", {
      data: { tool_call_id: "nested", tool_name: "read", input: { path: "src/a.ts" } },
    }),
  ])
  let model = ExecutionEvents.projectUnits(ViewState.initial("/work"), parent.units)
  model = ExecutionEvents.projectChildUnits(model, "turn:agent", child.units)

  expect(model.blocks.some((block) => (block as ViewState.TranscriptBlock)._tag === "Reasoning")).toBe(false)
  expect(model.items.some((item) => (item as ViewState.TranscriptItem).id === "turn:child:turn:agent:user")).toBe(false)
  expect(model.items).toContainEqual(
    expect.objectContaining({ _tag: "Block", id: "tool:child:turn:agent:nested", parentId: "turn:agent" }),
  )
})

it("normalizes a lone nested child agent into an agent tool with a stable row key", () => {
  const parent = Transcript.project("turn", "delegate", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Coordinate the work" } },
    }),
    event("spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: "child:turn:agent" },
    }),
  ])
  const child = Transcript.project("child:turn:agent", "", [
    event("gc-started", 0, "child_run.started", {
      data: { child_execution_id: "grandchild", profile: "oracle" },
    }),
  ])
  let model = ExecutionEvents.projectUnits(ViewState.initial("/work"), parent.units)
  model = ExecutionEvents.projectChildUnits(model, "turn:agent", child.units)
  model = { ...model, expandedRowKeys: ["tool:turn:agent"] }

  expect(model.blocks.some((block) => (block as ViewState.TranscriptBlock)._tag === "ChildAgent")).toBe(false)
  expect(
    model.blocks.find(
      (block) =>
        (block as ViewState.TranscriptBlock)._tag === "ToolCall" &&
        (block as { childId?: string }).childId === "grandchild",
    ),
  ).toMatchObject({
    _tag: "ToolCall",
    id: "grandchild",
    childId: "grandchild",
    status: "running",
    presentation: { family: "agent" },
  })
  const agent = transcriptUnits(model).find((unit) => unit.kind === "tool")
  if (agent?.kind !== "tool") throw new Error("Expected agent tool")
  expect(agent.children?.map((row) => transcriptUnitId(model, row))).toContain("tool:grandchild")
})

it("dedupes a nested child agent into an existing matching agent tool across batches", () => {
  const parent = Transcript.project("turn", "delegate", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Coordinate the work" } },
    }),
    event("spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: "child:turn:agent" },
    }),
  ])
  const firstBatch = Transcript.project("child:turn:agent", "", [
    event("gc", 0, "tool.call.requested", {
      data: { tool_call_id: "gc", tool_name: "task", input: { prompt: "Run the nested work" } },
    }),
    event("gc-spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "gc", child_execution_id: "grandchild" },
    }),
  ])
  const secondBatch = Transcript.project("child:turn:agent", "", [
    event("gc-done", 0, "child_run.completed", {
      data: { child_execution_id: "grandchild", profile: "task" },
    }),
  ])
  let model = ExecutionEvents.projectUnits(ViewState.initial("/work"), parent.units)
  model = ExecutionEvents.projectChildUnits(model, "turn:agent", firstBatch.units)
  const toolCount = model.blocks.filter((block) => (block as ViewState.TranscriptBlock)._tag === "ToolCall").length
  model = ExecutionEvents.projectChildUnits(model, "turn:agent", secondBatch.units)

  const grandchildTools = model.blocks.filter(
    (block) =>
      (block as ViewState.TranscriptBlock)._tag === "ToolCall" &&
      (block as { childId?: string }).childId === "grandchild",
  )
  expect(grandchildTools).toHaveLength(1)
  expect(grandchildTools[0]).toMatchObject({ id: "child:turn:agent:gc", status: "complete" })
  expect(model.blocks.some((block) => (block as ViewState.TranscriptBlock)._tag === "ChildAgent")).toBe(false)
  expect(model.blocks.filter((block) => (block as ViewState.TranscriptBlock)._tag === "ToolCall").length).toBe(
    toolCount,
  )
})

it("renders a completed child response from its parent result when child events are unavailable", () => {
  const childId = "execution:child:turn:complete"
  const projection = Transcript.project("turn", "prompt", [
    event("agent", 0, "tool.call.requested", {
      data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "Complete the work" } },
    }),
    event("agent-spawned", 1, "child_run.spawned", {
      data: { tool_call_id: "agent", child_execution_id: childId },
    }),
    event("agent-result", 2, "tool.result.received", {
      data: {
        tool_call_id: "agent",
        output: {
          childExecutionId: childId,
          status: "completed",
          output: [{ _tag: "text", text: "Child completed the boundary." }],
        },
      },
    }),
  ])
  const projected = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)
  const model = { ...projected, expandedRowKeys: ["tool:turn:agent"] }
  const rendered = renderTranscriptStyled(model)
    .chunks.map((chunk) => chunk.text)
    .join("")

  expect(rendered).toContain("Subagent finished")
  expect(rendered).toContain("Child completed the boundary.")
})

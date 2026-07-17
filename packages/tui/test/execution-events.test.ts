import * as Transcript from "@rika/transcript"
import { describe, expect, it } from "vitest"
import { ExecutionEvents, ViewState } from "../src"
import { transcriptUnitId, transcriptUnits } from "../src/transcript-units"

const event = (
  cursor: string,
  sequence: number,
  type: string,
  fields: Partial<Transcript.SourceEvent> = {},
): Transcript.SourceEvent => ({ cursor, sequence, type, createdAt: sequence, ...fields })

describe("ExecutionEvents.projectUnits", () => {
  it("updates one stable tool row as input and output arrive", () => {
    let projection = Transcript.empty("turn", "prompt")
    let model = ExecutionEvents.projectUnits(ViewState.initial("/work"), projection.units)
    projection = Transcript.applyEvent(
      projection,
      event("call", 0, "tool.call.requested", {
        data: { tool_call_id: "call", tool_name: "read_file", input: { path: "src/a.ts" } },
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
        data: { tool_call_id: "call", tool_name: "read_file", input: { path: "src/a.ts" } },
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
        data: { tool_call_id: "call", tool_name: "read_file", input: { path: "a.ts" } },
      }),
    ])
    const second = Transcript.project("turn-2", "second", [
      event("call", 0, "tool.call.requested", {
        data: { tool_call_id: "call", tool_name: "read_file", input: { path: "b.ts" } },
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
        data: { tool_call_id: "read", tool_name: "read_file", input: { path: "src/a.ts", offset: 3, limit: 4 } },
      }),
      event("read-result", 1, "tool.result.received", {
        data: { tool_call_id: "read", output: "contents" },
      }),
      event("shell", 2, "tool.call.requested", {
        data: { tool_call_id: "shell", tool_name: "shell", input: { command: "bun test" } },
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
})

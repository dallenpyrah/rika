import { describe, expect, it } from "@effect/vitest"
import {
  childParentMatch,
  empty,
  ensureChildTool,
  hasRunningBlocks,
  project,
  settleChild,
  settleRunning,
  type SourceEvent,
} from "../src"

describe("Transcript projection", () => {
  it("settles running tool and child blocks when the execution fails or is cancelled", () => {
    const base: ReadonlyArray<SourceEvent> = [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "call", tool_name: "task", input: { prompt: "work" } },
      },
      {
        cursor: "spawn",
        sequence: 2,
        type: "child_run.spawned",
        createdAt: 2,
        data: { child_execution_id: "orphan-child", preset_name: "task" },
      },
    ]
    const cancelled = project("turn-a", "prompt", [
      ...base,
      { cursor: "cancelled", sequence: 3, type: "execution.cancelled", createdAt: 3 },
    ])
    const failed = project("turn-a", "prompt", [
      ...base,
      { cursor: "failed", sequence: 3, type: "execution.failed", createdAt: 3, data: { message: "boom" } },
    ])

    expect(cancelled.units.find((item) => item.key === "tool:turn-a:call")).toMatchObject({
      revision: 3,
      content: { _tag: "Block", block: { _tag: "ToolCall", status: "cancelled" } },
    })
    expect(cancelled.units.find((item) => item.key === "child:turn-a:orphan-child")).toMatchObject({
      revision: 3,
      content: { _tag: "Block", block: { _tag: "ChildAgent", status: "cancelled" } },
    })
    expect(failed.units.find((item) => item.key === "tool:turn-a:call")).toMatchObject({
      content: { _tag: "Block", block: { _tag: "ToolCall", status: "failed" } },
    })
    expect(failed.units.find((item) => item.key === "child:turn-a:orphan-child")).toMatchObject({
      content: { _tag: "Block", block: { _tag: "ChildAgent", status: "failed" } },
    })
  })

  it("settles linked tools and standalone child agents through the settlement helpers", () => {
    const projection = project("turn-a", "prompt", [
      {
        cursor: "call",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "call", tool_name: "task", input: { prompt: "work" } },
      },
      {
        cursor: "spawn",
        sequence: 2,
        type: "child_run.spawned",
        createdAt: 2,
        data: { tool_call_id: "call", child_execution_id: "child-1", preset_name: "task" },
      },
      {
        cursor: "orphan",
        sequence: 3,
        type: "child_run.spawned",
        createdAt: 3,
        data: { child_execution_id: "orphan-child", preset_name: "task" },
      },
    ])
    const settledLinked = settleChild(projection, "child-1", "complete", 99)
    const settledOrphan = settleChild(settledLinked, "orphan-child", "cancelled", 99)
    const swept = settleRunning(projection, "cancelled", 50)

    expect(settledLinked.units.find((item) => item.key === "tool:turn-a:call")).toMatchObject({
      revision: 99,
      content: { _tag: "Block", block: { _tag: "ToolCall", status: "complete", childId: "child-1" } },
    })
    expect(settledOrphan.units.find((item) => item.key === "child:turn-a:orphan-child")).toMatchObject({
      revision: 99,
      content: { _tag: "Block", block: { _tag: "ChildAgent", status: "cancelled" } },
    })
    expect(hasRunningBlocks(projection)).toBe(true)
    expect(hasRunningBlocks(settledOrphan)).toBe(false)
    expect(hasRunningBlocks(swept)).toBe(false)
    expect(settleChild(settledOrphan, "child-1", "failed", 120)).toEqual(settledOrphan)
  })

  it("matches a child to its scoped parent tool and rejects a same-callId tool in another scope", () => {
    const foreign = { id: "other:spawn", scope: "other", childId: undefined, family: "agent" as const, mark: "foreign" }
    const correct = {
      id: "parent:spawn",
      scope: "parent",
      childId: undefined,
      family: "agent" as const,
      mark: "correct",
    }
    const childId = "execution:parent:child:spawn"

    expect(childParentMatch([foreign, correct], childId)?.mark).toBe("correct")
    expect(childParentMatch([foreign], childId)).toBeUndefined()
  })

  it("prefers an exact childId match over a scoped fallback candidate", () => {
    const fallback = {
      id: "parent:spawn",
      scope: "parent",
      childId: undefined,
      family: "agent" as const,
      mark: "fallback",
    }
    const exact = {
      id: "parent:other",
      scope: "parent",
      childId: "execution:parent:child:spawn",
      family: "agent" as const,
      mark: "exact",
    }

    expect(childParentMatch([fallback, exact], "execution:parent:child:spawn")?.mark).toBe("exact")
  })

  it("ignores a non-agent tool even when its scope and call id match the child key", () => {
    const nonAgent = { id: "parent:spawn", scope: "parent", childId: undefined, family: "shell" as const }

    expect(childParentMatch([nonAgent], "execution:parent:child:spawn")).toBeUndefined()
  })

  it("matches a scoped parent for the url-encoded child id encoding without a spawn correlation", () => {
    const parent = { id: "parent-turn:agent", scope: "parent-turn", childId: undefined, family: "agent" as const }

    expect(childParentMatch([parent], "child:execution%3Aparent-turn:agent")).toBe(parent)
  })

  it("resolves a nested fan-out child id to its correctly scoped orchestrator tool", () => {
    const orchestratorId = "child:execution%3Aturn:rika:execution%3Aturn:call-orchestrator"
    const nestedId = `child:${encodeURIComponent(orchestratorId)}:rika:${encodeURIComponent(orchestratorId)}:one`
    const nestedTool = {
      id: `${orchestratorId}:one`,
      scope: orchestratorId,
      childId: undefined,
      family: "agent" as const,
    }
    const foreign = {
      id: "other-turn:one",
      scope: "other-turn",
      childId: undefined,
      family: "agent" as const,
    }

    expect(childParentMatch([foreign, nestedTool], nestedId)).toBe(nestedTool)
  })

  it("rejects a same-callId tool in another scope for the url-encoded encoding", () => {
    const foreign = { id: "other-turn:agent", scope: "other-turn", childId: undefined, family: "agent" as const }

    expect(childParentMatch([foreign], "child:execution%3Aparent-turn:agent")).toBeUndefined()
  })

  it("ensures a scoped agent tool for a child and stays idempotent when it already exists", () => {
    const childId = "execution:parent:child:spawn"
    const created = ensureChildTool(empty("parent", "prompt"), childId, "oracle")

    expect(created.tool).toMatchObject({ _tag: "ToolCall", id: "parent:child:spawn", childId })
    expect(created.tool.presentation.family).toBe("agent")
    expect(created.projection.units.find((unit) => unit.key === "tool:parent:child:spawn")).toBeDefined()

    const again = ensureChildTool(created.projection, childId, "oracle")

    expect(again.projection).toBe(created.projection)
    expect(again.tool.id).toBe("parent:child:spawn")
    expect(
      again.projection.units.filter((unit) => unit.content._tag === "Block" && unit.content.block._tag === "ToolCall"),
    ).toHaveLength(1)
  })

  it("records one error unit with a failed outcome and a non-empty reason when the execution fails", () => {
    const projection = project("turn-a", "prompt", [
      { cursor: "failed", sequence: 1, type: "execution.failed", createdAt: 1, text: "internal tool failed" },
    ])
    const errors = projection.units.filter(
      (unit) => unit.content._tag === "Block" && unit.content.block._tag === "Error",
    )

    expect(errors).toHaveLength(1)
    const error = errors[0]!
    expect(
      error.content._tag === "Block" && error.content.block._tag === "Error" ? error.content.block.detail : "",
    ).toBe("internal tool failed")
    expect(error.executionOutcome).toMatchObject({ status: "failed", reason: "internal tool failed" })
  })

  const streamingToolBlock = (name: string, partialInput: string) => {
    const projection = project("turn-a", "prompt", [
      {
        cursor: "0",
        sequence: 0,
        type: "model.toolcall.delta",
        createdAt: 0,
        data: { tool_call_id: "call", tool_name: name, delta: partialInput },
      },
    ])
    const unit = projection.units.find((candidate) => candidate.key === "tool:turn-a:call")!
    if (unit.content._tag !== "Block" || unit.content.block._tag !== "ToolCall")
      throw new Error("expected a streaming ToolCall block")
    return unit.content.block
  }

  it("derives a shell command detail from streaming input before the JSON closes", () => {
    expect(streamingToolBlock("bash", "").detail).toBe("")
    expect(streamingToolBlock("bash", '{"command":').detail).toBe("")
    expect(streamingToolBlock("bash", '{"command":"mkdir -p src/tools').detail).toBe("mkdir -p src/tools")
    expect(streamingToolBlock("bash", '{"command":"echo one\\necho two').detail).toBe("echo one\necho two")
    const settled = streamingToolBlock("bash", '{"command":"echo done"}')
    expect(settled.detail).toBe("echo done")
    expect(settled.detail.includes('{"')).toBe(false)
  })

  it("never carries the raw input JSON blob into a streaming shell detail", () => {
    const raw = '{"command":"cat > a.ts <<EOF\\nimport x\\nEOF","timeout":30000}'
    for (let cut = 1; cut <= raw.length; cut += 1) {
      expect(streamingToolBlock("bash", raw.slice(0, cut)).detail.includes('{"')).toBe(false)
    }
  })

  it("derives an edit path and file preview from streaming input", () => {
    expect(streamingToolBlock("edit", '{"old_str":"a').files).toEqual([])
    const withPath = streamingToolBlock("edit", '{"path":"src/tools/edit.ts","old_str":"const x')
    expect(withPath.detail).toBe("src/tools/edit.ts")
    expect(withPath.files[0]?.path).toBe("src/tools/edit.ts")
    expect(withPath.files[0]?.kind).toBe("update")
  })

  it("derives a write path and create preview from streaming input", () => {
    const block = streamingToolBlock("write", '{"path":"src/app.ts","content":"export const a')
    expect(block.detail).toBe("src/app.ts")
    expect(block.files[0]?.path).toBe("src/app.ts")
    expect(block.files[0]?.kind).toBe("add")
  })
})

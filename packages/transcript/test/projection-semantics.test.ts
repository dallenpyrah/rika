import { describe, expect, it } from "@effect/vitest"
import { providers } from "@opencode-ai/models/snapshot"
import { applyEvent, empty, project, withNestedProjections, type SourceEvent } from "../src"

const usage = (cursor: string, sequence: number): SourceEvent => ({
  cursor,
  sequence,
  type: "model.usage.reported",
  createdAt: sequence,
  data: { cost_usd: 1.25 },
})

describe("Transcript projection", () => {
  it("applies duplicate and older source events idempotently", () => {
    const event: SourceEvent = {
      cursor: "cursor-1",
      sequence: 1,
      type: "model.output.delta",
      createdAt: 1,
      text: "answer",
    }
    const once = applyEvent(empty("turn-a", "prompt"), event)
    expect(applyEvent(once, event)).toEqual(once)
    expect(applyEvent(once, { ...event, cursor: "cursor-0", sequence: 0, text: "stale" })).toEqual(once)
  })

  it("projects every semantic block shape with stable keys across lifecycle revisions", () => {
    const projection = project("turn-a", "prompt", [
      { cursor: "reason", sequence: 0, type: "model.reasoning.delta", createdAt: 0, text: "thinking" },
      {
        cursor: "tool",
        sequence: 1,
        type: "tool.call.requested",
        createdAt: 1,
        data: { tool_call_id: "read", tool_name: "read", input: { path: "a.ts" } },
      },
      {
        cursor: "result",
        sequence: 2,
        type: "tool.result.received",
        createdAt: 2,
        data: { tool_call_id: "orphan", output: "orphan result" },
      },
      { cursor: "diff-1", sequence: 3, type: "workspace.diff", createdAt: 3, data: { path: "a.ts", patch: "-a\n+b" } },
      { cursor: "diff-2", sequence: 4, type: "workspace.diff", createdAt: 4, data: { path: "a.ts", patch: "-a\n+c" } },
      {
        cursor: "usage",
        sequence: 5,
        type: "model.usage.reported",
        createdAt: 5,
        data: { input_tokens: 10, output_tokens: 20, model: "test" },
      },
      {
        cursor: "compaction-1",
        sequence: 6,
        type: "context.compacted",
        createdAt: 6,
        data: { summary: "Earlier work", checkpoint: "checkpoint-1" },
      },
      {
        cursor: "compaction-2",
        sequence: 7,
        type: "context.compacted",
        createdAt: 7,
        data: { summary: "Updated work", checkpoint: "checkpoint-2" },
      },
      {
        cursor: "notice",
        sequence: 8,
        type: "notification.created",
        createdAt: 8,
        data: { title: "Ready", detail: "Review the result" },
      },
      {
        cursor: "permission-1",
        sequence: 9,
        type: "permission.ask.requested",
        createdAt: 9,
        data: { wait_id: "permission", title: "Allow read", input: { path: "a.ts" } },
      },
      {
        cursor: "permission-2",
        sequence: 10,
        type: "permission.ask.resolved",
        createdAt: 10,
        data: { wait_id: "permission", title: "Allow read", approved: false },
      },
      {
        cursor: "child-1",
        sequence: 11,
        type: "child_run.spawned",
        createdAt: 11,
        data: { child_execution_id: "child", preset_name: "task" },
      },
      {
        cursor: "child-2",
        sequence: 12,
        type: "child_run.completed",
        createdAt: 12,
        data: { child_execution_id: "child", preset_name: "task", summary: "done" },
      },
      {
        cursor: "workflow-1",
        sequence: 13,
        type: "workflow.waiting",
        createdAt: 13,
        data: { run_id: "delivery-1", workflow: "delivery", step: "approval" },
      },
      {
        cursor: "workflow-2",
        sequence: 14,
        type: "workflow.completed",
        createdAt: 14,
        data: { run_id: "delivery-1", workflow: "delivery", step: "done" },
      },
      {
        cursor: "image",
        sequence: 15,
        type: "image.attachment.created",
        createdAt: 15,
        data: { id: "image-1", name: "shot.png", media_type: "image/png", width: 80, height: 40, bytes: 120 },
      },
      { cursor: "error", sequence: 16, type: "budget.exceeded", createdAt: 16, data: { message: "Budget exhausted" } },
    ])

    expect(
      projection.units.flatMap((item) => (item.content._tag === "Block" ? [item.content.block._tag] : [])),
    ).toEqual([
      "Reasoning",
      "ToolCall",
      "ToolResult",
      "Diff",
      "Compaction",
      "Notification",
      "Permission",
      "ChildAgent",
      "Workflow",
      "ImageAttachment",
      "Error",
    ])
    expect(projection.units.filter((item) => item.key.includes("a.ts") && item.key.startsWith("diff:"))).toHaveLength(1)
    expect(projection.units.filter((item) => item.key.startsWith("workflow:")).map((item) => item.revision)).toEqual([
      14,
    ])
    expect(projection.units.find((item) => item.key === "compaction:turn-a")).toMatchObject({ revision: 7 })
    expect(projection.units.find((item) => item.key === "permission:turn-a:permission")).toMatchObject({
      content: { _tag: "Block", block: { status: "denied" } },
    })
    expect(projection.revision).toBe(16)
    expect(projection.oldestCursor).toBe("reason")
    expect(projection.checkpointCursor).toBe("error")
  })

  it("checkpoints every observable Relay event shape without replay duplication", () => {
    const events: ReadonlyArray<SourceEvent> = [
      { cursor: "accepted", sequence: 0, type: "execution.accepted", createdAt: 0 },
      { cursor: "started", sequence: 1, type: "execution.started", createdAt: 1 },
      { cursor: "input", sequence: 2, type: "model.input.prepared", createdAt: 2 },
      { cursor: "output", sequence: 3, type: "model.output.completed", createdAt: 3, text: "answer" },
      { cursor: "usage", sequence: 4, type: "model.usage.reported", createdAt: 4, data: { cost_usd: 0.25 } },
      {
        cursor: "call",
        sequence: 5,
        type: "tool.call.requested",
        createdAt: 5,
        data: { tool_call_id: "call", tool_name: "read", input: { path: "a.ts" } },
      },
      {
        cursor: "result",
        sequence: 6,
        type: "tool.result.received",
        createdAt: 6,
        data: { tool_call_id: "call", output: "ok" },
      },
      {
        cursor: "approval-requested",
        sequence: 7,
        type: "tool.approval.requested",
        createdAt: 7,
        data: { wait_id: "approval", tool_name: "bash" },
      },
      {
        cursor: "approval-resolved",
        sequence: 8,
        type: "tool.approval.resolved",
        createdAt: 8,
        data: { wait_id: "approval", tool_name: "bash", approved: true },
      },
      {
        cursor: "permission-requested",
        sequence: 9,
        type: "permission.ask.requested",
        createdAt: 9,
        data: { wait_id: "permission" },
      },
      {
        cursor: "permission-resolved",
        sequence: 10,
        type: "permission.ask.resolved",
        createdAt: 10,
        data: { wait_id: "permission", approved: true },
      },
      { cursor: "wait-created", sequence: 11, type: "wait.created", createdAt: 11, data: { wait_id: "wait" } },
      { cursor: "wait-woken", sequence: 12, type: "wait.woken", createdAt: 12, data: { wait_id: "wait" } },
      { cursor: "wait-timeout", sequence: 13, type: "wait.timed_out", createdAt: 13, data: { wait_id: "wait" } },
      { cursor: "wait-cancel", sequence: 14, type: "wait.cancelled", createdAt: 14, data: { wait_id: "wait" } },
      {
        cursor: "child",
        sequence: 15,
        type: "child_run.spawned",
        createdAt: 15,
        data: { child_execution_id: "child" },
      },
      { cursor: "fan-out", sequence: 16, type: "child_fan_out.created", createdAt: 16, data: { fan_out_id: "fan" } },
      {
        cursor: "member",
        sequence: 17,
        type: "child_fan_out.member.terminal",
        createdAt: 17,
        data: { member: { child_execution_id: "member", status: "failed", error: "member failed" } },
      },
      {
        cursor: "fan-terminal",
        sequence: 18,
        type: "child_fan_out.terminal",
        createdAt: 18,
        data: { fan_out_id: "fan" },
      },
      { cursor: "budget", sequence: 19, type: "budget.exceeded", createdAt: 19, data: { message: "budget" } },
      { cursor: "completed", sequence: 20, type: "execution.completed", createdAt: 20 },
      { cursor: "failed", sequence: 21, type: "execution.failed", createdAt: 21, text: "failed" },
      { cursor: "cancelled", sequence: 22, type: "execution.cancelled", createdAt: 22 },
    ]
    let projection = empty("turn-a", "prompt")
    for (const event of events) {
      projection = applyEvent(projection, event)
      expect(projection.revision).toBe(event.sequence)
      expect(projection.checkpointCursor).toBe(event.cursor)
      expect(applyEvent(projection, event)).toEqual(projection)
    }

    expect(projection.units.find((item) => item.key === "permission:turn-a:approval")).toMatchObject({
      content: { _tag: "Block", block: { status: "approved" } },
    })
    expect(projection.units.find((item) => item.key === "child:turn-a:member")).toMatchObject({
      content: { _tag: "Block", block: { status: "failed", summary: "member failed" } },
    })
    expect(
      projection.units.filter((item) => item.content._tag === "Block" && item.content.block._tag === "Error"),
    ).toHaveLength(2)
  })

  it("keeps nested keys, revisions, parents, and deterministic source order without mutating inputs", () => {
    const root = project("root", "prompt", [
      {
        cursor: "tool",
        sequence: 2,
        type: "tool.call.requested",
        createdAt: 2,
        data: { tool_call_id: "child", tool_name: "task", input: { prompt: "work" } },
      },
    ])
    const child = project("child", "", [
      { cursor: "answer", sequence: 7, type: "model.output.completed", createdAt: 7, text: "done" },
    ])
    const rootBefore = structuredClone(root)
    const childBefore = structuredClone(child)
    const first = withNestedProjections(root, [{ parentId: "root:child", projection: child }])
    const second = withNestedProjections(root, [{ parentId: "root:child", projection: child }])

    expect(first).toEqual(second)
    expect(root).toEqual(rootBefore)
    expect(child).toEqual(childBefore)
    expect(first.units.map(({ key, revision, parentId, order }) => ({ key, revision, parentId, order }))).toEqual([
      { key: "turn:root:user", revision: 0, parentId: undefined, order: { sequence: 0, part: 0 } },
      { key: "tool:root:child", revision: 2, parentId: undefined, order: { sequence: 1, part: 0 } },
      { key: "turn:child:user", revision: 0, parentId: "root:child", order: { sequence: 2, part: 0 } },
      { key: "assistant:child:0", revision: 7, parentId: "root:child", order: { sequence: 3, part: 0 } },
    ])
  })

  it("keeps a recovered root completion on the root execution instead of its failed nested child", () => {
    const root = empty("root", "delegate")
    const failedChild = project("child", "", [
      { cursor: "failed", sequence: 0, type: "execution.failed", createdAt: 1, text: "child failed" },
    ])
    const flattened = withNestedProjections(root, [{ parentId: "root:agent", projection: failedChild }])
    const completed = applyEvent(flattened, {
      cursor: "root-done",
      sequence: 1,
      type: "execution.completed",
      createdAt: 2,
    })
    const reloaded = withNestedProjections(completed, [{ parentId: "root:agent", projection: failedChild }])

    expect(reloaded.units.find((unit) => unit.key === "turn:root:user")?.executionOutcome).toEqual({
      status: "complete",
    })
    expect(
      reloaded.units.find((unit) => unit.turnId === "child" && unit.executionOutcome !== undefined)?.executionOutcome,
    ).toEqual({
      status: "failed",
      reason: "child failed",
    })
  })

  it("persists a hidden execution outcome when an execution has no root user unit", () => {
    const root = project("root", "prompt", [
      { cursor: "answer", sequence: 0, type: "model.output.completed", createdAt: 1, text: "answer" },
    ])
    const projection = applyEvent(
      { ...root, units: root.units.filter((unit) => unit.content._tag !== "Entry" || unit.content.role !== "user") },
      { cursor: "done", sequence: 1, type: "execution.completed", createdAt: 2 },
    )

    expect(projection.units).toContainEqual(
      expect.objectContaining({
        key: "execution:root:outcome",
        revision: 1,
        executionOutcome: { status: "complete" },
      }),
    )
  })

  it("counts usage cost when the revision was poisoned by higher foreign sequences", () => {
    const projection = project("turn-a", "prompt", [
      { cursor: "foreign", sequence: 4526, type: "model.output.delta", createdAt: 0, text: "child text" },
      {
        cursor: "usage-9",
        sequence: 9,
        type: "model.usage.reported",
        createdAt: 1,
        data: { cost_usd: 1.25 },
      },
      {
        cursor: "usage-30",
        sequence: 30,
        type: "model.usage.reported",
        createdAt: 2,
        data: { cost_usd: 1.25 },
      },
    ])

    expect(projection.revision).toBe(4526)
    expect(projection.checkpointCursor).toBe("foreign")
    expect(projection.costUsd).toBeCloseTo(2.5, 10)
    expect(projection.usageCursors).toEqual(["usage-9", "usage-30"])
  })

  it("uses models.dev context tiers at their published threshold", () => {
    const model = providers.openai!.models["gpt-5.6-sol"]!
    const tier = model.cost!.tiers![0]!
    const event = (cursor: string, inputTokens: number): SourceEvent => ({
      cursor,
      sequence: 1,
      type: "model.usage.reported",
      createdAt: 1,
      data: {
        provider: "openai",
        model: model.id,
        input_tokens: inputTokens,
        input_tokens_uncached: inputTokens,
        output_tokens: 0,
      },
    })

    expect(project("below", "", [event("below", tier.tier.size - 1)]).costUsd).toBeCloseTo(
      ((tier.tier.size - 1) * model.cost!.input) / 1_000_000,
      10,
    )
    expect(project("at", "", [event("at", tier.tier.size)]).costUsd).toBeCloseTo(
      (tier.tier.size * tier.input) / 1_000_000,
      10,
    )
    expect(project("at", "", [event("at", tier.tier.size)]).pricingVersion).toBeDefined()
  })

  it("counts duplicate and out-of-order usage events exactly once", () => {
    const first = applyEvent(empty("turn-a", "prompt"), usage("usage-5", 5))
    const duplicated = applyEvent(applyEvent(first, usage("usage-5", 5)), usage("usage-5", 2))
    const reordered = applyEvent(duplicated, usage("usage-2", 2))

    expect(duplicated.costUsd).toBeCloseTo(1.25, 10)
    expect(reordered.costUsd).toBeCloseTo(2.5, 10)
    expect(reordered.revision).toBe(5)
    expect(reordered.checkpointCursor).toBe("usage-5")
    expect(reordered.usageCursors).toEqual(["usage-5", "usage-2"])
  })
})

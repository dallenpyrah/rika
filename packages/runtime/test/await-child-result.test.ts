import { describe, expect, it } from "@effect/vitest"
import type { Execution } from "@relayfx/sdk"
import { resolveChildResult } from "../src/execution-backend"

type EventInput = Record<string, unknown>

const events = (values: ReadonlyArray<EventInput>): ReadonlyArray<Execution.ExecutionEvent> =>
  values.map((value, index) => ({ sequence: index, ...value }) as unknown as Execution.ExecutionEvent)

const delta = (partId: string, index: number, text: string): EventInput => ({
  type: "model.output.delta",
  data: { delta: text, delta_index: index, part_id: partId },
})

describe("resolveChildResult", () => {
  it("recovers streamed output and failure detail when a child fails after finishing its report", () => {
    const result = resolveChildResult(
      events([
        delta("part-a", 0, "Full "),
        delta("part-a", 1, "report"),
        { type: "model.usage.reported", data: { finish_reason: "stop" } },
        {
          type: "execution.failed",
          data: { message: "OpenAiClient.createResponse: HTTP 400 Stream must be set to true" },
        },
      ]),
    )
    expect(result.status).toBe("failed")
    expect(result.output).toEqual([
      { type: "text", text: "Full report" },
      {
        type: "text",
        text: "Subagent execution failed: OpenAiClient.createResponse: HTTP 400 Stream must be set to true",
      },
    ])
  })

  it("remaps a failed child with a post-tool completed response to completed", () => {
    const result = resolveChildResult(
      events([
        { type: "tool.call.requested" },
        { type: "tool.result.received" },
        { type: "model.output.completed", content: [{ type: "text", text: "final answer" }] },
        { type: "execution.failed", data: { message: "late failure" } },
      ]),
    )
    expect(result.status).toBe("completed")
    expect(result.output).toEqual([{ type: "text", text: "final answer" }])
  })

  it("keeps completed output untouched when model.output.completed exists", () => {
    const result = resolveChildResult(
      events([
        delta("part-a", 0, "ignored"),
        { type: "model.output.completed", content: [{ type: "text", text: "final" }] },
        { type: "execution.completed", content: [] },
      ]),
    )
    expect(result.status).toBe("completed")
    expect(result.output).toEqual([{ type: "text", text: "final" }])
  })

  it("prefers terminal content over recovered deltas", () => {
    const result = resolveChildResult(
      events([
        delta("part-a", 0, "draft"),
        { type: "execution.completed", content: [{ type: "text", text: "terminal" }] },
      ]),
    )
    expect(result.status).toBe("completed")
    expect(result.output).toEqual([{ type: "text", text: "terminal" }])
  })

  it("keeps terminal failure content without appending a synthetic message", () => {
    const result = resolveChildResult(
      events([
        delta("part-a", 0, "draft"),
        { type: "execution.failed", content: [{ type: "text", text: "boom" }], data: { message: "boom" } },
      ]),
    )
    expect(result.status).toBe("failed")
    expect(result.output).toEqual([{ type: "text", text: "boom" }])
  })

  it("reports cancellation with empty stream output", () => {
    const result = resolveChildResult(events([{ type: "execution.cancelled", data: {} }]))
    expect(result.status).toBe("cancelled")
    expect(result.output).toEqual([{ type: "text", text: "Subagent execution was cancelled" }])
  })

  it("orders recovered deltas by part and delta index", () => {
    const result = resolveChildResult(
      events([
        delta("part-b", 0, "second"),
        delta("part-a", 1, "one"),
        delta("part-a", 0, "part "),
        { type: "execution.failed", data: {} },
      ]),
    )
    expect(result.status).toBe("failed")
    expect(result.output[0]).toEqual({ type: "text", text: "second\n\npart one" })
    expect(result.output[1]).toEqual({ type: "text", text: "Subagent execution failed" })
  })
})

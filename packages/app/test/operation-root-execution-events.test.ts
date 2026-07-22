import { describe, expect, it } from "@effect/vitest"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Operation } from "../src/index"

const usageEventAt = (cursor: string, sequence: number): ExecutionBackend.Event => ({
  cursor,
  sequence,
  type: "model.usage.reported",
  createdAt: 1,
  data: { model: "test", input_tokens: 100, output_tokens: 10 },
})

describe("rootExecutionEvents", () => {
  it("keeps root execution events and drops child execution events", () => {
    const turnId = "turn-1"
    const events = [
      usageEventAt(`execution:${turnId}:model:9:usage`, 9),
      usageEventAt(`child:execution%3A${turnId}:call_a:model:4526:usage`, 4526),
      usageEventAt(`execution:${turnId}:model:30:usage`, 30),
      usageEventAt(`execution:title:${turnId}:model:8:usage`, 8),
      usageEventAt("synthetic-cursor", 40),
    ]
    const filtered = Operation.rootExecutionEvents(turnId, events)
    expect(filtered.map((value) => value.sequence)).toEqual([9, 30, 40])
  })

  it("keeps a poisoned child sequence out of the projected revision", () => {
    const turnId = "turn-2"
    const events = [
      usageEventAt(`child:execution%3A${turnId}:call_a:model:4526:usage`, 4526),
      usageEventAt(`execution:${turnId}:model:9:usage`, 9),
    ]
    expect(Operation.rootExecutionEvents(turnId, events).every((value) => value.sequence <= 9)).toBe(true)
  })
})

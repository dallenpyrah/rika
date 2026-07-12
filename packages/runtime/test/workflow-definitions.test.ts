import { describe, expect, it } from "vitest"
import { compile, definitions } from "../src/workflow-definitions"

describe("workflow definitions", () => {
  it("compiles pinned v2 product workflows with grounded children and joins", () => {
    expect(definitions.map((item) => [item.definition.version, item.definition.name])).toEqual([
      [2, "delivery"],
      [2, "research-synthesis"],
    ])
    const research = definitions[1]!.definition
    expect(research.operations.find((operation) => operation.kind === "parallel")).toMatchObject({
      fan_out_key: "research",
      max_concurrency: 2,
    })
    expect(research.operations.find((operation) => operation.kind === "join")).toMatchObject({
      policy: { _tag: "all" },
    })
  })

  it("compiles the complete typed extension surface without executable code", () => {
    const result = compile({
      schemaVersion: 1,
      name: "extension",
      entry: "sequence",
      operations: [
        { id: "sequence", kind: "sequence", operations: ["approval", "timer", "branch"] },
        { id: "approval", kind: "approval", prompt: "Continue?" },
        { id: "timer", kind: "timer", durationMs: 10 },
        { id: "branch", kind: "branch", condition: "approved", whenTrue: "retry", whenFalse: "cancel" },
        { id: "child", kind: "child", profile: "Task", prompt: "work" },
        { id: "tool", kind: "tool", toolName: "workspace.read", input: { path: "README.md" } },
        { id: "tool-empty", kind: "tool", toolName: "git.status" },
        { id: "retry", kind: "retry", operation: "child", maxAttempts: 3 },
        { id: "budget", kind: "budget", operation: "retry", limit: 100, unit: "operations" },
        { id: "cancel", kind: "cancellation", operation: "budget", onCancel: "undo" },
        { id: "cancel-plain", kind: "cancellation", operation: "budget" },
        { id: "undo", kind: "compensation", operation: "child", compensateWith: "timer" },
        { id: "parallel", kind: "parallel", fanOutKey: "extension", operations: ["child"], maxConcurrency: 1 },
        {
          id: "join",
          kind: "join",
          parallelOperation: "parallel",
          members: ["child"],
          policy: { _tag: "quorum", count: 1 },
        },
        { id: "completion", kind: "structured-completion", schemaRef: "schema:result", valueFrom: "tool" },
      ],
    })
    expect(result.definition.version).toBe(2)
    expect(result.definition.operations.map((operation) => operation.kind)).toEqual([
      "sequence",
      "approval",
      "timer",
      "branch",
      "child",
      "tool",
      "tool",
      "retry",
      "budget",
      "cancellation",
      "cancellation",
      "compensation",
      "parallel",
      "join",
      "structured-completion",
    ])
    expect(result.definition.operations.find((operation) => operation.kind === "tool")).toMatchObject({
      tool_name: "workspace.read",
      input: { path: "README.md" },
    })
    expect(result.definition.operations.find((operation) => operation.kind === "structured-completion")).toMatchObject({
      schema_ref: "schema:result",
      value_from: "tool",
    })
    expect(result.definition.operations.find((operation) => operation.id === "tool-empty")).toEqual({
      id: "tool-empty",
      kind: "tool",
      tool_name: "git.status",
    })
  })
})

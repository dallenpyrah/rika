import { describe, expect, test } from "bun:test"
import { McpApprovalStore } from "@rika/persistence"
import { McpClient } from "@rika/tools"
import { Effect, Layer, Schema } from "effect"
import { Mcp, Output } from "../src/index"

const server: McpClient.ServerSummary = {
  name: "filesystem",
  source: "workspace",
  kind: "command",
  status: "approval_required",
  fingerprint: "abc123",
}

const approval: McpApprovalStore.Approval = {
  id: "/repo:filesystem:abc123",
  workspace_root: "/repo",
  server_name: "filesystem",
  fingerprint: "abc123",
  approved_at: 1234,
}

const makeLayer = (output: Output.MemoryOutput) =>
  Mcp.layer.pipe(
    Layer.provideMerge(Output.memoryLayer(output)),
    Layer.provideMerge(
      Layer.succeed(
        McpClient.Service,
        McpClient.Service.of({
          servers: Effect.succeed([server]),
          approve: () => Effect.succeed(approval),
          toolDefinitions: Effect.succeed([]),
          callTool: () =>
            Effect.fail(new McpClient.McpClientError({ message: "not implemented", operation: "callTool" })),
        }),
      ),
    ),
  )

describe("CLI MCP commands", () => {
  test("prints configured MCP servers as JSON", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Mcp.executeCommand({ type: "mcp", action: "list" }).pipe(Effect.provide(makeLayer(output))),
    )

    expect(exitCode).toBe(0)
    expect(output.stderr).toEqual([])
    const servers = Schema.decodeUnknownSync(Schema.Array(McpClient.ServerSummary))(
      JSON.parse(output.stdout[0] ?? "[]"),
    )
    expect(servers).toEqual([server])
  })

  test("prints an approval record as JSON", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Mcp.executeCommand({ type: "mcp", action: "approve", server_name: "filesystem" }).pipe(
        Effect.provide(makeLayer(output)),
      ),
    )

    expect(exitCode).toBe(0)
    const parsed = Schema.decodeUnknownSync(McpApprovalStore.Approval)(JSON.parse(output.stdout[0] ?? "{}"))
    expect(parsed).toEqual(approval)
  })
})

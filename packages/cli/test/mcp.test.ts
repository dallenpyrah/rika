import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SkillRegistry } from "@rika/agent"
import { Config } from "@rika/core"
import { McpApprovalStore } from "@rika/persistence"
import { McpClient } from "@rika/tools"
import { Effect, Layer, Schema } from "effect"
import { Args, Mcp, Output } from "../src/index"

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
          settingsSources: Effect.succeed([]),
          servers: Effect.succeed([server]),
          serversForSources: () => Effect.succeed([server]),
          approve: () => Effect.succeed(approval),
          approveForSources: () => Effect.succeed(approval),
          doctor: Effect.succeed([]),
          doctorForSources: () => Effect.succeed([]),
          toolDefinitions: Effect.succeed([]),
          toolDefinitionsForSources: () => Effect.succeed([]),
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

  test("adds, lists, doctors, and removes a server without touching unrelated settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-cli-mcp-"))
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    const settingsPath = join(home, ".config", "rika", "settings.json")
    await mkdir(join(home, ".config", "rika"), { recursive: true })
    await mkdir(workspace, { recursive: true })
    await writeFile(settingsPath, `${JSON.stringify({ "mode.default": "deep2" }, null, 2)}\n`)
    const previousHome = process.env.HOME
    process.env.HOME = home

    try {
      const output: Output.MemoryOutput = { stdout: [], stderr: [] }
      const layer = commandLayer(output, workspace, home)
      const run = (command: Args.McpCommand) =>
        Effect.runPromise(Mcp.executeCommand(command).pipe(Effect.provide(layer)))

      expect(
        await run({
          type: "mcp",
          action: "add",
          server_name: "bogus",
          global: true,
          command: "definitely-rika-missing-mcp-command",
          args: ["--stdio"],
        }),
      ).toBe(0)
      expect(await run({ type: "mcp", action: "list" })).toBe(0)
      expect(await run({ type: "mcp", action: "doctor" })).toBe(0)
      expect(await run({ type: "mcp", action: "remove", server_name: "bogus", global: true })).toBe(0)

      const listed = Schema.decodeUnknownSync(Schema.Array(McpClient.ServerSummary))(
        JSON.parse(output.stdout[1] ?? "[]"),
      )
      const health = Schema.decodeUnknownSync(Schema.Array(McpClient.ServerHealth))(
        JSON.parse(output.stdout[2] ?? "[]"),
      )
      const settings = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
        JSON.parse(await readFile(settingsPath, "utf8")),
      )
      expect(listed).toMatchObject([{ name: "bogus", source: "user", kind: "command", status: "ready" }])
      expect(health).toMatchObject([{ name: "bogus", status: "unreachable" }])
      expect(settings).toEqual({ "mode.default": "deep2" })
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
    }
  })

  test("approves skill-bundled command MCP servers through the public command", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-cli-mcp-skill-"))
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    const skillDirectory = join(workspace, ".agents", "skills", "deploy")
    await mkdir(skillDirectory, { recursive: true })
    const skill: SkillRegistry.Skill = {
      summary: {
        name: "deploy",
        description: "Deploy code",
        source: "project",
        directory: skillDirectory,
        skill_file: join(skillDirectory, "SKILL.md"),
      },
      instructions: "Deploy instructions",
      resources: [],
      mcp_servers: { deployer: { command: "node", args: ["server.js"] } },
    }
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const layer = commandLayer(output, workspace, home, SkillRegistry.fakeLayer([skill]))
    const run = (command: Args.McpCommand) => Effect.runPromise(Mcp.executeCommand(command).pipe(Effect.provide(layer)))

    expect(await run({ type: "mcp", action: "list" })).toBe(0)
    expect(await run({ type: "mcp", action: "approve", server_name: "deployer" })).toBe(0)
    expect(await run({ type: "mcp", action: "list" })).toBe(0)

    const before = Schema.decodeUnknownSync(Schema.Array(McpClient.ServerSummary))(JSON.parse(output.stdout[0] ?? "[]"))
    const approvalRecord = Schema.decodeUnknownSync(McpApprovalStore.Approval)(JSON.parse(output.stdout[1] ?? "{}"))
    const after = Schema.decodeUnknownSync(Schema.Array(McpClient.ServerSummary))(JSON.parse(output.stdout[2] ?? "[]"))
    expect(before).toMatchObject([{ name: "deployer", source: "workspace", status: "approval_required" }])
    expect(approvalRecord.server_name).toBe("deployer")
    expect(after).toMatchObject([{ name: "deployer", source: "workspace", status: "ready" }])
  })
})

const commandLayer = (
  output: Output.MemoryOutput,
  workspace: string,
  home: string,
  skills: Layer.Layer<SkillRegistry.Service> = SkillRegistry.emptyLayer,
) => {
  const configLayer = Config.layerFromValues({
    workspace_root: workspace,
    data_dir: join(workspace, ".rika"),
    default_mode: "smart",
  })
  return Mcp.layerFromInput({ env: { HOME: home, RIKA_WORKSPACE_ROOT: workspace }, cwd: workspace, home }).pipe(
    Layer.provideMerge(Output.memoryLayer(output)),
    Layer.provideMerge(
      McpClient.layer.pipe(Layer.provideMerge(configLayer), Layer.provideMerge(McpApprovalStore.fakeLayer())),
    ),
    Layer.provideMerge(skills),
  )
}

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { run, sandbox, type Sandbox } from "./process"

let context: Sandbox

beforeAll(async () => {
  context = await sandbox()
})
afterAll(async () => context.dispose())

describe("packaged extension and operation contract", () => {
  test("skills can be added, inspected, listed, and removed", async () => {
    const source = join(context.root, "example-skill")
    await mkdir(source)
    await writeFile(join(source, "SKILL.md"), "---\nname: example-skill\ndescription: E2E skill\n---\n\n# Example\n")
    expect((await run(context, ["skills", "add", source])).exitCode).toBe(0)
    const listed = await run(context, ["skills", "list"])
    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain("example-skill")
    expect((await run(context, ["skills", "inspect", "example-skill"])).stdout).toContain("# Example")
    expect((await run(context, ["skills", "remove", "example-skill"])).exitCode).toBe(0)
  }, 20_000)

  test("MCP configuration lifecycle and doctor run from the artifact", async () => {
    expect((await run(context, ["mcp", "add", "fixture", "echo", "ready"])).exitCode).toBe(0)
    expect((await run(context, ["mcp", "list"])).stdout).toContain("fixture")
    expect((await run(context, ["mcp", "disable", "fixture"])).exitCode).toBe(0)
    expect((await run(context, ["mcp", "enable", "fixture"])).exitCode).toBe(0)
    expect((await run(context, ["mcp", "approve", "fixture", "--workspace", context.workspace])).exitCode).toBe(0)
    expect((await run(context, ["mcp", "doctor"])).exitCode).toBe(0)
    expect((await run(context, ["mcp", "remove", "fixture"])).exitCode).toBe(0)
  }, 20_000)

  test("MCP OAuth status and logout run from the artifact without exposing credentials", async () => {
    expect((await run(context, ["mcp", "add", "oauth-fixture", "--url", "https://example.test/mcp"])).exitCode).toBe(0)
    const status = await run(context, ["mcp", "oauth", "status", "oauth-fixture"])
    expect(status.exitCode).toBe(0)
    expect(status.stdout).toContain("unauthenticated")
    expect(status.stdout).not.toContain("access_token")
    expect((await run(context, ["mcp", "oauth", "logout", "oauth-fixture"])).exitCode).toBe(0)
  }, 20_000)

  test("plugin and extension generations persist across process reopen", async () => {
    for (const action of ["enable", "disable", "rollback"] as const) {
      expect((await run(context, ["extensions", action, "fixture"])).exitCode).toBe(0)
    }
    expect((await run(context, ["extensions", "list"])).stdout).toContain("fixture")
  }, 20_000)

  test("review, config, doctor, and typed failures have stable process behavior", async () => {
    expect((await run(context, ["review", "--help"])).exitCode).toBe(0)
    expect((await run(context, ["config", "list"])).exitCode).toBe(0)
    expect((await run(context, ["doctor"])).exitCode).toBe(0)
    for (const args of [
      ["threads", "show", "missing-thread"],
      ["skills", "inspect", "missing-skill"],
      ["mcp", "add", "invalid"],
      ["tools", "show", "missing-tool"],
    ]) {
      const result = await run(context, args)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).not.toBe("")
    }
  }, 20_000)
})

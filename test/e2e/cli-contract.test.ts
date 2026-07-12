import { exists } from "node:fs/promises"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { binary, run, sandbox, type Sandbox } from "./process"

let context: Sandbox

beforeAll(async () => {
  context = await sandbox()
})
afterAll(async () => context.dispose())

describe("packaged CLI contract", () => {
  test("help, version, and parser failures have stable exit behavior", async () => {
    const parsing = await sandbox()
    const help = await run(parsing, ["--help"])
    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain("Local durable coding agent")
    expect((await run(parsing, ["--version"])).stdout).toContain("0.0.0")
    for (const args of [["run", "--mode", "impossible"]]) {
      const result = await run(parsing, args)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.length + result.stdout.length).toBeGreaterThan(0)
    }
    expect(await exists(parsing.env.RIKA_DATABASE!)).toBe(false)
    expect(await exists(parsing.env.RIKA_RELAY_DATABASE!)).toBe(false)
    await parsing.dispose()
  }, 20_000)

  test("tools list and show expose the packaged catalog", async () => {
    const listed = await run(context, ["tools", "list"])
    expect(listed.exitCode).toBe(0)
    const tools = JSON.parse(listed.stdout)
    expect(tools.some((tool: { name: string }) => tool.name === "read_file")).toBe(true)
    const shown = await run(context, ["tools", "show", "read_file"])
    expect(shown.exitCode).toBe(0)
    expect(JSON.parse(shown.stdout).name).toBe("read_file")
    expect((await run(context, ["tools", "show", "missing-tool"])).exitCode).not.toBe(0)
  }, 20_000)

  test("config, keymap, and doctor never disclose configured secrets", async () => {
    context.env.PARALLEL_API_KEY = "e2e-super-secret"
    for (const args of [["config", "list"], ["config", "keymap"], ["doctor"]]) {
      const result = await run(context, args)
      expect(result.exitCode).toBe(0)
      expect(`${result.stdout}${result.stderr}`).not.toContain("e2e-super-secret")
    }
  }, 20_000)

  test("continue, fork, export, and usage work across real processes", async () => {
    const created = JSON.parse((await run(context, ["threads", "new"])).stdout)
    const continued = await run(context, ["threads", "continue", created.id])
    expect(continued.exitCode).toBe(0)
    const forked = JSON.parse((await run(context, ["threads", "fork", created.id])).stdout)
    expect(forked.id).not.toBe(created.id)
    const exported = await run(context, ["threads", "export", created.id, "--format", "json"])
    expect(exported.exitCode).toBe(0)
    expect(JSON.parse(exported.stdout).thread.id).toBe(created.id)
    const usage = await run(context, ["threads", "usage", created.id])
    expect(usage.exitCode).toBe(0)
    expect(JSON.parse(usage.stdout)).toBeDefined()
  }, 20_000)

  test("execute streams JSONL and rejects malformed JSON input", async () => {
    const streamed = await run(context, ["--execute", "--stream-json", "hello"])
    expect(streamed.exitCode).toBe(0)
    const events = streamed.stdout.split("\n").map((line) => JSON.parse(line))
    expect(events.some((event) => event.type === "execution.completed")).toBe(true)
    const malformed = await run(context, ["--execute", "--stream-json", "--stream-json-input"], { input: "not-json\n" })
    expect(malformed.exitCode).not.toBe(0)
  }, 20_000)

  test("SIGINT tears down an interactive terminal process", async () => {
    const child = Bun.spawn([binary], {
      cwd: context.workspace,
      env: { ...context.env, TERM: "xterm-256color" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    await Bun.sleep(300)
    child.kill("SIGINT")
    const exited = await Promise.race([child.exited, Bun.sleep(5_000).then(() => -1)])
    if (exited === -1) child.kill("SIGKILL")
    expect(exited).not.toBe(-1)
  })
})

import { afterAll, beforeAll, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { run, sandbox, type Sandbox } from "./process"

let context: Sandbox

beforeAll(async () => {
  context = await sandbox()
  Bun.spawnSync(["git", "init", "-q"], { cwd: context.workspace })
  Bun.spawnSync(["git", "config", "user.email", "rika@example.test"], { cwd: context.workspace })
  Bun.spawnSync(["git", "config", "user.name", "Rika Test"], { cwd: context.workspace })
  await writeFile(join(context.workspace, "review.txt"), "before\n")
  Bun.spawnSync(["git", "add", "review.txt"], { cwd: context.workspace })
  Bun.spawnSync(["git", "commit", "-qm", "base"], { cwd: context.workspace })
})

afterAll(async () => context.dispose())

test("packaged review runs durable lanes with stable text and JSON output", async () => {
  expect((await run(context, ["review"])).stdout).toBe("No changes to review.")
  await writeFile(join(context.workspace, "review.txt"), "after\n")
  const text = await run(context, ["review", "review.txt"], { timeout: 60_000 })
  expect(text.exitCode).toBe(0)
  expect(text.stdout).toContain("## correctness\ndeterministic response")
  expect(text.stdout).toContain("## security\ndeterministic response")
  expect(text.stdout).toContain("## quality\ndeterministic response")
  Bun.spawnSync(["git", "add", "review.txt"], { cwd: context.workspace })
  const json = await run(context, ["review", "--staged", "--json"], { timeout: 60_000 })
  expect(json.exitCode).toBe(0)
  expect(JSON.parse(json.stdout)).toMatchObject({
    status: "satisfied",
    lanes: [
      { id: "correctness", status: "completed", output: "deterministic response" },
      { id: "security", status: "completed", output: "deterministic response" },
      { id: "quality", status: "completed", output: "deterministic response" },
    ],
  })
}, 130_000)

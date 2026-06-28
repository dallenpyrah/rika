import { describe, expect, test } from "bun:test"
import { SkillRegistry } from "@rika/agent"
import { Effect, Layer, Schema } from "effect"
import { Output, Skills } from "../src/index"

const deploySkill: SkillRegistry.Skill = {
  summary: {
    name: "deploy",
    description: "Deploy safely",
    source: "project",
    directory: "/workspace/.agents/skills/deploy",
    skill_file: "/workspace/.agents/skills/deploy/SKILL.md",
  },
  instructions: "Deploy instructions",
  resources: [{ path: "/workspace/.agents/skills/deploy/scripts/deploy.ts", relative_path: "scripts/deploy.ts" }],
}

const makeLayer = (output: Output.MemoryOutput) =>
  Skills.layer.pipe(
    Layer.provideMerge(Output.memoryLayer(output)),
    Layer.provideMerge(SkillRegistry.fakeLayer([deploySkill])),
  )

describe("CLI skill commands", () => {
  test("prints installed skill summaries as JSON", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Skills.executeCommand({ type: "skills", action: "list" }).pipe(Effect.provide(makeLayer(output))),
    )

    expect(exitCode).toBe(0)
    expect(output.stderr).toEqual([])
    const summaries = Schema.decodeUnknownSync(Schema.Array(SkillRegistry.SkillSummary))(
      JSON.parse(output.stdout[0] ?? "[]"),
    )
    expect(summaries).toEqual([deploySkill.summary])
  })

  test("prints full selected skill metadata as JSON", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Skills.executeCommand({ type: "skills", action: "inspect", name: "deploy" }).pipe(
        Effect.provide(makeLayer(output)),
      ),
    )

    expect(exitCode).toBe(0)
    const skill = Schema.decodeUnknownSync(SkillRegistry.Skill)(JSON.parse(output.stdout[0] ?? "{}"))
    expect(skill).toEqual(deploySkill)
  })
})

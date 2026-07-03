import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { SkillRegistry } from "../src/index"

const tempRoot = () => mkdtemp(join(tmpdir(), "rika-skills-"))

describe("SkillRegistry", () => {
  test("discovers skills with deterministic project-over-user precedence", async () => {
    const root = await tempRoot()
    const project = join(root, "project-skills")
    const user = join(root, "user-skills")
    await writeSkill(project, "deploy", "deploy", "Project deploy", "Project instructions")
    await writeSkill(user, "deploy", "deploy", "User deploy", "User instructions")
    await writeSkill(user, "review", "review", "Review code", "Review instructions")

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const summaries = yield* SkillRegistry.list()
        const deploy = yield* SkillRegistry.inspect("deploy")
        return { summaries, deploy }
      }).pipe(
        Effect.provide(
          SkillRegistry.layerFromLocations([
            { source: "project", root: project },
            { source: "user", root: user },
          ]),
        ),
      ),
    )

    expect(result.summaries.map((skill) => `${skill.name}:${skill.source}:${skill.description}`)).toEqual([
      "deploy:project:Project deploy",
      "review:user:Review code",
    ])
    expect(result.deploy.instructions).toBe("Project instructions\n")
  })

  test("skips invalid frontmatter without hiding valid skills", async () => {
    const root = await tempRoot()
    const skills = join(root, "skills")
    await writeSkill(skills, "valid", "valid", "Valid skill", "Valid instructions")
    await mkdir(join(skills, "invalid"), { recursive: true })
    await writeFile(join(skills, "invalid", "SKILL.md"), "---\nname: invalid\n---\nMissing description\n")

    const summaries = await Effect.runPromise(
      SkillRegistry.list().pipe(
        Effect.provide(SkillRegistry.layerFromLocations([{ source: "project", root: skills }])),
      ),
    )

    expect(summaries.map((skill) => skill.name)).toEqual(["valid"])
  })

  test("returns bundled resource paths without loading their contents", async () => {
    const root = await tempRoot()
    const skills = join(root, "skills")
    await writeSkill(skills, "deploy", "deploy", "Deploy code", "Deploy instructions")
    await mkdir(join(skills, "deploy", "scripts"), { recursive: true })
    await writeFile(join(skills, "deploy", "scripts", "deploy.ts"), "console.log('deploy')\n")

    const skill = await Effect.runPromise(
      SkillRegistry.inspect("deploy").pipe(
        Effect.provide(SkillRegistry.layerFromLocations([{ source: "project", root: skills }])),
      ),
    )

    expect(skill.resources).toEqual([
      { path: join(skills, "deploy", "scripts", "deploy.ts"), relative_path: "scripts/deploy.ts" },
    ])
  })

  test("reads bundled mcp.json beside selected skill instructions", async () => {
    const root = await tempRoot()
    const skills = join(root, "skills")
    await writeSkill(skills, "deploy", "deploy", "Deploy code", "Deploy instructions")
    await writeFile(
      join(skills, "deploy", "mcp.json"),
      `${JSON.stringify({ deployer: { command: "node", args: ["server.js"] } }, null, 2)}\n`,
    )

    const skill = await Effect.runPromise(
      SkillRegistry.inspect("deploy").pipe(
        Effect.provide(SkillRegistry.layerFromLocations([{ source: "project", root: skills }])),
      ),
    )

    expect(skill.mcp_servers).toEqual({ deployer: { command: "node", args: ["server.js"] } })
  })

  test("selects full instructions only for explicitly requested skills", async () => {
    const root = await tempRoot()
    const skills = join(root, "skills")
    await writeSkill(skills, "deploy", "deploy", "Deploy code", "Deploy instructions")
    await writeSkill(skills, "review", "review", "Review code", "Review instructions")

    const selection = await Effect.runPromise(
      SkillRegistry.selectForPrompt({ content: "Use skill deploy for this release." }).pipe(
        Effect.provide(SkillRegistry.layerFromLocations([{ source: "project", root: skills }])),
      ),
    )

    expect(selection.available.map((skill) => skill.name)).toEqual(["deploy", "review"])
    expect(selection.selected.map((skill) => skill.summary.name)).toEqual(["deploy"])
    expect(selection.selected[0]?.instructions).toBe("Deploy instructions\n")
  })

  test("requires explicit skill names to match token boundaries", async () => {
    const root = await tempRoot()
    const skills = join(root, "skills")
    await writeSkill(skills, "deploy", "deploy", "Deploy code", "Deploy instructions")
    await writeSkill(skills, "deployment", "deployment", "Deployment workflow", "Deployment instructions")

    const layer = SkillRegistry.layerFromLocations([{ source: "project", root: skills }])
    const deployment = await Effect.runPromise(
      SkillRegistry.selectForPrompt({ content: "Use skill deployment for this release." }).pipe(Effect.provide(layer)),
    )
    const deploy = await Effect.runPromise(
      SkillRegistry.selectForPrompt({ content: "Use the deploy skill for this release." }).pipe(Effect.provide(layer)),
    )
    const deployer = await Effect.runPromise(
      SkillRegistry.selectForPrompt({ content: "Use skill deployer for this release." }).pipe(Effect.provide(layer)),
    )

    expect(deployment.selected.map((skill) => skill.summary.name)).toEqual(["deployment"])
    expect(deploy.selected.map((skill) => skill.summary.name)).toEqual(["deploy"])
    expect(deployer.selected.map((skill) => skill.summary.name)).toEqual([])
  })
})

const writeSkill = async (root: string, directory: string, name: string, description: string, body: string) => {
  const skillDirectory = join(root, directory)
  await mkdir(skillDirectory, { recursive: true })
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${description}`, "---", body, ""].join("\n"),
  )
}

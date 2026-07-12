import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, test } from "bun:test"
import { Effect, FileSystem } from "effect"
import { SkillRegistry } from "../src"

const document = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`

test("workspace skills override global skills and activation lazily loads contained resources", async () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-skills-" })
      const globalRoot = `${root}/global`
      const workspaceRoot = `${root}/workspace`
      yield* fileSystem.makeDirectory(`${globalRoot}/review`, { recursive: true })
      yield* fileSystem.makeDirectory(`${workspaceRoot}/review/references`, { recursive: true })
      yield* fileSystem.makeDirectory(`${globalRoot}/build`, { recursive: true })
      yield* fileSystem.writeFileString(`${globalRoot}/review/SKILL.md`, document("review", "global", "global body"))
      yield* fileSystem.writeFileString(
        `${workspaceRoot}/review/SKILL.md`,
        document("review", "workspace", "workspace body"),
      )
      yield* fileSystem.writeFileString(`${workspaceRoot}/review/references/checklist.md`, "check")
      yield* fileSystem.writeFileString(`${globalRoot}/build/SKILL.md`, document("build", "build things", "build body"))
      const registry = yield* SkillRegistry.discover({ globalRoot, workspaceRoot, descriptionCap: 20 })
      const selected = yield* registry.source.get("review")
      const activated = yield* registry.activate("review")
      return { registry, selected, activated }
    }).pipe(Effect.provide(SkillRegistry.fileSystemLayer)),
  )
  const first = await Effect.runPromise(program.pipe(Effect.provide(BunServices.layer)))
  const second = await Effect.runPromise(program.pipe(Effect.provide(BunServices.layer)))
  expect(first.registry.listings).toEqual(["- build: build things", "- review: workspace"])
  expect(first.selected?.frontmatter.description).toBe("workspace")
  expect(first.activated).toEqual({
    body: "workspace body",
    resources: [{ path: "references/checklist.md", content: "check" }],
  })
  expect(first.registry.digest).toHaveLength(64)
  expect(first.registry.digest).toBe(second.registry.digest)
})

test("returns a typed error for missing activation", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* SkillRegistry.discover({ globalRoot: "/global", workspaceRoot: "/workspace" })
      return yield* Effect.flip(registry.activate("missing"))
    }).pipe(Effect.provide(SkillRegistry.fileSystemTestLayer({}, {})), Effect.provide(BunServices.layer)),
  )
  expect(result._tag).toBe("@rika/extensions/SkillRegistryError")
})

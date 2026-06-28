import { describe, expect, test } from "bun:test"
import { Config, IdGenerator, Time } from "@rika/core"
import { ArtifactStore } from "@rika/persistence"
import { Common, Ids } from "@rika/schema"
import { Effect, Layer, Option } from "effect"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PluginHost, PluginUi, SelfExtension } from "../src/index"

const now = Common.TimestampMillis.make(1_234)
const threadId = Ids.ThreadId.make("thread_self_extension_test")

const tempRoot = () => mkdtemp(join(tmpdir(), "rika-self-extension-"))

const exists = async (path: string) => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const baseLayer = (
  workspaceRoot: string,
  verifier = SelfExtension.fakeVerifier({ status: "passed", exit_code: 0 }),
) => {
  const configLayer = Config.layerFromValues({
    workspace_root: workspaceRoot,
    data_dir: `${workspaceRoot}/.rika`,
    default_mode: "smart",
  })
  const supportLayer = Layer.mergeAll(
    configLayer,
    ArtifactStore.fakeLayer(),
    IdGenerator.sequenceLayer(1),
    Time.fixedLayer(now),
    PluginUi.silentLayer,
  )
  return Layer.mergeAll(
    supportLayer,
    SelfExtension.layerFromAdapters({ workspaceRoot, verifier }).pipe(Layer.provideMerge(supportLayer)),
    PluginHost.layer.pipe(Layer.provideMerge(configLayer), Layer.provideMerge(PluginUi.silentLayer)),
  )
}

describe("SelfExtension", () => {
  test("generates project-local skills and records an artifact with a diff", async () => {
    const root = await tempRoot()

    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const change = yield* SelfExtension.createSkill({
          name: "deploy-helper",
          description: "Help deploy safely",
          instructions: "Run the deployment checklist.",
          thread_id: threadId,
        })
        const stored = yield* ArtifactStore.get(change.artifact_id)
        return { change, stored }
      }).pipe(Effect.provide(baseLayer(root))),
    )

    const skill = await readFile(join(root, ".agents", "skills", "deploy-helper", "SKILL.md"), "utf8")
    expect(skill).toContain("name: deploy-helper")
    expect(skill).toContain("Run the deployment checklist.")
    expect(output.change).toMatchObject({ kind: "skill", action: "create-skill", enabled: true })
    expect(output.change.files).toEqual([
      {
        path: ".agents/skills/deploy-helper/SKILL.md",
        before: null,
        after: skill,
      },
    ])
    expect(Option.getOrUndefined(output.stored)).toMatchObject({
      id: output.change.artifact_id,
      thread_id: threadId,
      kind: "other",
      metadata: { kind: "self-extension", action: "create-skill", enabled: true },
    })
  })

  test("writes generated plugins disabled until verification passes and then loads them", async () => {
    const root = await tempRoot()

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const before = yield* PluginHost.Service.pipe(Effect.flatMap((host) => host.report))
        const created = yield* SelfExtension.createPlugin({
          name: "hello-world",
          description: "Say hello from a generated plugin",
          thread_id: threadId,
        })
        const disabledAfterCreate = yield* Effect.promise(() =>
          exists(join(root, ".rika", "plugins", "hello-world.ts.disabled")),
        )
        const stillDisabled = yield* PluginHost.Service.pipe(Effect.flatMap((host) => host.reload))
        const enabled = yield* SelfExtension.enablePlugin({
          name: "hello-world",
          verification_command: "bun test --pass-with-no-tests",
          thread_id: threadId,
        })
        const loaded = yield* PluginHost.Service.pipe(Effect.flatMap((host) => host.reload))
        const commands = yield* PluginHost.commands()
        return { before, created, disabledAfterCreate, stillDisabled, enabled, loaded, commands }
      }).pipe(Effect.provide(baseLayer(root))),
    )

    expect(result.before.loaded).toEqual([])
    expect(result.created).toMatchObject({ action: "create-plugin", enabled: false })
    expect(result.stillDisabled.loaded).toEqual([])
    expect(result.stillDisabled.errors).toEqual([])
    expect(result.disabledAfterCreate).toBe(true)

    expect(result.enabled).toMatchObject({ action: "enable-plugin", enabled: true })
    expect(result.enabled.trust.verification).toMatchObject({
      status: "passed",
      command: "bun test --pass-with-no-tests",
    })
    expect(await exists(join(root, ".rika", "plugins", "hello-world.ts"))).toBe(true)
    expect(await exists(join(root, ".rika", "plugins", "hello-world.ts.disabled"))).toBe(false)
    expect(result.loaded.loaded.map((plugin) => plugin.name)).toEqual(["hello-world"])
    expect(result.commands.map((command) => command.name)).toEqual(["hello-world.hello"])
  })

  test("failed verification records the decision and keeps a plugin bypassed", async () => {
    const root = await tempRoot()
    const verifier = SelfExtension.fakeVerifier({ status: "failed", exit_code: 1, stderr: "tests failed" })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* SelfExtension.createPlugin({ name: "bad-plugin", description: "Broken plugin", thread_id: threadId })
        const enabled = yield* SelfExtension.enablePlugin({
          name: "bad-plugin",
          verification_command: "bun test",
          thread_id: threadId,
        })
        const report = yield* PluginHost.Service.pipe(Effect.flatMap((host) => host.reload))
        const stored = yield* ArtifactStore.get(enabled.artifact_id)
        return { enabled, report, stored }
      }).pipe(Effect.provide(baseLayer(root, verifier))),
    )

    expect(result.enabled).toMatchObject({ action: "enable-plugin", enabled: false })
    expect(result.enabled.trust.verification).toMatchObject({ status: "failed", command: "bun test" })
    expect(await exists(join(root, ".rika", "plugins", "bad-plugin.ts"))).toBe(false)
    expect(await exists(join(root, ".rika", "plugins", "bad-plugin.ts.disabled"))).toBe(true)
    expect(result.report).toMatchObject({ loaded: [], errors: [] })
    expect(Option.getOrUndefined(result.stored)).toMatchObject({
      metadata: { kind: "self-extension", action: "enable-plugin", enabled: false },
    })
  })

  test("rollback disables an enabled plugin without deleting the generated source", async () => {
    const root = await tempRoot()

    const rolledBack = await Effect.runPromise(
      Effect.gen(function* () {
        yield* SelfExtension.createPlugin({ name: "toggle-me", description: "Toggle plugin" })
        yield* SelfExtension.enablePlugin({ name: "toggle-me", verification_command: "bun test" })
        return yield* SelfExtension.rollbackPlugin({ name: "toggle-me", reason: "startup failed" })
      }).pipe(Effect.provide(baseLayer(root))),
    )

    expect(rolledBack).toMatchObject({ action: "rollback-plugin", enabled: false })
    expect(rolledBack.trust.reason).toBe("startup failed")
    expect(await exists(join(root, ".rika", "plugins", "toggle-me.ts"))).toBe(false)
    expect(await exists(join(root, ".rika", "plugins", "toggle-me.ts.disabled"))).toBe(true)
  })
})

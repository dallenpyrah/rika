import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Settings } from "../src/index"

describe("Settings", () => {
  test("resolves env over workspace settings over user settings over defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-settings-"))
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    await mkdir(join(home, ".config", "rika"), { recursive: true })
    await mkdir(join(workspace, ".rika"), { recursive: true })
    await writeFile(
      join(home, ".config", "rika", "settings.json"),
      JSON.stringify({
        "orb.template": "user-template",
        "orb.idleTimeoutSeconds": 111,
        "project.default": "user-project",
      }),
    )
    await writeFile(
      join(workspace, ".rika", "settings.json"),
      JSON.stringify({
        "orb.template": "workspace-template",
        "project.default": "workspace-project",
      }),
    )

    try {
      const snapshot = await Effect.runPromise(
        Settings.snapshot.pipe(
          Effect.provide(
            Settings.layerFromEnv(
              {
                HOME: home,
                RIKA_ORB_TEMPLATE: "env-template",
                RIKA_ORB_IDLE_TIMEOUT: "42",
              },
              workspace,
            ),
          ),
        ),
      )

      expect(snapshot.values).toEqual({
        orb: {
          template: "env-template",
          idleTimeoutSeconds: 42,
        },
        project: {
          default: "workspace-project",
        },
      })
      expect(snapshot.sources).toEqual({
        "orb.template": "env",
        "orb.idleTimeoutSeconds": "env",
        "project.default": "workspace",
      })
      expect(snapshot.warnings).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("warns on malformed JSON and falls back without crashing", async () => {
    const root = await mkdtemp(join(tmpdir(), "rika-settings-malformed-"))
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    await mkdir(join(home, ".config", "rika"), { recursive: true })
    await mkdir(workspace, { recursive: true })
    const userSettings = join(home, ".config", "rika", "settings.json")
    await writeFile(userSettings, "{")

    try {
      const snapshot = await Effect.runPromise(
        Settings.snapshot.pipe(Effect.provide(Settings.layerFromEnv({ HOME: home }, workspace))),
      )

      expect(snapshot.values).toEqual({
        orb: {
          template: "rika-orb",
          idleTimeoutSeconds: 300,
        },
        project: {},
      })
      expect(snapshot.sources).toEqual({
        "orb.template": "default",
        "orb.idleTimeoutSeconds": "default",
      })
      expect(snapshot.warnings).toHaveLength(1)
      expect(snapshot.warnings[0]).toMatchObject({
        path: userSettings,
        source: "user",
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

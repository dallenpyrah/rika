import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  childRunSpawnPermission,
  names,
  outputSchemas,
  presets,
  resolve,
  resolvePainter,
  subagentHandoffTargets,
} from "../src/agent-profiles"

const model = { provider: "test", model: "deterministic" }
const relayModel = (selection: {
  readonly provider: string
  readonly model: string
  readonly registrationKey?: string
}) => ({
  provider: selection.provider,
  model: selection.model,
  ...(selection.registrationKey === undefined ? {} : { registration_key: selection.registrationKey }),
})

describe("product agent profiles", () => {
  it("resolves the exact narrowed tools and permissions for each shipping specialist", () => {
    const registered = presets(model)
    expect(Object.keys(registered)).toEqual(names)
    for (const name of names) {
      const profile = resolve(name, model)
      expect(profile.agent.name).toBe(`rika-${name.toLowerCase()}`)
      expect(registered[name]?.model).toEqual(relayModel(model))
      expect(registered[name]?.tool_names).toEqual(Object.keys(profile.agent.toolkit.tools))
      expect(registered[name]?.permissions.length).toBeGreaterThan(0)
      expect(registered[name]?.output_schema_ref).toMatch(/^rika\.agent\./)
    }
    expect(registered.Oracle).toMatchObject({
      tool_names: ["find_files", "grep", "read_file", "task", "oracle", "librarian", "review"],
      permissions: ["workspace.read"],
    })
    expect(registered.Librarian).toMatchObject({
      tool_names: ["web_search", "read_web_page", "task", "oracle", "librarian", "review"],
      permissions: ["network.read"],
    })
    expect(registered.Review).toMatchObject({
      tool_names: ["grep", "read_file", "git_status"],
      permissions: ["workspace.read"],
    })
    expect(registered.Task).toMatchObject({
      tool_names: [
        "find_files",
        "grep",
        "read_file",
        "create_file",
        "edit_file",
        "shell",
        "shell_command_status",
        "task",
        "oracle",
        "librarian",
        "review",
      ],
      permissions: ["workspace.read", "workspace.write", "process.run"],
    })
  })

  it("supports data-first and data-last preset model overrides", () => {
    const oracleModel = { provider: "oracle", model: "reasoning" }
    const taskModel = { provider: "task", model: "coding" }
    const agentModels = { Task: taskModel }

    for (const registered of [presets(model, oracleModel, agentModels), presets(oracleModel, agentModels)(model)]) {
      expect(Object.keys(registered)).toEqual(names)
      expect(registered.Oracle?.model).toEqual(relayModel(oracleModel))
      expect(registered.Task?.model).toEqual(relayModel(taskModel))
      expect(registered.Review?.model).toEqual(relayModel(model))
    }

    expect(presets(model, oracleModel).Oracle?.model).toEqual(relayModel(oracleModel))
    expect(presets()(model).Oracle?.model).toEqual(relayModel(model))
  })

  it.effect("accepts and rejects every shipping specialist structured output contract", () =>
    Effect.gen(function* () {
      const contracts = [
        [outputSchemas.Task, { summary: "done", files: ["a.ts"] }, { summary: "done", files: "a.ts" }],
        [outputSchemas.Oracle, { answer: "A", evidence: ["file:1"] }, { answer: "A", evidence: "file:1" }],
        [
          outputSchemas.Librarian,
          { answer: "A", sources: ["https://example.test"] },
          { answer: "A", sources: "https://example.test" },
        ],
        [outputSchemas.Review, { summary: "ok", findings: [] }, { summary: "ok", findings: "invalid" }],
      ] as const
      for (const [schema, valid, invalid] of contracts) {
        expect(yield* Schema.decodeUnknownEffect(schema)(valid)).toEqual(valid)
        expect(String(yield* Effect.flip(Schema.decodeUnknownEffect(schema)(invalid)))).toMatch(
          /files|evidence|sources|findings/,
        )
      }
    }),
  )

  it("maps subagent handoff targets to registered presets and excludes the media-gated Painter", () => {
    const registered = presets(model)
    for (const target of subagentHandoffTargets) {
      expect(names).toContain(target.preset_name)
      expect(registered[target.preset_name]).toBeDefined()
    }
    expect(subagentHandoffTargets.map((target) => target.preset_name)).not.toContain("Painter")
    expect(subagentHandoffTargets.map((target) => target.name)).toEqual([
      "oracle",
      "librarian",
      "review",
      "read_thread",
      "task",
    ])
    expect(childRunSpawnPermission).toEqual({ name: "relay.child_run.spawn", value: true })
    expect(registered.ReadThread?.tool_names).toEqual([
      "find_thread",
      "read_thread",
      "task",
      "oracle",
      "librarian",
      "review",
    ])
    expect(registered.ReadThread?.permissions).toEqual(["thread.read"])
  })

  it.effect("uses the configured route for Painter and returns a typed unavailable error", () =>
    Effect.gen(function* () {
      const painter = yield* resolvePainter(model, true)
      expect(painter.preset.model).toEqual(relayModel(model))
      expect(painter.preset.tool_names).toEqual(["view_media", "task", "oracle", "librarian", "review"])
      const unavailable = yield* Effect.flip(resolvePainter(model, false))
      expect(unavailable._tag).toBe("PainterUnavailableError")
      expect(unavailable).toMatchObject(model)
    }),
  )
})

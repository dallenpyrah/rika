import { describe, expect, it } from "@effect/vitest"
import { TurnPolicy } from "@batonfx/core"
import { Effect } from "effect"
import {
  childRunSpawnPermission,
  mainInstructions,
  names,
  presets,
  resolve,
  resolvePainter,
  subagentHandoffTargets,
} from "../src/agent-profiles"

const model = { provider: "test", model: "deterministic" }
const threadRecoveryTools = ["search_threads", "read_thread_transcript"]
const expectedInstructions = {
  Oracle:
    "Act as a read-only, high-reasoning advisor for high-level planning, architecture tradeoffs, difficult debugging analysis, and critical review of focused evidence. Do not perform primary workspace or codebase exploration; use focused inspection only to assess supplied evidence. Ground your advice in workspace evidence, explain your reasoning and recommendations, and do not modify files.",
  Librarian:
    "Research current external sources and return concise, cited findings without modifying files. Start with a self-contained objective and one to three focused queries. Use auto for a normal lookup. Use compare only for disputed, recent, safety-sensitive, or high-impact claims where independent perspectives improve confidence; do not query every source by default. Choose the search kind deliberately. Use web for general research, Exa through kind code for semantic implementation examples, and kind github with githubSearchType for exact code, repositories, issues and pull requests, or commit history. Prefer primary and authoritative sources. Search excerpts are leads, not final proof: use read_web_page when the source text, version, date, qualification, or surrounding context matters. Cross-check important claims, distinguish sourced facts from your conclusions, cite the URLs that support each material finding, and call out disagreement or uncertainty explicitly. Stop when the evidence is sufficient for the request.",
  Painter:
    "Produce a requested visual artifact through the available media route and report its metadata. Do not modify source files.",
  Review: "Review workspace changes for correctness, regressions, and missing tests. Do not modify files.",
  ReadThread: "Answer only from local thread transcripts and identify the threads used.",
  Task: "Complete the assigned workspace investigation, reproduction, verification, or implementation task and report findings, changed files, and verification. Modify files only when the delegated task requests it.",
} as const
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
  it("loads normalized instructions for every shipping profile", () => {
    expect(Object.keys(expectedInstructions)).toEqual(names)
    expect(mainInstructions).toContain("Route delegation by purpose")
    expect(mainInstructions).toContain("Call the read_thread subagent selectively")
    for (const name of names) {
      const profile = resolve(name, model)
      expect(profile.preset.instructions.length).toBeGreaterThan(0)
      expect(profile.preset.instructions).toContain(
        name === "ReadThread" ? "checking later turns" : "read_thread subagent selectively",
      )
      expect(profile.agent.instructions).toBe(profile.preset.instructions)
    }
  })

  it("resolves the exact narrowed tools and permissions for each shipping specialist", () => {
    const registered = presets({ model })
    expect(Object.keys(registered)).toEqual(names)
    for (const name of names) {
      const profile = resolve(name, model)
      expect(profile.agent.name).toBe(`rika-${name.toLowerCase()}`)
      expect(profile.agent.policy).toBe(TurnPolicy.forever)
      expect(registered[name]?.model).toEqual(relayModel(model))
      expect(registered[name]?.tool_names).toEqual(Object.keys(profile.agent.toolkit.tools))
      expect(registered[name]?.permissions.length).toBeGreaterThan(0)
      expect(registered[name]).not.toHaveProperty("output_schema_ref")
    }
    expect(registered.Oracle).toMatchObject({
      tool_names: ["grep", "read", "web_search", "read_thread", ...threadRecoveryTools],
      permissions: ["workspace.read", "network.read", "thread.read"],
    })
    expect(registered.Oracle?.instructions).toContain(
      "high-level planning, architecture tradeoffs, difficult debugging analysis",
    )
    expect(registered.Oracle?.instructions).toContain("Do not perform primary workspace or codebase exploration")
    expect(registered.Oracle?.instructions).toContain("do not modify files")
    expect(mainInstructions).toContain(
      "Use Task for workspace investigation, codebase exploration, reproductions, and implementation",
    )
    expect(mainInstructions).toContain(
      "delegate independent investigations in parallel only when they are genuinely independent",
    )
    expect(mainInstructions).toContain("Use Oracle only as a read-only, high-reasoning advisor")
    expect(mainInstructions).toContain("after it has been gathered")
    expect(mainInstructions).toContain("do not use Oracle to search or explore the codebase")
    expect(mainInstructions).not.toContain("Consult Oracle frequently")
    expect(mainInstructions).toContain("Use Review for a focused assessment")
    expect(mainInstructions).toContain("tell the user that you are consulting it")
    expect(mainInstructions).toContain("after consulting Oracle, state that you did")
    expect(mainInstructions).toContain("remaining responsible for the implementation and conclusion")
    expect(mainInstructions).toContain("Use auto for normal lookups")
    expect(mainInstructions).toContain("kind code for semantic implementation examples")
    expect(mainInstructions).toContain("kind github for exact code")
    expect(mainInstructions).not.toContain("provider IDs")
    expect(mainInstructions).toContain("fetch authoritative pages")
    expect(mainInstructions).toContain("Delegate broad or multi-source external research to Librarian")
    expect(mainInstructions).not.toContain("Use subagents for independent work")
    expect(mainInstructions).not.toContain("parallel delegation")
    expect(mainInstructions).not.toContain("same tool-call batch")
    expect(registered.Librarian).toMatchObject({
      tool_names: [
        "web_search",
        "read_web_page",
        "task",
        "oracle",
        "librarian",
        "review",
        "read_thread",
        ...threadRecoveryTools,
      ],
      permissions: ["network.read", "thread.read"],
    })
    expect(registered.Librarian?.instructions).toContain("one to three focused queries")
    expect(registered.Librarian?.instructions).toContain("Use compare only")
    expect(registered.Librarian?.instructions).not.toContain("provider IDs")
    expect(registered.Librarian?.instructions).toContain("Search excerpts are leads, not final proof")
    expect(registered.Librarian?.instructions).toContain("distinguish sourced facts from your conclusions")
    expect(registered.Librarian?.instructions).toContain("Stop when the evidence is sufficient")
    expect(registered.Review).toMatchObject({
      tool_names: ["grep", "read", "web_search", "read_thread", ...threadRecoveryTools],
      permissions: ["workspace.read", "network.read", "thread.read"],
    })
    expect(registered.Oracle?.tool_names).not.toContain("task")
    expect(registered.Task?.instructions).toContain(
      "workspace investigation, reproduction, verification, or implementation",
    )
    expect(registered.Task?.instructions).toContain("Modify files only when the delegated task requests it")
    expect(registered.Task).toMatchObject({
      tool_names: [
        "grep",
        "read",
        "write",
        "edit",
        "bash",
        "shell_command_status",
        "web_search",
        "task",
        "oracle",
        "librarian",
        "review",
        "read_thread",
        ...threadRecoveryTools,
      ],
      permissions: ["workspace.read", "workspace.write", "process.run", "network.read", "thread.read"],
    })
    expect(registered.Task?.instructions).not.toContain("Use subagents for independent work")
    expect(registered.Task?.instructions).not.toContain("parallel delegation")
    expect(registered.Task?.instructions).not.toContain("same tool-call batch")
  })

  it("grants thread read permission to every profile that can recover thread context", () => {
    const registered = presets({ model })
    for (const profile of Object.values(registered)) {
      if (
        profile.tool_names.some(
          (tool) => tool === "read_thread" || tool === "search_threads" || tool === "read_thread_transcript",
        )
      )
        expect(profile.permissions).toContain("thread.read")
    }
  })

  it("routes Task to main and every specialist to oracle", () => {
    const oracleModel = { provider: "oracle", model: "reasoning" }

    for (const registered of [presets({ model, oracleModel })]) {
      expect(Object.keys(registered)).toEqual(names)
      expect(registered.Oracle?.model).toEqual(relayModel(oracleModel))
      expect(registered.Task?.model).toEqual(relayModel(model))
      expect(registered.Librarian?.model).toEqual(relayModel(oracleModel))
      expect(registered.Painter?.model).toEqual(relayModel(oracleModel))
      expect(registered.Review?.model).toEqual(relayModel(oracleModel))
      expect(registered.ReadThread?.model).toEqual(relayModel(oracleModel))
    }

    expect(presets({ model, oracleModel }).Oracle?.model).toEqual(relayModel(oracleModel))
    expect(presets({ model }).Oracle?.model).toEqual(relayModel(model))
  })

  it("maps subagent handoff targets to registered presets and excludes the media-gated Painter", () => {
    const registered = presets({ model })
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
    expect(registered.ReadThread?.tool_names).toEqual(["search_threads", "read_thread_transcript"])
    expect(registered.ReadThread?.permissions).toEqual(["thread.read"])
  })

  it.effect("uses the configured route for Painter and returns a typed unavailable error", () =>
    Effect.gen(function* () {
      const painter = yield* resolvePainter(model, true)
      expect(painter.preset.model).toEqual(relayModel(model))
      expect(painter.preset.tool_names).toEqual([
        "view_media",
        "task",
        "oracle",
        "librarian",
        "review",
        "read_thread",
        ...threadRecoveryTools,
      ])
      expect(painter.preset.permissions).toEqual(["workspace.read", "thread.read"])
      const unavailable = yield* Effect.flip(resolvePainter(model, false))
      expect(unavailable._tag).toBe("PainterUnavailableError")
      expect(unavailable).toMatchObject(model)
    }),
  )
})

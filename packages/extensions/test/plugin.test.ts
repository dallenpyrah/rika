import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { ExecutionExtensions, PluginApi, PluginDigest, PluginLoader, PluginRegistry, PluginTrust } from "../src"

const tool = (description: string): PluginApi.Tool => ({
  name: "inspect",
  description,
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  execute: Effect.fn("Fixture.inspect")((input) => Effect.succeed(input)),
})

const source = (id: string, content: string, register: PluginApi.PluginV1["register"]): PluginLoader.Source => ({
  id,
  content,
  configuration: { enabled: true },
  load: () => Effect.succeed(Object.freeze({ apiVersion: PluginApi.v1.apiVersion, id, register })),
})

const layers = Layer.mergeAll(PluginTrust.memoryLayer(), PluginRegistry.memoryLayer, BunServices.layer)

it("trusted v1 plugins register typed capabilities with duplicate diagnostics and deterministic digests", async () => {
  const program = Effect.gen(function* () {
    const trust = yield* PluginTrust.Service
    const digest = yield* PluginDigest.source("alpha")
    yield* trust.approve("workspace", "alpha", digest)
    const fixture = source("alpha", "alpha", (registrar) => {
      registrar.tool(tool("first"))
      registrar.tool(tool("duplicate"))
      registrar.mode({ name: "review", description: "Review", defaultTools: ["inspect"] })
      registrar.agentProfile({ name: "reviewer", description: "Reviewer", mode: "review", tools: ["inspect"] })
      registrar.uiAction("ready", { kind: "notice", message: "Ready" })
    })
    const first = yield* PluginLoader.reload("workspace", [fixture])
    const second = yield* PluginLoader.reload("workspace", [fixture])
    return { first, second }
  }).pipe(Effect.provide(layers))
  const { first, second } = await Effect.runPromise(program)
  expect(first.id).toBe(second.id)
  expect(first.tools.get("inspect")?.description).toBe("first")
  expect(first.modes.has("review")).toBe(true)
  expect(first.agentProfiles.has("reviewer")).toBe(true)
  expect(first.uiActions.get("ready")).toEqual({ kind: "notice", message: "Ready" })
  expect(first.diagnostics).toEqual(["alpha: duplicate tool registration: inspect"])
})

it("isolates failures, skips untrusted code, and retains pinned generations across reload", async () => {
  let untrustedLoaded = false
  const program = Effect.gen(function* () {
    const trust = yield* PluginTrust.Service
    const oldDigest = yield* PluginDigest.source("old")
    yield* trust.approve("workspace", "good", oldDigest)
    const old = yield* PluginLoader.reload("workspace", [source("good", "old", (api) => api.tool(tool("old")))])
    const unavailable = yield* Effect.flip((yield* PluginRegistry.Service).pinned("missing"))
    const newDigest = yield* PluginDigest.source("new")
    yield* trust.approve("workspace", "good", newDigest)
    const current = yield* PluginLoader.reload("workspace", [
      source("good", "new", (api) => api.tool(tool("new"))),
      { ...source("hidden", "hidden", () => {}), load: () => Effect.die((untrustedLoaded = true)) },
      { ...source("broken", "broken", () => {}), load: () => Effect.fail("boom") },
    ])
    const pinned = yield* (yield* PluginRegistry.Service).pinned(old.id)
    return { old, current, pinned, unavailable }
  }).pipe(Effect.provide(layers))
  const result = await Effect.runPromise(program)
  expect(result.current.id).not.toBe(result.old.id)
  expect(result.pinned.tools.get("inspect")?.description).toBe("old")
  expect(result.unavailable._tag).toBe("@rika/extensions/PluginGenerationUnavailable")
  expect(result.current.diagnostics).toHaveLength(2)
  expect(untrustedLoaded).toBe(false)
})

it("pins every execution extension digest and fails typed when its generation is unavailable", async () => {
  const program = Effect.gen(function* () {
    const trust = yield* PluginTrust.Service
    const digest = yield* PluginDigest.source("pinned")
    yield* trust.approve("workspace", "pinned", digest)
    const generation = yield* PluginLoader.reload("workspace", [source("pinned", "pinned", () => {})])
    const extensions = yield* ExecutionExtensions.Service
    const activated = yield* extensions.future("mcp-fingerprint", "context-digest")
    const missingRegistry = yield* PluginRegistry.Service
    const unavailable = yield* Effect.flip(missingRegistry.pinned("unavailable"))
    return { generation, activated, unavailable }
  }).pipe(Effect.provide(ExecutionExtensions.layer), Effect.provide(layers))
  const result = await Effect.runPromise(program)
  expect(result.activated.pin).toEqual({
    generation: result.generation.id,
    sourceDigest: result.generation.sourceDigest,
    configFingerprint: result.generation.configFingerprint,
    toolSchemaDigest: result.generation.toolSchemaDigest,
    mcpFingerprint: "mcp-fingerprint",
    resolvedContextDigest: "context-digest",
  })
  expect(result.unavailable._tag).toBe("@rika/extensions/PluginGenerationUnavailable")
})

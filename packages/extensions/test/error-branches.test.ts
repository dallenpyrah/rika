import * as BunServices from "@effect/platform-bun/BunServices"
import { McpToolSource } from "@batonfx/mcp"
import { expect, it } from "@effect/vitest"
import { Crypto, Effect, FileSystem, Layer, PlatformError } from "effect"
import {
  McpConfig,
  McpRuntime,
  PluginApi,
  PluginDigest,
  PluginLoader,
  PluginRegistry,
  PluginTrust,
  SkillRegistry,
} from "../src"

const document = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\nbody`

const platformFailure = (method: string) =>
  PlatformError.systemError({ _tag: "Unknown", module: "test", method, description: `${method} failed` })

const pluginSource = (id: string, load: PluginLoader.Source["load"]): PluginLoader.Source => ({
  id,
  content: id,
  configuration: {},
  load,
})

const skillLayer = (operation: keyof SkillRegistry.FileSystemInterface) =>
  Layer.succeed(
    SkillRegistry.SkillFileSystem,
    SkillRegistry.SkillFileSystem.of({
      exists: () => (operation === "exists" ? Effect.fail(platformFailure("exists")) : Effect.succeed(true)),
      readDirectory: () =>
        operation === "readDirectory"
          ? Effect.fail(platformFailure("readDirectory"))
          : Effect.succeed(["resource.txt"]),
      isFile: () => (operation === "isFile" ? Effect.fail(platformFailure("isFile")) : Effect.succeed(true)),
      readFileString: () =>
        operation === "readFileString" ? Effect.fail(platformFailure("readFileString")) : Effect.succeed("resource"),
    }),
  )

it("maps every skill resource filesystem failure", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* Effect.serviceOption(SkillRegistry.SkillFileSystem)
        expect(fileSystem._tag).toBe("Some")
      }),
    ).pipe(Effect.provide(skillLayer("exists"))),
  )
  const operations = ["exists", "readDirectory", "isFile", "readFileString"] as const
  const results = await Promise.all(
    operations.map((operation) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem
            const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-skill-errors-" })
            const globalRoot = `${root}/global`
            const workspaceRoot = `${root}/workspace`
            yield* fileSystem.makeDirectory(`${globalRoot}/test`, { recursive: true })
            yield* fileSystem.writeFileString(`${globalRoot}/test/SKILL.md`, document("test"))
            const registry = yield* SkillRegistry.discover({ globalRoot, workspaceRoot })
            return yield* Effect.flip(registry.activate("test"))
          }),
        ).pipe(Effect.provide(skillLayer(operation)), Effect.provide(BunServices.layer)),
      ),
    ),
  )
  for (const result of results) {
    expect(result.operation).toBe("activate")
    expect(result.message).toContain("failed")
  }
})

it("exercises the skill test filesystem and rejects escaping resources", async () => {
  const activation = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-skill-test-layer-" })
        const globalRoot = `${root}/global`
        const workspaceRoot = `${root}/workspace`
        yield* fileSystem.makeDirectory(`${globalRoot}/test`, { recursive: true })
        yield* fileSystem.writeFileString(`${globalRoot}/test/SKILL.md`, document("test"))
        const files = {
          [`${globalRoot}/test/SKILL.md`]: document("test"),
          [`${globalRoot}/test/resource.txt`]: "resource",
        }
        const activate = (entries: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const registry = yield* SkillRegistry.discover({ globalRoot, workspaceRoot })
            return yield* registry.activate("test")
          }).pipe(
            Effect.provide(
              SkillRegistry.fileSystemTestLayer(files, {
                [globalRoot]: ["test/SKILL.md"],
                [workspaceRoot]: [],
                [`${globalRoot}/test`]: entries,
              }),
            ),
          )
        const success = yield* activate(["SKILL.md", "directory", "resource.txt"])
        const escaped = yield* Effect.flip(activate(["../outside.txt"]))
        return { success, escaped }
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  )
  expect(activation.success.resources).toEqual([{ path: "resource.txt", content: "resource" }])
  expect(activation.escaped.message).toBe("Resource path escapes skill directory")
})

it.effect("exercises missing test filesystem entries", () =>
  Effect.gen(function* () {
    const fileSystem = yield* SkillRegistry.SkillFileSystem
    expect((yield* Effect.exit(fileSystem.readDirectory("/missing")))._tag).toBe("Failure")
    expect((yield* Effect.exit(fileSystem.readFileString("/missing")))._tag).toBe("Failure")
    expect(yield* fileSystem.exists("/missing")).toBe(false)
    expect(yield* fileSystem.isFile("/missing")).toBe(false)
  }).pipe(Effect.provide(SkillRegistry.fileSystemTestLayer({}, {})), Effect.provide(BunServices.layer)),
)

it("maps skill digest and lazy body read failures", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-skill-boundaries-" })
        const globalRoot = `${root}/global`
        const workspaceRoot = `${root}/workspace`
        const manifest = `${globalRoot}/test/SKILL.md`
        yield* fileSystem.makeDirectory(`${globalRoot}/test`, { recursive: true })
        yield* fileSystem.writeFileString(manifest, document("test"))
        const registry = yield* SkillRegistry.discover({ globalRoot, workspaceRoot })
        yield* fileSystem.remove(manifest)
        expect((yield* Effect.flip(registry.activate("test"))).operation).toBe("activate")
      }).pipe(Effect.provide(SkillRegistry.fileSystemLayer)),
    ).pipe(Effect.provide(BunServices.layer)),
  )

  const failure = platformFailure("digest")
  const cryptoLayer = Layer.succeed(
    Crypto.Crypto,
    Crypto.make({ randomBytes: (size) => new Uint8Array(size), digest: () => Effect.fail(failure) }),
  )
  const digestError = await Effect.runPromise(
    Effect.flip(
      SkillRegistry.discover({ globalRoot: "/global", workspaceRoot: "/workspace" }).pipe(
        Effect.provide(SkillRegistry.fileSystemTestLayer({}, {})),
        Effect.provide(cryptoLayer),
        Effect.provide(BunServices.layer),
      ),
    ),
  )
  expect(digestError.operation).toBe("digest")
})

it.effect("maps MCP discovery errors and exercises factory methods", () => {
  const server: McpConfig.LocalServer = {
    kind: "local",
    name: "server",
    command: "command",
    args: [],
    environment: {},
    source: "workspace",
    sourceDigest: "digest",
  }
  const source = McpToolSource.McpToolSource.of({
    server: "server",
    tools: Effect.fail("discovery failed") as unknown as Effect.Effect<ReadonlyArray<McpToolSource.DiscoveredTool>>,
    callTool: (_tool, input) => Effect.succeed(input),
    aiTools: Effect.succeed([]),
  })
  return Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* McpRuntime.Service
      expect(yield* runtime.connect(server)).toBe(source)
      const error = yield* Effect.flip(McpRuntime.discover(server))
      expect(error.phase).toBe("discover")
    }),
  ).pipe(Effect.provide(McpRuntime.testLayer(() => Effect.succeed(source))))
})

it("isolates plugin import, contract, and registration failures", async () => {
  const layers = Layer.mergeAll(PluginTrust.memoryLayer(), PluginRegistry.memoryLayer, BunServices.layer)
  const generation = await Effect.runPromise(
    Effect.gen(function* () {
      const trust = yield* PluginTrust.Service
      for (const id of ["import", "contract", "register"]) {
        yield* trust.approve("workspace", id, yield* PluginDigest.source(id))
      }
      return yield* PluginLoader.reload("workspace", [
        pluginSource("import", () => Effect.fail(new Error("read/import failed"))),
        pluginSource("contract", () =>
          Effect.succeed({ apiVersion: 2, id: "wrong", register: () => {} } as unknown as PluginApi.PluginV1),
        ),
        pluginSource("register", () =>
          Effect.succeed({
            apiVersion: 1,
            id: "register",
            register: () => {
              throw new Error("registration failed")
            },
          }),
        ),
      ])
    }).pipe(Effect.provide(layers)),
  )
  expect(generation.diagnostics).toHaveLength(3)
  expect(generation.diagnostics.join("\n")).toContain("load failed")
  expect(generation.diagnostics.join("\n")).toContain("invalid plugin contract")
  expect(generation.diagnostics.join("\n")).toContain("registration failed")
})

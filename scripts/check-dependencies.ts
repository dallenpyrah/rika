import { FileSystem } from "effect"
import { Effect, Schema } from "effect"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"

const PackageJson = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  workspaces: Schema.optionalKey(Schema.Unknown),
})

const forbiddenProtocols = ["file:", "link:"] as const
const externalFrameworks = new Set([
  "@batonfx/core",
  "@batonfx/mcp",
  "@batonfx/providers",
  "@batonfx/skills",
  "@batonfx/test",
  "@relayfx/sdk",
])

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const source = yield* fileSystem.readFileString("package.json")
  const json = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageJson))(source)
  const dependencies = { ...json.dependencies, ...json.devDependencies }
  const violations = Object.entries(dependencies).flatMap(([name, version]) => {
    if (forbiddenProtocols.some((protocol) => version.startsWith(protocol))) return [`${name} uses ${version}`]
    if (externalFrameworks.has(name) && version === "workspace:*") return [`${name} uses external workspace linking`]
    return []
  })
  if (violations.length > 0) return yield* Effect.fail(new Error(violations.join("\n")))
})

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)))

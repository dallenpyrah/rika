import * as BunServices from "@effect/platform-bun/BunServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import * as Logging from "../src/logging"

describe("Logging", () => {
  it.effect("writes Effect JSON logs with secure permissions and reports them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-" })
        yield* Effect.logInfo("process.started").pipe(
          Effect.annotateLogs({ "rika.process.role": "client", "rika.version": "1.2.3" }),
          Effect.provide(
            Logging.layer({
              dataRoot: root,
              role: "client",
              version: "1.2.3",
              now: new Date("2026-07-14T10:00:00.000Z"),
              pid: 42,
            }),
          ),
        )
        const diagnostics = path.join(root, "diagnostics")
        const filename = path.join(diagnostics, "client-2026-07-14T10-00-00-000Z-42.jsonl")
        assert.strictEqual((yield* fs.stat(diagnostics)).mode & 0o777, 0o700)
        assert.strictEqual((yield* fs.stat(filename)).mode & 0o777, 0o600)
        const record = JSON.parse((yield* fs.readFileString(filename)).trim())
        assert.strictEqual(record.message, "process.started")
        assert.strictEqual(record.annotations["rika.process.role"], "client")
        assert.deepStrictEqual(yield* Logging.status(root), {
          directory: diagnostics,
          files: 1,
          bytes: (yield* fs.stat(filename)).size,
        })
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  )

  it.effect("exports only logging files into a private directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-" })
        const outputRoot = yield* fs.makeTempDirectoryScoped({ prefix: "rika-export-parent-" })
        const diagnostics = yield* Logging.directory(root)
        yield* fs.makeDirectory(diagnostics, { mode: 0o700 })
        yield* fs.writeFileString(path.join(diagnostics, "client.jsonl"), "{}\n", { mode: 0o600 })
        yield* fs.writeFileString(path.join(diagnostics, "resident.token"), "secret", { mode: 0o600 })
        yield* fs.symlink(path.join(diagnostics, "resident.token"), path.join(diagnostics, "leak.jsonl"))
        const output = path.join(outputRoot, "export")
        assert.strictEqual(yield* Logging.exportLogs(root, output), output)
        assert.deepStrictEqual(yield* fs.readDirectory(output), ["client.jsonl"])
        assert.strictEqual((yield* fs.stat(output)).mode & 0o777, 0o700)
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  )

  it.effect("resolves one canonical data root from both database paths", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "rika-data-root-" })
        const root = path.join(parent, "data")
        const link = path.join(parent, "data-link")
        yield* fs.makeDirectory(root)
        yield* fs.symlink(root, link)
        assert.strictEqual(
          yield* Logging.resolveDataRoot(path.join(link, "rika.db"), path.join(root, "relay.db")),
          yield* fs.realPath(root),
        )
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  )

  it.effect("honors the configured minimum level", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-logging-" })
        yield* Effect.all([Effect.logInfo("hidden"), Effect.logError("visible")]).pipe(
          Effect.provide(Logging.layer({ dataRoot: root, role: "resident", version: "1", level: "error", pid: 7 })),
        )
        const diagnostics = yield* Logging.directory(root)
        const [name] = yield* fs.readDirectory(diagnostics)
        const content = yield* fs.readFileString(path.join(diagnostics, name!))
        assert.notInclude(content, "hidden")
        assert.include(content, "visible")
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  )
})

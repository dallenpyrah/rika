import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Data, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

class ReleaseSmokeError extends Data.TaggedError("ReleaseSmokeError")<{
  readonly step: string
  readonly message: string
}> {}

const failure = (step: string, message: string) => new ReleaseSmokeError({ step, message })
const mapFailure = (step: string) =>
  Effect.mapError((error: { readonly message: string }) => failure(step, error.message))

const NamedItemsJson = Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String })))
const ThreadsJson = Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String })))
const UnknownJson = Schema.UnknownFromJsonString

const program = Effect.scoped(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const root = yield* path.fromFileUrl(new URL("..", import.meta.url)).pipe(mapFailure("resolve project root"))
    const targetIndex = Bun.argv.indexOf("--target")
    const kernel = process.platform === "darwin" ? "darwin" : "linux"
    const architecture = process.arch === "x64" ? "x64" : "arm64"
    const target = targetIndex < 0 ? `${kernel}-${architecture}` : (Bun.argv[targetIndex + 1] ?? "")
    const archive = path.join(root, "artifacts", `rika-${target}.tar.gz`)
    if (!(yield* fileSystem.exists(archive).pipe(mapFailure("check archive"))))
      return yield* failure("check archive", `Archive not found: ${archive}. Run bun run package first.`)
    const temporary = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "rika-release-smoke-" })
      .pipe(mapFailure("create smoke directory"))
    const extracted = yield* spawner
      .exitCode(ChildProcess.make("tar", ["-xzf", archive, "-C", temporary]))
      .pipe(mapFailure("extract archive"))
    if (Number(extracted) !== 0) return yield* failure("extract archive", `tar exited with code ${extracted}`)
    const binary = path.join(temporary, `rika-${target}`, "bin", "rika")
    const workspace = path.join(temporary, "workspace")
    const home = path.join(temporary, "home")
    const state = path.join(temporary, "state")
    yield* Effect.forEach(
      [workspace, home, state],
      (directory) => fileSystem.makeDirectory(directory).pipe(mapFailure("create smoke workspace")),
      { discard: true },
    )
    yield* fileSystem
      .writeFileString(path.join(workspace, "smoke.txt"), "release-smoke-needle\n")
      .pipe(mapFailure("seed workspace"))
    const grepScript = yield* Schema.encodeUnknownEffect(UnknownJson)([
      {
        parts: [{ type: "toolCall", name: "grep", params: { pattern: "release-smoke-needle", regex: false } }],
      },
      { parts: [{ type: "text", text: "SMOKE_COMPLETE" }] },
    ]).pipe(mapFailure("encode model script"))
    const environment = {
      HOME: home,
      RIKA_DATABASE: path.join(state, "rika.db"),
      RIKA_RELAY_DATABASE: path.join(state, "relay.db"),
      RIKA_INTERNAL_RESIDENT_GRACE: "0",
      RIKA_TEST_MODEL_SCRIPT: grepScript,
    }
    const output = (command: ReadonlyArray<string>, extraEnvironment: Readonly<Record<string, string>> = {}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const step = `run ${command.join(" ")}`
          const handle = yield* spawner
            .spawn(
              ChildProcess.make(binary, command, {
                cwd: workspace,
                extendEnv: true,
                env: { ...environment, ...extraEnvironment },
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
              }),
            )
            .pipe(mapFailure(step))
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              Stream.mkString(Stream.decodeText(handle.stdout)),
              Stream.mkString(Stream.decodeText(handle.stderr)),
              handle.exitCode,
            ],
            { concurrency: 3 },
          ).pipe(mapFailure(step))
          if (Number(exitCode) !== 0)
            return yield* failure(step, `exit ${exitCode}\n${stderr.slice(0, 2_000)}\n${stdout.slice(0, 2_000)}`)
          return stdout
        }),
      )
    const version = yield* output(["--version"])
    if (!version.includes("rika")) return yield* failure("version", `Unexpected --version output: ${version}`)
    if (Bun.argv.includes("--boot-only")) {
      yield* Effect.log(`Release boot smoke passed for ${target}`)
      return
    }
    const listed = yield* output(["tools", "list"])
    const tools = yield* Schema.decodeUnknownEffect(NamedItemsJson)(listed).pipe(mapFailure("decode tools list"))
    if (!tools.some((tool) => tool.name === "read"))
      return yield* failure("tools list", "Catalog does not contain the read tool")
    const executed = yield* output(["run", "find the needle"])
    if (!executed.includes("SMOKE_COMPLETE"))
      return yield* failure(
        "packaged run",
        `Deterministic packaged run did not complete a grep tool turn: ${executed.slice(0, 2_000)}`,
      )
    const threads = yield* output(["threads", "list"])
    const decoded = yield* Schema.decodeUnknownEffect(ThreadsJson)(threads).pipe(mapFailure("decode threads list"))
    if (decoded.length !== 1) return yield* failure("threads list", `Expected one thread, saw ${decoded.length}`)
    yield* Effect.log(`Release smoke passed for ${target}`)
  }),
)

BunRuntime.runMain(
  Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
)

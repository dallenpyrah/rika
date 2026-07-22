import * as BunServices from "@effect/platform-bun/BunServices"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { Config, Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

interface InstallTestContext {
  readonly root: string
  readonly temporary: string
  readonly installRoot: string
  readonly binDir: string
  readonly home: string
  readonly state: string
  readonly env: Record<string, string | undefined>
}

interface ProcessResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

let context: InstallTestContext

const runTest = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer), Effect.scoped))

const runChild = Effect.fn("LocalInstallTest.runChild")(function* (
  executable: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: Record<string, string | undefined> },
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const child = yield* spawner.spawn(
        ChildProcess.make(executable, args, {
          cwd: options.cwd,
          env: options.env,
          extendEnv: true,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      )
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: 3 },
      )
      return { stdout, stderr, exitCode: Number(exitCode) } satisfies ProcessResult
    }),
  )
})

const runScript = (name: string, env: Record<string, string | undefined> = {}) =>
  runChild("bun", ["run", `scripts/${name}.ts`], { cwd: context.root, env: { ...context.env, ...env } })

const runRika = (args: ReadonlyArray<string>) =>
  runChild("rika", args, {
    cwd: context.temporary,
    env: {
      ...context.env,
      RIKA_DATABASE: `${context.state}/rika.db`,
      RIKA_RELAY_DATABASE: `${context.state}/relay.db`,
      RIKA_TEST_MODEL_RESPONSE: "deterministic response",
    },
  })

beforeAll(() =>
  runTest(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../..", import.meta.url))
      const temporary = yield* fileSystem.makeTempDirectory({ prefix: "rika-local-install-" })
      const binDir = path.join(temporary, "bin")
      const inheritedPath = yield* Config.string("PATH").pipe(Config.withDefault(""))
      context = {
        root,
        temporary,
        installRoot: path.join(temporary, "install", "current"),
        binDir,
        home: path.join(temporary, "home"),
        state: path.join(temporary, "state"),
        env: {
          HOME: path.join(temporary, "home"),
          PATH: `${binDir}:${inheritedPath}`,
          RIKA_INSTALL_ROOT: path.join(temporary, "install", "current"),
          RIKA_BIN_DIR: binDir,
        },
      }
    }),
  ),
)

beforeEach(() =>
  runTest(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      yield* Effect.forEach([context.installRoot, context.binDir, context.state, context.home], (target) =>
        fileSystem.remove(target, { recursive: true, force: true }),
      )
      yield* fileSystem.makeDirectory(context.home, { recursive: true })
    }),
  ),
)

afterAll(() =>
  runTest(
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fileSystem) => fileSystem.remove(context.temporary, { recursive: true, force: true })),
    ),
  ),
)

describe("packaged local installation", () => {
  test(
    "installs, runs by PATH name, reinstalls, and uninstalls idempotently",
    () =>
      runTest(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const installed = yield* runScript("install-local")
          expect(installed.exitCode, installed.stderr).toBe(0)
          expect(yield* fileSystem.readLink(path.join(context.binDir, "rika"))).toBe(
            path.join(context.installRoot, "bin", "rika"),
          )
          expect((yield* fileSystem.stat(path.join(context.installRoot, "bin", "node_modules"))).type).toBe("Directory")
          for (const args of [["--version"], ["--help"], ["tools", "list"]]) {
            const result = yield* runRika(args)
            expect(result.exitCode, `${args.join(" ")}\n${result.stderr}`).toBe(0)
          }
          const executed = yield* runRika(["run", "--ephemeral", "say hi"])
          expect(executed.exitCode, executed.stderr).toBe(0)
          expect(executed.stdout).toContain("deterministic response")
          expect(executed.stderr).not.toContain("TypeError: members.map is not a function")
          expect(executed.stderr).not.toContain("requires Crypto")
          yield* fileSystem.writeFileString(path.join(context.installRoot, "obsolete"), "old install")
          expect((yield* runScript("install-local")).exitCode).toBe(0)
          expect(yield* fileSystem.exists(path.join(context.installRoot, "obsolete"))).toBe(false)
          expect((yield* runScript("uninstall-local")).exitCode).toBe(0)
          expect((yield* runScript("uninstall-local")).exitCode).toBe(0)
          expect(yield* fileSystem.exists(context.installRoot)).toBe(false)
        }),
      ),
    30_000,
  )

  test(
    "installed TUI tears down after SIGTERM",
    () =>
      runTest(
        Effect.gen(function* () {
          const installed = yield* runScript("install-local")
          expect(installed.exitCode, installed.stderr).toBe(0)
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const child = yield* spawner.spawn(
            ChildProcess.make("rika", [], {
              cwd: context.temporary,
              env: {
                ...context.env,
                TERM: "xterm-256color",
                RIKA_DATABASE: `${context.state}/rika.db`,
                RIKA_RELAY_DATABASE: `${context.state}/relay.db`,
              },
              stdin: "pipe",
              stdout: "ignore",
              stderr: "ignore",
            }),
          )
          yield* Effect.addFinalizer(() => child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore))
          yield* Effect.sleep("500 millis")
          yield* child.kill({ killSignal: "SIGTERM" })
          yield* Effect.exit(child.exitCode).pipe(Effect.timeout("5 seconds"))
        }),
      ),
    15_000,
  )

  test(
    "does not overwrite a foreign command",
    () =>
      runTest(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          yield* fileSystem.makeDirectory(context.binDir, { recursive: true })
          const foreign = path.join(context.temporary, "foreign-rika")
          const command = path.join(context.binDir, "rika")
          yield* fileSystem.writeFileString(foreign, "foreign")
          yield* fileSystem.symlink(foreign, command)
          expect((yield* runScript("install-local")).exitCode).not.toBe(0)
          expect(yield* fileSystem.readLink(command)).toBe(foreign)
          yield* fileSystem.remove(command)
        }),
      ),
    20_000,
  )

  test(
    "replaces the previous packaged Rika launcher",
    () =>
      runTest(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const command = path.join(context.binDir, "rika")
          yield* fileSystem.makeDirectory(context.binDir, { recursive: true })
          yield* fileSystem.writeFileString(
            command,
            '#!/usr/bin/env sh\nSCRIPT_DIR=$(dirname "$0")\nSHARE_DIR="$SCRIPT_DIR/../share/rika"\nexec "$SCRIPT_DIR/rika-darwin-arm64.bin" "$@"\n',
          )
          yield* fileSystem.chmod(command, 0o755)
          const result = yield* runScript("install-local")
          expect(result.exitCode, result.stderr).toBe(0)
          expect(yield* fileSystem.readLink(command)).toBe(path.join(context.installRoot, "bin", "rika"))
          expect((yield* runScript("uninstall-local")).exitCode).toBe(0)
        }),
      ),
    20_000,
  )

  test(
    "keeps the prior owned install when replacement has an invalid payload",
    () =>
      runTest(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const installed = yield* runScript("install-local")
          expect(installed.exitCode, installed.stderr).toBe(0)
          const marker = path.join(context.installRoot, "prior-install")
          yield* fileSystem.writeFileString(marker, "preserve me")
          const malformedRoot = path.join(context.temporary, "malformed-package")
          const malformedPayload = path.join(malformedRoot, "rika-invalid-target")
          const archive = path.join(context.root, "artifacts", "rika-invalid-target.tar.gz")
          yield* fileSystem.makeDirectory(malformedPayload, { recursive: true })
          yield* fileSystem.writeFileString(path.join(malformedPayload, "README"), "missing executable")
          yield* Effect.addFinalizer(() =>
            fileSystem
              .remove(archive, { force: true })
              .pipe(Effect.andThen(fileSystem.remove(malformedRoot, { recursive: true, force: true })), Effect.ignore),
          )
          const archived = yield* runChild("tar", ["-czf", archive, "-C", malformedRoot, "rika-invalid-target"], {
            cwd: context.root,
            env: context.env,
          })
          expect(archived.exitCode, archived.stderr).toBe(0)
          const replacement = yield* runScript("install-local", { RIKA_PACKAGE_TARGET: "invalid-target" })
          expect(replacement.exitCode).not.toBe(0)
          expect(`${replacement.stdout}\n${replacement.stderr}`).toContain("Package does not contain bin/rika")
          expect(yield* fileSystem.readFileString(marker)).toBe("preserve me")
          expect(yield* fileSystem.readLink(path.join(context.binDir, "rika"))).toBe(
            path.join(context.installRoot, "bin", "rika"),
          )
        }),
      ),
    20_000,
  )

  test(
    "uninstall preserves state and configuration",
    () =>
      runTest(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const installed = yield* runScript("install-local")
          expect(installed.exitCode, installed.stderr).toBe(0)
          const state = path.join(context.home, ".rika", "rika.db")
          const configuration = path.join(context.home, ".config", "rika", "settings.json")
          yield* fileSystem.makeDirectory(path.dirname(state), { recursive: true })
          yield* fileSystem.makeDirectory(path.dirname(configuration), { recursive: true })
          yield* fileSystem.writeFileString(state, "durable state")
          yield* fileSystem.writeFileString(configuration, '{"theme":"dark"}')
          const uninstalled = yield* runScript("uninstall-local")
          expect(uninstalled.exitCode, uninstalled.stderr).toBe(0)
          expect(yield* fileSystem.exists(context.installRoot)).toBe(false)
          expect(yield* fileSystem.exists(path.join(context.binDir, "rika"))).toBe(false)
          expect(yield* fileSystem.readFileString(state)).toBe("durable state")
          expect(yield* fileSystem.readFileString(configuration)).toBe('{"theme":"dark"}')
        }),
      ),
    20_000,
  )
})

import { expect, test } from "vitest"
import { Effect, FileSystem } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as ResourceSampler from "./resource-sampler"
import { runTest } from "./process"

test("resource sampler catches and cleans a grandchild after its client exits", () =>
  runTest(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const sampler = yield* ResourceSampler.Service
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-resource-sampler-" })
      const release = `${directory}/release`
      const client = yield* spawner.spawn(
        ChildProcess.make(
          "sh",
          ["-c", 'while [ ! -f "$1" ]; do sleep 0.01; done; sh -c "sleep 60 & wait" &', "sh", release],
          {
            detached: true,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          },
        ),
      )
      const clientPid = Number(client.pid)
      yield* sampler.track([clientPid])
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(-clientPid, "SIGKILL")
          } catch {}
        }),
      )
      yield* fileSystem.writeFileString(release, "")
      expect(Number(yield* client.exitCode)).toBe(0)
      const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      let detected = yield* sampler.scanOrphans
      while (!detected.some((entry) => entry.command.includes("sleep"))) {
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        if (now - started >= 2_000) break
        yield* Effect.sleep("20 millis")
        detected = yield* sampler.scanOrphans
      }
      expect(detected.some((entry) => entry.command.includes("sleep"))).toBe(true)
      const cleanup = yield* sampler.terminateOrphans
      expect(cleanup.detected.some((entry) => entry.command.includes("sleep"))).toBe(true)
      expect(cleanup.remaining).toEqual([])
    }).pipe(Effect.provide(ResourceSampler.layer({ intervalMilliseconds: 25 })), Effect.scoped),
  ))

test("resource sampler excludes its own process probes from tracked trees", () =>
  runTest(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const sampler = yield* ResourceSampler.Service
      const client = yield* spawner.spawn(
        ChildProcess.make("sleep", ["60"], {
          detached: false,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      yield* Effect.addFinalizer(() => client.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore))
      yield* sampler.track([Number(client.pid)])
      const detected = yield* sampler.scanOrphans
      expect(
        detected.filter(
          (entry) =>
            entry.parentPid === process.pid && /^\(?(?:ps|pgrep|lsof)\)?$/.test(entry.command.split("/").at(-1) ?? ""),
        ),
      ).toEqual([])
    }).pipe(Effect.provide(ResourceSampler.layer({ intervalMilliseconds: 25 })), Effect.scoped),
  ))

test("resource sampler does not adopt an untracked sibling in the same process group", () =>
  runTest(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const sampler = yield* ResourceSampler.Service
      const tracked = yield* spawner.spawn(
        ChildProcess.make("sleep", ["60"], {
          detached: false,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      const sibling = yield* spawner.spawn(
        ChildProcess.make("sleep", ["60"], {
          detached: false,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      yield* Effect.addFinalizer(() =>
        Effect.all([tracked.kill({ killSignal: "SIGKILL" }), sibling.kill({ killSignal: "SIGKILL" })], {
          concurrency: 2,
          discard: true,
        }).pipe(Effect.ignore),
      )
      yield* sampler.track([Number(tracked.pid)])
      const detected = yield* sampler.scanOrphans
      expect(detected.some((entry) => entry.pid === Number(tracked.pid))).toBe(true)
      expect(detected.some((entry) => entry.pid === Number(sibling.pid))).toBe(false)
    }).pipe(Effect.provide(ResourceSampler.layer({ intervalMilliseconds: 25 })), Effect.scoped),
  ))

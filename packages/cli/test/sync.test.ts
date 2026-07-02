import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config, IdGenerator, Time } from "@rika/core"
import { OrbChanges } from "@rika/orb"
import { Database, Migration, OrbStore } from "@rika/persistence"
import { Codec, Common, Ids, Remote } from "@rika/schema"
import { Effect, Layer } from "effect"
import { BackendEndpoint, Output, Runtime, Sync } from "../src/index"

const threadId = Ids.ThreadId.make("thread_sync_e2e")
const orbId = Ids.OrbId.make("orb_sync_e2e")
const runtimeThreadId = Ids.ThreadId.make("thread_sync_runtime")
const projectId = Ids.ProjectId.make("project_sync_e2e")
const now = Common.TimestampMillis.make(2_020_000_000_000)

describe("CLI sync command", () => {
  test("applies orb changes into a dedicated worktree and can run twice", async () => {
    const local = await mkdtemp(join(tmpdir(), "rika-sync-local-"))
    const orb = await mkdtemp(join(tmpdir(), "rika-sync-orb-"))
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    let server: ReturnType<typeof Bun.serve> | undefined
    try {
      const baseCommit = await prepareRepositories(local, orb)
      server = startOrbChangesServer(orb, baseCommit)

      const layer = makeLayer(local, endpointUrl(server), output)
      const firstExit = await Effect.runPromise(
        Sync.executeCommand({ type: "sync", thread_id: threadId }).pipe(Effect.provide(layer)),
      )
      const worktree = join(local, ".rika", "worktrees", threadId)
      await runGit(worktree, ["checkout", "-B", "wrong_sync_branch", baseCommit])
      await writeFile(join(worktree, "stale.txt"), "stale\n")
      const secondExit = await Effect.runPromise(
        Sync.executeCommand({ type: "sync", thread_id: threadId }).pipe(Effect.provide(layer)),
      )

      expect(firstExit).toBe(0)
      expect(secondExit).toBe(0)
      expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("after\n")
      expect(await readFile(join(worktree, "new.txt"), "utf8")).toBe("untracked\n")
      expect(await readFile(join(worktree, "image.bin"))).toEqual(Buffer.from([0, 1, 2, 3, 255]))
      expect((await runGit(worktree, ["branch", "--show-current"])).trim()).toBe(`rika/orb/${threadId}`)
      let staleRemoved = false
      try {
        await readFile(join(worktree, "stale.txt"), "utf8")
      } catch {
        staleRemoved = true
      }
      expect(staleRemoved).toBe(true)
      expect(output.stdout[0]).toContain(worktree)
      expect(output.stderr).toEqual([])
    } finally {
      if (server !== undefined) await server.stop(true)
      await rm(local, { force: true, recursive: true })
      await rm(orb, { force: true, recursive: true })
    }
  })

  test("clears the mirrored worktree when the orb diff becomes empty", async () => {
    const local = await mkdtemp(join(tmpdir(), "rika-sync-empty-local-"))
    const orb = await mkdtemp(join(tmpdir(), "rika-sync-empty-orb-"))
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    let server: ReturnType<typeof Bun.serve> | undefined
    try {
      const baseCommit = await prepareRepositories(local, orb)
      server = startOrbChangesServer(orb, baseCommit)
      const layer = makeLayer(local, endpointUrl(server), output)

      const firstExit = await Effect.runPromise(
        Sync.executeCommand({ type: "sync", thread_id: threadId }).pipe(Effect.provide(layer)),
      )
      const worktree = join(local, ".rika", "worktrees", threadId)
      await writeFile(join(worktree, "stale.txt"), "stale\n")
      await runGit(orb, ["reset", "--hard", baseCommit])
      await runGit(orb, ["clean", "-fd"])
      const secondExit = await Effect.runPromise(
        Sync.executeCommand({ type: "sync", thread_id: threadId }).pipe(Effect.provide(layer)),
      )

      expect(firstExit).toBe(0)
      expect(secondExit).toBe(0)
      expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("before\n")
      expect(await fileMissing(join(worktree, "new.txt"))).toBe(true)
      expect(await fileMissing(join(worktree, "image.bin"))).toBe(true)
      expect(await fileMissing(join(worktree, "stale.txt"))).toBe(true)
      expect(output.stdout.at(-1)).toBe("no changes yet")
      expect(output.stderr).toEqual([])
    } finally {
      if (server !== undefined) await server.stop(true)
      await rm(local, { force: true, recursive: true })
      await rm(orb, { force: true, recursive: true })
    }
  })

  test("runs through the CLI runtime against a persisted orb endpoint", async () => {
    const local = await mkdtemp(join(tmpdir(), "rika-sync-runtime-local-"))
    const orb = await mkdtemp(join(tmpdir(), "rika-sync-runtime-orb-"))
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const dataDir = join(local, ".rika")

    let server: ReturnType<typeof Bun.serve> | undefined
    try {
      const baseCommit = await prepareRepositories(local, orb)
      server = startOrbChangesServer(orb, baseCommit)
      const runningServer = server
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate()
          const created = yield* OrbStore.create({
            thread_id: runtimeThreadId,
            project_id: projectId,
            base_commit: baseCommit,
          })
          yield* OrbStore.setSandbox(created.orb_id, "sandbox_sync_runtime")
          yield* OrbStore.setEndpoint(created.orb_id, {
            endpoint_url: endpointUrl(runningServer),
            token: "orb-token",
          })
          yield* OrbStore.setStatus(created.orb_id, "running")
        }).pipe(Effect.provide(makeStorageLayer(local, dataDir))),
      )

      const exitCode = await Effect.runPromise(
        Runtime.runProcess({
          argv: ["sync", runtimeThreadId],
          env: { RIKA_DATA_DIR: dataDir },
          cwd: local,
        }).pipe(Effect.provide(Output.memoryLayer(output))),
      )
      const worktree = join(local, ".rika", "worktrees", runtimeThreadId)

      expect(exitCode).toBe(0)
      expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("after\n")
      expect(await readFile(join(worktree, "new.txt"), "utf8")).toBe("untracked\n")
      expect(await readFile(join(worktree, "image.bin"))).toEqual(Buffer.from([0, 1, 2, 3, 255]))
      expect(output.stdout[0]).toContain(worktree)
      expect(output.stderr).toEqual([])
    } finally {
      if (server !== undefined) await server.stop(true)
      await rm(local, { force: true, recursive: true })
      await rm(orb, { force: true, recursive: true })
    }
  })
})

const makeLayer = (workspaceRoot: string, endpointUrl: string, output: Output.MemoryOutput) => {
  const configLayer = Config.layerFromValues({
    workspace_root: workspaceRoot,
    data_dir: join(workspaceRoot, ".rika"),
    default_mode: "smart",
  })
  const resolverLayer = Layer.succeed(
    BackendEndpoint.Resolver,
    BackendEndpoint.Resolver.of({
      resolveEndpoint: () =>
        Effect.succeed({
          kind: "orb" as const,
          url: endpointUrl,
          token: "orb-token",
          orb_id: orbId,
          thread_id: threadId,
        }),
    }),
  )
  return Sync.layer.pipe(
    Layer.provideMerge(Output.memoryLayer(output)),
    Layer.provideMerge(configLayer),
    Layer.provideMerge(resolverLayer),
  )
}

const makeStorageLayer = (workspaceRoot: string, dataDir: string) => {
  const configLayer = Config.layerFromValues({
    workspace_root: workspaceRoot,
    data_dir: dataDir,
    default_mode: "smart",
  })
  const databaseLayer = Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.fixedLayer(now)
  const idLayer = IdGenerator.sequenceLayer(1)
  const orbStoreLayer = OrbStore.layer.pipe(
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(idLayer),
  )
  return Layer.mergeAll(configLayer, databaseLayer, Migration.layer, timeLayer, idLayer, orbStoreLayer)
}

const prepareRepositories = async (local: string, orb: string) => {
  await runGit(local, ["init", "-b", "main"])
  await runGit(local, ["config", "user.email", "rika@example.test"])
  await runGit(local, ["config", "user.name", "Rika Test"])
  await writeFile(join(local, "README.md"), "before\n")
  await runGit(local, ["add", "README.md"])
  await runGit(local, ["commit", "-m", "init"])
  const baseCommit = (await runGit(local, ["rev-parse", "HEAD"])).trim()
  await runGit(tmpdir(), ["clone", local, orb])
  await writeFile(join(orb, "README.md"), "after\n")
  await writeFile(join(orb, "new.txt"), "untracked\n")
  await writeFile(join(orb, "image.bin"), new Uint8Array([0, 1, 2, 3, 255]))
  return baseCommit
}

const startOrbChangesServer = (orb: string, baseCommit: string) => {
  let server: ReturnType<typeof Bun.serve>
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/health") {
        return json({
          status: "healthy",
          url: endpointUrl(server),
          workspace_root: orb,
          data_dir: join(orb, ".rika"),
          backend_id: "orb-sync-test",
          version: "0.0.0",
        })
      }
      if (url.pathname === "/v1/orb/changes") {
        if (request.headers.get("authorization") !== "Bearer orb-token") {
          return json({ error: { message: "Unauthorized", code: "unauthorized" } }, 401)
        }
        const changes = await Effect.runPromise(
          OrbChanges.changes({ workspace_root: orb, base_commit: baseCommit }).pipe(Effect.provide(OrbChanges.layer)),
        )
        return json(Codec.encode(Remote.OrbChangesResponse)(changes))
      }
      return json({ error: { message: "Not found", code: "not_found" } }, 404)
    },
  })
  return server
}

const endpointUrl = (server: ReturnType<typeof Bun.serve>) => `http://127.0.0.1:${server.port}`

const fileMissing = async (path: string) => {
  try {
    await readFile(path)
    return false
  } catch {
    return true
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const runGit = async (cwd: string, args: ReadonlyArray<string>) => {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
  return stdout
}

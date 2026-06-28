import { describe, expect, test } from "bun:test"
import { Remote } from "@rika/schema"
import { Effect } from "effect"
import { LocalBackend } from "../src/index"

const workspaceRoot = "/workspace/rika-local-backend"
const dataDir = `${workspaceRoot}/.rika`

describe("CLI local backend", () => {
  test("reuses a healthy connection record without spawning", async () => {
    const system = fakeSystem()
    const record: LocalBackend.BackendRecord = {
      url: "http://127.0.0.1:45555",
      token: "secret-token",
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      pid: 123,
      started_at: 1,
    }
    system.files.set(LocalBackend.recordPath(dataDir), JSON.stringify(record))
    system.healthy.set(healthKey(record.url, record.token), health(record))

    const endpoint = await Effect.runPromise(
      LocalBackend.connectOrStart({ workspace_root: workspaceRoot, data_dir: dataDir, mode: "smart" }).pipe(
        Effect.provide(LocalBackend.layerFromInput({ env: {}, cwd: workspaceRoot, system })),
      ),
    )

    expect(endpoint).toEqual({
      url: record.url,
      token: record.token,
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      pid: 123,
    })
    expect(system.spawns).toHaveLength(0)
  })

  test("starts one backend for concurrent callers and hides tokens from redaction", async () => {
    const system = fakeSystem()
    const layer = LocalBackend.layerFromInput({ env: { RIKA_BACKEND_PORT: "45678" }, cwd: workspaceRoot, system })
    const run = () =>
      Effect.runPromise(
        LocalBackend.connectOrStart({ workspace_root: workspaceRoot, data_dir: dataDir, mode: "smart" }).pipe(
          Effect.provide(layer),
        ),
      )

    const [first, second, third] = await Promise.all([run(), run(), run()])

    expect(first).toEqual(second)
    expect(second).toEqual(third)
    expect(system.spawns).toHaveLength(1)
    expect(first.url).toBe("http://127.0.0.1:45678")
    expect(LocalBackend.redactEndpoint(first)).not.toHaveProperty("token")
  })

  test("replaces stale records and reports backend status", async () => {
    const system = fakeSystem()
    const stale: LocalBackend.BackendRecord = {
      url: "http://127.0.0.1:45001",
      token: "dead-token",
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      pid: 111,
      started_at: 1,
    }
    system.files.set(LocalBackend.recordPath(dataDir), JSON.stringify(stale))
    const layer = LocalBackend.layerFromInput({ env: { RIKA_BACKEND_PORT: "45679" }, cwd: workspaceRoot, system })

    const before = await Effect.runPromise(
      LocalBackend.status({ workspace_root: workspaceRoot, data_dir: dataDir }).pipe(Effect.provide(layer)),
    )
    const endpoint = await Effect.runPromise(
      LocalBackend.connectOrStart({ workspace_root: workspaceRoot, data_dir: dataDir, mode: "deep" }).pipe(
        Effect.provide(layer),
      ),
    )
    const after = await Effect.runPromise(
      LocalBackend.status({ workspace_root: workspaceRoot, data_dir: dataDir }).pipe(Effect.provide(layer)),
    )

    expect(before).toMatchObject({ status: "stale", endpoint: stale.url, pid: 111 })
    expect(endpoint.url).toBe("http://127.0.0.1:45679")
    expect(after).toMatchObject({ status: "healthy", endpoint: endpoint.url, pid: endpoint.pid })
  })
})

interface FakeSystem extends LocalBackend.System {
  readonly files: Map<string, string>
  readonly healthy: Map<string, Remote.BackendHealth>
  readonly spawns: Array<LocalBackend.SpawnInput>
}

const fakeSystem = (): FakeSystem => {
  const files = new Map<string, string>()
  const locks = new Set<string>()
  const healthy = new Map<string, Remote.BackendHealth>()
  const spawns: Array<LocalBackend.SpawnInput> = []
  return {
    files,
    healthy,
    spawns,
    readText: (path) =>
      Effect.suspend(() => {
        const value = files.get(path)
        if (value === undefined)
          return Effect.fail(new LocalBackend.BackendError({ message: `Missing ${path}`, operation: "readText" }))
        return Effect.succeed(value)
      }),
    writePrivateText: (path, text) => Effect.sync(() => void files.set(path, text)),
    remove: (path) =>
      Effect.sync(() => {
        files.delete(path)
        locks.delete(path)
      }),
    makeDir: () => Effect.void,
    tryAcquireLock: (path) =>
      Effect.sync(() => {
        if (locks.has(path)) return false
        locks.add(path)
        return true
      }),
    releaseLock: (path) => Effect.sync(() => void locks.delete(path)),
    lockAgeMillis: (path) => Effect.sync(() => (locks.has(path) ? 0 : undefined)),
    randomToken: Effect.sync(() => `token-${spawns.length + 1}`),
    spawnServer: (input) =>
      Effect.sync(() => {
        spawns.push(input)
        const spawned = { ...input, url: `http://${input.host}:${input.port}`, pid: 9000 + spawns.length }
        healthy.set(healthKey(spawned.url, input.token), health(spawned))
        return { pid: spawned.pid }
      }),
    health: (url, token) =>
      Effect.suspend(() => {
        const value = healthy.get(healthKey(url, token))
        if (value === undefined)
          return Effect.fail(new LocalBackend.BackendError({ message: "unhealthy", operation: "health" }))
        return Effect.succeed(value)
      }),
    sleep: () => Effect.promise(() => Bun.sleep(0)),
  }
}

const healthKey = (url: string, token: string) => `${url}\n${token}`

const health = (input: {
  readonly url: string
  readonly workspace_root: string
  readonly data_dir: string
  readonly pid: number
}): Remote.BackendHealth => ({
  status: "healthy",
  url: input.url,
  workspace_root: input.workspace_root,
  data_dir: input.data_dir,
  pid: input.pid,
  version: "0.0.0",
})

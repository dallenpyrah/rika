import { describe, expect, test } from "bun:test"
import { Config, IdGenerator, Time } from "@rika/core"
import { OrbActivity } from "@rika/orb"
import { Database, Migration, OrbStore } from "@rika/persistence"
import { Common, Ids } from "@rika/schema"
import { Effect, Layer } from "effect"
import { BackendEndpoint, LocalBackend, Runtime } from "../src/index"

const workspaceRoot = "/workspace/rika-backend-endpoint"
const dataDir = `${workspaceRoot}/.rika`
const threadId = Ids.ThreadId.make("thread_backend_endpoint")
const projectId = Ids.ProjectId.make("project_backend_endpoint")
const now = Common.TimestampMillis.make(2_020_000_000_000)

describe("CLI backend endpoint resolver", () => {
  test("prefers a running orb endpoint over the local backend", async () => {
    const local = fakeLocalBackend()
    const health = fakeHealth()
    const endpoint = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* createRunningOrb()
        return yield* BackendEndpoint.resolveEndpoint({
          thread_id: threadId,
          workspace_root: workspaceRoot,
          data_dir: dataDir,
          mode: "smart",
          env: {},
        })
      }).pipe(Effect.provide(makeLayer(local.service, health.service))),
    )

    expect(endpoint).toMatchObject({
      kind: "orb",
      url: "https://orb-endpoint.rika.test",
      token: "orb-token",
    })
    expect(endpoint).not.toHaveProperty("pid")
    expect(local.connects).toBe(0)
    expect(health.calls).toEqual([{ url: "https://orb-endpoint.rika.test", token: "orb-token" }])
  })

  test("errors for a paused orb instead of falling back to env or local", async () => {
    const local = fakeLocalBackend()
    const health = fakeHealth()
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* createPausedOrb()
        return yield* BackendEndpoint.resolveEndpoint({
          thread_id: threadId,
          workspace_root: workspaceRoot,
          data_dir: dataDir,
          mode: "smart",
          env: {
            RIKA_BACKEND_URL: "https://env.rika.test",
            RIKA_BACKEND_TOKEN: "env-token",
          },
        }).pipe(Effect.flip)
      }).pipe(Effect.provide(makeLayer(local.service, health.service))),
    )

    expect(error).toBeInstanceOf(BackendEndpoint.BackendEndpointError)
    expect(error.message).toContain("paused")
    expect(local.connects).toBe(0)
    expect(health.calls).toEqual([])
  })

  test("errors for a running orb with missing endpoint credentials", async () => {
    const local = fakeLocalBackend()
    const health = fakeHealth()
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* createRunningOrbWithoutEndpoint()
        return yield* BackendEndpoint.resolveEndpoint({
          thread_id: threadId,
          workspace_root: workspaceRoot,
          data_dir: dataDir,
          mode: "smart",
          env: {
            RIKA_BACKEND_URL: "https://env.rika.test",
            RIKA_BACKEND_TOKEN: "env-token",
          },
        }).pipe(Effect.flip)
      }).pipe(Effect.provide(makeLayer(local.service, health.service))),
    )

    expect(error).toBeInstanceOf(BackendEndpoint.BackendEndpointError)
    expect(error.message).toContain("has no endpoint")
    expect(local.connects).toBe(0)
    expect(health.calls).toEqual([])
  })

  test("does not fall back when orb health validation fails", async () => {
    const local = fakeLocalBackend()
    const health = fakeHealth({ fail: true })
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* createRunningOrb()
        return yield* BackendEndpoint.resolveEndpoint({
          thread_id: threadId,
          workspace_root: workspaceRoot,
          data_dir: dataDir,
          mode: "smart",
          env: {
            RIKA_BACKEND_URL: "https://env.rika.test",
            RIKA_BACKEND_TOKEN: "env-token",
          },
        }).pipe(Effect.flip)
      }).pipe(Effect.provide(makeLayer(local.service, health.service))),
    )

    expect(error).toBeInstanceOf(BackendEndpoint.BackendEndpointError)
    expect(local.connects).toBe(0)
    expect(health.calls).toEqual([{ url: "https://orb-endpoint.rika.test", token: "orb-token" }])
  })

  test("uses env endpoint before local backend when no orb is registered", async () => {
    const local = fakeLocalBackend()
    const health = fakeHealth()
    const endpoint = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* BackendEndpoint.resolveEndpoint({
          thread_id: threadId,
          workspace_root: workspaceRoot,
          data_dir: dataDir,
          mode: "smart",
          env: {
            RIKA_BACKEND_URL: "https://env.rika.test/",
            RIKA_BACKEND_TOKEN: "env-token",
          },
        })
      }).pipe(Effect.provide(makeLayer(local.service, health.service))),
    )

    expect(endpoint).toEqual({
      kind: "env",
      url: "https://env.rika.test",
      token: "env-token",
    })
    expect(local.connects).toBe(0)
    expect(health.calls).toEqual([{ url: "https://env.rika.test", token: "env-token" }])
  })

  test("falls back to the local backend when no orb or env endpoint exists", async () => {
    const local = fakeLocalBackend()
    const health = fakeHealth()
    const endpoint = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* BackendEndpoint.resolveEndpoint({
          workspace_root: workspaceRoot,
          data_dir: dataDir,
          mode: "smart",
          env: {},
        })
      }).pipe(Effect.provide(makeLayer(local.service, health.service))),
    )

    expect(endpoint).toMatchObject({
      kind: "local",
      url: "http://127.0.0.1:45555",
      token: "local-token",
      pid: 123,
    })
    expect(local.connects).toBe(1)
    expect(health.calls).toEqual([])
  })

  test("reconnecting client resolves endpoints by request thread id", async () => {
    const urls: Array<string> = []
    const resolved: Array<Ids.ThreadId | undefined> = []
    const touched: Array<Ids.OrbId> = []
    const client = Runtime.reconnectingClient({
      resolveEndpoint: (input) =>
        Effect.sync(() => {
          resolved.push(input.thread_id)
          if (input.thread_id === threadId) {
            return {
              kind: "orb" as const,
              url: "https://orb-endpoint.rika.test",
              token: "orb-token",
              orb_id: Ids.OrbId.make("orb_backend_endpoint"),
              thread_id: threadId,
            }
          }
          return {
            kind: "local" as const,
            url: "http://127.0.0.1:45555",
            token: "local-token",
            workspace_root: workspaceRoot,
            data_dir: dataDir,
            pid: 123,
          }
        }),
      touchOrb: (orbId) =>
        Effect.sync(() => {
          touched.push(orbId)
        }),
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        urls.push(url)
        if (url.startsWith("https://orb-endpoint.rika.test")) {
          return new Response(
            JSON.stringify({
              summary: threadSummary(threadId),
              events: [],
            }),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify([threadSummary(Ids.ThreadId.make("thread_local_backend_endpoint"))]), {
          status: 200,
        })
      },
    })

    const listed = await Effect.runPromise(client.listThreads())
    const opened = await Effect.runPromise(client.openThread(threadId))

    expect(listed.map((summary) => summary.thread_id)).toEqual([Ids.ThreadId.make("thread_local_backend_endpoint")])
    expect(opened.summary.thread_id).toBe(threadId)
    expect(urls[0]).toStartWith("http://127.0.0.1:45555")
    expect(urls[1]).toStartWith("https://orb-endpoint.rika.test")
    expect(resolved).toEqual([undefined, threadId])
    expect(touched).toEqual([Ids.OrbId.make("orb_backend_endpoint")])
  })

  test("reconnecting client rejects stale cached orb endpoints before fetch", async () => {
    const urls: Array<string> = []
    const resolved: Array<Ids.ThreadId | undefined> = []
    let running = true
    const client = Runtime.reconnectingClient({
      resolveEndpoint: (input) =>
        Effect.sync(() => {
          resolved.push(input.thread_id)
          return {
            kind: "orb" as const,
            url: "https://orb-endpoint.rika.test",
            token: "orb-token",
            orb_id: Ids.OrbId.make("orb_backend_endpoint"),
            thread_id: threadId,
          }
        }),
      touchOrb: (orbId) =>
        running
          ? Effect.void
          : Effect.fail(
              new OrbActivity.OrbActivityError({
                message: `Orb ${orbId} is paused`,
                operation: "touch",
                orb_id: orbId,
              }),
            ),
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        urls.push(url)
        return new Response(
          JSON.stringify({
            summary: threadSummary(threadId),
            events: [],
          }),
          { status: 200 },
        )
      },
    })

    await Effect.runPromise(client.openThread(threadId))
    running = false
    const secondError = await Effect.runPromise(client.openThread(threadId).pipe(Effect.flip))
    const resolvedAfterSecond = Array.from(resolved)
    const urlsAfterSecond = Array.from(urls)
    const thirdError = await Effect.runPromise(client.openThread(threadId).pipe(Effect.flip))

    expect(secondError.operation).toBe("backend.touchOrb")
    expect(secondError.message).toContain("paused")
    expect(resolvedAfterSecond).toEqual([threadId])
    expect(urlsAfterSecond).toHaveLength(1)
    expect(thirdError.operation).toBe("backend.touchOrb")
    expect(resolved).toEqual([threadId, threadId])
    expect(urls).toHaveLength(1)
  })
})

const createRunningOrb = () =>
  Effect.gen(function* () {
    const created = yield* OrbStore.create({ thread_id: threadId, project_id: projectId })
    yield* OrbStore.setSandbox(created.orb_id, "sandbox_backend_endpoint")
    yield* OrbStore.setEndpoint(created.orb_id, {
      endpoint_url: "https://orb-endpoint.rika.test",
      token: "orb-token",
    })
    yield* OrbStore.setStatus(created.orb_id, "running")
  })

const createPausedOrb = () =>
  Effect.gen(function* () {
    const created = yield* OrbStore.create({ thread_id: threadId, project_id: projectId })
    yield* OrbStore.setSandbox(created.orb_id, "sandbox_backend_endpoint")
    yield* OrbStore.setEndpoint(created.orb_id, {
      endpoint_url: "https://orb-endpoint.rika.test",
      token: "orb-token",
    })
    yield* OrbStore.setStatus(created.orb_id, "running")
    yield* OrbStore.setStatus(created.orb_id, "paused")
  })

const createRunningOrbWithoutEndpoint = () =>
  Effect.gen(function* () {
    const created = yield* OrbStore.create({ thread_id: threadId, project_id: projectId })
    yield* OrbStore.setSandbox(created.orb_id, "sandbox_backend_endpoint")
    yield* OrbStore.setStatus(created.orb_id, "running")
  })

const makeLayer = (localBackend: LocalBackend.Interface, health: BackendEndpoint.HealthInterface) => {
  const configLayer = Config.layerFromValues({
    workspace_root: workspaceRoot,
    data_dir: dataDir,
    default_mode: "smart",
  })
  const databaseLayer = Database.memoryLayer
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    Migration.layer,
    Time.fixedLayer(now),
    IdGenerator.sequenceLayer(1),
    OrbStore.layer.pipe(
      Layer.provideMerge(databaseLayer),
      Layer.provideMerge(Time.fixedLayer(now)),
      Layer.provideMerge(IdGenerator.sequenceLayer(1)),
    ),
  )
  return Layer.mergeAll(
    storageLayer,
    Layer.succeed(LocalBackend.Service, localBackend),
    Layer.succeed(BackendEndpoint.Health, BackendEndpoint.Health.of(health)),
  )
}

const fakeLocalBackend = () => {
  const state = {
    connects: 0,
    service: LocalBackend.Service.of({
      connectOrStart: () =>
        Effect.sync(() => {
          state.connects += 1
          return {
            kind: "local" as const,
            url: "http://127.0.0.1:45555",
            token: "local-token",
            workspace_root: workspaceRoot,
            data_dir: dataDir,
            pid: 123,
          }
        }),
      status: () =>
        Effect.succeed({
          status: "healthy" as const,
          workspace_root: workspaceRoot,
          data_dir: dataDir,
          endpoint: "http://127.0.0.1:45555",
          pid: 123,
        }),
    }),
  }
  return state
}

const fakeHealth = (input: { readonly fail?: boolean } = {}) => {
  const state = {
    calls: [] as Array<{ readonly url: string; readonly token: string }>,
    service: {
      health: (url: string, token: string) =>
        Effect.suspend(() => {
          state.calls.push({ url, token })
          if (input.fail === true) {
            return Effect.fail(
              new BackendEndpoint.BackendEndpointError({
                message: "health failed",
                operation: "health",
              }),
            )
          }
          return Effect.succeed({
            status: "healthy" as const,
            url,
            workspace_root: "/home/user/repo",
            data_dir: "/home/user/repo/.rika",
            backend_id: "orb-backend",
            version: "0.0.0",
          })
        }),
    },
  }
  return state
}

const threadSummary = (summaryThreadId: Ids.ThreadId) => ({
  thread_id: summaryThreadId,
  workspace_id: Ids.WorkspaceId.make(workspaceRoot),
  diff: { additions: 0, modifications: 0, deletions: 0 },
  archived: false,
  created_at: now,
  updated_at: now,
})

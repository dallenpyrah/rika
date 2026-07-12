import * as BunServices from "@effect/platform-bun/BunServices"
import { OAuth } from "@batonfx/mcp"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Redacted } from "effect"
import { createServer } from "node:http"
import { McpOAuth } from "../src"

if (globalThis.Bun === undefined) {
  const ports = new Set<number>()
  Object.assign(globalThis, {
    Bun: {
      sleep: (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      serve: (options: {
        readonly hostname: string
        readonly port: number
        readonly fetch: (request: Request) => Response | Promise<Response>
      }) => {
        if (ports.has(options.port)) throw new globalThis.Error(`Port ${options.port} is already in use`)
        ports.add(options.port)
        const server = createServer(async (request, response) => {
          const result = await options.fetch(
            new Request(`http://${options.hostname}:${options.port}${request.url ?? "/"}`),
          )
          response.writeHead(result.status, Object.fromEntries(result.headers.entries()))
          response.end(await result.text())
        })
        server.listen(options.port, options.hostname)
        return {
          stop: () => {
            ports.delete(options.port)
            server.close()
          },
        }
      },
    },
  })
}

describe("McpOAuth", () => {
  it("opens the browser and maps command failures", async () => {
    const original = Bun.spawn
    const host = await Effect.runPromise(
      Effect.map(McpOAuth.Host, (value) => value).pipe(Effect.provide(McpOAuth.hostLayer)),
    )
    Object.assign(Bun, { spawn: () => ({ exited: Promise.resolve(0) }) })
    await Effect.runPromise(host.open("https://example.test/authorize"))
    Object.assign(Bun, { spawn: () => ({ exited: Promise.resolve(1) }) })
    const error = await Effect.runPromise(Effect.flip(host.open("https://example.test/authorize")))
    expect(error.operation).toBe("open-browser")
    Object.assign(Bun, { spawn: original })
  })

  it("selects the browser command for every supported platform", async () => {
    const originalSpawn = Bun.spawn
    const originalPlatform = process.platform
    const commands: Array<Array<string>> = []
    Object.assign(Bun, {
      spawn: (command: Array<string>) => {
        commands.push(command)
        return { exited: Promise.resolve(0) }
      },
    })
    const host = await Effect.runPromise(
      Effect.map(McpOAuth.Host, (value) => value).pipe(Effect.provide(McpOAuth.hostLayer)),
    )
    try {
      const openPlatforms = async (platforms: ReadonlyArray<string>): Promise<void> => {
        if (platforms.length === 0) return
        const [platform, ...remaining] = platforms
        Object.defineProperty(process, "platform", { value: platform, configurable: true })
        await Effect.runPromise(host.open("https://example.test/authorize"))
        await openPlatforms(remaining)
      }
      await openPlatforms(["darwin", "win32", "linux"])
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
      Object.assign(Bun, { spawn: originalSpawn })
    }
    expect(commands).toEqual([
      ["open", "https://example.test/authorize"],
      ["cmd", "/c", "start", "", "https://example.test/authorize"],
      ["xdg-open", "https://example.test/authorize"],
    ])
  })

  it("persists redacted tokens in a protected file and removes individual servers", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-oauth-" })
          const filename = `${root}/nested/tokens.json`
          yield* Effect.gen(function* () {
            const store = yield* OAuth.TokenStore
            expect(Option.isNone(yield* store.load("one"))).toBe(true)
            yield* store.save("one", Redacted.make("secret-one"))
            yield* store.save("two", Redacted.make("secret-two"))
            const loaded = yield* store.load("one")
            expect(Option.isSome(loaded) && Redacted.value(loaded.value)).toBe("secret-one")
            expect((yield* fs.stat(filename)).mode & 0o777).toBe(0o600)
            expect(yield* fs.readFileString(filename)).toBe('{"one":"secret-one","two":"secret-two"}')
            expect(String(loaded)).not.toContain("secret-one")
            yield* store.remove("one")
            expect(Option.isNone(yield* store.load("one"))).toBe(true)
            expect(yield* fs.readFileString(filename)).toBe('{"two":"secret-two"}')
          }).pipe(Effect.provide(McpOAuth.tokenStoreLayer(filename)))
        }).pipe(Effect.provide(BunServices.layer)),
      ),
    )
  })

  it("maps malformed and inaccessible token files to provider operations", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "rika-oauth-errors-" })
          const filename = `${root}/tokens.json`
          const run = <A, E>(effect: Effect.Effect<A, E, OAuth.TokenStore>) =>
            effect.pipe(Effect.provide(McpOAuth.tokenStoreLayer(filename)), Effect.provide(BunServices.layer))
          yield* fs.writeFileString(filename, "{")
          expect(
            (yield* Effect.flip(run(Effect.flatMap(OAuth.TokenStore, (store) => store.load("s"))))).operation,
          ).toBe("load")
          expect(
            (yield* Effect.flip(run(Effect.flatMap(OAuth.TokenStore, (store) => store.save("s", Redacted.make("x"))))))
              .operation,
          ).toBe("save")
          expect(
            (yield* Effect.flip(run(Effect.flatMap(OAuth.TokenStore, (store) => store.remove("s"))))).operation,
          ).toBe("remove")
        }).pipe(Effect.provide(BunServices.layer)),
      ),
    )
  })

  it("hosts the real callback path, rejects other paths, and maps bind errors", async () => {
    const host = await Effect.runPromise(
      Effect.map(McpOAuth.Host, (value) => value).pipe(Effect.provide(McpOAuth.hostLayer)),
    )
    const callback = Effect.runPromise(host.callback("http://127.0.0.1:17839/oauth/callback"))
    await Bun.sleep(10)
    expect((await fetch("http://127.0.0.1:17839/wrong")).status).toBe(404)
    const response = await fetch("http://127.0.0.1:17839/oauth/callback?code=ok&state=state")
    expect(await response.text()).toContain("Authentication complete")
    expect(await callback).toContain("code=ok")
    const occupied = Bun.serve({ hostname: "127.0.0.1", port: 17839, fetch: () => new Response() })
    const error = await Effect.runPromise(Effect.flip(host.callback("http://127.0.0.1:17839/oauth/callback")))
    occupied.stop()
    expect(error.operation).toBe("callback")
    expect(error.message).not.toContain("secret")
  })

  it.effect("reports status, logout, and host failures through the service boundary", () => {
    const store = OAuth.tokenStoreMemoryLayer
    const host = McpOAuth.hostTestLayer({
      open: () => Effect.fail(new McpOAuth.Error({ server: "browser", operation: "open-browser", message: "denied" })),
      callback: () => Effect.succeed("unused"),
    })
    const serviceLayer = Layer.merge(McpOAuth.layer.pipe(Layer.provide(host), Layer.provide(store)), store)
    return Effect.gen(function* () {
      const tokenStore = yield* OAuth.TokenStore
      yield* tokenStore.save("https://unused.test", Redacted.make("token"))
      const service = yield* McpOAuth.Service
      expect(yield* service.status("server", "https://unused.test")).toBe("authenticated")
      yield* service.logout("server", "https://unused.test")
      expect(yield* service.status("server", "https://unused.test")).toBe("unauthenticated")
      const login = yield* Effect.flip(service.login("server", "not a url"))
      expect(login.operation).toBe("login")
      expect(login.message).not.toContain("token")
    }).pipe(Effect.provide(serviceLayer))
  })

  it.effect("maps non-Error token store failures through the service boundary", () => {
    const store = Layer.succeed(
      OAuth.TokenStore,
      OAuth.TokenStore.of({
        load: () => Effect.fail("unavailable") as never,
        save: () => Effect.void,
        remove: () => Effect.void,
      }),
    )
    const serviceLayer = McpOAuth.layer.pipe(
      Layer.provide(McpOAuth.hostTestLayer({ open: () => Effect.void, callback: () => Effect.never })),
      Layer.provide(store),
    )
    return Effect.gen(function* () {
      const service = yield* McpOAuth.Service
      const error = yield* Effect.flip(service.status("server", "https://example.test"))
      expect(error.message).toBe("unavailable")
    }).pipe(Effect.provide(serviceLayer))
  })
})

import { describe, expect, test } from "bun:test"
import { Config, Diagnostics, SecretRedactor } from "@rika/core"
import { HttpServer } from "@rika/server"
import { Effect, Fiber, Layer, ManagedRuntime, Ref } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Output, Runtime, Server } from "../src/index"

const testNative = process.env.RIKA_RUN_NATIVE_RIVET_TESTS === "1" ? test : test.skip

describe("CLI server command", () => {
  test("prints the server URL and closes the handle when interrupted", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    const closeRef = Effect.runSync(Ref.make(false))
    const served: Array<HttpServer.ServeInput | undefined> = []
    const httpLayer = Layer.succeed(
      HttpServer.Service,
      HttpServer.Service.of({
        handle: () => Effect.succeed(new Response()),
        serve: (input) =>
          Effect.sync(() => {
            served.push(input)
            return {
              url: "http://127.0.0.1:4587",
              close: () => Ref.set(closeRef, true),
            }
          }),
      }),
    )
    const configLayer = Config.layerFromValues({
      workspace_root: "/workspace/rika-cli-test",
      data_dir: "/workspace/rika-cli-test/.rika",
      default_mode: "smart",
    })
    const redactorLayer = SecretRedactor.layer
    const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
    const layer = Server.layer.pipe(
      Layer.provideMerge(Output.memoryLayer(output)),
      Layer.provideMerge(httpLayer),
      Layer.provideMerge(configLayer),
      Layer.provideMerge(diagnosticsLayer),
    )
    const runtime = ManagedRuntime.make(layer)

    const fiber = runtime.runFork(
      Server.executeCommand({
        type: "server",
        host: "0.0.0.0",
        port: 4587,
        token: "secret",
        workspace_root: "/home/user/repo",
        orb: true,
        base_commit: "abc123",
        ephemeral: true,
      }),
    )
    while (output.stdout.length === 0) await Bun.sleep(1)
    await runtime.runPromise(Fiber.interrupt(fiber))
    const closed = Effect.runSync(Ref.get(closeRef))

    expect(output.stdout).toEqual([JSON.stringify({ url: "http://127.0.0.1:4587" })])
    expect(output.stderr).toEqual([])
    expect(served).toEqual([
      {
        host: "0.0.0.0",
        port: 4587,
        token: "secret",
        workspace_root: "/home/user/repo",
        orb: true,
        base_commit: "abc123",
      },
    ])
    expect(closed).toBe(true)
  })

  test("native layer serves through the Rivet native edge", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    const closeRef = Effect.runSync(Ref.make(false))
    const served: Array<Server.NativeServeInput | undefined> = []
    const nativeLayer = Layer.succeed(
      Server.NativeServerEdge,
      Server.NativeServerEdge.of({
        serve: (input) =>
          Effect.sync(() => {
            served.push(input)
            return {
              url: "http://127.0.0.1:4588",
              close: () => Ref.set(closeRef, true),
            }
          }),
      }),
    )
    const configLayer = Config.layerFromValues({
      workspace_root: "/workspace/rika-cli-test",
      data_dir: "/workspace/rika-cli-test/.rika",
      default_mode: "smart",
    })
    const redactorLayer = SecretRedactor.layer
    const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
    const layer = Server.nativeLayer.pipe(
      Layer.provideMerge(Output.memoryLayer(output)),
      Layer.provideMerge(nativeLayer),
      Layer.provideMerge(configLayer),
      Layer.provideMerge(diagnosticsLayer),
    )
    const runtime = ManagedRuntime.make(layer)

    const fiber = runtime.runFork(
      Server.executeCommand({
        type: "server",
        host: "127.0.0.1",
        port: 4588,
        token: "secret",
        workspace_root: "/home/user/repo",
        orb: false,
        ephemeral: true,
      }),
    )
    while (output.stdout.length === 0) await Bun.sleep(1)
    await runtime.runPromise(Fiber.interrupt(fiber))
    const closed = Effect.runSync(Ref.get(closeRef))

    expect(output.stdout).toEqual([JSON.stringify({ url: "http://127.0.0.1:4588" })])
    expect(output.stderr).toEqual([])
    expect(served).toEqual([
      {
        hostname: "127.0.0.1",
        port: 4588,
        token: "secret",
      },
    ])
    expect(closed).toBe(true)
  })

  test("native layer forwards orb server metadata to the Rivet native edge", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    const closeRef = Effect.runSync(Ref.make(false))
    const served: Array<Server.NativeServeInput | undefined> = []
    const nativeLayer = Layer.succeed(
      Server.NativeServerEdge,
      Server.NativeServerEdge.of({
        serve: (input) =>
          Effect.sync(() => {
            served.push(input)
            return {
              url: "http://127.0.0.1:4589",
              close: () => Ref.set(closeRef, true),
            }
          }),
      }),
    )
    const configLayer = Config.layerFromValues({
      workspace_root: "/workspace/rika-cli-test",
      data_dir: "/workspace/rika-cli-test/.rika",
      default_mode: "smart",
    })
    const redactorLayer = SecretRedactor.layer
    const diagnosticsLayer = Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer))
    const layer = Server.nativeLayer.pipe(
      Layer.provideMerge(Output.memoryLayer(output)),
      Layer.provideMerge(nativeLayer),
      Layer.provideMerge(configLayer),
      Layer.provideMerge(diagnosticsLayer),
    )
    const runtime = ManagedRuntime.make(layer)

    const fiber = runtime.runFork(
      Server.executeCommand({
        type: "server",
        host: "127.0.0.1",
        port: 4589,
        token: "secret",
        workspace_root: "/home/user/repo",
        orb: true,
        base_commit: "abc123",
        ephemeral: true,
      }),
    )
    while (output.stdout.length === 0) await Bun.sleep(1)
    await runtime.runPromise(Fiber.interrupt(fiber))
    const closed = Effect.runSync(Ref.get(closeRef))

    expect(output.stdout).toEqual([JSON.stringify({ url: "http://127.0.0.1:4589" })])
    expect(output.stderr).toEqual([])
    expect(served).toEqual([
      {
        hostname: "127.0.0.1",
        port: 4589,
        token: "secret",
        orb: true,
        workspace_root: "/home/user/repo",
        base_commit: "abc123",
      },
    ])
    expect(closed).toBe(true)
  })

  testNative(
    "native server live layer serves through the real Rivet host and HTTP edge",
    async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), "rika-cli-native-server-"))
      const stdoutWrites: Array<string> = []
      const originalWrite = process.stdout.write.bind(process.stdout)
      const uniqueId = `${process.pid}_${Date.now()}`
      const threadId = `cli_native_smoke_thread_${uniqueId}`
      const workspaceId = `cli_native_smoke_workspace_${uniqueId}`
      const command = {
        type: "server" as const,
        host: "127.0.0.1",
        port: 0,
        token: "secret",
        workspace_root: workspaceRoot,
        orb: false,
        ephemeral: true,
      }
      process.stdout.write = function write(
        chunk: string | Uint8Array,
        encodingOrCallback?: unknown,
        callback?: unknown,
      ) {
        stdoutWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
        if (typeof encodingOrCallback === "function") encodingOrCallback()
        if (typeof callback === "function") callback()
        return true
      }
      const runtime = ManagedRuntime.make(
        Runtime.serverLiveLayer(command, { RIKA_API_KEY: "native-server-smoke-key" }, workspaceRoot),
      )
      const fiber = runtime.runFork(Server.executeCommand(command))

      try {
        for (let attempts = 0; serverUrlFromWrites(stdoutWrites) === undefined && attempts < 12_000; attempts += 1) {
          const exit = fiber.pollUnsafe()
          if (exit !== undefined) throw new Error(String(exit))
          await Bun.sleep(10)
        }
        const url = serverUrlFromWrites(stdoutWrites)
        expect(typeof url).toBe("string")
        if (url === undefined) throw new Error("missing server URL")
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

        const health = await fetch(`${url}/health`)
        expect(health.status).toBe(200)
        const healthBody: unknown = await health.json()
        expect(isObjectRecord(healthBody)).toBe(true)
        if (!isObjectRecord(healthBody)) throw new Error("missing health payload")
        const healthStatus = healthBody.status
        expect(typeof healthStatus).toBe("string")
        if (typeof healthStatus !== "string") throw new Error("missing health status")
        expect(["healthy", "ok"]).toContain(healthStatus)

        const created = await fetch(`${url}/v1/threads`, {
          method: "POST",
          headers: {
            authorization: "Bearer secret",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            thread_id: threadId,
            workspace_id: workspaceId,
          }),
        })
        const createdText = await created.text()
        if (created.status !== 200) throw new Error(`create thread failed ${created.status}: ${createdText}`)
        const summary: unknown = JSON.parse(createdText)
        expect(isObjectRecord(summary)).toBe(true)
        if (!isObjectRecord(summary)) throw new Error("missing thread summary")
        expect(summary).toMatchObject({
          thread_id: threadId,
          workspace_id: workspaceId,
          archived: false,
          visibility: "private",
        })
      } finally {
        await runtime.runPromise(Fiber.interrupt(fiber))
        await Effect.runPromise(runtime.disposeEffect)
        process.stdout.write = originalWrite
        await rm(workspaceRoot, { recursive: true, force: true })
      }
    },
    180_000,
  )
})

const isObjectRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const serverUrlFromWrites = (writes: ReadonlyArray<string>) => {
  for (const write of writes) {
    for (const line of write.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("{")) continue
      try {
        const value: unknown = JSON.parse(trimmed)
        if (isObjectRecord(value) && typeof value.url === "string") return value.url
      } catch {}
    }
  }
  return undefined
}

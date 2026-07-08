import { describe, expect, test } from "bun:test"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Settings } from "@rika/core"
import { OrbPty } from "@rika/orb"
import { ProjectStore } from "@rika/persistence"
import { Ids } from "@rika/schema"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { Runtime, RuntimeEnv } from "../src/index"

describe("CLI runtime environment", () => {
  test("maps global settings to Rika model provider env values", async () => {
    const env = await Effect.runPromise(
      RuntimeEnv.envFromSettings({
        api_key: "dummy",
        base_url: "http://127.0.0.1:8317/v1",
      }),
    )

    expect(env).toEqual({
      RIKA_API_KEY: "dummy",
      RIKA_BASE_URL: "http://127.0.0.1:8317/v1",
    })
  })

  test("gives process env precedence over .env.local, and .env.local over global settings", () => {
    const env = RuntimeEnv.mergeEnv({
      globalSettingsEnv: {
        RIKA_API_KEY: "global-key",
        RIKA_BASE_URL: "http://global.test/v1",
      },
      dotEnvLocalEnv: RuntimeEnv.parseDotEnv(`
        RIKA_API_KEY=local-key
        RIKA_BASE_URL=http://local.test/v1
      `),
      processEnv: {
        RIKA_API_KEY: "process-key",
      },
    })

    expect(env.RIKA_API_KEY).toBe("process-key")
    expect(env.RIKA_BASE_URL).toBe("http://local.test/v1")
  })

  test("loads ~/.rika/settings.json and workspace .env.local", async () => {
    const files = new Map([
      ["/home/user/.rika/settings.json", JSON.stringify({ api_key: "global-key", base_url: "http://global.test/v1" })],
      ["/workspace/rika/.env.local", "RIKA_API_KEY=local-key\n"],
    ])
    const system: RuntimeEnv.System = {
      readText: (path) =>
        files.has(path)
          ? Effect.succeed(files.get(path) ?? "")
          : Effect.fail(Object.assign(new Error(`missing ${path}`), { code: "ENOENT" })),
    }

    const env = await Effect.runPromise(
      RuntimeEnv.load({ env: {}, cwd: "/workspace/rika", home: "/home/user", system }),
    )

    expect(env.RIKA_API_KEY).toBe("local-key")
    expect(env.RIKA_BASE_URL).toBe("http://global.test/v1")
  })

  test("builds a redactor layer from runtime env and command tokens", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const apiKey = yield* SecretRedactor.redact("key env-api-key-secret")
        const serverToken = yield* SecretRedactor.redact("token server-command-token")
        return { apiKey, serverToken }
      }).pipe(
        Effect.provide(
          Runtime.secretRedactorLayer({ RIKA_API_KEY: "env-api-key-secret" }, [
            { label: "RIKA_SERVER_TOKEN", value: "server-command-token" },
          ]),
        ),
      ),
    )

    expect(result).toEqual({
      apiKey: "key [REDACTED:RIKA_API_KEY]",
      serverToken: "token [REDACTED:RIKA_SERVER_TOKEN]",
    })
  })

  test("selects the native Rivet server backend by default", () => {
    expect(Runtime.serverBackendFromEnv({})).toBe("native-rivet")
    expect(Runtime.serverBackendFromEnv({ RIKA_SERVER_BACKEND: "native-rivet" })).toBe("native-rivet")
    expect(Runtime.serverBackendFromEnv({ RIKA_SERVER_BACKEND: "remote-control" })).toBe("native-rivet")
  })

  test("selects the native Rivet backend for server commands even with legacy env", () => {
    expect(Runtime.serverBackendForCommand({ orb: true }, {})).toBe("native-rivet")
    expect(Runtime.serverBackendForCommand({ orb: false }, {})).toBe("native-rivet")
    expect(Runtime.serverBackendForCommand({ orb: true }, { RIKA_SERVER_BACKEND: "native-rivet" })).toBe("native-rivet")
    expect(Runtime.serverBackendForCommand({ orb: true }, { RIKA_SERVER_BACKEND: "remote-control" })).toBe(
      "native-rivet",
    )
  })

  test("normalizes workspace env so command workspace overrides ambient env", () => {
    const env = Runtime.envForWorkspaceRoot(
      { RIKA_WORKSPACE_ROOT: "/workspace/ambient", RIKA_DATA_DIR: "/data/rika" },
      "/workspace/command",
    )

    expect(env).toEqual({
      RIKA_WORKSPACE_ROOT: "/workspace/command",
      RIKA_DATA_DIR: "/data/rika",
    })
  })

  test("native Rivet edge runtime provides project store for project search", async () => {
    const workspaceRoot = `/tmp/rika-native-rivet-runtime-test-${Date.now()}`
    const configLayer = Config.layerFromValues({
      workspace_root: workspaceRoot,
      data_dir: `${workspaceRoot}/.rika`,
      default_mode: "smart",
    })
    const redactorLayer = SecretRedactor.layer
    const diagnosticsLayer = Layer.mergeAll(
      configLayer,
      redactorLayer,
      Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer)),
    )
    class DummyService extends Context.Service<DummyService, Record<string, never>>()(
      "Rika.Cli.Test.NativeRivetDummy",
    ) {}
    class RivetOrbMirrorMarker extends Context.Service<RivetOrbMirrorMarker, Record<string, never>>()(
      "Rika.Cli.Test.RivetOrbMirrorMarker",
    ) {}
    const managedOptions: Array<Record<string, unknown> | undefined> = []
    const ptyEnvs: Array<Readonly<Record<string, string>>> = []
    const mirrorSyncCalls: Array<string> = []
    const dummyLayer = Layer.succeed(DummyService, DummyService.of({}))
    const ptySystemLayer = OrbPty.systemTestLayer({
      open: (input) =>
        Effect.sync(() => {
          ptyEnvs.push(input.env)
          return {
            write: () => Effect.void,
            resize: () => Effect.void,
            close: Effect.void,
          }
        }),
    })
    const fakeRivetHost: Runtime.RivetHostModule = {
      LocalHost: {
        layerFromEnv: () => dummyLayer,
        managedLayerFromEnv: (_env, _cwd, options) =>
          Layer.effect(
            DummyService,
            Effect.sync(() => {
              managedOptions.push(options)
              return DummyService.of({})
            }),
          ),
        threadClientLayerFromEnv: () => dummyLayer,
      },
      NativeEdge: {
        layer: () => dummyLayer,
        serve: () => Effect.fail("unused"),
      },
      ThreadClient: {
        getEvents: () => Effect.succeed([]),
      },
      ThreadDirectory: {
        layer: dummyLayer,
        liveLayer: dummyLayer,
      },
      OrbMirror: {
        layer: Layer.succeed(RivetOrbMirrorMarker, RivetOrbMirrorMarker.of({})),
        syncRunning: () =>
          Effect.sync(() => {
            mirrorSyncCalls.push("sync")
          }),
      },
    }
    const layer = Runtime.nativeRivetEdgeRuntimeLayer(
      fakeRivetHost,
      { type: "server", orb: false, ephemeral: true },
      { RIKA_WORKSPACE_ROOT: "/workspace/ambient" },
      workspaceRoot,
      configLayer,
      redactorLayer,
      diagnosticsLayer,
      ptySystemLayer,
    )
    const runtime = ManagedRuntime.make(layer.pipe(Layer.provideMerge(IdGenerator.sequenceLayer(1))))

    try {
      const project = await runtime.runPromise(
        ProjectStore.create({ name: "backend", repo_origin: "https://github.com/example/backend.git" }),
      )
      const pty = await runtime.runPromise(OrbPty.Service)
      const settings = await runtime.runPromise(Settings.snapshot)
      await runtime.runPromise(
        pty.open({
          workspace_root: workspaceRoot,
          cols: 80,
          rows: 24,
          onData: () => Effect.void,
          onExit: () => Effect.void,
        }),
      )

      expect(project.name).toBe("backend")
      expect(typeof pty.open).toBe("function")
      expect(settings.values.orb.template).toBe("rika-orb")
      expect(ptyEnvs[0]?.RIKA_WORKSPACE_ROOT).toBe(workspaceRoot)
      expect(managedOptions).toHaveLength(1)
      expect(managedOptions[0]?.workspaceAccessLayer).toBeDefined()
      expect(managedOptions[0]?.databaseMode).toBe("memory")
      await runtime.runPromise(Effect.serviceOption(RivetOrbMirrorMarker))
      expect(mirrorSyncCalls).toEqual([])
    } finally {
      await Effect.runPromise(runtime.disposeEffect)
    }
  })

  test("native Rivet actor host always uses memory AgentLoop database even when edge stores are live", async () => {
    const workspaceRoot = `/tmp/rika-native-rivet-memory-host-${Date.now()}`
    const configLayer = Config.layerFromValues({
      workspace_root: workspaceRoot,
      data_dir: `${workspaceRoot}/.rika`,
      default_mode: "smart",
    })
    const redactorLayer = SecretRedactor.layer
    const diagnosticsLayer = Layer.mergeAll(
      configLayer,
      redactorLayer,
      Diagnostics.memoryLayer([]).pipe(Layer.provideMerge(redactorLayer)),
    )
    class DummyService extends Context.Service<DummyService, Record<string, never>>()(
      "Rika.Cli.Test.NativeRivetMemoryHostDummy",
    ) {}
    class RivetOrbMirrorMarker extends Context.Service<RivetOrbMirrorMarker, Record<string, never>>()(
      "Rika.Cli.Test.RivetOrbMirrorMemoryMarker",
    ) {}
    const managedOptions: Array<Record<string, unknown> | undefined> = []
    const dummyLayer = Layer.succeed(DummyService, DummyService.of({}))
    const fakeRivetHost: Runtime.RivetHostModule = {
      LocalHost: {
        layerFromEnv: () => dummyLayer,
        managedLayerFromEnv: (_env, _cwd, options) =>
          Layer.effect(
            DummyService,
            Effect.sync(() => {
              managedOptions.push(options)
              return DummyService.of({})
            }),
          ),
        threadClientLayerFromEnv: () => dummyLayer,
      },
      NativeEdge: {
        layer: () => dummyLayer,
        serve: () => Effect.fail("unused"),
      },
      ThreadClient: {
        getEvents: () => Effect.succeed([]),
      },
      ThreadDirectory: {
        layer: dummyLayer,
        liveLayer: dummyLayer,
      },
      OrbMirror: {
        layer: Layer.succeed(RivetOrbMirrorMarker, RivetOrbMirrorMarker.of({})),
        syncRunning: () => Effect.void,
      },
    }
    const layer = Runtime.nativeRivetEdgeRuntimeLayer(
      fakeRivetHost,
      { type: "server", orb: false, ephemeral: false },
      {},
      workspaceRoot,
      configLayer,
      redactorLayer,
      diagnosticsLayer,
    )
    const runtime = ManagedRuntime.make(layer.pipe(Layer.provideMerge(IdGenerator.sequenceLayer(1))))

    try {
      await runtime.runPromise(Effect.serviceOption(DummyService))
      expect(managedOptions).toHaveLength(1)
      expect(managedOptions[0]?.databaseMode).toBe("memory")
    } finally {
      await Effect.runPromise(runtime.disposeEffect)
    }
  })

  test("probes the native Rivet actor before serving", async () => {
    const calls: Array<{ readonly thread_id: Ids.ThreadId; readonly after_sequence: number }> = []
    const emptyLayer = Layer.empty
    const fakeRivetHost: Runtime.RivetHostModule = {
      LocalHost: {
        layerFromEnv: () => emptyLayer,
        managedLayerFromEnv: () => emptyLayer,
        threadClientLayerFromEnv: () => emptyLayer,
      },
      NativeEdge: {
        layer: () => emptyLayer,
        serve: () => Effect.fail("unused"),
      },
      ThreadClient: {
        getEvents: (input) =>
          Effect.sync(() => {
            calls.push(input)
            return []
          }),
      },
      ThreadDirectory: {
        layer: emptyLayer,
        liveLayer: emptyLayer,
      },
      OrbMirror: {
        layer: emptyLayer,
        syncRunning: () => Effect.void,
      },
    }

    await Effect.runPromise(Runtime.waitForNativeRivetActor(fakeRivetHost))

    expect(calls).toEqual([
      { thread_id: Ids.ThreadId.make(`thread_native_rivet_ready_${process.pid}_1`), after_sequence: 0 },
      { thread_id: Ids.ThreadId.make(`thread_native_rivet_ready_${process.pid}_2`), after_sequence: 0 },
      { thread_id: Ids.ThreadId.make(`thread_native_rivet_ready_${process.pid}_3`), after_sequence: 0 },
    ])
  })
})

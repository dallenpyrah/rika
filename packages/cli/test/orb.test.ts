import { describe, expect, test } from "bun:test"
import { Config, IdGenerator, Time } from "@rika/core"
import { OrbManager } from "@rika/orb"
import { ArtifactStore, Database, Migration, OrbStore } from "@rika/persistence"
import { Client } from "@rika/sdk"
import { Artifact, Common, Ids, Orb, Remote } from "@rika/schema"
import { OrbMirror } from "@rika/server"
import { Effect, Layer, Option, Stream } from "effect"
import { Input, Orb as CliOrb, Output } from "../src/index"

const threadId = Ids.ThreadId.make("thread_cli_orb")
const projectId = Ids.ProjectId.make("project_cli_orb")
const orbId = Ids.OrbId.make("orb_1")
const now = Common.TimestampMillis.make(1_970_000_000_000)
const finalDiff: Remote.OrbChangesResponse = {
  base_commit: "abc123",
  head_commit: "def456",
  diff: "diff --git a/README.md b/README.md",
  dirty: true,
}

describe("CLI orb commands", () => {
  test("list prints an orb table from OrbStore.list", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedOrb("running")
        return yield* CliOrb.executeCommand({ type: "orb", action: "list" })
      }).pipe(Effect.provide(makeLayer({ output }))),
    )

    expect(exitCode).toBe(0)
    expect(output.stderr).toEqual([])
    expect(output.stdout).toEqual([
      "thread\tproject\tstatus\tlast_active_at",
      `${threadId}\t${projectId}\trunning\t${now}`,
    ])
  })

  test("kill with force flushes, stores a final diff artifact, then kills", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedOrb("running")
        const exitCode = yield* CliOrb.executeCommand({
          type: "orb",
          action: "kill",
          thread_id: threadId,
          force: true,
        })
        const stored = yield* OrbStore.get(orbId)
        const artifacts = yield* ArtifactStore.list({ thread_id: threadId, kind: "orb-final-diff" })
        return { exitCode, stored, artifacts }
      }).pipe(Effect.provide(makeLayer({ output, calls }))),
    )

    expect(result.exitCode).toBe(0)
    expect(calls).toEqual(["flush", "changes", "artifact.put", "kill"])
    expect(result.stored?.status).toBe("killed")
    expect(output.stderr).toEqual([])
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0]).toMatchObject({
      thread_id: threadId,
      kind: "orb-final-diff",
      title: "Orb final diff",
      content: finalDiff,
    })
    expect(JSON.stringify(result.artifacts[0]?.content)).not.toContain("orb-token")
  })

  test("kill default no aborts without mutation", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedOrb("running")
        const exitCode = yield* CliOrb.executeCommand({
          type: "orb",
          action: "kill",
          thread_id: threadId,
          force: false,
        })
        const stored = yield* OrbStore.get(orbId)
        const artifacts = yield* ArtifactStore.list({ thread_id: threadId, kind: "orb-final-diff" })
        return { exitCode, stored, artifacts }
      }).pipe(Effect.provide(makeLayer({ output, input: "\n", calls }))),
    )

    expect(result.exitCode).toBe(1)
    expect(calls).toEqual([])
    expect(result.stored?.status).toBe("running")
    expect(result.artifacts).toEqual([])
    expect(output.stderr).toEqual([`Kill orb ${orbId} for thread ${threadId}? [y/N]`, "aborted"])
  })

  test("unreachable kill warns, skips artifact, and still marks killed", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedOrb("running")
        const exitCode = yield* CliOrb.executeCommand({
          type: "orb",
          action: "kill",
          thread_id: threadId,
          force: true,
        })
        const stored = yield* OrbStore.get(orbId)
        const artifacts = yield* ArtifactStore.list({ thread_id: threadId, kind: "orb-final-diff" })
        return { exitCode, stored, artifacts }
      }).pipe(Effect.provide(makeLayer({ output, calls, flushFails: true }))),
    )

    expect(result.exitCode).toBe(0)
    expect(calls).toEqual(["flush", "kill"])
    expect(result.stored?.status).toBe("killed")
    expect(result.artifacts).toEqual([])
    expect(output.stderr[0]).toContain("warning: skipped final orb diff")
  })

  test("artifact persistence failure aborts before kill", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedOrb("running")
        const exit = yield* Effect.result(
          CliOrb.executeCommand({
            type: "orb",
            action: "kill",
            thread_id: threadId,
            force: true,
          }),
        )
        const stored = yield* OrbStore.get(orbId)
        const artifacts = yield* ArtifactStore.list({ thread_id: threadId, kind: "orb-final-diff" })
        return { exit, stored, artifacts }
      }).pipe(Effect.provide(makeLayer({ output, calls, artifactPutFails: true }))),
    )

    expect(result.exit._tag).toBe("Failure")
    if (result.exit._tag === "Failure") {
      expect(result.exit.failure).toBeInstanceOf(ArtifactStore.ArtifactStoreError)
    }
    expect(calls).toEqual(["flush", "changes", "artifact.put"])
    expect(result.stored?.status).toBe("running")
    expect(result.artifacts).toEqual([])
  })

  test("orb changes API failure aborts before kill", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedOrb("running")
        const exit = yield* Effect.result(
          CliOrb.executeCommand({
            type: "orb",
            action: "kill",
            thread_id: threadId,
            force: true,
          }),
        )
        const stored = yield* OrbStore.get(orbId)
        const artifacts = yield* ArtifactStore.list({ thread_id: threadId, kind: "orb-final-diff" })
        return { exit, stored, artifacts }
      }).pipe(Effect.provide(makeLayer({ output, calls, changesFails: true }))),
    )

    expect(result.exit._tag).toBe("Failure")
    if (result.exit._tag === "Failure") {
      expect(result.exit.failure).toBeInstanceOf(Client.SdkError)
    }
    expect(calls).toEqual(["flush", "changes"])
    expect(result.stored?.status).toBe("running")
    expect(result.artifacts).toEqual([])
  })

  test("generic sandbox kill failure does not mark the orb killed locally", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const calls: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* seedOrb("running")
        const exit = yield* Effect.result(
          CliOrb.executeCommand({
            type: "orb",
            action: "kill",
            thread_id: threadId,
            force: true,
          }),
        )
        const stored = yield* OrbStore.get(orbId)
        const artifacts = yield* ArtifactStore.list({ thread_id: threadId, kind: "orb-final-diff" })
        return { exit, stored, artifacts }
      }).pipe(Effect.provide(makeLayer({ output, calls, killFails: true }))),
    )

    expect(result.exit._tag).toBe("Failure")
    if (result.exit._tag === "Failure") {
      expect(result.exit.failure).toBeInstanceOf(OrbManager.OrbProvisionError)
    }
    expect(calls).toEqual(["flush", "changes", "artifact.put", "kill"])
    expect(result.stored?.status).toBe("running")
    expect(result.artifacts).toHaveLength(1)
  })
})

const makeLayer = (input: {
  readonly output: Output.MemoryOutput
  readonly input?: string
  readonly calls?: Array<string>
  readonly flushFails?: boolean
  readonly artifactPutFails?: boolean
  readonly changesFails?: boolean
  readonly killFails?: boolean
}) => {
  const calls = input.calls ?? []
  const configLayer = Config.layerFromValues({
    workspace_root: "/workspace/rika-cli-orb-test",
    data_dir: "/workspace/rika-cli-orb-test/.rika",
    default_mode: "smart",
  })
  const databaseLayer = Database.memoryLayer
  const timeLayer = Time.fixedLayer(now)
  const idLayer = IdGenerator.sequenceLayer(1)
  const artifactLayer = artifactStoreLayer(calls, input.artifactPutFails === true)
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    Migration.layer,
    timeLayer,
    idLayer,
    artifactLayer,
    OrbStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer), Layer.provideMerge(idLayer)),
  )
  const clientFactory: CliOrb.ClientFactory = () =>
    Client.make({
      requestJson: () =>
        Effect.sync(() => {
          calls.push("changes")
        }).pipe(
          Effect.andThen(
            input.changesFails === true
              ? Effect.fail(
                  new Client.SdkError({ message: "orb changes failed", operation: "requestJson", status: 500 }),
                )
              : Effect.succeed(finalDiff),
          ),
        ),
      streamJson: () => Stream.empty,
    })

  const outputLayer = Output.memoryLayer(input.output)
  const inputLayer = Input.memoryLayer(input.input ?? "", true)
  const managerLayer = orbManagerLayer(calls, input.killFails === true).pipe(Layer.provideMerge(storageLayer))
  const mirrorLayer = orbMirrorLayer(calls, input.flushFails === true)
  const commandLayer = CliOrb.layerWithClientFactory(clientFactory).pipe(
    Layer.provideMerge(storageLayer),
    Layer.provideMerge(outputLayer),
    Layer.provideMerge(inputLayer),
    Layer.provideMerge(managerLayer),
    Layer.provideMerge(mirrorLayer),
  )
  return Layer.mergeAll(storageLayer, outputLayer, inputLayer, managerLayer, mirrorLayer, commandLayer)
}

const artifactStoreLayer = (calls: Array<string>, putFails: boolean) => {
  const rows = new Map<Ids.ArtifactId, Artifact.Artifact>()
  return Layer.succeed(
    ArtifactStore.Service,
    ArtifactStore.Service.of({
      put: (artifact) =>
        Effect.sync(() => calls.push("artifact.put")).pipe(
          Effect.andThen(
            putFails
              ? Effect.fail(
                  new ArtifactStore.ArtifactStoreError({
                    message: "artifact store unavailable",
                    operation: "put",
                    artifact_id: artifact.id,
                  }),
                )
              : Effect.sync(() => {
                  rows.set(artifact.id, artifact)
                  return artifact
                }),
          ),
        ),
      get: (artifactId) => Effect.succeed(Option.fromNullishOr(rows.get(artifactId))),
      list: (input) =>
        Effect.succeed(
          [...rows.values()]
            .filter((artifact) => artifact.thread_id === input.thread_id)
            .filter((artifact) => input.kind === undefined || artifact.kind === input.kind)
            .toSorted((left, right) => right.created_at - left.created_at)
            .slice(0, input.limit ?? 100),
        ),
    }),
  )
}

const orbManagerLayer = (
  calls: Array<string>,
  killFails: boolean,
): Layer.Layer<OrbManager.Service, never, OrbStore.Service> =>
  Layer.effect(
    OrbManager.Service,
    Effect.map(OrbStore.Service, (orbs) =>
      OrbManager.Service.of({
        provisionForThread: (input) =>
          Effect.succeed(orbRecord({ thread_id: input.thread_id, project_id: input.project_id })),
        pause: (id) => orbs.setStatus(id, "paused").pipe(Effect.mapError(toOrbProvisionError("pause", id))),
        resume: (id) => orbs.setStatus(id, "running").pipe(Effect.mapError(toOrbProvisionError("resume", id))),
        kill: (id) =>
          Effect.sync(() => calls.push("kill")).pipe(
            Effect.andThen(
              killFails
                ? Effect.fail(
                    new OrbManager.OrbProvisionError({
                      message: "sandbox provider denied kill",
                      step: "kill",
                      orb_id: id,
                    }),
                  )
                : orbs.setStatus(id, "killed").pipe(Effect.mapError(toOrbProvisionError("kill", id))),
            ),
          ),
      }),
    ),
  )

const orbMirrorLayer = (calls: Array<string>, flushFails: boolean) =>
  Layer.succeed(
    OrbMirror.Service,
    OrbMirror.Service.of({
      mirror: () => Effect.void,
      flush: () =>
        Effect.sync(() => calls.push("flush")).pipe(
          Effect.andThen(
            flushFails
              ? Effect.fail(new Client.SdkError({ message: "orb unreachable", operation: "streamJson" }))
              : Effect.void,
          ),
        ),
      mirrorRunningOrbsOnce: () => Effect.void,
      syncRunning: () => Effect.void,
    }),
  )

const seedOrb = (status: Extract<Orb.OrbStatus, "running" | "paused">) =>
  Effect.gen(function* () {
    const created = yield* OrbStore.create({
      thread_id: threadId,
      project_id: projectId,
      sandbox_id: "sandbox_cli_orb",
      base_commit: "abc123",
      endpoint_url: "https://orb.cli.test",
      token: "orb-token",
    })
    return yield* OrbStore.setStatus(created.orb_id, status)
  })

const orbRecord = (override: Partial<Orb.OrbRecord> = {}): Orb.OrbRecord => ({
  orb_id: orbId,
  thread_id: threadId,
  project_id: projectId,
  sandbox_id: "sandbox_cli_orb",
  status: "running",
  base_commit: "abc123",
  endpoint_url: "https://orb.cli.test",
  created_at: now,
  last_active_at: now,
  ...override,
})

const toOrbProvisionError = (step: string, id: Ids.OrbId) => (error: unknown) =>
  new OrbManager.OrbProvisionError({
    message: error instanceof Error ? error.message : String(error),
    step,
    orb_id: id,
  })

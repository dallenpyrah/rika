import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Config, IdGenerator, Time } from "@rika/core"
import { Database, Migration, ProjectStore } from "@rika/persistence"
import { Common, Ids } from "@rika/schema"
import { Effect, Layer, Schema } from "effect"
import { Input, Output, Project } from "../src/index"

const now = Common.TimestampMillis.make(1_980_000_002_000)
const ProjectView = Schema.Struct({
  project_id: Schema.String,
  name: Schema.String,
  repo_origin: Schema.String,
  default_branch: Schema.String,
  template_id: Schema.NullOr(Schema.String),
  env_keys: Schema.Array(Schema.String),
  secret_names: Schema.Array(Schema.String),
  created_at: Schema.Number,
  updated_at: Schema.Number,
})

describe("CLI project commands", () => {
  test("creates, lists, shows, and updates project settings without printing secret values", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-cli-project-"))
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const create = yield* Project.executeCommand({
          type: "project",
          action: "create",
          name: "demo",
          repo_origin: "https://github.com/x/y",
          default_branch: "trunk",
          template_id: "linux",
        })
        const setEnv = yield* Project.executeCommand({
          type: "project",
          action: "set-env",
          name: "demo",
          env_assignment: "FOO=bar",
        })
        const setSecret = yield* Project.executeCommand({
          type: "project",
          action: "set-secret",
          name: "demo",
          secret_name: "TOKEN",
        })
        const show = yield* Project.executeCommand({ type: "project", action: "show", name: "demo" })
        const list = yield* Project.executeCommand({ type: "project", action: "list" })
        const secrets = yield* ProjectStore.secretsForProvision(Ids.ProjectId.make("project_1"))
        return { create, setEnv, setSecret, show, list, secrets }
      }).pipe(Effect.provide(makeLayer(output, dataDir, "s3cret\n"))),
    )

    const create = Schema.decodeUnknownSync(ProjectView)(JSON.parse(output.stdout[0] ?? "{}"))
    const setEnv = Schema.decodeUnknownSync(ProjectView)(JSON.parse(output.stdout[1] ?? "{}"))
    const setSecret = Schema.decodeUnknownSync(ProjectView)(JSON.parse(output.stdout[2] ?? "{}"))
    const show = Schema.decodeUnknownSync(ProjectView)(JSON.parse(output.stdout[3] ?? "{}"))
    const list = Schema.decodeUnknownSync(Schema.Array(ProjectView))(JSON.parse(output.stdout[4] ?? "[]"))

    expect(result).toEqual({ create: 0, setEnv: 0, setSecret: 0, show: 0, list: 0, secrets: { TOKEN: "s3cret" } })
    expect(create).toMatchObject({ name: "demo", env_keys: [], secret_names: [] })
    expect(setEnv).toMatchObject({ name: "demo", env_keys: ["FOO"], secret_names: [] })
    expect(setSecret).toMatchObject({ name: "demo", env_keys: ["FOO"], secret_names: ["TOKEN"] })
    expect(show).toMatchObject({ name: "demo", env_keys: ["FOO"], secret_names: ["TOKEN"] })
    expect(list[0]).toMatchObject({ name: "demo", env_keys: ["FOO"], secret_names: ["TOKEN"] })
    expect(output.stdout.join("\n")).not.toContain("s3cret")
    expect(output.stderr).toEqual([])
    await rm(dataDir, { force: true, recursive: true })
  })

  test("creates a project from the workspace git remote when repo is omitted", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rika-cli-project-"))
    const workspaceRoot = await mkdtemp(join(tmpdir(), "rika-cli-project-workspace-"))
    await runGit(workspaceRoot, ["init"])
    await runGit(workspaceRoot, ["remote", "add", "origin", "https://github.com/x/y"])
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }

    const exitCode = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* Project.executeCommand({
          type: "project",
          action: "create",
          name: "demo",
        })
      }).pipe(Effect.provide(makeLayer(output, dataDir, "", workspaceRoot))),
    )

    const create = Schema.decodeUnknownSync(ProjectView)(JSON.parse(output.stdout[0] ?? "{}"))

    expect(exitCode).toBe(0)
    expect(create).toMatchObject({ name: "demo", repo_origin: "https://github.com/x/y" })
    expect(output.stderr).toEqual([])
    await rm(dataDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  })
})

const makeLayer = (
  output: Output.MemoryOutput,
  dataDir: string,
  input: string,
  workspaceRoot = "/workspace/rika-cli-project-test",
) => {
  const configLayer = Config.layerFromValues({
    workspace_root: workspaceRoot,
    data_dir: dataDir,
    default_mode: "smart",
  })
  const databaseLayer = Database.memoryLayer
  const timeLayer = Time.fixedLayer(now)
  const idLayer = IdGenerator.sequenceLayer(1)
  const projectStoreLayer = ProjectStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(idLayer),
  )
  return Project.layer.pipe(
    Layer.provideMerge(Output.memoryLayer(output)),
    Layer.provideMerge(Input.memoryLayer(input)),
    Layer.provideMerge(projectStoreLayer),
    Layer.provideMerge(configLayer),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(Migration.layer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(idLayer),
  )
}

const runGit = async (cwd: string, args: ReadonlyArray<string>) => {
  const subprocess = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()])
  if (exitCode !== 0) throw new Error(stderr)
}

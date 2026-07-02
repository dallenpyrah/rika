import { Config } from "@rika/core"
import { Client } from "@rika/sdk"
import { Ids } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { mkdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as Args from "./args"
import * as BackendEndpoint from "./backend-endpoint"
import * as Output from "./output"

export class SyncError extends Schema.TaggedErrorClass<SyncError>()("SyncError", {
  message: Schema.String,
  exit_code: Schema.Int,
}) {}

export type RunError = BackendEndpoint.ResolveError | Client.SdkError | SyncError

export interface SystemInterface {
  readonly exists: (path: string) => Effect.Effect<boolean, SyncError>
  readonly makeDir: (path: string) => Effect.Effect<void, SyncError>
  readonly remove: (path: string) => Effect.Effect<void, SyncError>
  readonly writeText: (path: string, text: string) => Effect.Effect<void, SyncError>
  readonly runGit: (cwd: string, args: ReadonlyArray<string>) => Effect.Effect<string, SyncError>
}

export class System extends Context.Service<System, SystemInterface>()("@rika/cli/Sync/System") {}

export interface Interface {
  readonly executeCommand: (command: Args.SyncCommand) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Sync") {}

const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const output = yield* Output.Service
    const config = yield* Config.Service
    const resolver = yield* BackendEndpoint.Resolver
    const system = yield* System

    return Service.of({
      executeCommand: Effect.fn("Cli.Sync.executeCommand")(function* (command: Args.SyncCommand) {
        const values = yield* config.get
        const endpoint = yield* resolver.resolveEndpoint({
          thread_id: command.thread_id,
          workspace_root: values.workspace_root,
          data_dir: values.data_dir,
          mode: values.default_mode,
          env: {},
        })
        if (endpoint.kind !== "orb") {
          return yield* new SyncError({
            message: `Thread ${command.thread_id} is not backed by a running orb`,
            exit_code: 2,
          })
        }

        const client = Client.make(Client.fetchTransport({ base_url: endpoint.url, token: endpoint.token }))
        const changes = yield* client.orbChanges()
        yield* verifyBaseCommit(system, values.workspace_root, changes.base_commit)

        const segment = yield* safeThreadSegment(command.thread_id)
        const worktreeParent = join(values.workspace_root, ".rika", "worktrees")
        const worktree = join(worktreeParent, segment)
        const branch = `rika/orb/${segment}`
        yield* system.makeDir(worktreeParent)
        const worktreeExists = yield* system.exists(worktree)
        if (!worktreeExists) {
          yield* system.runGit(values.workspace_root, ["worktree", "add", "-B", branch, worktree, changes.base_commit])
        } else {
          yield* system.runGit(worktree, ["checkout", "-B", branch, changes.base_commit])
        }
        yield* system.runGit(worktree, ["reset", "--hard", changes.base_commit])
        yield* system.runGit(worktree, ["clean", "-fd"])
        if (changes.diff.trim().length === 0) {
          yield* output.stdout("no changes yet")
          return 0
        }
        const patchPath = join(values.data_dir, `sync-${segment}.patch`)
        yield* system.makeDir(values.data_dir)
        yield* system.writeText(patchPath, changes.diff)
        yield* system
          .runGit(worktree, ["apply", "--binary", "--whitespace=nowarn", patchPath])
          .pipe(Effect.ensuring(system.remove(patchPath).pipe(Effect.ignore)))
        const status = yield* system.runGit(worktree, ["status", "--short"])
        const firstLine = status.split(/\r?\n/).find((line) => line.length > 0)
        yield* output.stdout(worktree)
        if (firstLine !== undefined) yield* output.stdout(firstLine)
        return 0
      }),
    })
  }),
)

export const systemLayer = Layer.succeed(
  System,
  System.of({
    exists: Effect.fn("Cli.Sync.System.exists")(function* (path: string) {
      return yield* Effect.tryPromise({
        try: async () => {
          try {
            await stat(path)
            return true
          } catch (cause) {
            if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false
            throw cause
          }
        },
        catch: (cause) => new SyncError({ message: errorMessage(cause), exit_code: 1 }),
      })
    }),
    makeDir: Effect.fn("Cli.Sync.System.makeDir")(function* (path: string) {
      yield* Effect.tryPromise({
        try: () => mkdir(path, { recursive: true }),
        catch: (cause) => new SyncError({ message: errorMessage(cause), exit_code: 1 }),
      })
    }),
    remove: Effect.fn("Cli.Sync.System.remove")(function* (path: string) {
      yield* Effect.tryPromise({
        try: () => rm(path, { force: true }),
        catch: (cause) => new SyncError({ message: errorMessage(cause), exit_code: 1 }),
      })
    }),
    writeText: Effect.fn("Cli.Sync.System.writeText")(function* (path: string, text: string) {
      yield* Effect.tryPromise({
        try: () => writeFile(path, text),
        catch: (cause) => new SyncError({ message: errorMessage(cause), exit_code: 1 }),
      })
    }),
    runGit: Effect.fn("Cli.Sync.System.runGit")(function* (cwd: string, args: ReadonlyArray<string>) {
      return yield* Effect.tryPromise({
        try: async () => {
          const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(process.stdout).text(),
            new Response(process.stderr).text(),
            process.exited,
          ])
          if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`)
          return stdout
        },
        catch: (cause) => new SyncError({ message: errorMessage(cause), exit_code: 1 }),
      })
    }),
  }),
)

export const layer = serviceLayer.pipe(Layer.provide(systemLayer))

export const executeCommand = Effect.fn("Cli.Sync.executeCommand.call")(function* (command: Args.SyncCommand) {
  const service = yield* Service
  return yield* service.executeCommand(command)
})

export const formatError = (error: Args.ArgsError | RunError) => {
  if (error instanceof Args.ArgsError && error.usage !== undefined) return `${error.message}\n${error.usage}`
  if (error instanceof Args.ArgsError || error instanceof SyncError) return error.message
  if (error instanceof BackendEndpoint.BackendEndpointError) return error.message
  if (error instanceof Client.SdkError) return error.message
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const verifyBaseCommit = Effect.fn("Cli.Sync.verifyBaseCommit")(function* (
  system: SystemInterface,
  workspaceRoot: string,
  baseCommit: string,
) {
  const result = yield* Effect.result(system.runGit(workspaceRoot, ["cat-file", "-e", `${baseCommit}^{commit}`]))
  if (result._tag === "Failure") {
    return yield* new SyncError({
      message: `base commit ${baseCommit} not found locally — fetch or pull first`,
      exit_code: 1,
    })
  }
  return undefined
})

const safeThreadSegment = (threadId: Ids.ThreadId): Effect.Effect<string, SyncError> => {
  if (/^[A-Za-z0-9._-]+$/.test(threadId)) return Effect.succeed(threadId)
  return Effect.fail(new SyncError({ message: `Thread id ${threadId} is not safe for a worktree path`, exit_code: 2 }))
}

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

import { Remote } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"

export class OrbChangesError extends Schema.TaggedErrorClass<OrbChangesError>()("OrbChangesError", {
  message: Schema.String,
  operation: Schema.String,
  workspace_root: Schema.String,
}) {}

export interface ChangesInput extends Schema.Schema.Type<typeof ChangesInput> {}
export const ChangesInput = Schema.Struct({
  workspace_root: Schema.String,
  base_commit: Schema.String,
}).annotate({ identifier: "Rika.Orb.OrbChanges.ChangesInput" })

export interface SystemInterface {
  readonly runGit: (workspaceRoot: string, args: ReadonlyArray<string>) => Effect.Effect<string, OrbChangesError>
}

export class System extends Context.Service<System, SystemInterface>()("@rika/orb/OrbChanges/System") {}

export interface Interface {
  readonly changes: (input: ChangesInput) => Effect.Effect<Remote.OrbChangesResponse, OrbChangesError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/orb/OrbChanges") {}

const workspacePathspec = [".", ":(exclude).rika/**"] as const

const serviceLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const system = yield* System
    return Service.of({
      changes: Effect.fn("OrbChanges.changes")(function* (input: ChangesInput) {
        yield* system.runGit(input.workspace_root, ["add", "-N", "--", ...workspacePathspec])
        const headCommit = yield* system.runGit(input.workspace_root, ["rev-parse", "HEAD"])
        const diff = yield* system.runGit(input.workspace_root, [
          "diff",
          "--binary",
          "--no-ext-diff",
          "--no-textconv",
          input.base_commit,
          "--",
          ...workspacePathspec,
        ])
        const status = yield* system.runGit(input.workspace_root, ["status", "--porcelain", "--", ...workspacePathspec])
        return {
          base_commit: input.base_commit,
          head_commit: headCommit.trim(),
          diff,
          dirty: status.trim().length > 0,
        }
      }),
    })
  }),
)

export const systemLayer = Layer.succeed(
  System,
  System.of({
    runGit: Effect.fn("OrbChanges.System.runGit")(function* (workspaceRoot: string, args: ReadonlyArray<string>) {
      return yield* Effect.tryPromise({
        try: async () => {
          const process = Bun.spawn(["git", ...args], { cwd: workspaceRoot, stdout: "pipe", stderr: "pipe" })
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(process.stdout).text(),
            new Response(process.stderr).text(),
            process.exited,
          ])
          if (exitCode !== 0) {
            throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`)
          }
          return stdout
        },
        catch: (cause) =>
          new OrbChangesError({
            message: cause instanceof Error ? cause.message : String(cause),
            operation: `git ${args[0] ?? "unknown"}`,
            workspace_root: workspaceRoot,
          }),
      })
    }),
  }),
)

export const layer = serviceLayer.pipe(Layer.provide(systemLayer))

export const testLayer = (implementation: Interface) => Layer.succeed(Service, Service.of(implementation))

export const systemTestLayer = (implementation: SystemInterface) => Layer.succeed(System, System.of(implementation))

export const layerWithSystem = (system: Layer.Layer<System>) => serviceLayer.pipe(Layer.provide(system))

export const changes = Effect.fn("OrbChanges.changes.call")(function* (input: ChangesInput) {
  const service = yield* Service
  return yield* service.changes(input)
})

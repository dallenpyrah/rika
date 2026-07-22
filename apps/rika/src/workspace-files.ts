import type { PathTarget } from "@rika/tui"
import { Effect, FileSystem, Function, Path, PlatformError, Schema } from "effect"

type PathOperations = {
  readonly isAbsolute: (path: string) => boolean
  readonly relative: (from: string, to: string) => string
  readonly resolve: (...paths: ReadonlyArray<string>) => string
}

const realpath = (path: string) => FileSystem.FileSystem.pipe(Effect.flatMap((fileSystem) => fileSystem.realPath(path)))
const stat = (path: string) => FileSystem.FileSystem.pipe(Effect.flatMap((fileSystem) => fileSystem.stat(path)))

const fffError = (workspace: string, method: string, cause: unknown) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FFF",
    method,
    pathOrDescriptor: workspace,
    description: cause instanceof Error ? cause.message : String(cause),
    cause,
  })

type FffModule = typeof import("@ff-labs/fff-node")

const importFffModule = (workspace: string, specifier: string) =>
  Effect.tryPromise({
    try: () => import(specifier) as Promise<FffModule>,
    catch: (cause) => fffError(workspace, "initialize", cause),
  })

const loadFileFinder = (workspace: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const modulePath = path.join(
      path.dirname(process.execPath),
      "node_modules",
      "@ff-labs",
      "fff-node",
      "dist",
      "src",
      "index.js",
    )
    const moduleUrl = yield* path
      .toFileUrl(modulePath)
      .pipe(Effect.mapError((cause) => fffError(workspace, "initialize", cause)))
    return yield* importFffModule(workspace, moduleUrl.href).pipe(
      Effect.catch(() => importFffModule(workspace, "@ff-labs/fff-node")),
    )
  })

const fffGlob = (workspace: string, pattern: string, maximumFiles: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { FileFinder } = yield* loadFileFinder(workspace)
      const created = yield* Effect.try({
        try: () => FileFinder.create({ basePath: workspace, aiMode: true }),
        catch: (cause) => fffError(workspace, "initialize", cause),
      })
      if (!created.ok) return yield* fffError(workspace, "initialize", created.error)
      const finder = yield* Effect.acquireRelease(Effect.succeed(created.value), (acquiredFinder) =>
        Effect.sync(() => acquiredFinder.destroy()).pipe(Effect.ignore),
      )
      const scanned = yield* Effect.tryPromise({
        try: () => finder.waitForScan(10_000),
        catch: (cause) => fffError(workspace, "scan", cause),
      })
      if (!scanned.ok) return yield* fffError(workspace, "scan", scanned.error)
      if (!scanned.value) return yield* fffError(workspace, "scan", "Initial workspace scan timed out")
      const result = yield* Effect.try({
        try: () => finder.glob(pattern, { pageSize: maximumFiles }),
        catch: (cause) => fffError(workspace, "glob", cause),
      })
      if (!result.ok) return yield* fffError(workspace, "glob", result.error)
      return result.value.items.map((item) => item.relativePath)
    }),
  )

export const internal = { fffGlob }

export class WorkspaceFileError extends Schema.TaggedErrorClass<WorkspaceFileError>()("WorkspaceFileError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export const makeWorkspaceFiles = ({ isAbsolute, relative, resolve }: PathOperations) => {
  const resolveWorkspacePathImpl = (workspace: string, target: PathTarget): string => {
    const root = resolve(workspace)
    const path = resolve(root, target.path)
    const relation = relative(root, path)
    if (
      relation === ".." ||
      relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(relation)
    )
      throw new Error("Path is outside the workspace")
    return path
  }

  const resolveWorkspacePath: {
    (target: PathTarget): (workspace: string) => string
    (workspace: string, target: PathTarget): string
  } = Function.dual(2, resolveWorkspacePathImpl)

  const resolveWorkspaceFileImpl = Effect.fn("WorkspaceFiles.resolveWorkspaceFile")(function* (
    workspace: string,
    target: PathTarget,
  ) {
    if (target.path.length === 0 || isAbsolute(target.path))
      return yield* WorkspaceFileError.make({ path: target.path, message: "Path is outside the workspace" })
    const root = yield* realpath(workspace).pipe(
      Effect.mapError(() => WorkspaceFileError.make({ path: target.path, message: "Workspace is unavailable" })),
    )
    const candidate = resolve(root, target.path)
    const lexicalRelation = relative(root, candidate)
    if (lexicalRelation === ".." || lexicalRelation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
      return yield* WorkspaceFileError.make({ path: target.path, message: "Path is outside the workspace" })
    const path = yield* realpath(candidate).pipe(
      Effect.mapError(() => WorkspaceFileError.make({ path: target.path, message: "Path does not exist" })),
    )
    const relation = relative(root, path)
    if (
      relation === ".." ||
      relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(relation)
    )
      return yield* WorkspaceFileError.make({ path: target.path, message: "Path is outside the workspace" })
    const info = yield* stat(path).pipe(
      Effect.mapError(() => WorkspaceFileError.make({ path: target.path, message: "Path is unavailable" })),
    )
    if (info.type !== "File")
      return yield* WorkspaceFileError.make({ path: target.path, message: "Path is not a file" })
    return path
  })

  const resolveWorkspaceFile: {
    (target: PathTarget): (workspace: string) => Effect.Effect<string, WorkspaceFileError, FileSystem.FileSystem>
    (workspace: string, target: PathTarget): Effect.Effect<string, WorkspaceFileError, FileSystem.FileSystem>
  } = Function.dual(2, (workspace: string, target: PathTarget) => resolveWorkspaceFileImpl(workspace, target))

  return { resolveWorkspaceFile, resolveWorkspaceFileImpl, resolveWorkspacePath }
}

import type {
  FileFinderApi,
  GrepOptions,
  GrepResult,
  Result as FffResult,
  SearchOptions,
  SearchResult,
} from "@ff-labs/fff-node"
import { Context, Effect, Function, Layer, Path, Schema } from "effect"

export interface GlobOptions {
  readonly maxThreads?: number
  readonly currentFile?: string
  readonly pageIndex?: number
  readonly pageSize?: number
}

export type { GrepOptions, GrepResult, SearchOptions, SearchResult }

export const Operation = Schema.Literals(["initialize", "scan", "fileSearch", "glob", "grep"])
export type Operation = typeof Operation.Type

export class WorkspaceIndexError extends Schema.TaggedErrorClass<WorkspaceIndexError>()("WorkspaceIndexError", {
  operation: Operation,
  message: Schema.String,
}) {}

export interface Interface {
  readonly fileSearch: (query: string, options?: SearchOptions) => Effect.Effect<SearchResult, WorkspaceIndexError>
  readonly glob: (pattern: string, options?: GlobOptions) => Effect.Effect<SearchResult, WorkspaceIndexError>
  readonly grep: (query: string, options?: GrepOptions) => Effect.Effect<GrepResult, WorkspaceIndexError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/tools/workspace-index/Service") {}

const indexError = (operation: Operation, cause: unknown) =>
  WorkspaceIndexError.make({ operation, message: cause instanceof Error ? cause.message : String(cause) })

const unwrap = <A>(operation: Operation, result: FffResult<A>): Effect.Effect<A, WorkspaceIndexError> =>
  result.ok ? Effect.succeed(result.value) : Effect.fail(indexError(operation, result.error))

const call = <A>(operation: Operation, evaluate: () => FffResult<A>) =>
  Effect.try({ try: evaluate, catch: (cause) => indexError(operation, cause) }).pipe(
    Effect.flatMap((result) => unwrap(operation, result)),
  )

type FffModule = typeof import("@ff-labs/fff-node")

const importFffModule = (specifier: string) =>
  Effect.tryPromise({
    try: () => import(specifier) as Promise<FffModule>,
    catch: (cause) => indexError("initialize", cause),
  })

const loadFileFinder = Effect.gen(function* () {
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
  const moduleUrl = yield* path.toFileUrl(modulePath).pipe(Effect.mapError((cause) => indexError("initialize", cause)))
  return yield* importFffModule(moduleUrl.href).pipe(Effect.catch(() => importFffModule("@ff-labs/fff-node")))
})

const fromFinder = (finder: FileFinderApi): Interface => ({
  fileSearch: (query, options) => call("fileSearch", () => finder.fileSearch(query, options)),
  glob: (pattern, options) => call("glob", () => finder.glob(pattern, options)),
  grep: (query, options) => call("grep", () => finder.grep(query, options)),
})

const makeLayer = (workspace: string, scanTimeoutMillis: number) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { FileFinder } = yield* loadFileFinder
      const finder = yield* Effect.acquireRelease(
        call("initialize", () => FileFinder.create({ basePath: workspace, aiMode: true })),
        (acquired) => Effect.sync(() => acquired.destroy()).pipe(Effect.ignore),
      )
      const scanned = yield* Effect.tryPromise({
        try: () => finder.waitForScan(scanTimeoutMillis),
        catch: (cause) => indexError("scan", cause),
      }).pipe(Effect.flatMap((result) => unwrap("scan", result)))
      if (!scanned) return yield* indexError("scan", `Initial workspace scan timed out after ${scanTimeoutMillis}ms`)
      return Service.of(fromFinder(finder))
    }),
  )

export const layer: {
  (workspace: string): Layer.Layer<Service, WorkspaceIndexError>
  (scanTimeoutMillis: number): (workspace: string) => Layer.Layer<Service, WorkspaceIndexError>
  (workspace: string, scanTimeoutMillis: number): Layer.Layer<Service, WorkspaceIndexError>
} = Function.dual(
  (args) => args.length === 1 && typeof args[0] === "string",
  (workspace: string, scanTimeoutMillis = 10_000) => makeLayer(workspace, scanTimeoutMillis),
)

export const testLayer = (implementation: Interface) => Layer.succeed(Service, Service.of(implementation))

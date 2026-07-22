import { FileFinder } from "@ff-labs/fff-bun"
import type {
  FileFinderApi,
  GrepOptions,
  GrepResult,
  Result as FffResult,
  SearchOptions,
  SearchResult,
} from "@ff-labs/fff-bun"
import { Context, Effect, Layer, Schema } from "effect"

declare global {
  const FFF_LIBC: "gnu" | "musl"
}

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

const fromFinder = (finder: FileFinderApi): Interface => ({
  fileSearch: (query, options) => call("fileSearch", () => finder.fileSearch(query, options)),
  glob: (pattern, options) => call("glob", () => finder.glob(pattern, options)),
  grep: (query, options) => call("grep", () => finder.grep(query, options)),
})

const scanTimeoutMillis = 10_000

const acquireIndex = (workspace: string) =>
  Effect.gen(function* () {
    const finder = yield* Effect.acquireRelease(
      call("initialize", () => FileFinder.create({ basePath: workspace, aiMode: true })),
      (acquired) => Effect.sync(() => acquired.destroy()).pipe(Effect.ignore),
    )
    const scanned = yield* Effect.tryPromise({
      try: () => finder.waitForScan(scanTimeoutMillis),
      catch: (cause) => indexError("scan", cause),
    }).pipe(Effect.flatMap((result) => unwrap("scan", result)))
    if (!scanned) return yield* indexError("scan", `Initial workspace scan timed out after ${scanTimeoutMillis}ms`)
    return fromFinder(finder)
  })

export const layer = (workspace: string) => Layer.effect(Service, Effect.map(acquireIndex(workspace), Service.of))

export const globOnce = (request: {
  readonly workspace: string
  readonly pattern: string
  readonly options?: GlobOptions
}) =>
  Effect.scoped(
    Effect.flatMap(acquireIndex(request.workspace), (index) => index.glob(request.pattern, request.options)),
  )

export const testLayer = (implementation: Interface) => Layer.succeed(Service, Service.of(implementation))

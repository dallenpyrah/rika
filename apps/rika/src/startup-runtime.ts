import { Operation } from "@rika/app"
import * as Turn from "@rika/persistence/turn"
import { Effect, FileSystem, Function, PlatformError, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { executionModelRoutes } from "./model-routing"
import { ExternalBoundaryError } from "./test-model-script"

type Operations = {
  readonly basename: (path: string) => string
  readonly dirname: (path: string) => string
  readonly resolve: (...paths: ReadonlyArray<string>) => string
  readonly mkdir: (
    path: string,
    options?: { readonly recursive?: boolean },
  ) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>
  readonly realpath: (path: string) => Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem>
}

export const withClientWorkspace: {
  (workspace: string): (input: Operation.Input) => Operation.Input
  (input: Operation.Input, workspace: string): Operation.Input
} = Function.dual(2, (input: Operation.Input, workspace: string): Operation.Input => {
  if (input._tag === "Interactive" || input._tag === "Run" || input._tag === "Review")
    return { ...input, clientWorkspace: workspace, workspace: input.workspace ?? workspace }
  if (input._tag === "Mcp" && input.action === "approve")
    return { ...input, clientWorkspace: workspace, workspace: input.workspace ?? workspace }
  if (
    input._tag === "Skill" ||
    input._tag === "Mcp" ||
    input._tag === "Extension" ||
    input._tag === "Config" ||
    input._tag === "Auth" ||
    input._tag === "Doctor" ||
    input._tag === "Thread" ||
    input._tag === "Workflow"
  )
    return { ...input, clientWorkspace: workspace }
  return input
})

export const persistedModelRoutesForStartup = (turns: ReadonlyArray<Turn.Turn>) =>
  turns.flatMap((turn) => executionModelRoutes(turn.executionRoute))
const persistedExecutionRouteRow = Schema.Struct({ execution_route_json: Schema.String })
const persistedExecutionRouteJson = Schema.fromJsonString(Turn.ExecutionRoutePin)
export const persistedTitleModelRoutesForStartup = Effect.gen(function* () {
  const sql = yield* SqlClient
  const rows = yield* sql`SELECT execution_route_json FROM rika_turns`
  const routes = yield* Effect.forEach(rows, (row) =>
    Schema.decodeUnknownEffect(persistedExecutionRouteRow)(row).pipe(
      Effect.flatMap((decoded) =>
        Schema.decodeUnknownEffect(persistedExecutionRouteJson)(decoded.execution_route_json),
      ),
    ),
  )
  return routes.flatMap((route) => (route.title === undefined ? [] : [route.title]))
}).pipe(Effect.withSpan("StartupRuntime.persistedTitleModelRoutesForStartup"))

export const makeStartupRuntime = ({ basename, dirname, mkdir, realpath, resolve }: Operations) => {
  const impl = Effect.fn("StartupRuntime.canonicalDatabaseRoot")(function* (
    productDatabase: string,
    relayDatabase: string,
  ) {
    if (basename(productDatabase) !== "rika.db" || basename(relayDatabase) !== "relay.db")
      return yield* ExternalBoundaryError.make({
        operation: "canonicalize database root",
        message: "RIKA_DATABASE and RIKA_RELAY_DATABASE must name rika.db and relay.db in one data directory",
      })
    const productRoot = dirname(resolve(productDatabase))
    const relayRoot = dirname(resolve(relayDatabase))
    yield* Effect.all([mkdir(productRoot, { recursive: true }), mkdir(relayRoot, { recursive: true })], {
      concurrency: 2,
    })
    const [canonicalProductRoot, canonicalRelayRoot] = yield* Effect.all([realpath(productRoot), realpath(relayRoot)], {
      concurrency: 2,
    })
    if (canonicalProductRoot !== canonicalRelayRoot)
      return yield* ExternalBoundaryError.make({
        operation: "canonicalize database root",
        message: "RIKA_DATABASE and RIKA_RELAY_DATABASE must use one data directory",
      })
    return canonicalProductRoot
  })
  const canonicalDatabaseRoot: {
    (relayDatabase: string): (productDatabase: string) => ReturnType<typeof impl>
    (productDatabase: string, relayDatabase: string): ReturnType<typeof impl>
  } = Function.dual(2, impl)
  return { canonicalDatabaseRoot }
}

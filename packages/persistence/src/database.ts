import { Database as BunSqliteDatabase } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Config } from "@rika/core"
import { Context, Effect, Layer, Schema } from "effect"
import { drizzle } from "drizzle-orm/bun-sqlite"
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import type { SQL } from "drizzle-orm"
import { schema } from "./schema"

export type Dialect = "sqlite"

export type DrizzleDatabase = SQLiteBunDatabase<typeof schema> & QueryMethods

export interface QueryMethods {
  readonly get: <T extends Record<string, unknown>>(query: SQL) => T | undefined
  readonly all: <T extends Record<string, unknown>>(query: SQL) => T[]
  readonly run: (query: SQL) => unknown
}

export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()("DatabaseError", {
  message: Schema.String,
  operation: Schema.String,
}) {}

export interface Interface {
  readonly dialect: Dialect
  readonly withDatabase: <A>(operation: (database: DrizzleDatabase) => A) => Effect.Effect<A, DatabaseError>
  readonly withDatabaseEffect: <A, E, R>(
    operation: (database: DrizzleDatabase) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | DatabaseError, R>
  readonly queryGet: <T>(query: SQL) => Effect.Effect<T | undefined, DatabaseError>
  readonly queryAll: <T>(query: SQL) => Effect.Effect<ReadonlyArray<T>, DatabaseError>
  readonly queryRun: (query: SQL) => Effect.Effect<void, DatabaseError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/persistence/Database") {}

export const dialectFromUrl = (url: string | undefined): Dialect => {
  void url
  return "sqlite"
}

export const pathFromConfig = (config: Config.Values) => config.database_url ?? `${config.data_dir}/rika.sqlite`

export const dialect = Effect.fn("Database.dialect")(function* () {
  const database = yield* Service
  return database.dialect
})

export const layerFromPath = (path: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const sqlite = yield* openSqlite(path)
      const database = drizzle({ client: sqlite, schema }) as DrizzleDatabase
      return Service.of(makeSqliteService(database))
    }),
  )

export const memoryLayer = layerFromPath(":memory:")

export const layerFromUrl = (url: string) => {
  if (isPostgresUrl(url)) {
    return Layer.effect(
      Service,
      Effect.fail(new DatabaseError({ message: "Rika local persistence only supports SQLite", operation: "open" })),
    )
  }
  if (url === ":memory:" || url.startsWith("file::memory:")) return memoryLayer
  const path = url.startsWith("file:") ? url.slice("file:".length) : url
  return layerFromPath(path)
}

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* Config.Service
    const values = yield* config.get
    const url = values.database_url
    if (url !== undefined && isPostgresUrl(url)) {
      return Layer.effect(
        Service,
        Effect.fail(new DatabaseError({ message: "Rika local persistence only supports SQLite", operation: "open" })),
      )
    }
    return layerFromPath(pathFromConfig(values))
  }),
)

export const withDatabase = Effect.fn("Database.withDatabase.call")(function* <A>(
  operation: (database: DrizzleDatabase) => A,
) {
  const database = yield* Service
  return yield* database.withDatabase(operation)
})

export const withDatabaseEffect = Effect.fn("Database.withDatabaseEffect.call")(function* <A, E, R>(
  operation: (database: DrizzleDatabase) => Effect.Effect<A, E, R>,
) {
  const database = yield* Service
  return yield* database.withDatabaseEffect(operation)
})

export const queryGet = Effect.fn("Database.queryGet.call")(function* <T>(query: SQL) {
  const database = yield* Service
  return yield* database.queryGet<T>(query)
})

export const queryAll = Effect.fn("Database.queryAll.call")(function* <T>(query: SQL) {
  const database = yield* Service
  return yield* database.queryAll<T>(query)
})

export const queryRun = Effect.fn("Database.queryRun.call")(function* (query: SQL) {
  const database = yield* Service
  return yield* database.queryRun(query)
})

const makeSqliteService = (database: DrizzleDatabase): Interface =>
  ({
    dialect: "sqlite",
    withDatabase: Effect.fn("Database.withDatabase")(function* <A>(operation: (database: DrizzleDatabase) => A) {
      return yield* Effect.try({
        try: () => operation(database),
        catch: (cause) => new DatabaseError({ message: describeCause(cause), operation: "withDatabase" }),
      })
    }),
    withDatabaseEffect: Effect.fn("Database.withDatabaseEffect")(function* <A, E, R>(
      operation: (database: DrizzleDatabase) => Effect.Effect<A, E, R>,
    ) {
      const effect = yield* Effect.try({
        try: () => operation(database),
        catch: (cause) => new DatabaseError({ message: describeCause(cause), operation: "withDatabaseEffect" }),
      })
      return yield* effect
    }),
    queryGet: <T>(query: SQL) =>
      Effect.try({
        try: () => database.get(query) as T | undefined,
        catch: (cause) => new DatabaseError({ message: describeCause(cause), operation: "queryGet" }),
      }),
    queryAll: <T>(query: SQL) =>
      Effect.try({
        try: () => database.all(query) as T[],
        catch: (cause) => new DatabaseError({ message: describeCause(cause), operation: "queryAll" }),
      }),
    queryRun: (query: SQL) =>
      Effect.try({
        try: () => {
          database.run(query)
        },
        catch: (cause) => new DatabaseError({ message: describeCause(cause), operation: "queryRun" }),
      }),
  }) satisfies Interface

const openSqlite = (path: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        ensureParentDirectory(path)
        const sqlite = new BunSqliteDatabase(path, { create: true })
        configureSqlite(sqlite, path)
        return sqlite
      },
      catch: (cause) => new DatabaseError({ message: describeCause(cause), operation: "open" }),
    }),
    (sqlite) => Effect.sync(() => sqlite.close()).pipe(Effect.ignore),
  )

const ensureParentDirectory = (path: string) => {
  if (path === ":memory:" || path.startsWith("file:")) return
  mkdirSync(dirname(path), { recursive: true })
}

const configureSqlite = (sqlite: BunSqliteDatabase, path: string) => {
  sqlite.exec("PRAGMA foreign_keys = ON")
  sqlite.exec("PRAGMA busy_timeout = 5000")
  if (path !== ":memory:") sqlite.exec("PRAGMA journal_mode = WAL")
  sqlite.exec("PRAGMA synchronous = NORMAL")
}

const isPostgresUrl = (url: string) => {
  const normalized = url.trim().toLowerCase()
  return normalized.startsWith("postgres://") || normalized.startsWith("postgresql://")
}

const describeCause = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

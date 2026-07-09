import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import { migrate as migrateDatabase } from "drizzle-orm/bun-sqlite/migrator"
import { DatabaseError, Service as DatabaseService, withDatabaseEffect, type DrizzleDatabase } from "./database"
import * as ThreadFileProjection from "./thread-file-projection"

export const sourceMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url))

export const installedMigrationsFolder = (executablePath = process.execPath) =>
  join(dirname(executablePath), "..", "share", "rika", "drizzle")

export const migrationsFolderFromEnv = (env: Record<string, string | undefined> = process.env) => {
  if (env.RIKA_MIGRATIONS_DIR !== undefined && env.RIKA_MIGRATIONS_DIR.length > 0) return env.RIKA_MIGRATIONS_DIR
  if (sourceMigrationsFolder.includes("/$bunfs/")) return installedMigrationsFolder()
  return sourceMigrationsFolder
}

export const defaultMigrationsFolder = migrationsFolderFromEnv()

export class MigrationError extends Schema.TaggedErrorClass<MigrationError>()("MigrationError", {
  message: Schema.String,
  migrations_folder: Schema.String,
}) {}

export interface Interface {
  readonly migrate: () => Effect.Effect<void, DatabaseError | MigrationError, DatabaseService>
}

export class Service extends Context.Service<Service, Interface>()("@rika/persistence/Migration") {}

export const layerFromFolder = (migrationsFolder = defaultMigrationsFolder) =>
  Layer.succeed(
    Service,
    Service.of({
      migrate: Effect.fn("Migration.migrate")(function* () {
        return yield* withDatabaseEffect((database) =>
          Effect.try({
            try: () => {
              repairCollapsedLocalMigrationCompatibility(database)
              migrateDatabase(database, { migrationsFolder })
              backfillArtifactWorkspaces(database)
              ThreadFileProjection.backfillThreadFiles(database)
            },
            catch: (cause) =>
              new MigrationError({ message: describeCause(cause), migrations_folder: migrationsFolder }),
          }).pipe(Effect.asVoid),
        )
      }),
    }),
  )

export const layer = layerFromFolder()

export const migrate = Effect.fn("Migration.migrate.call")(function* () {
  const migration = yield* Service
  return yield* migration.migrate()
})

const describeCause = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

type ColumnRepair = {
  readonly table: string
  readonly column: string
  readonly definition: string
}

const collapsedMigrationColumnRepairs: ReadonlyArray<ColumnRepair> = [
  { table: "artifacts", column: "workspace_id", definition: "text" },
  { table: "thread_projections", column: "title_text", definition: "text" },
  { table: "thread_projections", column: "diff_additions", definition: "integer DEFAULT 0 NOT NULL" },
  { table: "thread_projections", column: "diff_modifications", definition: "integer DEFAULT 0 NOT NULL" },
  { table: "thread_projections", column: "diff_deletions", definition: "integer DEFAULT 0 NOT NULL" },
  { table: "thread_projections", column: "last_context_tokens", definition: "integer" },
  { table: "thread_projections", column: "last_model", definition: "text" },
  { table: "thread_projections", column: "last_user_id", definition: "text" },
  { table: "thread_projections", column: "visibility", definition: "text DEFAULT 'private' NOT NULL" },
]

const repairCollapsedLocalMigrationCompatibility = (database: DrizzleDatabase) => {
  const columnsByTable = new Map<string, Set<string>>()
  for (const repair of collapsedMigrationColumnRepairs) {
    if (!tableExists(database, repair.table)) continue
    if (!columnsByTable.has(repair.table)) columnsByTable.set(repair.table, existingColumns(database, repair.table))
    const columns = columnsByTable.get(repair.table)!
    if (!columns.has(repair.column)) {
      database.run(
        sql.raw(
          `ALTER TABLE ${quoteIdentifier(repair.table)} ADD ${quoteIdentifier(repair.column)} ${repair.definition}`,
        ),
      )
      columns.add(repair.column)
    }
  }
}

const existingColumns = (database: DrizzleDatabase, table: string) => {
  if (!tableExists(database, table)) return new Set<string>()
  return new Set(
    database.all<{ name: string }>(sql.raw(`PRAGMA table_info(${quoteIdentifier(table)})`)).map((row) => row.name),
  )
}

const tableExists = (database: DrizzleDatabase, table: string) =>
  database.get<{ name: string }>(sql`select name from sqlite_master where type = 'table' and name = ${table}`) !==
  undefined

const backfillArtifactWorkspaces = (database: DrizzleDatabase) => {
  if (!tableExists(database, "artifacts") || !tableExists(database, "thread_projections")) return
  const artifactColumns = existingColumns(database, "artifacts")
  const projectionColumns = existingColumns(database, "thread_projections")
  if (!artifactColumns.has("workspace_id") || !projectionColumns.has("workspace_id")) return
  database.run(
    sql.raw(`UPDATE artifacts
SET workspace_id = (
  SELECT thread_projections.workspace_id
  FROM thread_projections
  WHERE thread_projections.thread_id = artifacts.thread_id
)
WHERE workspace_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM thread_projections
    WHERE thread_projections.thread_id = artifacts.thread_id
  )`),
  )
}

const quoteIdentifier = (value: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid SQLite identifier: ${value}`)
  return `\`${value}\``
}

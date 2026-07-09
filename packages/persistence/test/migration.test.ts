import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Common, Event, Ids } from "@rika/schema"
import { Database, Migration, ThreadEventLog } from "../src/index"

const layer = Layer.mergeAll(Database.memoryLayer, Migration.layer, ThreadEventLog.layer)

describe("Migration", () => {
  test("applies committed migrations at runtime", async () => {
    const tables = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* Database.withDatabase((database) =>
          database.all<{ name: string }>(sql`select name from sqlite_master where type = 'table' order by name`),
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(tables.map((table) => table.name)).toContain("thread_events")
  })

  test("applies projection columns used by thread summaries", async () => {
    const columns = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* Database.withDatabase((database) =>
          database.all<{ name: string }>(sql`pragma table_info(thread_projections)`),
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["title_text", "diff_additions", "diff_modifications", "diff_deletions"]),
    )
  })

  test("backfills thread files from historical event log rows", async () => {
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadEventLog.appendMany([historicalThreadCreated, historicalToolRequested])
        const before = yield* Database.withDatabase((database) =>
          database.all<{ path: string }>(sql`select path from thread_files order by path asc`),
        )
        yield* Migration.migrate()
        const after = yield* Database.withDatabase((database) =>
          database.all<{ thread_id: string; path: string }>(
            sql`select thread_id, path from thread_files order by thread_id asc, path asc`,
          ),
        )
        return { before, after }
      }).pipe(Effect.provide(layer)),
    )

    expect(rows.before).toEqual([])
    expect(rows.after).toEqual([{ thread_id: historicalThreadId, path: "packages/server/src/search.ts" }])
  })

  test("tolerates existing local tables from older migration stacks", async () => {
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Database.withDatabase((database) =>
          database.transaction(() => {
            database.run(
              sql.raw(
                "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)",
              ),
            )
            database.run(
              sql.raw(
                "INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES ('old-hash', 1782591185000, '20260627201305_mature_dragon_lord', '2026-07-07T20:21:16.360Z')",
              ),
            )
            database.run(
              sql.raw(
                "CREATE TABLE thread_projections (`thread_id` text PRIMARY KEY, `workspace_id` text NOT NULL, `user_id` text, `latest_message_id` text, `latest_message_role` text, `latest_message_text` text, `latest_message_created_at` integer, `active_turn_id` text, `active_turn_status` text, `archived` integer DEFAULT 0 NOT NULL, `last_sequence` integer NOT NULL, `created_at` integer NOT NULL, `updated_at` integer NOT NULL)",
              ),
            )
            database.run(
              sql.raw(
                "INSERT INTO thread_projections (`thread_id`, `workspace_id`, `archived`, `last_sequence`, `created_at`, `updated_at`) VALUES ('legacy-thread', 'legacy-workspace', 0, 1, 1, 1)",
              ),
            )
            database.run(
              sql.raw(
                "CREATE TABLE artifacts (`id` text PRIMARY KEY, `thread_id` text NOT NULL, `turn_id` text, `kind` text NOT NULL, `title` text, `content` text NOT NULL, `metadata` text, `created_at` integer NOT NULL)",
              ),
            )
            database.run(
              sql.raw(
                "INSERT INTO artifacts (`id`, `thread_id`, `kind`, `content`, `created_at`) VALUES ('legacy-artifact', 'legacy-thread', 'text', 'legacy', 1)",
              ),
            )
          }),
        )
        yield* Migration.migrate()
        return yield* Database.withDatabase((database) => ({
          tables: database.all<{ name: string }>(
            sql`select name from sqlite_master where type = 'table' order by name`,
          ),
          artifact_columns: database.all<{ name: string }>(sql.raw("PRAGMA table_info(artifacts)")),
          projection_columns: database.all<{ name: string }>(sql.raw("PRAGMA table_info(thread_projections)")),
          artifact: database.get<{ workspace_id: string | null }>(
            sql`select workspace_id from artifacts where id = 'legacy-artifact'`,
          ),
        }))
      }).pipe(Effect.provide(layer)),
    )

    expect(state.tables.map((table) => table.name)).toEqual(expect.arrayContaining(["artifacts", "thread_events"]))
    expect(state.artifact_columns.map((column) => column.name)).toContain("workspace_id")
    expect(state.projection_columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "title_text",
        "diff_additions",
        "last_context_tokens",
        "last_model",
        "last_user_id",
        "visibility",
      ]),
    )
    expect(state.artifact?.workspace_id).toBe("legacy-workspace")
  })

  test("resolves source, configured, and installed migration folders", () => {
    expect(Migration.migrationsFolderFromEnv({ RIKA_MIGRATIONS_DIR: "/tmp/rika-migrations" })).toBe(
      "/tmp/rika-migrations",
    )
    expect(Migration.migrationsFolderFromEnv({})).toBe(Migration.sourceMigrationsFolder)
    expect(Migration.installedMigrationsFolder("/opt/rika/bin/rika")).toBe("/opt/rika/share/rika/drizzle")
  })
})

const historicalThreadId = Ids.ThreadId.make("migration_thread_file_backfill")
const historicalTurnId = Ids.TurnId.make("migration_turn_file_backfill")
const historicalCreatedAt = Common.TimestampMillis.make(1_789_000_000_000)

const historicalThreadCreated: Event.ThreadCreated = {
  id: Ids.EventId.make("migration_thread_file_backfill_created"),
  thread_id: historicalThreadId,
  sequence: 1,
  version: 1,
  created_at: historicalCreatedAt,
  type: "thread.created",
  data: { workspace_id: Ids.WorkspaceId.make("migration_workspace_file_backfill") },
}

const historicalToolRequested: Event.ToolCallRequested = {
  id: Ids.EventId.make("migration_thread_file_backfill_tool"),
  thread_id: historicalThreadId,
  turn_id: historicalTurnId,
  sequence: 2,
  version: 1,
  created_at: historicalCreatedAt,
  type: "tool.call.requested",
  data: {
    call: {
      id: Ids.ToolCallId.make("migration_thread_file_backfill_call"),
      name: "edit",
      input: { path: "packages/server/src/search.ts" },
    },
  },
}

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Ids, Workspace } from "@rika/schema"
import { Database, Migration, ThreadProjection, WorkspaceStore } from "../src/index"

describe("Postgres index", () => {
  test("selects the postgres dialect for postgres connection strings", () => {
    expect(Database.dialectFromUrl("postgres://localhost/rika")).toBe("postgres")
    expect(Database.dialectFromUrl("postgresql://user:pass@localhost:5432/rika")).toBe("postgres")
    expect(Database.dialectFromUrl("file:./rika.sqlite")).toBe("sqlite")
    expect(Database.dialectFromUrl(undefined)).toBe("sqlite")
  })

  test("applies the Postgres index schema through Migration.migrate without thread_events", async () => {
    const program = Effect.gen(function* () {
      yield* Migration.migrate()
      const tables = yield* Database.queryAll<{ readonly table_name: string }>(
        sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
      )
      const names = tables.map((row) => row.table_name)
      expect(names).toContain("workspace_memberships")
      expect(names).toContain("thread_projections")
      expect(names).toContain("user_tokens")
      expect(names).not.toContain("thread_events")
    })

    await Effect.runPromise(
      program.pipe(Effect.provide(Migration.layer), Effect.provide(Database.postgresMemoryLayer)),
    )
  })

  test("runs cross-cutting index writes on an ephemeral Postgres database without a thread_events event log", async () => {
    const program = Effect.gen(function* () {
      const dialect = yield* Database.dialect()
      expect(dialect).toBe("postgres")

      const membership = yield* WorkspaceStore.putMembership({
        workspace_id: Ids.WorkspaceId.make("ws_postgres_index"),
        user_id: Ids.UserId.make("user_postgres_index"),
        role: "owner",
        created_at: 1,
      })
      expect(membership.workspace_id).toBe(Ids.WorkspaceId.make("ws_postgres_index"))

      yield* ThreadProjection.apply({
        id: Ids.EventId.make("event_postgres_index_created"),
        thread_id: Ids.ThreadId.make("thread_postgres_index"),
        sequence: 1,
        version: 1,
        created_at: 1,
        type: "thread.created",
        data: { workspace_id: Ids.WorkspaceId.make("ws_postgres_index") },
      })

      const listed = yield* ThreadProjection.listThreads()
      expect(listed.map((thread) => thread.thread_id)).toEqual([Ids.ThreadId.make("thread_postgres_index")])

      const eventLogTables = yield* Database.queryAll<{ readonly table_name: string }>(
        sql`select table_name from information_schema.tables where table_schema = 'public' and table_name = 'thread_events'`,
      )
      expect(eventLogTables).toEqual([])

      const memberships = yield* WorkspaceStore.listMemberships(Ids.WorkspaceId.make("ws_postgres_index"))
      expect(memberships).toHaveLength(1)
      expect(memberships[0]?.role).toBe("owner" satisfies Workspace.Membership["role"])
    })

    await Effect.runPromise(
      program.pipe(
        Effect.provide(WorkspaceStore.layer),
        Effect.provide(ThreadProjection.layer),
        Effect.provide(Database.postgresMemoryLayer),
      ),
    )
  })
})

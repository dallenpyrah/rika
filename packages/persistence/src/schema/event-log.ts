import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const thread_events = sqliteTable(
  "thread_events",
  {
    id: text().primaryKey(),
    thread_id: text().notNull(),
    turn_id: text(),
    sequence: integer().notNull(),
    version: integer().notNull(),
    type: text().notNull(),
    payload: text().notNull(),
    message_id: text(),
    tool_call_id: text(),
    artifact_id: text(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("thread_events_thread_sequence_idx").on(table.thread_id, table.sequence),
    index("thread_events_thread_created_idx").on(table.thread_id, table.created_at),
    index("thread_events_type_idx").on(table.type),
  ],
)

export type ThreadEventRow = typeof thread_events.$inferSelect
export type NewThreadEventRow = typeof thread_events.$inferInsert

export const thread_projections = sqliteTable(
  "thread_projections",
  {
    thread_id: text().primaryKey(),
    workspace_id: text().notNull(),
    user_id: text(),
    latest_message_id: text(),
    latest_message_role: text(),
    latest_message_text: text(),
    latest_message_created_at: integer(),
    active_turn_id: text(),
    active_turn_status: text(),
    archived: integer().notNull().default(0),
    last_sequence: integer().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("thread_projections_updated_idx").on(table.updated_at),
    index("thread_projections_workspace_idx").on(table.workspace_id),
  ],
)

export type ThreadProjectionRow = typeof thread_projections.$inferSelect
export type NewThreadProjectionRow = typeof thread_projections.$inferInsert

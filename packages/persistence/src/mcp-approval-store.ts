import { Time } from "@rika/core"
import { Common } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import { createHash } from "node:crypto"
import * as Database from "./database"
import { mcp_server_approvals } from "./schema"

export interface ApprovalInput extends Schema.Schema.Type<typeof ApprovalInput> {}
export const ApprovalInput = Schema.Struct({
  workspace_root: Schema.String,
  server_name: Schema.String,
  fingerprint: Schema.String,
}).annotate({ identifier: "Rika.Persistence.McpApprovalStore.ApprovalInput" })

export interface Approval extends Schema.Schema.Type<typeof Approval> {}
export const Approval = Schema.Struct({
  id: Schema.String,
  workspace_root: Schema.String,
  server_name: Schema.String,
  fingerprint: Schema.String,
  approved_at: Common.TimestampMillis,
}).annotate({ identifier: "Rika.Persistence.McpApprovalStore.Approval" })

export class McpApprovalStoreError extends Schema.TaggedErrorClass<McpApprovalStoreError>()("McpApprovalStoreError", {
  message: Schema.String,
  operation: Schema.String,
  server_name: Schema.optional(Schema.String),
}) {}

export interface Interface {
  readonly approve: (input: ApprovalInput) => Effect.Effect<Approval, Database.DatabaseError | McpApprovalStoreError>
  readonly isApproved: (input: ApprovalInput) => Effect.Effect<boolean, Database.DatabaseError | McpApprovalStoreError>
  readonly list: (
    workspaceRoot?: string,
  ) => Effect.Effect<ReadonlyArray<Approval>, Database.DatabaseError | McpApprovalStoreError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/persistence/McpApprovalStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const databaseService = yield* Database.Service
    const time = yield* Time.Service
    return Service.of({
      approve: Effect.fn("McpApprovalStore.approve")(function* (input: ApprovalInput) {
        const approvedAt = yield* time.nowMillis
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => approveRow(database, input, approvedAt),
            catch: (cause) => toError(cause, "approve", input.server_name),
          }),
        )
      }),
      isApproved: Effect.fn("McpApprovalStore.isApproved")(function* (input: ApprovalInput) {
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () =>
              database.get<ApprovalRow>(
                sql`select * from mcp_server_approvals where workspace_root = ${input.workspace_root} and server_name = ${input.server_name} and fingerprint = ${input.fingerprint} limit 1`,
              ) !== undefined,
            catch: (cause) => toError(cause, "isApproved", input.server_name),
          }),
        )
      }),
      list: Effect.fn("McpApprovalStore.list")(function* (workspaceRoot?: string) {
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => listRows(database, workspaceRoot),
            catch: (cause) => toError(cause, "list"),
          }),
        )
      }),
    })
  }),
)

export const memoryLayer = layer.pipe(Layer.provideMerge(Database.memoryLayer), Layer.provideMerge(Time.layer))

export const fakeLayer = (initial: ReadonlyArray<Approval> = []) => {
  const rows = new Map(initial.map((approval) => [approval.id, approval]))
  return Layer.succeed(
    Service,
    Service.of({
      approve: Effect.fn("McpApprovalStore.approve.fake")(function* (input: ApprovalInput) {
        const existing = rows.get(approvalId(input))
        if (existing !== undefined) return existing
        const approval: Approval = {
          id: approvalId(input),
          workspace_root: input.workspace_root,
          server_name: input.server_name,
          fingerprint: input.fingerprint,
          approved_at: Common.TimestampMillis.make(1),
        }
        yield* Effect.sync(() => rows.set(approval.id, approval))
        return approval
      }),
      isApproved: Effect.fn("McpApprovalStore.isApproved.fake")(function* (input: ApprovalInput) {
        return [...rows.values()].some(
          (approval) =>
            approval.workspace_root === input.workspace_root &&
            approval.server_name === input.server_name &&
            approval.fingerprint === input.fingerprint,
        )
      }),
      list: Effect.fn("McpApprovalStore.list.fake")(function* (workspaceRoot?: string) {
        return [...rows.values()].filter(
          (approval) => workspaceRoot === undefined || approval.workspace_root === workspaceRoot,
        )
      }),
    }),
  )
}

export const approve = Effect.fn("McpApprovalStore.approve.call")(function* (input: ApprovalInput) {
  const store = yield* Service
  return yield* store.approve(input)
})

export const isApproved = Effect.fn("McpApprovalStore.isApproved.call")(function* (input: ApprovalInput) {
  const store = yield* Service
  return yield* store.isApproved(input)
})

export const list = Effect.fn("McpApprovalStore.list.call")(function* (workspaceRoot?: string) {
  const store = yield* Service
  return yield* store.list(workspaceRoot)
})

type ApprovalDatabase = Pick<Database.DrizzleDatabase, "get" | "insert" | "all">

interface ApprovalRow {
  readonly id: string
  readonly workspace_root: string
  readonly server_name: string
  readonly fingerprint: string
  readonly approved_at: number
}

const approveRow = (database: ApprovalDatabase, input: ApprovalInput, approvedAt: Common.TimestampMillis): Approval => {
  const id = approvalId(input)
  const existing = database.get<ApprovalRow>(sql`select * from mcp_server_approvals where id = ${id} limit 1`)
  if (existing !== undefined) return rowToApproval(existing)
  database
    .insert(mcp_server_approvals)
    .values({
      id,
      workspace_root: input.workspace_root,
      server_name: input.server_name,
      fingerprint: input.fingerprint,
      approved_at: approvedAt,
    })
    .run()
  return {
    id,
    workspace_root: input.workspace_root,
    server_name: input.server_name,
    fingerprint: input.fingerprint,
    approved_at: approvedAt,
  }
}

const listRows = (database: ApprovalDatabase, workspaceRoot?: string) => {
  const rows =
    workspaceRoot === undefined
      ? database.all<ApprovalRow>(sql`select * from mcp_server_approvals order by workspace_root asc, server_name asc`)
      : database.all<ApprovalRow>(
          sql`select * from mcp_server_approvals where workspace_root = ${workspaceRoot} order by server_name asc`,
        )
  return rows.map(rowToApproval)
}

export const approvalId = (input: ApprovalInput) =>
  createHash("sha256")
    .update(JSON.stringify([input.workspace_root, input.server_name, input.fingerprint]))
    .digest("hex")

const rowToApproval = (row: ApprovalRow): Approval => ({
  id: row.id,
  workspace_root: row.workspace_root,
  server_name: row.server_name,
  fingerprint: row.fingerprint,
  approved_at: Common.TimestampMillis.make(row.approved_at),
})

const toError = (cause: unknown, operation: string, serverName?: string) => {
  if (cause instanceof McpApprovalStoreError) return cause
  return new McpApprovalStoreError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
    ...(serverName === undefined ? {} : { server_name: serverName }),
  })
}

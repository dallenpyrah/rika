import { Common, Ids, Workspace } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import { createHash } from "node:crypto"
import * as Database from "./database"

export interface MembershipKey extends Schema.Schema.Type<typeof MembershipKey> {}
export const MembershipKey = Schema.Struct({
  workspace_id: Ids.WorkspaceId,
  user_id: Ids.UserId,
}).annotate({ identifier: "Rika.Persistence.WorkspaceStore.MembershipKey" })

export class WorkspaceStoreError extends Schema.TaggedErrorClass<WorkspaceStoreError>()("WorkspaceStoreError", {
  message: Schema.String,
  operation: Schema.String,
  workspace_id: Schema.optional(Ids.WorkspaceId),
  user_id: Schema.optional(Ids.UserId),
}) {}

export interface Interface {
  readonly putMembership: (
    membership: Workspace.Membership,
  ) => Effect.Effect<Workspace.Membership, Database.DatabaseError | WorkspaceStoreError>
  readonly getMembership: (
    input: MembershipKey,
  ) => Effect.Effect<Workspace.Membership | undefined, Database.DatabaseError | WorkspaceStoreError>
  readonly listMemberships: (
    workspaceId: Ids.WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<Workspace.Membership>, Database.DatabaseError | WorkspaceStoreError>
  readonly listUserMemberships: (
    userId: Ids.UserId,
  ) => Effect.Effect<ReadonlyArray<Workspace.Membership>, Database.DatabaseError | WorkspaceStoreError>
  readonly workspaceHasMembers: (
    workspaceId: Ids.WorkspaceId,
  ) => Effect.Effect<boolean, Database.DatabaseError | WorkspaceStoreError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/persistence/WorkspaceStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const databaseService = yield* Database.Service
    return Service.of({
      putMembership: Effect.fn("WorkspaceStore.putMembership")(function* (membership: Workspace.Membership) {
        return yield* putMembershipRow(databaseService, membership).pipe(
          Effect.mapError((cause) => toError(cause, "putMembership", membership.workspace_id, membership.user_id)),
        )
      }),
      getMembership: Effect.fn("WorkspaceStore.getMembership")(function* (input: MembershipKey) {
        return yield* databaseService
          .queryGet<MembershipRow>(
            sql`select * from workspace_memberships where workspace_id = ${input.workspace_id} and user_id = ${input.user_id} limit 1`,
          )
          .pipe(
            Effect.map(rowToMembership),
            Effect.mapError((cause) => toError(cause, "getMembership", input.workspace_id, input.user_id)),
          )
      }),
      listMemberships: Effect.fn("WorkspaceStore.listMemberships")(function* (workspaceId: Ids.WorkspaceId) {
        return yield* databaseService
          .queryAll<MembershipRow>(
            sql`select * from workspace_memberships where workspace_id = ${workspaceId} order by role asc, user_id asc`,
          )
          .pipe(
            Effect.map((rows) => rows.map(rowToExistingMembership)),
            Effect.mapError((cause) => toError(cause, "listMemberships", workspaceId)),
          )
      }),
      listUserMemberships: Effect.fn("WorkspaceStore.listUserMemberships")(function* (userId: Ids.UserId) {
        return yield* databaseService
          .queryAll<MembershipRow>(
            sql`select * from workspace_memberships where user_id = ${userId} order by workspace_id asc`,
          )
          .pipe(
            Effect.map((rows) => rows.map(rowToExistingMembership)),
            Effect.mapError((cause) => toError(cause, "listUserMemberships", undefined, userId)),
          )
      }),
      workspaceHasMembers: Effect.fn("WorkspaceStore.workspaceHasMembers")(function* (workspaceId: Ids.WorkspaceId) {
        return yield* databaseService
          .queryGet<{ readonly count: number | string }>(
            sql`select count(*) as count from workspace_memberships where workspace_id = ${workspaceId}`,
          )
          .pipe(
            Effect.map((row) => Number(row?.count ?? 0) !== 0),
            Effect.mapError((cause) => toError(cause, "workspaceHasMembers", workspaceId)),
          )
      }),
    })
  }),
)

export const fakeLayer = (initial: ReadonlyArray<Workspace.Membership> = []) => {
  const rows = new Map(initial.map((membership) => [membershipId(membership), membership]))
  return Layer.succeed(
    Service,
    Service.of({
      putMembership: Effect.fn("WorkspaceStore.putMembership.fake")(function* (membership: Workspace.Membership) {
        const id = membershipId(membership)
        yield* Effect.sync(() => rows.set(id, membership))
        return membership
      }),
      getMembership: Effect.fn("WorkspaceStore.getMembership.fake")(function* (input: MembershipKey) {
        return rows.get(membershipId(input))
      }),
      listMemberships: Effect.fn("WorkspaceStore.listMemberships.fake")(function* (workspaceId: Ids.WorkspaceId) {
        return [...rows.values()].filter((membership) => membership.workspace_id === workspaceId)
      }),
      listUserMemberships: Effect.fn("WorkspaceStore.listUserMemberships.fake")(function* (userId: Ids.UserId) {
        return [...rows.values()].filter((membership) => membership.user_id === userId)
      }),
      workspaceHasMembers: Effect.fn("WorkspaceStore.workspaceHasMembers.fake")(function* (
        workspaceId: Ids.WorkspaceId,
      ) {
        return [...rows.values()].some((membership) => membership.workspace_id === workspaceId)
      }),
    }),
  )
}

export const putMembership = Effect.fn("WorkspaceStore.putMembership.call")(function* (
  membership: Workspace.Membership,
) {
  const store = yield* Service
  return yield* store.putMembership(membership)
})

export const getMembership = Effect.fn("WorkspaceStore.getMembership.call")(function* (input: MembershipKey) {
  const store = yield* Service
  return yield* store.getMembership(input)
})

export const listMemberships = Effect.fn("WorkspaceStore.listMemberships.call")(function* (
  workspaceId: Ids.WorkspaceId,
) {
  const store = yield* Service
  return yield* store.listMemberships(workspaceId)
})

export const listUserMemberships = Effect.fn("WorkspaceStore.listUserMemberships.call")(function* (userId: Ids.UserId) {
  const store = yield* Service
  return yield* store.listUserMemberships(userId)
})

export const workspaceHasMembers = Effect.fn("WorkspaceStore.workspaceHasMembers.call")(function* (
  workspaceId: Ids.WorkspaceId,
) {
  const store = yield* Service
  return yield* store.workspaceHasMembers(workspaceId)
})

interface MembershipRow {
  readonly id: string
  readonly workspace_id: string
  readonly user_id: string
  readonly role: string
  readonly created_at: number | string
}

const putMembershipRow = (database: Database.Interface, membership: Workspace.Membership) =>
  Effect.gen(function* () {
    const id = membershipId(membership)
    const existing = yield* database.queryGet<MembershipRow>(
      sql`select * from workspace_memberships where id = ${id} limit 1`,
    )
    if (existing !== undefined) return rowToExistingMembership(existing)
    yield* database.queryRun(sql`
      insert into workspace_memberships (id, workspace_id, user_id, role, created_at)
      values (${id}, ${membership.workspace_id}, ${membership.user_id}, ${membership.role}, ${membership.created_at})
    `)
    return membership
  })

export const membershipId = (input: MembershipKey) =>
  createHash("sha256")
    .update(JSON.stringify([input.workspace_id, input.user_id]))
    .digest("hex")

const rowToMembership = (row: MembershipRow | undefined) =>
  row === undefined ? undefined : rowToExistingMembership(row)

const rowToExistingMembership = (row: MembershipRow): Workspace.Membership => ({
  workspace_id: Ids.WorkspaceId.make(row.workspace_id),
  user_id: Ids.UserId.make(row.user_id),
  role: Schema.decodeUnknownSync(Workspace.MembershipRole)(row.role),
  created_at: Common.TimestampMillis.make(Number(row.created_at)),
})

const toError = (cause: unknown, operation: string, workspaceId?: Ids.WorkspaceId, userId?: Ids.UserId) => {
  if (cause instanceof WorkspaceStoreError) return cause
  return new WorkspaceStoreError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
    ...(workspaceId === undefined ? {} : { workspace_id: workspaceId }),
    ...(userId === undefined ? {} : { user_id: userId }),
  })
}

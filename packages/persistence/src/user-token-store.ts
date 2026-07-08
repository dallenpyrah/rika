import { Common, Ids } from "@rika/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import { createHash, randomBytes } from "node:crypto"
import * as Database from "./database"

export interface UserTokenRecord extends Schema.Schema.Type<typeof UserTokenRecord> {}
export const UserTokenRecord = Schema.Struct({
  token_hash: Schema.String,
  user_id: Ids.UserId,
  label: Schema.optional(Schema.String),
  created_at: Common.TimestampMillis,
  revoked_at: Schema.optional(Common.TimestampMillis),
}).annotate({ identifier: "Rika.Persistence.UserTokenStore.UserTokenRecord" })

export interface IssuedUserToken extends Schema.Schema.Type<typeof IssuedUserToken> {}
export const IssuedUserToken = Schema.Struct({
  token: Schema.String,
  record: UserTokenRecord,
}).annotate({ identifier: "Rika.Persistence.UserTokenStore.IssuedUserToken" })

export class UserTokenStoreError extends Schema.TaggedErrorClass<UserTokenStoreError>()("UserTokenStoreError", {
  message: Schema.String,
  operation: Schema.String,
  user_id: Schema.optional(Ids.UserId),
}) {}

export interface Interface {
  readonly issue: (input: {
    readonly user_id: Ids.UserId
    readonly label?: string
    readonly created_at: Common.TimestampMillis
  }) => Effect.Effect<IssuedUserToken, Database.DatabaseError | UserTokenStoreError>
  readonly resolve: (
    token: string,
  ) => Effect.Effect<UserTokenRecord | undefined, Database.DatabaseError | UserTokenStoreError>
  readonly revoke: (
    tokenHash: string,
    revokedAt: Common.TimestampMillis,
  ) => Effect.Effect<UserTokenRecord | undefined, Database.DatabaseError | UserTokenStoreError>
  readonly listForUser: (
    userId: Ids.UserId,
  ) => Effect.Effect<ReadonlyArray<UserTokenRecord>, Database.DatabaseError | UserTokenStoreError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/persistence/UserTokenStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    return Service.of({
      issue: Effect.fn("UserTokenStore.issue")(function* (input) {
        const token = `rika_${randomBytes(24).toString("base64url")}`
        const tokenHash = hashToken(token)
        yield* database
          .queryRun(sql`
            insert into user_tokens (token_hash, user_id, label, created_at, revoked_at)
            values (${tokenHash}, ${input.user_id}, ${input.label ?? null}, ${input.created_at}, null)
          `)
          .pipe(Effect.mapError((cause) => toError(cause, "issue", input.user_id)))
        return {
          token,
          record: {
            token_hash: tokenHash,
            user_id: input.user_id,
            ...(input.label === undefined ? {} : { label: input.label }),
            created_at: input.created_at,
          },
        }
      }),
      resolve: Effect.fn("UserTokenStore.resolve")(function* (token: string) {
        const tokenHash = hashToken(token)
        return yield* database
          .queryGet<UserTokenRow>(
            sql`select * from user_tokens where token_hash = ${tokenHash} and revoked_at is null limit 1`,
          )
          .pipe(
            Effect.map(rowToRecord),
            Effect.mapError((cause) => toError(cause, "resolve")),
          )
      }),
      revoke: Effect.fn("UserTokenStore.revoke")(function* (tokenHash: string, revokedAt: Common.TimestampMillis) {
        yield* database
          .queryRun(sql`update user_tokens set revoked_at = ${revokedAt} where token_hash = ${tokenHash}`)
          .pipe(Effect.mapError((cause) => toError(cause, "revoke")))
        return yield* database
          .queryGet<UserTokenRow>(sql`select * from user_tokens where token_hash = ${tokenHash} limit 1`)
          .pipe(
            Effect.map(rowToRecord),
            Effect.mapError((cause) => toError(cause, "revoke")),
          )
      }),
      listForUser: Effect.fn("UserTokenStore.listForUser")(function* (userId: Ids.UserId) {
        return yield* database
          .queryAll<UserTokenRow>(
            sql`select * from user_tokens where user_id = ${userId} order by created_at desc, token_hash asc`,
          )
          .pipe(
            Effect.map((rows) => rows.flatMap((row) => {
              const record = rowToRecord(row)
              return record === undefined ? [] : [record]
            })),
            Effect.mapError((cause) => toError(cause, "listForUser", userId)),
          )
      }),
    })
  }),
)

export const issue = Effect.fn("UserTokenStore.issue.call")(function* (input: {
  readonly user_id: Ids.UserId
  readonly label?: string
  readonly created_at: Common.TimestampMillis
}) {
  const store = yield* Service
  return yield* store.issue(input)
})

export const resolve = Effect.fn("UserTokenStore.resolve.call")(function* (token: string) {
  const store = yield* Service
  return yield* store.resolve(token)
})

export const revoke = Effect.fn("UserTokenStore.revoke.call")(function* (
  tokenHash: string,
  revokedAt: Common.TimestampMillis,
) {
  const store = yield* Service
  return yield* store.revoke(tokenHash, revokedAt)
})

export const listForUser = Effect.fn("UserTokenStore.listForUser.call")(function* (userId: Ids.UserId) {
  const store = yield* Service
  return yield* store.listForUser(userId)
})

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex")

interface UserTokenRow {
  readonly token_hash: string
  readonly user_id: string
  readonly label: string | null
  readonly created_at: number | string
  readonly revoked_at: number | string | null
}

const rowToRecord = (row: UserTokenRow | undefined): UserTokenRecord | undefined => {
  if (row === undefined) return undefined
  return {
    token_hash: row.token_hash,
    user_id: Ids.UserId.make(row.user_id),
    ...(row.label === null || row.label === undefined ? {} : { label: row.label }),
    created_at: Common.TimestampMillis.make(Number(row.created_at)),
    ...(row.revoked_at === null || row.revoked_at === undefined
      ? {}
      : { revoked_at: Common.TimestampMillis.make(Number(row.revoked_at)) }),
  }
}

const toError = (cause: unknown, operation: string, userId?: Ids.UserId) => {
  if (cause instanceof UserTokenStoreError) return cause
  return new UserTokenStoreError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
    ...(userId === undefined ? {} : { user_id: userId }),
  })
}

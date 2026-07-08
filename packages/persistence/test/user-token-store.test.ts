import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Common, Ids } from "@rika/schema"
import { Database, Migration, UserTokenStore } from "../src/index"

describe("UserTokenStore", () => {
  test("issues, resolves, lists, and revokes user-scoped bearer tokens", async () => {
    const userId = Ids.UserId.make("user_token_owner")
    const program = Effect.gen(function* () {
      yield* Migration.migrate()
      const issued = yield* UserTokenStore.issue({
        user_id: userId,
        label: "cli",
        created_at: Common.TimestampMillis.make(10),
      })
      expect(issued.token.startsWith("rika_")).toBe(true)
      expect(issued.record.user_id).toBe(userId)
      expect(issued.record.label).toBe("cli")

      const resolved = yield* UserTokenStore.resolve(issued.token)
      expect(resolved?.token_hash).toBe(issued.record.token_hash)
      expect(resolved?.user_id).toBe(userId)

      const listed = yield* UserTokenStore.listForUser(userId)
      expect(listed.map((row) => row.token_hash)).toEqual([issued.record.token_hash])

      const revoked = yield* UserTokenStore.revoke(issued.record.token_hash, Common.TimestampMillis.make(20))
      expect(revoked?.revoked_at).toBe(20)

      const afterRevoke = yield* UserTokenStore.resolve(issued.token)
      expect(afterRevoke).toBeUndefined()
    })

    await Effect.runPromise(
      program.pipe(
        Effect.provide(UserTokenStore.layer),
        Effect.provide(Migration.layer),
        Effect.provide(Database.memoryLayer),
      ),
    )
  })

  test("issues and resolves tokens on the Postgres index without thread_events", async () => {
    const userId = Ids.UserId.make("user_token_postgres")
    const program = Effect.gen(function* () {
      const issued = yield* UserTokenStore.issue({
        user_id: userId,
        created_at: Common.TimestampMillis.make(11),
      })
      const resolved = yield* UserTokenStore.resolve(issued.token)
      expect(resolved?.user_id).toBe(userId)
    })

    await Effect.runPromise(
      program.pipe(Effect.provide(UserTokenStore.layer), Effect.provide(Database.postgresMemoryLayer)),
    )
  })
})

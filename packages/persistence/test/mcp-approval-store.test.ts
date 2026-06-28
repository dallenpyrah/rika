import { describe, expect, test } from "bun:test"
import { Time } from "@rika/core"
import { Common } from "@rika/schema"
import { Effect, Layer } from "effect"
import { Database, McpApprovalStore, Migration } from "../src/index"

const databaseLayer = Database.memoryLayer
const timeLayer = Time.fixedLayer(Common.TimestampMillis.make(1234))
const approvalLayer = McpApprovalStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer))
const layer = Layer.mergeAll(databaseLayer, Migration.layer, approvalLayer, timeLayer)

describe("McpApprovalStore", () => {
  test("approves workspace command servers by config fingerprint", async () => {
    const input = { workspace_root: "/repo", server_name: "local", fingerprint: "abc123" }
    const id = McpApprovalStore.approvalId(input)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const before = yield* McpApprovalStore.isApproved(input)
        const approval = yield* McpApprovalStore.approve(input)
        const after = yield* McpApprovalStore.isApproved(input)
        return { before, approval, after }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.before).toBe(false)
    expect(result.after).toBe(true)
    expect(result.approval).toEqual({
      id,
      workspace_root: "/repo",
      server_name: "local",
      fingerprint: "abc123",
      approved_at: 1234,
    })
  })

  test("approval is idempotent and scoped to workspace plus fingerprint", async () => {
    const input = { workspace_root: "/repo", server_name: "local", fingerprint: "abc123" }

    const approvals = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* McpApprovalStore.approve(input)
        yield* McpApprovalStore.approve(input)
        yield* McpApprovalStore.approve({ ...input, fingerprint: "changed" })
        yield* McpApprovalStore.approve({ ...input, workspace_root: "/other" })
        return yield* McpApprovalStore.list("/repo")
      }).pipe(Effect.provide(layer)),
    )

    expect(approvals.map((approval) => approval.id)).toEqual([
      McpApprovalStore.approvalId(input),
      McpApprovalStore.approvalId({ ...input, fingerprint: "changed" }),
    ])
  })

  test("approval checks do not collide when workspace roots or server names contain separators", async () => {
    const approved = { workspace_root: "/repo:local", server_name: "search", fingerprint: "abc123" }
    const collisionWithOldId = { workspace_root: "/repo", server_name: "local:search", fingerprint: "abc123" }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* McpApprovalStore.approve(approved)
        return yield* McpApprovalStore.isApproved(collisionWithOldId)
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toBe(false)
  })
})

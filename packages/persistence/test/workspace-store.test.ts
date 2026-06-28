import { describe, expect, test } from "bun:test"
import { Common, Ids, Workspace } from "@rika/schema"
import { Effect, Layer } from "effect"
import { Database, Migration, WorkspaceStore } from "../src/index"

const workspaceId = Ids.WorkspaceId.make("workspace_store")
const otherWorkspaceId = Ids.WorkspaceId.make("workspace_store_other")
const ownerId = Ids.UserId.make("user_owner")
const memberId = Ids.UserId.make("user_member")
const now = Common.TimestampMillis.make(1_980_000_000_000)

const storeLayer = WorkspaceStore.layer.pipe(Layer.provideMerge(Database.memoryLayer))
const layer = Layer.mergeAll(Database.memoryLayer, Migration.layer, storeLayer)

describe("WorkspaceStore", () => {
  test("persists and lists workspace memberships", async () => {
    const owner = membership(ownerId, "owner", workspaceId)
    const member = membership(memberId, "member", workspaceId)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const before = yield* WorkspaceStore.workspaceHasMembers(workspaceId)
        yield* WorkspaceStore.putMembership(owner)
        yield* WorkspaceStore.putMembership(member)
        const fetched = yield* WorkspaceStore.getMembership({ workspace_id: workspaceId, user_id: ownerId })
        const workspaceMemberships = yield* WorkspaceStore.listMemberships(workspaceId)
        const userMemberships = yield* WorkspaceStore.listUserMemberships(memberId)
        const after = yield* WorkspaceStore.workspaceHasMembers(workspaceId)
        return { before, fetched, workspaceMemberships, userMemberships, after }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.before).toBe(false)
    expect(result.fetched).toEqual(owner)
    expect(result.workspaceMemberships.map((item) => item.user_id)).toEqual([memberId, ownerId])
    expect(result.userMemberships).toEqual([member])
    expect(result.after).toBe(true)
  })

  test("membership ids are scoped by workspace and user", async () => {
    const owner = membership(ownerId, "owner", workspaceId)
    const sameUserOtherWorkspace = membership(ownerId, "owner", otherWorkspaceId)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* WorkspaceStore.putMembership(owner)
        yield* WorkspaceStore.putMembership(sameUserOtherWorkspace)
        return yield* WorkspaceStore.listUserMemberships(ownerId)
      }).pipe(Effect.provide(layer)),
    )

    expect(result.map((item) => item.workspace_id)).toEqual([workspaceId, otherWorkspaceId])
  })
})

const membership = (
  userId: Ids.UserId,
  role: Workspace.MembershipRole,
  workspaceIdValue: Ids.WorkspaceId,
): Workspace.Membership => ({
  workspace_id: workspaceIdValue,
  user_id: userId,
  role,
  created_at: now,
})

import { describe, expect, test } from "bun:test"
import { Config, Time } from "@rika/core"
import { Database, Migration, ThreadEventLog, ThreadProjection, WorkspaceStore } from "@rika/persistence"
import { Common, Event, Ids, Workspace } from "@rika/schema"
import { Effect, Layer } from "effect"
import { WorkspaceAccess } from "../src/index"

const workspaceId = Ids.WorkspaceId.make("workspace_access")
const otherWorkspaceId = Ids.WorkspaceId.make("workspace_access_other")
const ownerId = Ids.UserId.make("user_access_owner")
const memberId = Ids.UserId.make("user_access_member")
const outsiderId = Ids.UserId.make("user_access_outsider")
const threadId = Ids.ThreadId.make("thread_access")
const now = Common.TimestampMillis.make(1_990_000_000_000)

const configLayer = Config.layerFromValues({
  workspace_root: "/workspace/rika-access-test",
  data_dir: "/workspace/rika-access-test/.rika",
  default_mode: "smart",
})
const databaseLayer = Database.memoryLayer
const timeLayer = Time.fixedLayer(now)
const storeLayer = WorkspaceStore.layer.pipe(Layer.provideMerge(databaseLayer))
const accessLayer = WorkspaceAccess.layer.pipe(
  Layer.provideMerge(databaseLayer),
  Layer.provideMerge(ThreadProjection.layer),
  Layer.provideMerge(storeLayer),
  Layer.provideMerge(timeLayer),
)
const layer = Layer.mergeAll(
  configLayer,
  databaseLayer,
  Migration.layer,
  ThreadEventLog.layer,
  ThreadProjection.layer,
  storeLayer,
  timeLayer,
  accessLayer,
)

describe("WorkspaceAccess", () => {
  test("allows local mode without a user identity", async () => {
    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* WorkspaceAccess.authorizeWorkspace({ workspace_id: workspaceId, action: "write" })
      }).pipe(Effect.provide(layer)),
    )

    expect(decision).toEqual({ allowed: true, action: "write", workspace_id: workspaceId })
  })

  test("enforces member and owner role boundaries", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* WorkspaceStore.putMembership(membership(ownerId, "owner", workspaceId))
        yield* WorkspaceStore.putMembership(membership(memberId, "member", workspaceId))
        const ownerAdmin = yield* WorkspaceAccess.authorizeWorkspace({
          workspace_id: workspaceId,
          user_id: ownerId,
          action: "admin",
        })
        const memberWrite = yield* WorkspaceAccess.authorizeWorkspace({
          workspace_id: workspaceId,
          user_id: memberId,
          action: "write",
        })
        const memberAdmin = yield* WorkspaceAccess.authorizeWorkspace({
          workspace_id: workspaceId,
          user_id: memberId,
          action: "admin",
        })
        const outsiderRead = yield* WorkspaceAccess.authorizeWorkspace({
          workspace_id: workspaceId,
          user_id: outsiderId,
          action: "read",
        })
        return { ownerAdmin, memberWrite, memberAdmin, outsiderRead }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.ownerAdmin.allowed).toBe(true)
    expect(result.memberWrite.allowed).toBe(true)
    expect(result.memberAdmin.allowed).toBe(false)
    expect(result.outsiderRead.allowed).toBe(false)
  })

  test("checks thread access through the thread workspace projection", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const created = yield* ThreadEventLog.append(threadCreated())
        yield* ThreadProjection.apply(created)
        yield* WorkspaceStore.putMembership(membership(memberId, "member", workspaceId))
        const memberRead = yield* WorkspaceAccess.authorizeThread({
          thread_id: threadId,
          user_id: memberId,
          action: "read",
        })
        const outsiderRead = yield* WorkspaceAccess.authorizeThread({
          thread_id: threadId,
          user_id: outsiderId,
          action: "read",
        })
        const summaries = yield* ThreadProjection.listThreads()
        const readable = yield* WorkspaceAccess.filterReadableThreads(summaries, memberId)
        return { memberRead, outsiderRead, readable }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.memberRead.allowed).toBe(true)
    expect(result.outsiderRead.allowed).toBe(false)
    expect(result.readable.map((summary) => summary.thread_id)).toEqual([threadId])
  })

  test("bootstraps an empty hosted workspace owner but denies later outsiders", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        const owner = yield* WorkspaceAccess.ensureWorkspaceForCreate({
          workspace_id: otherWorkspaceId,
          user_id: ownerId,
          action: "write",
        })
        const outsider = yield* WorkspaceAccess.authorizeWorkspace({
          workspace_id: otherWorkspaceId,
          user_id: outsiderId,
          action: "write",
        })
        const memberships = yield* WorkspaceStore.listMemberships(otherWorkspaceId)
        return { owner, outsider, memberships }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.owner.allowed).toBe(true)
    expect(result.outsider.allowed).toBe(false)
    expect(result.memberships).toEqual([membership(ownerId, "owner", otherWorkspaceId)])
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

const threadCreated = (): Event.ThreadCreated => ({
  id: Ids.EventId.make("event_access_thread_created"),
  thread_id: threadId,
  sequence: 1,
  version: 1,
  created_at: now,
  type: "thread.created",
  data: { workspace_id: workspaceId },
})

import { describe, expect, test } from "bun:test"
import { Ids } from "@rika/schema"
import * as PresenceActor from "../src/presence-actor"

describe("PresenceActor", () => {
  test("heartbeats replace the same user and expire stale members", () => {
    const threadId = Ids.ThreadId.make("thread_presence")
    const alice = Ids.UserId.make("alice")
    const bob = Ids.UserId.make("bob")
    const first = PresenceActor.applyHeartbeat(PresenceActor.emptyState(), {
      thread_id: threadId,
      user_id: alice,
      at: 1000,
      connection_id: "c1",
      ttl_ms: 45_000,
    })
    const second = PresenceActor.applyHeartbeat(first, {
      thread_id: threadId,
      user_id: bob,
      at: 2000,
      ttl_ms: 45_000,
    })
    const third = PresenceActor.applyHeartbeat(second, {
      thread_id: threadId,
      user_id: alice,
      at: 50_000,
      connection_id: "c2",
      ttl_ms: 45_000,
    })

    expect(third.members.map((member) => member.user_id)).toEqual([alice])
    expect(third.members.find((member) => member.user_id === alice)?.connection_id).toBe("c2")
    expect(PresenceActor.activeMembers(third, 50_000, 45_000).map((member) => member.user_id)).toEqual([alice])
    expect(PresenceActor.activeMembers(second, 2_000, 45_000).map((member) => member.user_id)).toEqual([alice, bob])
  })
})

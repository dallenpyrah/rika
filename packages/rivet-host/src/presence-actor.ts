import { Action } from "@rivetkit/effect"
import { Ids } from "@rika/schema"
import { Schema } from "effect"

export interface PresenceMember extends Schema.Schema.Type<typeof PresenceMember> {}
export const PresenceMember = Schema.Struct({
  user_id: Ids.UserId,
  last_seen_at: Schema.Int,
  connection_id: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.RivetHost.PresenceActor.PresenceMember" })

export interface PresenceActorState extends Schema.Schema.Type<typeof PresenceActorState> {}
export const PresenceActorState = Schema.Struct({
  thread_id: Schema.optional(Ids.ThreadId),
  members: Schema.Array(PresenceMember),
}).annotate({ identifier: "Rika.RivetHost.PresenceActor.State" })

export interface HeartbeatPayload extends Schema.Schema.Type<typeof HeartbeatPayload> {}
export const HeartbeatPayload = Schema.Struct({
  thread_id: Ids.ThreadId,
  user_id: Ids.UserId,
  at: Schema.Int,
  connection_id: Schema.optional(Schema.String),
  ttl_ms: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.RivetHost.PresenceActor.HeartbeatPayload" })

export interface ListPresencePayload extends Schema.Schema.Type<typeof ListPresencePayload> {}
export const ListPresencePayload = Schema.Struct({
  thread_id: Ids.ThreadId,
  at: Schema.Int,
  ttl_ms: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.RivetHost.PresenceActor.ListPresencePayload" })

export const Heartbeat = Action.make("Heartbeat", {
  payload: HeartbeatPayload,
  success: PresenceActorState,
  error: Schema.Never,
})

export const ListPresence = Action.make("ListPresence", {
  payload: ListPresencePayload,
  success: Schema.Array(PresenceMember),
  error: Schema.Never,
})

export const emptyState = (): PresenceActorState => ({ members: [] })

export const applyHeartbeat = (
  state: PresenceActorState,
  payload: HeartbeatPayload,
): PresenceActorState => {
  const ttl = payload.ttl_ms ?? 45_000
  const cutoff = payload.at - ttl
  const others = state.members.filter(
    (member) => member.user_id !== payload.user_id && member.last_seen_at >= cutoff,
  )
  return {
    thread_id: payload.thread_id,
    members: [
      ...others,
      {
        user_id: payload.user_id,
        last_seen_at: payload.at,
        ...(payload.connection_id === undefined ? {} : { connection_id: payload.connection_id }),
      },
    ],
  }
}

export const activeMembers = (
  state: PresenceActorState,
  at: number,
  ttlMs = 45_000,
): ReadonlyArray<PresenceMember> => {
  const cutoff = at - ttlMs
  return state.members.filter((member) => member.last_seen_at >= cutoff)
}

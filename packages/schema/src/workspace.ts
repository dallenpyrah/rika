import { Schema } from "effect"
import { TimestampMillis } from "./common"
import { UserId, WorkspaceId } from "./ids"

export const MembershipRole = Schema.Literals(["owner", "member"]).annotate({
  identifier: "Rika.Workspace.MembershipRole",
})
export type MembershipRole = typeof MembershipRole.Type

export const AccessAction = Schema.Literals(["read", "write", "admin"]).annotate({
  identifier: "Rika.Workspace.AccessAction",
})
export type AccessAction = typeof AccessAction.Type

export interface Membership extends Schema.Schema.Type<typeof Membership> {}
export const Membership = Schema.Struct({
  workspace_id: WorkspaceId,
  user_id: UserId,
  role: MembershipRole,
  created_at: TimestampMillis,
}).annotate({ identifier: "Rika.Workspace.Membership" })

export interface AccessDecision extends Schema.Schema.Type<typeof AccessDecision> {}
export const AccessDecision = Schema.Struct({
  allowed: Schema.Boolean,
  action: AccessAction,
  workspace_id: WorkspaceId,
  user_id: Schema.optional(UserId),
  reason: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Workspace.AccessDecision" })

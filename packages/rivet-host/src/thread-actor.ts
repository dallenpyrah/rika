import { Action, Actor } from "@rivetkit/effect"
import { AgentLoop, WorkspaceAccess } from "@rika/agent"
import { Database, ThreadEventLog, ThreadProjection, WorkspaceStore } from "@rika/persistence"
import { Event, Ids, Message, Tool } from "@rika/schema"
import { Schema } from "effect"

export const AgentMode = Schema.Literals(["rush", "smart", "deep1", "deep2", "deep3"]).annotate({
  identifier: "Rika.RivetHost.ThreadActor.AgentMode",
})
export type AgentMode = typeof AgentMode.Type

export const TurnStatus = Schema.Literals(["idle", "active", "completed", "failed"]).annotate({
  identifier: "Rika.RivetHost.ThreadActor.TurnStatus",
})
export type TurnStatus = typeof TurnStatus.Type

export interface ThreadActorSnapshot extends Schema.Schema.Type<typeof ThreadActorSnapshot> {}
export const ThreadActorSnapshot = Schema.Struct({
  thread_id: Ids.ThreadId,
  last_sequence: Schema.Int,
  message_count: Schema.Int,
  archived: Schema.Boolean,
  visibility: Event.ThreadVisibility,
  active_turn_id: Schema.optional(Ids.TurnId),
  active_turn_status: TurnStatus,
  active_user_id: Schema.optional(Ids.UserId),
  latest_message_id: Schema.optional(Ids.MessageId),
  latest_message_role: Schema.optional(Message.Role),
  latest_message_text: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.RivetHost.ThreadActor.Snapshot" })

export interface ThreadActorState extends Schema.Schema.Type<typeof ThreadActorState> {}
export const ThreadActorState = Schema.Struct({
  thread_id: Schema.optional(Ids.ThreadId),
  workspace_id: Schema.optional(Ids.WorkspaceId),
  user_id: Schema.optional(Ids.UserId),
  created_at: Schema.optional(Schema.Int),
  last_sequence: Schema.Int,
  message_count: Schema.Int,
  archived: Schema.Boolean,
  visibility: Event.ThreadVisibility,
  active_turn_id: Schema.optional(Ids.TurnId),
  active_turn_status: TurnStatus,
  active_user_id: Schema.optional(Ids.UserId),
  latest_message_id: Schema.optional(Ids.MessageId),
  latest_message_role: Schema.optional(Message.Role),
  latest_message_text: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.RivetHost.ThreadActor.State" })

export interface VerifiedUserIdentity extends Schema.Schema.Type<typeof VerifiedUserIdentity> {}
export const VerifiedUserIdentity = Schema.Struct({
  _tag: Schema.Literal("VerifiedUserIdentity"),
  user_id: Ids.UserId,
}).annotate({ identifier: "Rika.RivetHost.ThreadActor.VerifiedUserIdentity" })

export interface EnsureThreadPayload extends Schema.Schema.Type<typeof EnsureThreadPayload> {}
export const EnsureThreadPayload = Schema.Struct({
  thread_id: Ids.ThreadId,
  workspace_id: Ids.WorkspaceId,
  identity: Schema.optional(VerifiedUserIdentity),
}).annotate({ identifier: "Rika.RivetHost.ThreadActor.EnsureThreadPayload" })

export interface StartTurnPayload extends Schema.Schema.Type<typeof StartTurnPayload> {}
export const StartTurnPayload = Schema.Struct({
  thread_id: Ids.ThreadId,
  workspace_id: Ids.WorkspaceId,
  identity: Schema.optional(VerifiedUserIdentity),
  content: Schema.String,
  content_parts: Schema.optional(Schema.Array(Message.ContentPart)),
  mode: Schema.optional(AgentMode),
  fast_mode: Schema.optional(Schema.Boolean),
  cancelled: Schema.optional(Schema.Boolean),
  tool_access: Schema.optional(Tool.TurnToolAccess),
}).annotate({ identifier: "Rika.RivetHost.ThreadActor.StartTurnPayload" })

export interface StartTurnResult extends Schema.Schema.Type<typeof StartTurnResult> {}
export const StartTurnResult = Schema.Struct({
  thread_id: Ids.ThreadId,
  accepted: Schema.Literal(true),
}).annotate({ identifier: "Rika.RivetHost.ThreadActor.StartTurnResult" })

export interface ThreadIdPayload extends Schema.Schema.Type<typeof ThreadIdPayload> {}
export const ThreadIdPayload = Schema.Struct({
  thread_id: Ids.ThreadId,
  identity: Schema.optional(VerifiedUserIdentity),
}).annotate({ identifier: "Rika.RivetHost.ThreadActor.ThreadIdPayload" })

export interface InterruptTurnPayload extends Schema.Schema.Type<typeof InterruptTurnPayload> {}
export const InterruptTurnPayload = Schema.Struct({
  thread_id: Ids.ThreadId,
  turn_id: Ids.TurnId,
  identity: Schema.optional(VerifiedUserIdentity),
  reason: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.RivetHost.ThreadActor.InterruptTurnPayload" })

export interface GetEventsPayload extends Schema.Schema.Type<typeof GetEventsPayload> {}
export const GetEventsPayload = Schema.Struct({
  thread_id: Ids.ThreadId,
  identity: Schema.optional(VerifiedUserIdentity),
  after_sequence: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.RivetHost.ThreadActor.GetEventsPayload" })

export interface AppendMirroredEventsPayload extends Schema.Schema.Type<typeof AppendMirroredEventsPayload> {}
export const AppendMirroredEventsPayload = Schema.Struct({
  thread_id: Ids.ThreadId,
  identity: Schema.optional(VerifiedUserIdentity),
  events: Schema.Array(Event.Event),
}).annotate({ identifier: "Rika.RivetHost.ThreadActor.AppendMirroredEventsPayload" })

export interface AppendMirroredEventsResult extends Schema.Schema.Type<typeof AppendMirroredEventsResult> {}
export const AppendMirroredEventsResult = Schema.Struct({
  inserted_events: Schema.Array(Event.Event),
  skipped_count: Schema.Int,
}).annotate({ identifier: "Rika.RivetHost.ThreadActor.AppendMirroredEventsResult" })

export interface SetVisibilityPayload extends Schema.Schema.Type<typeof SetVisibilityPayload> {}
export const SetVisibilityPayload = Schema.Struct({
  thread_id: Ids.ThreadId,
  identity: Schema.optional(VerifiedUserIdentity),
  visibility: Event.ThreadVisibility,
}).annotate({ identifier: "Rika.RivetHost.ThreadActor.SetVisibilityPayload" })

export interface PrepareForkThreadPayload extends Schema.Schema.Type<typeof PrepareForkThreadPayload> {}
export const PrepareForkThreadPayload = Schema.Struct({
  thread_id: Ids.ThreadId,
  identity: Schema.optional(VerifiedUserIdentity),
  fork_thread_id: Ids.ThreadId,
  at_turn: Schema.optional(Ids.TurnId),
  user_id: Schema.optional(Ids.UserId),
  title_text: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.RivetHost.ThreadActor.PrepareForkThreadPayload" })

export interface ImportForkThreadPayload extends Schema.Schema.Type<typeof ImportForkThreadPayload> {}
export const ImportForkThreadPayload = Schema.Struct({
  thread_id: Ids.ThreadId,
  identity: VerifiedUserIdentity,
  events: Schema.Array(Event.Event),
}).annotate({ identifier: "Rika.RivetHost.ThreadActor.ImportForkThreadPayload" })

export class ThreadActorActionError extends Schema.TaggedErrorClass<ThreadActorActionError>()(
  "ThreadActorActionError",
  {
    message: Schema.String,
    operation: Schema.String,
    thread_id: Schema.optional(Ids.ThreadId),
  },
) {}

export const ThreadActorForkErrorReason = Schema.Literals(["source_missing", "turn_missing", "turn_open"]).annotate({
  identifier: "Rika.RivetHost.ThreadActor.ForkErrorReason",
})
export type ThreadActorForkErrorReason = typeof ThreadActorForkErrorReason.Type

export class ThreadActorForkError extends Schema.TaggedErrorClass<ThreadActorForkError>()("ThreadActorForkError", {
  message: Schema.String,
  reason: ThreadActorForkErrorReason,
  thread_id: Ids.ThreadId,
  turn_id: Schema.optional(Ids.TurnId),
}) {}

export class ThreadActorActiveTurn extends Schema.TaggedErrorClass<ThreadActorActiveTurn>()("ThreadActorActiveTurn", {
  message: Schema.String,
  thread_id: Ids.ThreadId,
  active_user_id: Schema.optional(Ids.UserId),
}) {}

export const ThreadActorError = Schema.Union([
  ThreadActorActionError,
  ThreadActorActiveTurn,
  WorkspaceAccess.WorkspaceAccessError,
  WorkspaceAccess.WorkspaceAccessDenied,
  ThreadEventLog.ThreadEventLogError,
  AgentLoop.AgentLoopError,
  Database.DatabaseError,
  ThreadProjection.ThreadProjectionError,
  WorkspaceStore.WorkspaceStoreError,
  ThreadActorForkError,
]).annotate({ identifier: "Rika.RivetHost.ThreadActor.Error" })
export type ThreadActorError = typeof ThreadActorError.Type

export const EnsureThread = Action.make("EnsureThread", {
  payload: EnsureThreadPayload,
  success: ThreadActorSnapshot,
  error: ThreadActorError,
})

export const StartTurn = Action.make("StartTurn", {
  payload: StartTurnPayload,
  success: StartTurnResult,
  error: ThreadActorError,
})

export const GetEvents = Action.make("GetEvents", {
  payload: GetEventsPayload,
  success: Schema.Array(Event.Event),
  error: ThreadActorError,
})

export const AppendMirroredEvents = Action.make("AppendMirroredEvents", {
  payload: AppendMirroredEventsPayload,
  success: AppendMirroredEventsResult,
  error: ThreadActorError,
})

export const ReplayThread = Action.make("ReplayThread", {
  payload: ThreadIdPayload,
  success: ThreadActorSnapshot,
  error: ThreadActorError,
})

export const GetSnapshot = Action.make("GetSnapshot", {
  payload: ThreadIdPayload,
  success: ThreadActorSnapshot,
  error: ThreadActorError,
})

export const SetVisibility = Action.make("SetVisibility", {
  payload: SetVisibilityPayload,
  success: ThreadActorSnapshot,
  error: ThreadActorError,
})

export const PrepareForkThread = Action.make("PrepareForkThread", {
  payload: PrepareForkThreadPayload,
  success: Schema.Array(Event.Event),
  error: ThreadActorError,
})

export const ImportForkThread = Action.make("ImportForkThread", {
  payload: ImportForkThreadPayload,
  success: ThreadActorSnapshot,
  error: ThreadActorError,
})

export const ArchiveThread = Action.make("ArchiveThread", {
  payload: ThreadIdPayload,
  success: ThreadActorSnapshot,
  error: ThreadActorError,
})

export const UnarchiveThread = Action.make("UnarchiveThread", {
  payload: ThreadIdPayload,
  success: ThreadActorSnapshot,
  error: ThreadActorError,
})

export const CompactThread = Action.make("CompactThread", {
  payload: ThreadIdPayload,
  success: Event.ContextCompacted,
  error: ThreadActorError,
})

export const InterruptTurn = Action.make("InterruptTurn", {
  payload: InterruptTurnPayload,
  success: Event.TurnTerminal,
  error: ThreadActorError,
})

export const ThreadActor = Actor.make("ThreadActor", {
  actions: [
    EnsureThread,
    StartTurn,
    GetEvents,
    AppendMirroredEvents,
    ReplayThread,
    GetSnapshot,
    SetVisibility,
    PrepareForkThread,
    ImportForkThread,
    ArchiveThread,
    UnarchiveThread,
    CompactThread,
    InterruptTurn,
  ],
})

export const emptyState = (): ThreadActorState => ({
  last_sequence: 0,
  message_count: 0,
  archived: false,
  visibility: "private",
  active_turn_status: "idle",
})

export const snapshotFromState = (state: ThreadActorState, threadId: Ids.ThreadId): ThreadActorSnapshot => ({
  ...snapshotFieldsFromState(state),
  thread_id: state.thread_id ?? threadId,
})

export const stateFromEvents = (threadId: Ids.ThreadId, events: ReadonlyArray<Event.Event>): ThreadActorState =>
  events.reduce(applyEventToState, { ...emptyState(), thread_id: threadId })

export const applyEventToState = (state: ThreadActorState, event: Event.Event): ThreadActorState => {
  switch (event.type) {
    case "thread.created":
      return {
        ...state,
        thread_id: event.thread_id,
        workspace_id: event.data.workspace_id,
        ...(event.data.user_id === undefined ? {} : { user_id: event.data.user_id }),
        created_at: event.created_at,
        last_sequence: event.sequence,
      }
    case "message.added":
      return {
        ...state,
        thread_id: event.thread_id,
        last_sequence: event.sequence,
        message_count: state.message_count + 1,
        latest_message_id: event.data.message.id,
        latest_message_role: event.data.message.role,
        latest_message_text: textFromMessage(event.data.message),
      }
    case "turn.started":
      return {
        ...state,
        thread_id: event.thread_id,
        last_sequence: event.sequence,
        active_turn_id: event.turn_id,
        active_turn_status: "active",
        ...(event.data.user_id === undefined ? {} : { active_user_id: event.data.user_id }),
      }
    case "turn.completed":
      return {
        ...withoutActiveUser(state),
        thread_id: event.thread_id,
        last_sequence: event.sequence,
        active_turn_id: event.turn_id,
        active_turn_status: "completed",
      }
    case "turn.failed":
      return {
        ...withoutActiveUser(state),
        thread_id: event.thread_id,
        last_sequence: event.sequence,
        active_turn_id: event.turn_id,
        active_turn_status: "failed",
      }
    case "thread.archived":
      return {
        ...state,
        thread_id: event.thread_id,
        last_sequence: event.sequence,
        archived: true,
      }
    case "thread.unarchived":
      return {
        ...state,
        thread_id: event.thread_id,
        last_sequence: event.sequence,
        archived: false,
      }
    case "thread.visibility.set":
      return {
        ...state,
        thread_id: event.thread_id,
        last_sequence: event.sequence,
        visibility: event.data.visibility,
      }
    default:
      return { ...state, thread_id: event.thread_id, last_sequence: event.sequence }
  }
}

const snapshotFieldsFromState = (state: ThreadActorState) => {
  const { workspace_id: workspaceId, user_id: userId, created_at: createdAt, ...snapshot } = state
  void workspaceId
  void userId
  void createdAt
  return snapshot
}

const withoutActiveUser = (state: ThreadActorState): ThreadActorState => {
  const { active_user_id: activeUserId, ...rest } = state
  void activeUserId
  return rest
}

const textFromMessage = (message: Message.Message) => Message.displayText(message)

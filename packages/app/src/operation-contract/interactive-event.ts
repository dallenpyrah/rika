import * as Thread from "@rika/persistence/thread"
import * as ThreadSummary from "@rika/persistence/thread-summary"
import * as TranscriptPage from "@rika/persistence/transcript-page"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Schema } from "effect"

export interface QueueItem {
  readonly id: Turn.TurnId
  readonly prompt: string
  readonly attachments?: ReadonlyArray<string>
}

export type QueueChange =
  | { readonly _tag: "Reset"; readonly items: ReadonlyArray<QueueItem> }
  | { readonly _tag: "Added"; readonly item: QueueItem }
  | { readonly _tag: "Updated"; readonly item: QueueItem }
  | { readonly _tag: "Removed"; readonly turnId: Turn.TurnId }

export type InteractiveEvent =
  | { readonly _tag: "ThreadsListed"; readonly threads: ReadonlyArray<ThreadSummary.ThreadSummary> }
  | {
      readonly _tag: "ContextDiagnostics"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly turnId: Turn.TurnId
      readonly messages: ReadonlyArray<string>
    }
  | {
      readonly _tag: "TitleCostUpdated"
      readonly threadId: Thread.ThreadId
      readonly turnId: Turn.TurnId
      readonly turnCostUsd: number
      readonly threadCostUsd: number
      readonly globalCostUsd: number
    }
  | {
      readonly _tag: "TranscriptPatched"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly turnId: Turn.TurnId
      readonly rootTurnId?: Turn.TurnId
      readonly rootTurnCostUsd?: number
      readonly threadCostUsd?: number
      readonly globalCostUsd?: number
      readonly event: ExecutionBackend.Event
      readonly revision: number
    }
  | {
      readonly _tag: "TranscriptResyncRequired"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly reason: string
    }
  | { readonly _tag: "AssistantCompleted"; readonly text: string }
  | {
      readonly _tag: "ExecutionFailed"
      readonly selectionEpoch: number
      readonly threadId?: Thread.ThreadId
      readonly turnId?: Turn.TurnId
      readonly message: string
    }
  | {
      readonly _tag: "QueueUpdated"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly revision: number
      readonly queuedCount: number
      readonly change: QueueChange
    }
  | {
      readonly _tag: "QueueFull"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly capacity: number
      readonly count: number
    }
  | {
      readonly _tag: "QueueResyncRequired"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly reason: string
    }
  | {
      readonly _tag: "TurnStarted"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly turn: Turn.Turn
    }
  | {
      readonly _tag: "SelectionLoaded"
      readonly selectionEpoch: number
      readonly activitySequence: number
      readonly thread: Thread.Thread
      readonly entries: ReadonlyArray<TranscriptPage.Entry>
      readonly hasOlder: boolean
      readonly threadCostUsd: number
      readonly globalCostUsd?: number
      readonly oldestCursor?: TranscriptPage.PageCursor
      readonly queueRevision: number
      readonly queuedCount?: number
      readonly queue: ReadonlyArray<QueueItem>
      readonly activeTurn?: Turn.Turn
    }
  | {
      readonly _tag: "TranscriptPagePrepended"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly entries: ReadonlyArray<TranscriptPage.Entry>
      readonly hasOlder: boolean
      readonly threadCostUsd: number
      readonly globalCostUsd?: number
      readonly oldestCursor?: TranscriptPage.PageCursor
    }
  | { readonly _tag: "ShellPermissionRequested"; readonly id: string; readonly command: string }
  | { readonly _tag: "ShellPermissionCancelled"; readonly id: string }
  | { readonly _tag: "ShellCompleted"; readonly command: string; readonly text: string; readonly incognito: boolean }
  | {
      readonly _tag: "ExecutionControlled"
      readonly selectionEpoch: number
      readonly threadId?: Thread.ThreadId
      readonly turnId?: Turn.TurnId
      readonly action: "steered" | "cancelled" | "permission-resolved"
    }
  | { readonly _tag: "ThreadTitled"; readonly threadId: string; readonly title: string }
  | { readonly _tag: "ThreadActivated"; readonly threadId: string; readonly title: string }
  | {
      readonly _tag: "ThreadPreviewLoaded"
      readonly threadId: string
      readonly turns: ReadonlyArray<{ readonly prompt: string; readonly events: ReadonlyArray<ExecutionBackend.Event> }>
    }

export const InteractiveEventSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("ContextDiagnostics"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    turnId: Turn.TurnId,
    messages: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.tag("TitleCostUpdated"),
    threadId: Thread.ThreadId,
    turnId: Turn.TurnId,
    turnCostUsd: Schema.Finite,
    threadCostUsd: Schema.Finite,
    globalCostUsd: Schema.Finite,
  }),
  Schema.Struct({
    _tag: Schema.tag("TranscriptPatched"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    turnId: Turn.TurnId,
    rootTurnId: Schema.optionalKey(Turn.TurnId),
    rootTurnCostUsd: Schema.optionalKey(Schema.Finite),
    threadCostUsd: Schema.optionalKey(Schema.Finite),
    globalCostUsd: Schema.optionalKey(Schema.Finite),
    event: ExecutionBackend.Event,
    revision: Schema.Finite,
  }),
  Schema.Struct({
    _tag: Schema.tag("TranscriptResyncRequired"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    reason: Schema.String,
  }),
  Schema.Struct({ _tag: Schema.tag("ThreadsListed"), threads: Schema.Array(ThreadSummary.ThreadSummary) }),
  Schema.Struct({ _tag: Schema.tag("AssistantCompleted"), text: Schema.String }),
  Schema.Struct({
    _tag: Schema.tag("ExecutionFailed"),
    selectionEpoch: Schema.Int,
    threadId: Schema.optionalKey(Thread.ThreadId),
    turnId: Schema.optionalKey(Turn.TurnId),
    message: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.tag("QueueUpdated"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    revision: Schema.Int,
    queuedCount: Schema.Int,
    change: Schema.Union([
      Schema.Struct({
        _tag: Schema.tag("Reset"),
        items: Schema.Array(
          Schema.Struct({
            id: Turn.TurnId,
            prompt: Schema.String,
            attachments: Schema.optionalKey(Schema.Array(Schema.String)),
          }),
        ),
      }),
      Schema.Struct({
        _tag: Schema.tag("Added"),
        item: Schema.Struct({
          id: Turn.TurnId,
          prompt: Schema.String,
          attachments: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      }),
      Schema.Struct({
        _tag: Schema.tag("Updated"),
        item: Schema.Struct({
          id: Turn.TurnId,
          prompt: Schema.String,
          attachments: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      }),
      Schema.Struct({ _tag: Schema.tag("Removed"), turnId: Turn.TurnId }),
    ]),
  }),
  Schema.Struct({
    _tag: Schema.tag("QueueFull"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    capacity: Schema.Int,
    count: Schema.Int,
  }),
  Schema.Struct({
    _tag: Schema.tag("QueueResyncRequired"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    reason: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.tag("TurnStarted"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    turn: Turn.Turn,
  }),
  Schema.Struct({
    _tag: Schema.tag("SelectionLoaded"),
    selectionEpoch: Schema.Int,
    activitySequence: Schema.Int,
    thread: Thread.Thread,
    entries: Schema.Array(TranscriptPage.EntrySchema),
    hasOlder: Schema.Boolean,
    threadCostUsd: Schema.Finite,
    globalCostUsd: Schema.optionalKey(Schema.Finite),
    oldestCursor: Schema.optionalKey(TranscriptPage.PageCursor),
    queueRevision: Schema.Int,
    queuedCount: Schema.optionalKey(Schema.Int),
    queue: Schema.Array(
      Schema.Struct({
        id: Turn.TurnId,
        prompt: Schema.String,
        attachments: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
    ),
    activeTurn: Schema.optionalKey(Turn.Turn),
  }),
  Schema.Struct({
    _tag: Schema.tag("TranscriptPagePrepended"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    entries: Schema.Array(TranscriptPage.EntrySchema),
    hasOlder: Schema.Boolean,
    threadCostUsd: Schema.Finite,
    globalCostUsd: Schema.optionalKey(Schema.Finite),
    oldestCursor: Schema.optionalKey(TranscriptPage.PageCursor),
  }),
  Schema.Struct({ _tag: Schema.tag("ShellPermissionRequested"), id: Schema.String, command: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("ShellPermissionCancelled"), id: Schema.String }),
  Schema.Struct({
    _tag: Schema.tag("ShellCompleted"),
    command: Schema.String,
    text: Schema.String,
    incognito: Schema.Boolean,
  }),
  Schema.Struct({
    _tag: Schema.tag("ExecutionControlled"),
    selectionEpoch: Schema.Int,
    threadId: Schema.optionalKey(Thread.ThreadId),
    turnId: Schema.optionalKey(Turn.TurnId),
    action: Schema.Literals(["steered", "cancelled", "permission-resolved"]),
  }),
  Schema.Struct({ _tag: Schema.tag("ThreadTitled"), threadId: Schema.String, title: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("ThreadActivated"), threadId: Schema.String, title: Schema.String }),
  Schema.Struct({
    _tag: Schema.tag("ThreadPreviewLoaded"),
    threadId: Schema.String,
    turns: Schema.Array(Schema.Struct({ prompt: Schema.String, events: Schema.Array(ExecutionBackend.Event) })),
  }),
])

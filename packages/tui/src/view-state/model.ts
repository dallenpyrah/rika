import type * as Transcript from "@rika/transcript"
import { Function, Schema } from "effect"
import type { Key } from "../keys"

export const Mode = Schema.Literals(["low", "medium", "high", "ultra"])
export type Mode = typeof Mode.Type

export const Activity = Schema.Union([
  Schema.TaggedStruct("Sending", {}),
  Schema.TaggedStruct("Waiting", {}),
  Schema.TaggedStruct("Thinking", { bytes: Schema.Finite, blockId: Schema.optionalKey(Schema.String) }),
  Schema.TaggedStruct("Streaming", { bytes: Schema.Finite, blockId: Schema.optionalKey(Schema.String) }),
  Schema.TaggedStruct("RunningTools", {}),
])
export type Activity = typeof Activity.Type

export const utf8ByteLength = (value: string): number => {
  let bytes = 0
  for (const character of value) {
    const point = character.codePointAt(0)!
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
  }
  return bytes
}

export const formatActivityCounter = (tokens: number): string =>
  tokens < 1_000
    ? `${tokens} tok`
    : tokens < 10_000
      ? `${(tokens / 1_000).toFixed(2)}k tok`
      : tokens < 1_000_000
        ? `${(tokens / 1_000).toFixed(1)}k tok`
        : `${(tokens / 1_000_000).toFixed(1)}M tok`

export const formatActivity = (activity: Activity | undefined): string | undefined => {
  if (activity === undefined) return undefined
  if (activity._tag === "RunningTools") return "Running tools"
  if (activity._tag === "Thinking" || activity._tag === "Streaming") {
    const tokens = Math.floor(activity.bytes / 4)
    return `${activity._tag} ${formatActivityCounter(tokens)}`
  }
  return activity._tag
}

const streamActivityImpl = (
  current: Activity | undefined,
  tag: "Thinking" | "Streaming",
  text: string,
  blockId?: string,
): Activity => ({
  _tag: tag,
  bytes:
    current?._tag === tag && current.blockId === blockId ? current.bytes + utf8ByteLength(text) : utf8ByteLength(text),
  ...(blockId === undefined ? {} : { blockId }),
})

export const streamActivity: {
  (current: Activity | undefined, tag: "Thinking" | "Streaming", text: string, blockId: string | undefined): Activity
  (
    tag: "Thinking" | "Streaming",
    text: string,
    blockId: string | undefined,
  ): (current: Activity | undefined) => Activity
} = Function.dual(4, streamActivityImpl)

export const Entry = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "notice"]),
  text: Schema.String,
  turnId: Schema.optionalKey(Schema.String),
})
export type Entry = typeof Entry.Type

export type TranscriptBlock = Transcript.Block

export interface ThreadItem {
  readonly id: string
  readonly title: string
  readonly workspace: string
  readonly pinned: boolean
  readonly archived: boolean
  readonly status: "idle" | "queued" | "running" | "waiting"
  readonly unread: boolean
  readonly lastActivityAt: number
  readonly editTotals?: { readonly added: number; readonly modified: number; readonly removed: number }
}

export type PermissionDecision = "allow" | "always" | "deny"
export type PromptPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly path: string }
export type ComposerAttachment =
  | {
      readonly type: "text"
      readonly token: string
      readonly value: string
      readonly label: string
    }
  | {
      readonly type: "image"
      readonly token: string
      readonly path: string
      readonly label: string
    }
export interface ComposerDraft {
  readonly input: string
  readonly attachments: ReadonlyArray<ComposerAttachment>
}
export interface PastedTextAttachment {
  readonly type: "text" | "image"
  readonly token: string
  readonly value?: string
  readonly path?: string
  readonly label: string
}
export type UiEvent = {
  readonly id: string
  readonly cursor: string
  readonly turnId?: string
  readonly block: TranscriptBlock
}
export type TranscriptItem =
  | {
      readonly _tag: "Entry"
      readonly index: number
      readonly id?: string
      readonly turnId?: string
      readonly parentId?: string
    }
  | {
      readonly _tag: "Block"
      readonly index: number
      readonly id?: string
      readonly turnId?: string
      readonly parentId?: string
    }

export interface PaletteState {
  readonly open: boolean
  readonly query: string
  readonly selected: number
}
export interface ModePickerState {
  readonly open: boolean
  readonly selected: number
}
export interface FilePickerState {
  readonly open: boolean
  readonly query: string
  readonly selected: number
  readonly items: Loadable<ReadonlyArray<string>>
}
export interface ThreadSwitcherState {
  readonly open: boolean
  readonly query: string
  readonly selected: number
  readonly kind: "switch" | "mention"
  readonly previewScroll: number
}
export interface ThreadSidebarState {
  readonly open: boolean
  readonly focused: boolean
  readonly selected: number
  readonly scrollTop: number
}

export type Loadable<T> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly value: T }

const LoadableIdleSchema = Schema.TaggedStruct("Idle", {})
const LoadableLoadingSchema = Schema.TaggedStruct("Loading", {})

export const idle: Loadable<never> = { _tag: "Idle" }
export const loading: Loadable<never> = { _tag: "Loading" }
export const ready = <T>(value: T): Loadable<T> => ({ _tag: "Ready", value })
export const readyOr: {
  <T>(loadable: Loadable<T>, fallback: T): T
  <T>(fallback: T): (loadable: Loadable<T>) => T
} = Function.dual(
  2,
  <T>(loadable: Loadable<T>, fallback: T): T => (loadable._tag === "Ready" ? loadable.value : fallback),
)
export const isReady = <T>(loadable: Loadable<T>): loadable is { readonly _tag: "Ready"; readonly value: T } =>
  loadable._tag === "Ready"
export const isLoading = <T>(loadable: Loadable<T>): boolean => loadable._tag === "Loading"

const WorkspaceFilesSchema = Schema.Union([
  LoadableIdleSchema,
  LoadableLoadingSchema,
  Schema.TaggedStruct("Ready", { value: Schema.Array(Schema.String) }),
])

const PaletteStateSchema = Schema.Struct({ open: Schema.Boolean, query: Schema.String, selected: Schema.Finite })
const ModePickerStateSchema = Schema.Struct({ open: Schema.Boolean, selected: Schema.Finite })
const FilePickerStateSchema = Schema.Struct({
  open: Schema.Boolean,
  query: Schema.String,
  selected: Schema.Finite,
  items: WorkspaceFilesSchema,
})
const ThreadSwitcherStateSchema = Schema.Struct({
  open: Schema.Boolean,
  query: Schema.String,
  selected: Schema.Finite,
  kind: Schema.Literals(["switch", "mention"]),
  previewScroll: Schema.Finite,
})
const ThreadSidebarStateSchema = Schema.Struct({
  open: Schema.Boolean,
  focused: Schema.Boolean,
  selected: Schema.Finite,
  scrollTop: Schema.Finite,
})
const PastedTextAttachmentSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), token: Schema.String, value: Schema.String, label: Schema.String }),
  Schema.Struct({ type: Schema.Literal("image"), token: Schema.String, path: Schema.String, label: Schema.String }),
])
const ComposerDraftSchema = Schema.Struct({
  input: Schema.String,
  attachments: Schema.Array(PastedTextAttachmentSchema),
})

export const ChangedFile = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
  added: Schema.optional(Schema.Finite),
  removed: Schema.optional(Schema.Finite),
})
export type ChangedFile = typeof ChangedFile.Type

const ChangedFilesSchema = Schema.Union([
  LoadableIdleSchema,
  LoadableLoadingSchema,
  Schema.TaggedStruct("Ready", { value: Schema.Array(ChangedFile) }),
])
const ThreadPreviewValueSchema = Schema.Struct({
  threadId: Schema.String,
  turns: Schema.Array(Schema.Struct({ prompt: Schema.String, events: Schema.Array(Schema.Unknown) })),
})
const ThreadPreviewSchema = Schema.Union([
  LoadableIdleSchema,
  Schema.TaggedStruct("Loading", { previous: Schema.optionalKey(ThreadPreviewValueSchema) }),
  Schema.TaggedStruct("Ready", { value: ThreadPreviewValueSchema }),
])

export const QueueItem = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  attachments: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type QueueItem = typeof QueueItem.Type

export type QueueChange =
  | { readonly _tag: "Added"; readonly item: QueueItem }
  | { readonly _tag: "Updated"; readonly item: QueueItem }
  | { readonly _tag: "Removed"; readonly turnId: string }

export const Model = Schema.Struct({
  workspace: Schema.String,
  branch: Schema.optional(Schema.String),
  mode: Mode,
  entries: Schema.Array(Entry),
  blocks: Schema.Array(Schema.Unknown),
  items: Schema.Array(Schema.Unknown),
  input: Schema.String,
  cursor: Schema.Finite,
  pastedText: Schema.Array(PastedTextAttachmentSchema),
  history: Schema.Array(Schema.String),
  historyComposers: Schema.Array(ComposerDraftSchema),
  historyDraft: Schema.optional(ComposerDraftSchema),
  historyIndex: Schema.optional(Schema.Finite),
  historySearch: Schema.String,
  busy: Schema.Boolean,
  activity: Schema.optional(Activity),
  costUsd: Schema.optional(Schema.Finite),
  paletteOpen: Schema.Boolean,
  palette: PaletteStateSchema,
  modePicker: ModePickerStateSchema,
  filePicker: FilePickerStateSchema,
  threadSwitcher: ThreadSwitcherStateSchema,
  shortcutsOpen: Schema.Boolean,
  shortcutsTrigger: Schema.optional(Schema.Finite),
  pendingAction: Schema.optional(Schema.Unknown),
  composerHeight: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
  scrollOffset: Schema.Finite,
  scrollFollow: Schema.Boolean,
  threads: Schema.Array(Schema.Unknown),
  workspaceFilesOpen: Schema.Boolean,
  threadSidebar: ThreadSidebarStateSchema,
  permissionSelection: Schema.Finite,
  queueSelection: Schema.optional(Schema.String),
  queue: Schema.Array(QueueItem),
  queueThreadId: Schema.optional(Schema.String),
  queueRevision: Schema.optional(Schema.Int),
  editingTurnId: Schema.optional(Schema.String),
  editReturn: Schema.optional(ComposerDraftSchema),
  detailSelection: Schema.optional(Schema.String),
  expandedRowKeys: Schema.Array(Schema.String),
  seenEventIds: Schema.Array(Schema.String),
  seenExecutionEventKeys: Schema.Array(Schema.String),
  childExecutionOutcomes: Schema.Record(Schema.String, Schema.Unknown),
  activeTurnId: Schema.optional(Schema.String),
  eventCursor: Schema.optional(Schema.String),
  currentThreadId: Schema.optional(Schema.String),
  currentThreadTitle: Schema.optional(Schema.String),
  fastMode: Schema.Boolean,
  changedFilesOpen: Schema.Boolean,
  changedFiles: ChangedFilesSchema,
  sidebarWidth: Schema.Finite,
  threadLoading: Schema.Boolean,
  threadPreview: ThreadPreviewSchema,
})
export type Model = typeof Model.Type

export type Message =
  | { readonly _tag: "KeyPressed"; readonly key: Key }
  | { readonly _tag: "Pasted"; readonly text: string }
  | { readonly _tag: "ImageInserted"; readonly path: string }
  | { readonly _tag: "ImageRemoved"; readonly path: string }
  | { readonly _tag: "PastedTextExpanded"; readonly token: string }
  | { readonly _tag: "Resized"; readonly width: number; readonly height: number }
  | { readonly _tag: "ComposerHeightChanged"; readonly height: number }
  | { readonly _tag: "Submitted" }
  | { readonly _tag: "TurnStarted"; readonly turnId: string; readonly prompt: string }
  | { readonly _tag: "AssistantStreamed"; readonly id?: string; readonly turnId?: string; readonly text: string }
  | { readonly _tag: "AssistantCompleted"; readonly id?: string; readonly turnId?: string; readonly text: string }
  | { readonly _tag: "ExecutionCompleted"; readonly turnId?: string }
  | { readonly _tag: "ExecutionFailed"; readonly turnId?: string; readonly message: string }
  | { readonly _tag: "ExecutionCancelled"; readonly turnId?: string }
  | { readonly _tag: "BlockAdded"; readonly block: TranscriptBlock }
  | { readonly _tag: "ReasoningStreamed"; readonly text: string }
  | { readonly _tag: "ReasoningToggled"; readonly index: number }
  | { readonly _tag: "ScrollMoved"; readonly offset: number }
  | { readonly _tag: "ScrollFollowed" }
  | { readonly _tag: "PaletteActionConsumed" }
  | { readonly _tag: "ThreadsReplaced"; readonly threads: ReadonlyArray<ThreadItem> }
  | { readonly _tag: "ThreadActivated"; readonly threadId: string; readonly title: string }
  | { readonly _tag: "ThreadTitleChanged"; readonly threadId: string; readonly title: string }
  | { readonly _tag: "FilesReplaced"; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "BranchDetected"; readonly branch: string }
  | { readonly _tag: "UsageReported"; readonly costUsd?: number }
  | { readonly _tag: "WorkspaceFilesToggled" }
  | { readonly _tag: "ThreadSidebarSelectionMoved"; readonly offset: number }
  | { readonly _tag: "ThreadSidebarSelectionConfirmed"; readonly index?: number }
  | { readonly _tag: "ThreadPreviewScrolled"; readonly offset: number }
  | { readonly _tag: "PermissionSelectionMoved"; readonly offset: number }
  | { readonly _tag: "PermissionDecisionSelected"; readonly id: string; readonly decision?: PermissionDecision }
  | { readonly _tag: "PermissionCancelled"; readonly id: string }
  | { readonly _tag: "EventReplayed"; readonly event: UiEvent }
  | { readonly _tag: "DetailMoved"; readonly offset: number }
  | { readonly _tag: "DetailToggled"; readonly id?: string }
  | { readonly _tag: "AllDetailsToggled" }
  | { readonly _tag: "FastModeToggled" }
  | { readonly _tag: "SidebarViewToggled" }
  | { readonly _tag: "SidebarWidthChanged"; readonly width: number }
  | { readonly _tag: "ComposerReplaced"; readonly text: string }
  | { readonly _tag: "ChangedFilesRequested" }
  | { readonly _tag: "ChangedFilesReplaced"; readonly files: ReadonlyArray<ChangedFile> }
  | { readonly _tag: "FilesRequested" }
  | { readonly _tag: "ThreadPreviewRequested" }
  | { readonly _tag: "ThreadOpenRequested" }
  | { readonly _tag: "ThreadOpenCompleted" }
  | {
      readonly _tag: "ThreadPreviewLoaded"
      readonly threadId: string
      readonly turns: ReadonlyArray<{ readonly prompt: string; readonly events: ReadonlyArray<unknown> }>
    }

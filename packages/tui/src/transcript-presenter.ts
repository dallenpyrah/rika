import { Function } from "effect"
import { internal as Attachment } from "./transcript-presenter/attachment"
import { internal as Rows } from "./transcript-presenter/rows"
import { internal as Window } from "./transcript-presenter/window"
import type { Model, TranscriptBlock, TranscriptItem } from "./view-state"
import type { AttachmentResult, ChildProjection } from "./transcript-presenter/attachment"
import type { AgentTerminal, TranscriptUnit } from "./transcript-presenter/rows"
import type { RowWindowState } from "./transcript-presenter/window"
export { emptyAttachments, type AttachmentResult, type ChildProjection } from "./transcript-presenter/attachment"
export {
  projectChildUnits as applyChildUnits,
  projectUnits as applyTurnUnits,
  type Event,
} from "./transcript-presenter/projection"
export {
  isRowWindowPinned,
  maxMountedTranscriptRows,
  pinnedRowWindow,
  type RowWindowState,
} from "./transcript-presenter/window"
export {
  agentOutputText,
  escapePathTarget,
  expandableRowIds,
  expandableUnits,
  isToolOutputDisplayed,
  orderedTranscriptItems,
  toolDetail,
  toolDetails,
  toolKind,
  transcriptUnitId as unitId,
  transcriptUnits as rows,
  unitToggleTargets,
  type AgentTerminal,
  type PathTarget,
  type ToolDetail,
  type ToolGroupKind,
  type ToolKind,
  type ToolTranscriptUnit,
  type TranscriptUnit,
  type TranscriptUnitId,
} from "./transcript-presenter/rows"

export const attachChildProjections: {
  (
    model: Model,
    replayTurns: { readonly has: (turnId: string) => boolean },
    available: ReadonlyMap<string, ChildProjection>,
    attachments?: ReadonlyMap<string, number>,
  ): AttachmentResult
  (
    replayTurns: { readonly has: (turnId: string) => boolean },
    available: ReadonlyMap<string, ChildProjection>,
    attachments?: ReadonlyMap<string, number>,
  ): (model: Model) => AttachmentResult
} = Function.dual(
  (args) => typeof args[0] === "object" && args[0] !== null && "items" in args[0],
  Attachment.attachChildProjections,
)
export const minimumRowEnd: { (total: number, limit: number): number; (limit: number): (total: number) => number } =
  Function.dual(2, Window.minimumRowEnd)
export const resolveRowEnd: {
  (window: RowWindowState, total: number, limit: number): number
  (total: number, limit: number): (window: RowWindowState) => number
} = Function.dual((args) => args.length === 3, Window.resolveRowEnd)
export const rowWindowStart: { (end: number, limit: number): number; (limit: number): (end: number) => number } =
  Function.dual(2, Window.rowWindowStart)
export const shiftRowEnd: {
  (window: RowWindowState, delta: number, total: number, limit: number): number
  (delta: number, total: number, limit: number): (window: RowWindowState) => number
} = Function.dual((args) => args.length === 4, Window.shiftRowEnd)
export const relocateRowEnd: {
  (window: RowWindowState, anchorIndex: number, total: number, limit: number): number
  (anchorIndex: number, total: number, limit: number): (window: RowWindowState) => number
} = Function.dual((args) => args.length === 4, Window.relocateRowEnd)
export const includeRowEnd: {
  (end: number, index: number, total: number, limit: number): number
  (index: number, total: number, limit: number): (end: number) => number
} = Function.dual((args) => args.length === 4, Window.includeRowEnd)
export const agentTerminal: {
  (
    model: Model,
    block: Extract<TranscriptBlock, { _tag: "ToolCall" }>,
    children: ReadonlyArray<TranscriptItem>,
  ): AgentTerminal | undefined
  (
    block: Extract<TranscriptBlock, { _tag: "ToolCall" }>,
    children: ReadonlyArray<TranscriptItem>,
  ): (model: Model) => AgentTerminal | undefined
} = Function.dual(3, Rows.agentTerminal)
export const isExpandableUnit: {
  (model: Model, unit: TranscriptUnit): boolean
  (unit: TranscriptUnit): (model: Model) => boolean
} = Function.dual(2, Rows.isExpandableUnit)

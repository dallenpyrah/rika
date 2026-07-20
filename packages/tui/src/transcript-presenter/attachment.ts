import type { Unit } from "@rika/transcript"
import type { Model, TranscriptBlock, TranscriptItem } from "../view-state"
import { projectChildUnits } from "./projection"

export interface ChildProjection {
  readonly units: ReadonlyArray<Unit>
  readonly revision: number
}

export interface AttachmentResult {
  readonly model: Model
  readonly attachments: ReadonlyMap<string, number>
}

export const emptyAttachments: ReadonlyMap<string, number> = new Map()

const executionKey = (value: string): string => value.replace(/^execution:/, "")

const childParent = (
  model: Model,
  turnId: string,
): Extract<TranscriptBlock, { readonly _tag: "ToolCall" }> | undefined => {
  const childKey = executionKey(turnId)
  const blocks = model.blocks as ReadonlyArray<TranscriptBlock>
  for (const item of model.items as ReadonlyArray<TranscriptItem>) {
    if (item._tag !== "Block") continue
    const block = blocks[item.index]
    if ((block as { readonly _tag?: unknown } | undefined)?._tag !== "ToolCall") continue
    const tool = block as Extract<TranscriptBlock, { readonly _tag: "ToolCall" }>
    if (tool.childId !== undefined && executionKey(tool.childId) === childKey) return tool
    if (tool.presentation.family !== "agent") continue
    const prefix = `${item.turnId}:`
    const toolCallId = tool.id.startsWith(prefix) ? tool.id.slice(prefix.length) : tool.id
    if (childKey.endsWith(`:${toolCallId}`)) return tool
  }
  return undefined
}

export const attachChildProjections = (
  model: Model,
  replayTurns: { readonly has: (turnId: string) => boolean },
  availableProjections: ReadonlyMap<string, ChildProjection>,
  attachments: ReadonlyMap<string, number> = emptyAttachments,
): AttachmentResult => {
  let next = model
  let nextAttachments: Map<string, number> | undefined
  let advanced = true
  while (advanced) {
    advanced = false
    for (const [turnId, projection] of availableProjections) {
      if (replayTurns.has(turnId)) continue
      if ((nextAttachments ?? attachments).get(turnId) === projection.revision) continue
      const parent = childParent(next, turnId)
      if (parent === undefined) continue
      next = projectChildUnits(next, parent.id, projection.units)
      nextAttachments ??= new Map(attachments)
      nextAttachments.set(turnId, projection.revision)
      advanced = true
    }
  }
  return { model: next, attachments: nextAttachments ?? attachments }
}

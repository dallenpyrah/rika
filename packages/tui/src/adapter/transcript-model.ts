import { type TextChunk } from "@opentui/core"
import { Function, Option, Schema } from "effect"
import { type Model, type TranscriptItem } from "../view-state"
import type { TranscriptBlock } from "../view-state"
import {
  toolKind,
  type PathTarget,
  type ToolKind,
  type ToolTranscriptUnit,
  type TranscriptUnit,
} from "../transcript-presenter"

import { idleSpinnerFrame } from "./rendering"

const ToolInputJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

export const toolInputValue = (input: string): Record<string, unknown> =>
  Option.getOrElse(Schema.decodeUnknownOption(ToolInputJson)(input), () => ({}))

const inputString = (value: Record<string, unknown>, keys: ReadonlyArray<string>): string | undefined => {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === "string" && candidate.length > 0) return candidate
  }
  return undefined
}

export type ToolUnit = {
  readonly kind: ToolKind
  readonly block: Extract<TranscriptBlock, { _tag: "ToolCall" }>
  readonly index: number
}

export const diffCounts = (patch: string): readonly [number, number] => {
  let added = 0
  let removed = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1
  }
  return [added, removed]
}

export const shellCommandText = (block: Extract<TranscriptBlock, { _tag: "ToolCall" }>): string => {
  const value = toolInputValue(block.input)
  const command = block.detail || inputString(value, ["command", "cmd", "script"]) || ""
  return command || (block.input.trimStart().startsWith("{") ? "" : block.input)
}

export const shellExitCode = (block: Extract<TranscriptBlock, { _tag: "ToolCall" }>): number | undefined =>
  block.process?.exitCode

export const exploreChildLabel = (unit: ToolUnit): string => {
  const value = toolInputValue(unit.block.input)
  const detail =
    unit.block.detail ||
    inputString(value, ["path", "file_path", "file", "pattern", "query", "glob", "name"]) ||
    "workspace"
  if (unit.block.presentation.action === "skill") return detail
  if (unit.block.presentation.action === "media") return `Viewed ${detail}`
  if (unit.block.presentation.action === "git-status") return `Checked ${detail}`
  if (unit.block.presentation.action === "read" || unit.kind === "read") return `Read ${detail}`
  const pattern = inputString(value, ["pattern", "query", "glob", "path"])
  return `${unit.block.presentation.action === "grep" ? "Grep" : "Searched"} ${unit.block.detail || pattern || ""}`.trimEnd()
}

const plural = (count: number, singular: string): string => `${count} ${singular}${count === 1 ? "" : "s"}`

const iconChar = (failed: boolean, running: boolean, frame = idleSpinnerFrame, cancelled = false): string =>
  running ? frame : cancelled ? "⊘" : failed ? "✕" : "✓"

export const markerText = (expanded: boolean): string => (expanded ? " ▾" : " ▸")

export const cancelledAgentLabel = (activeLabel: string): string =>
  `${activeLabel.split(" ")[0] ?? "Subagent"} cancelled`
export const failedAgentLabel = (activeLabel: string): string => `${activeLabel.split(" ")[0] ?? "Subagent"} failed`

export interface UnitLineRange {
  readonly start: number
  readonly end: number
  readonly headerEnd?: number
  readonly unit: string
  readonly expandable: boolean
  readonly animated?: boolean
  readonly gapBefore?: boolean
  readonly targets?: ReadonlyArray<PathTarget>
}

export const maxMountedTranscriptEntries = 200

export { maxMountedTranscriptRows } from "../transcript-presenter"

export const boundedTranscriptModel: {
  (model: Model): Model
  (model: Model, end: number): Model
  (end: number): (model: Model) => Model
} = Function.dual(
  (args) => typeof args[0] === "object",
  (model: Model, end = model.items.length): Model => {
    const limit = maxMountedTranscriptEntries
    if (model.items.length === 0)
      return {
        ...model,
        entries: model.entries.slice(-limit),
        blocks: model.blocks.slice(-limit),
      }
    const windowEnd = Math.min(model.items.length, Math.max(0, Math.floor(end)))
    const allItems = model.items as ReadonlyArray<TranscriptItem>
    let hasParent = false
    for (let position = 0; position < windowEnd; position += 1)
      if (allItems[position]?.parentId !== undefined) {
        hasParent = true
        break
      }
    if (!hasParent) {
      const flat = allItems.slice(Math.max(0, windowEnd - limit), windowEnd)
      const entries: Array<Model["entries"][number]> = []
      const blocks: Array<Model["blocks"][number]> = []
      const entryIndices = new Map<number, number>()
      const blockIndices = new Map<number, number>()
      const items: Array<TranscriptItem> = []
      for (const item of flat) {
        if (item._tag === "Entry") {
          let index = entryIndices.get(item.index)
          if (index === undefined) {
            index = entries.length
            entryIndices.set(item.index, index)
            entries.push(model.entries[item.index]!)
          }
          items.push({ ...item, index })
          continue
        }
        let index = blockIndices.get(item.index)
        if (index === undefined) {
          index = blocks.length
          blockIndices.set(item.index, index)
          blocks.push(model.blocks[item.index]!)
        }
        items.push({ ...item, index })
      }
      return { ...model, entries, blocks, items }
    }
    const itemPositionByBlockId = new Map<string, number>()
    for (const [position, item] of allItems.entries()) {
      if (item._tag !== "Block") continue
      const block = model.blocks[item.index] as TranscriptBlock | undefined
      if (block?._tag === "ToolCall") itemPositionByBlockId.set(block.id, position)
    }
    const rootPositionOf = (start: number): number => {
      let position = start
      const seen = new Set<number>()
      while (!seen.has(position)) {
        seen.add(position)
        const parentId = allItems[position]?.parentId
        if (parentId === undefined) return position
        const parentPosition = itemPositionByBlockId.get(parentId)
        if (parentPosition === undefined) return position
        position = parentPosition
      }
      return position
    }
    const unitMembers = new Map<number, Array<number>>()
    const unitRoots: Array<number> = []
    for (let position = 0; position < windowEnd; position += 1) {
      const root = rootPositionOf(position)
      let members = unitMembers.get(root)
      if (members === undefined) {
        members = []
        unitMembers.set(root, members)
        unitRoots.push(root)
      }
      members.push(position)
    }
    const orderedRoots = unitRoots.toSorted((left, right) => left - right)
    const selectedRoots: Array<number> = []
    let selectedCount = 0
    for (let unitIndex = orderedRoots.length - 1; unitIndex >= 0; unitIndex -= 1) {
      const members = unitMembers.get(orderedRoots[unitIndex]!)!
      if (selectedRoots.length > 0 && selectedCount + members.length > limit) break
      selectedRoots.push(orderedRoots[unitIndex]!)
      selectedCount += members.length
    }
    const source = selectedRoots
      .flatMap((root) => unitMembers.get(root)!)
      .toSorted((left, right) => left - right)
      .map((position) => allItems[position]!)
    const entries: Array<Model["entries"][number]> = []
    const blocks: Array<Model["blocks"][number]> = []
    const entryIndices = new Map<number, number>()
    const blockIndices = new Map<number, number>()
    const items: Array<TranscriptItem> = []
    for (const item of source) {
      if (item._tag === "Entry") {
        let index = entryIndices.get(item.index)
        if (index === undefined) {
          index = entries.length
          entryIndices.set(item.index, index)
          entries.push(model.entries[item.index]!)
        }
        items.push({ ...item, index })
        continue
      }
      let index = blockIndices.get(item.index)
      if (index === undefined) {
        index = blocks.length
        blockIndices.set(item.index, index)
        blocks.push(model.blocks[item.index]!)
      }
      items.push({ ...item, index })
    }
    return { ...model, entries, blocks, items }
  },
)

const toolUnitsFor = (model: Model, indices: ReadonlyArray<number>): ReadonlyArray<ToolUnit> =>
  indices.map((index) => {
    const block = model.blocks[index] as Extract<TranscriptBlock, { _tag: "ToolCall" }>
    return { kind: toolKind(block.name, undefined), block, index }
  })

export interface TranscriptUnitBuild {
  readonly chunks: ReadonlyArray<TextChunk>
  readonly lines: number
  readonly root: UnitLineRange
  readonly nested: ReadonlyArray<UnitLineRange>
}

const offsetUnitRange = (range: UnitLineRange, offset: number): UnitLineRange => ({
  ...range,
  start: range.start + offset,
  end: range.end + offset,
  ...(range.headerEnd === undefined ? {} : { headerEnd: range.headerEnd + offset }),
})

let transcriptIdentityCounter = 0
const transcriptIdentityRevisions = new WeakMap<object, number>()
const identityRevision = (value: unknown): number => {
  if (typeof value !== "object" || value === null) return 0
  const current = transcriptIdentityRevisions.get(value)
  if (current !== undefined) return current
  transcriptIdentityCounter += 1
  transcriptIdentityRevisions.set(value, transcriptIdentityCounter)
  return transcriptIdentityCounter
}

const transcriptUnitRevision = (
  model: Model,
  unit: TranscriptUnit,
  unitKey: string,
  expandedSet: ReadonlySet<string>,
): string => {
  const ids: Array<number> = []
  const bits: Array<string> = []
  const pushExpanded = (id: string) => bits.push(expandedSet.has(id) ? "1" : "0")
  const walkTool = (tool: ToolTranscriptUnit) => {
    for (const index of tool.blocks) {
      const block = model.blocks[index] as TranscriptBlock
      ids.push(identityRevision(block))
      if (block._tag === "ToolCall") {
        pushExpanded(`tool:${block.id}`)
        pushExpanded(`tool-child:${block.id}`)
        for (const file of block.files) pushExpanded(`file:${file.key}`)
      }
    }
    for (const index of tool.diffs) ids.push(identityRevision(model.blocks[index]))
    for (const child of tool.children ?? []) walkTool(child)
    if (tool.terminal?.kind === "answer") ids.push(identityRevision(model.entries[tool.terminal.entry]))
    else if (tool.terminal?.kind === "error") bits.push(`${tool.terminal.tone}:${tool.terminal.text}`)
  }
  if (unit.kind === "entry") ids.push(identityRevision(model.entries[unit.entry]))
  else if (unit.kind === "tool") walkTool(unit)
  else ids.push(identityRevision(model.blocks[unit.block]))
  pushExpanded(unitKey)
  const selected = model.detailSelection === unitKey ? "1" : "0"
  const permission = unit.kind === "block" ? model.permissionSelection : -1
  return `${ids.join(".")}|${bits.join("")}|${selected}|${model.width}|${permission}`
}

export const internal = { inputString, plural, iconChar, toolUnitsFor, offsetUnitRange, transcriptUnitRevision }

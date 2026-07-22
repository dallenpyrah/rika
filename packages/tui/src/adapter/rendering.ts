import { bg, dim, fg, underline, StyledText, type TextChunk } from "@opentui/core"
import type { ColorInput } from "@opentui/core"
import cliSpinners from "cli-spinners"
import { Function, Schema } from "effect"
import stringWidth from "string-width"
import {
  boundedThreadSidebarWidth,
  fileSidebarLayoutWidth,
  readyOr,
  type Model,
  type QueueItem,
  type TranscriptItem,
} from "../view-state"
import type { ThreadItem, TranscriptBlock } from "../view-state"
import { colors, spacing } from "../theme"
import { renderMarkdown } from "../markdown-renderer"
import { renderDiff } from "../diff-renderer"
import { renderTool } from "../tool-renderer"
import { isToolOutputDisplayed } from "../transcript-presenter"

export const spinnerFrames: ReadonlyArray<string> = cliSpinners.dots.frames
export const statusSpinnerFrames: ReadonlyArray<string> = ["∼", "≈", "≋", "≈", "∼"]
export const spinnerInterval = 200
export const idleSpinnerFrame = "⠭"

export const transcriptStatusIcon =
  (spinnerFrame: string) =>
  (failed: boolean, active: boolean, cancelled = false): TextChunk =>
    fg(active ? colors.blue : cancelled ? colors.amber : failed ? colors.red : colors.green)(
      active ? spinnerFrame : cancelled ? "⊘" : failed ? "✕" : "✓",
    )

export class ToolSpinner {
  private state = [true, false, true, false, true, false, true, false]
  private previousState: ReadonlyArray<boolean> = []
  private generation = 0
  private readonly neighborMap = [
    [1, 3, 4, 5, 7],
    [0, 2, 4, 5, 6],
    [1, 3, 5, 6, 7],
    [0, 2, 4, 6, 7],
    [0, 1, 3, 5, 7],
    [0, 1, 2, 4, 6],
    [1, 2, 3, 5, 7],
    [0, 2, 3, 4, 6],
  ]

  constructor(private readonly random: () => number = Math.random) {}

  step(): void {
    const next = this.state.map((alive, index) => {
      const neighbors = this.neighborMap[index]!.filter((neighbor) => this.state[neighbor]).length
      return alive ? neighbors === 2 || neighbors === 3 : neighbors === 3 || neighbors === 6
    })
    const stable = next.every((alive, index) => alive === this.state[index])
    const repeats = this.previousState.length > 0 && next.every((alive, index) => alive === this.previousState[index])
    this.previousState = [...this.state]
    this.state = next
    this.generation += 1
    const live = next.filter(Boolean).length
    if (stable || repeats || this.generation >= 15 || live < 2) {
      let seeded: Array<boolean>
      do seeded = Array.from({ length: 8 }, () => this.random() > 0.6)
      while (seeded.filter(Boolean).length < 3)
      this.state = seeded
      this.previousState = []
      this.generation = 0
    }
  }

  toBraille(): string {
    const dots = [0, 1, 2, 6, 3, 4, 5, 7]
    let point = 0x2800
    for (const [index, alive] of this.state.entries()) if (alive) point |= 1 << dots[index]!
    return String.fromCharCode(point)
  }
}

export const markdownWidthForColumn = (width: number): number => Math.max(8, width - spacing.transcript * 2 - 2)

export const queueItemLabel = (item: QueueItem): string =>
  `${item.prompt}${item.attachments?.map((path) => `\n  ▧ ${path}`).join("") ?? ""}`

interface QueueHintSegment {
  readonly accent: string
  readonly suffix: string
}

export const queueNavigationHint: ReadonlyArray<QueueHintSegment> = [
  { accent: "Enter", suffix: " to steer" },
  { accent: "Backspace", suffix: " to dequeue" },
  { accent: "Ctrl+E", suffix: " to edit" },
]

export const queueEditingHint: ReadonlyArray<QueueHintSegment> = [
  { accent: "Editing queued", suffix: "" },
  { accent: "Enter", suffix: " save" },
  { accent: "Esc", suffix: " cancel" },
]

const minimumInlineQueueMessageWidth = 12

export const queueHintWidth = (segments: ReadonlyArray<QueueHintSegment>): number =>
  stringWidth(` ${segments.map((segment) => `${segment.accent}${segment.suffix}`).join(" · ")} `)

const fittingQueueHint = (
  segments: ReadonlyArray<QueueHintSegment>,
  width: number,
): ReadonlyArray<QueueHintSegment> => {
  for (let length = segments.length; length > 0; length -= 1) {
    const candidate = segments.slice(0, length)
    if (width - queueHintWidth(candidate) >= minimumInlineQueueMessageWidth) return candidate
  }
  return []
}

export class AdapterError extends Schema.TaggedErrorClass<AdapterError>()("TuiAdapterError", {
  message: Schema.String,
}) {}

export const adapterError = (cause: unknown) => AdapterError.make({ message: String(cause) })

export const loaderFrame: {
  (phase: string | undefined, frame: number): string
  (frame: number): (phase: string | undefined) => string
} = Function.dual(2, (phase: string | undefined, frame: number): string =>
  phase === undefined ? "" : statusSpinnerFrames[frame % statusSpinnerFrames.length]!,
)

export const renderBlock: {
  (width?: number): (block: TranscriptBlock) => string
  (block: TranscriptBlock): string
  (block: TranscriptBlock, width?: number): string
} = Function.dual(
  (args) => args.length > 1 || typeof args[0] !== "number",
  (block: TranscriptBlock, width = 80): string => {
    switch (block._tag) {
      case "Reasoning":
        return `◇ Reasoning\n  ${block.text}`
      case "ToolCall": {
        if (isToolOutputDisplayed(block)) return renderTool(block, width)
        const running = block.status === "running"
        const icon = running ? "⠿" : block.status === "complete" ? "✓" : block.status === "cancelled" ? "⊘" : "✗"
        const label = running ? block.presentation.activeLabel : block.presentation.completeLabel
        return `${icon} ${label}${block.detail.length === 0 ? "" : ` ${block.detail}`}`
      }
      case "ToolResult":
        return `${block.failed ? "✕" : "✓"} Result\n  ${block.output}`
      case "Diff":
        return `Δ ${block.path}\n${renderDiff(block.patch, width)}`
      case "ContextUsage":
        return `◷ Context ${block.text}${block.cost === undefined ? "" : ` · ${block.cost}`}`
      case "Compaction":
        return `↻ Compacted context${block.checkpoint === undefined ? "" : ` at ${block.checkpoint}`}\n  ${block.summary}`
      case "Notification":
        return `! ${block.title}\n  ${block.detail}`
      case "Error":
        return `✖ ERROR: ${block.title}${block.turnId === undefined ? "" : ` · Turn ${block.turnId}`}\n  ${block.detail}${block.recovery === undefined ? "" : `\n  Next: ${block.recovery}`}`
      case "Permission":
        return `? ${block.title} [${block.status}]\n  ${block.detail}`
      case "ChildAgent": {
        const icon =
          block.status === "running"
            ? "⠿"
            : block.status === "complete"
              ? "✓"
              : block.status === "cancelled"
                ? "⊘"
                : "✗"
        return `${icon} Subagent ${block.status === "running" ? "working" : block.status === "cancelled" ? "cancelled" : "finished"} ▸\n  ${block.name} · ${block.summary}`
      }
      case "Workflow":
        return `◫ Workflow ${block.name} [${block.status}]\n  ${block.step}`
      case "ImageAttachment": {
        const dimensions =
          block.width !== undefined && block.height !== undefined ? ` · ${block.width}×${block.height}` : ""
        const size = block.bytes === undefined ? "" : ` · ${block.bytes} bytes`
        return `▧ ${block.name} · ${block.mediaType}${dimensions}${size}`
      }
    }
  },
)

export const renderSidebar: {
  (spinnerFrame?: string): (model: Model) => StyledText
  (model: Model): StyledText
  (model: Model, spinnerFrame?: string): StyledText
} = Function.dual(
  (args) => args.length > 1 || typeof args[0] !== "string",
  (model: Model, spinnerFrame = idleSpinnerFrame): StyledText => {
    const chunks: Array<TextChunk> = []
    const threads = model.threads as ReadonlyArray<ThreadItem>
    const sidebarWidth = boundedThreadSidebarWidth(model.width)
    threads
      .slice(model.threadSidebar.scrollTop, model.threadSidebar.scrollTop + model.height)
      .forEach((thread, row) => {
        const index = row + model.threadSidebar.scrollTop
        if (row > 0) chunks.push(fg(colors.text)("\n"))
        const selected = model.threadSidebar.focused && index === model.threadSidebar.selected
        const marker =
          thread.id === model.currentThreadId
            ? "*"
            : thread.status !== "idle"
              ? spinnerFrame
              : thread.unread
                ? "○"
                : " "
        const title = truncateToWidth(thread.title, sidebarWidth - 4)
        const padding = " ".repeat(Math.max(0, sidebarWidth - 4 - stringWidth(title)))
        const renderedRow = ` ${marker} ${title}${padding}`
        if (selected) chunks.push(bg(colors.amber)(fg(colors.surface)(renderedRow)))
        else {
          chunks.push(fg(colors.text)(" "))
          chunks.push(
            thread.id === model.currentThreadId
              ? fg(colors.green)(marker)
              : thread.status !== "idle"
                ? fg(colors.blue)(marker)
                : thread.unread
                  ? dim(fg(colors.blue)(marker))
                  : fg(colors.text)(marker),
          )
          chunks.push(fg(colors.text)(` ${title}${padding}`))
        }
        chunks.push(dim(fg(colors.text)("│")))
      })
    return new StyledText(chunks)
  },
)

const changedFileColor = (status: string): ColorInput => {
  if (status.includes("?")) return colors.muted
  if (status.includes("A")) return colors.green
  if (status.includes("D")) return colors.red
  if (status.includes("R")) return colors.purple
  if (status.includes("M")) return colors.amber
  return colors.text
}

interface ChangedNode {
  readonly children: Map<string, ChangedNode>
  file?: import("../view-state").ChangedFile
}

export interface ChangedFileRow {
  readonly chunks: ReadonlyArray<TextChunk>
  readonly file?: import("../view-state").ChangedFile
  readonly nameIndex?: number
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

const truncateToWidth = (text: string, width: number): string => {
  let truncated = ""
  let used = 0
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const cells = stringWidth(segment)
    if (used + cells > width) break
    truncated += segment
    used += cells
  }
  return truncated
}

const wrapTextToWidth = (text: string, width: number): ReadonlyArray<string> => {
  const lines: Array<string> = []
  for (const hardLine of text.split("\n")) {
    let rest = hardLine
    while (stringWidth(rest) > width) {
      let end = 0
      let breakAt = 0
      let used = 0
      for (const { segment, index } of graphemeSegmenter.segment(rest)) {
        const cells = stringWidth(segment)
        if (used + cells > width) break
        used += cells
        end = index + segment.length
        if (/\s/u.test(segment)) breakAt = end
      }
      const split =
        breakAt > 0
          ? breakAt
          : end > 0
            ? end
            : (graphemeSegmenter.segment(rest)[Symbol.iterator]().next().value?.segment.length ?? rest.length)
      lines.push(rest.slice(0, split).trimEnd())
      rest = rest.slice(split).trimStart()
    }
    lines.push(rest)
  }
  return lines
}

const escapeChangedPathSegment = (text: string): string =>
  [...text]
    .map((character) => {
      const code = character.codePointAt(0)!
      if (character === "\n") return "\\n"
      if (character === "\r") return "\\r"
      if (character === "\t") return "\\t"
      if (code < 32 || (code >= 127 && code <= 159))
        return code <= 255 ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u{${code.toString(16)}}`
      return character
    })
    .join("")

const fileTreeRows = (
  files: ReadonlyArray<import("../view-state").ChangedFile>,
  innerWidth: number,
  showCounts: boolean,
): ReadonlyArray<ChangedFileRow> => {
  if (files.length === 0) return [{ chunks: [fg(colors.muted)("No changes")] }]
  const root: ChangedNode = { children: new Map() }
  for (const file of [...files].toSorted((a, b) => a.path.localeCompare(b.path))) {
    const segments = file.path.split("/")
    let node = root
    segments.forEach((segment, index) => {
      let child = node.children.get(segment)
      if (child === undefined) {
        child = { children: new Map() }
        node.children.set(segment, child)
      }
      if (index === segments.length - 1) child.file = file
      node = child
    })
  }
  const rows: Array<ChangedFileRow> = []
  const walk = (node: ChangedNode, depth: number) => {
    for (const [name, child] of node.children) {
      const indent = "  ".repeat(depth)
      const displayName = escapeChangedPathSegment(name)
      const indentChunks = indent.length > 0 ? [fg(colors.text)(indent)] : []
      if (child.file === undefined) {
        rows.push({
          chunks: [
            ...indentChunks,
            fg(colors.muted)(truncateToWidth(`${displayName}/`, Math.max(1, innerWidth - indent.length))),
          ],
        })
        walk(child, depth + 1)
      } else {
        const hasCounts = child.file.added !== undefined || child.file.removed !== undefined
        if (!showCounts || !hasCounts) {
          rows.push({
            chunks: [
              ...indentChunks,
              fg(changedFileColor(child.file.status))(
                truncateToWidth(displayName, Math.max(1, innerWidth - indent.length)),
              ),
            ],
            file: child.file,
            nameIndex: indentChunks.length,
          })
          continue
        }
        const added = ` +${child.file.added ?? 0}`
        const removed = ` -${child.file.removed ?? 0}`
        const label = truncateToWidth(
          displayName,
          Math.max(1, innerWidth - indent.length - stringWidth(added) - stringWidth(removed)),
        )
        rows.push({
          chunks: [
            ...indentChunks,
            fg(changedFileColor(child.file.status))(label),
            fg(colors.green)(added),
            fg(colors.red)(removed),
          ],
          file: child.file,
          nameIndex: indentChunks.length,
        })
      }
    }
  }
  walk(root, 0)
  return rows
}

export const sidebarInnerWidth = (model: Model): number => Math.max(1, fileSidebarLayoutWidth(model) - 8)

const sidebarFileRows = (model: Model, innerWidth: number): ReadonlyArray<ChangedFileRow> =>
  model.changedFilesOpen
    ? fileTreeRows(readyOr(model.changedFiles, []), innerWidth, true)
    : fileTreeRows(
        readyOr(model.filePicker.items, []).map((path) => ({ path, status: "" })),
        innerWidth,
        false,
      )

const renderFileRows = (rows: ReadonlyArray<ChangedFileRow>, hoveredRow?: number): StyledText => {
  const chunks: Array<TextChunk> = []
  for (const [index, row] of rows.entries()) {
    if (index > 0) chunks.push(fg(colors.text)("\n"))
    if (index === hoveredRow && row.file !== undefined && row.nameIndex !== undefined) {
      chunks.push(...row.chunks.map((chunk, chunkIndex) => (chunkIndex === row.nameIndex ? underline(chunk) : chunk)))
    } else {
      chunks.push(...row.chunks)
    }
  }
  return new StyledText(chunks)
}

export const renderChangedFiles: {
  (model: Model, innerWidth: number, hoveredRow?: number): StyledText
  (innerWidth: number, hoveredRow?: number): (model: Model) => StyledText
} = Function.dual(
  (args) => args.length > 1 && typeof args[0] !== "number",
  (model: Model, innerWidth: number, hoveredRow?: number): StyledText =>
    renderFileRows(fileTreeRows(readyOr(model.changedFiles, []), innerWidth, true), hoveredRow),
)

export const renderTranscript = (model: Model): string => {
  const welcome = model.entries.length === 0 ? `Rika\nLocal durable coding agent\n\n` : ""
  const entries = model.entries
    .map((entry) =>
      entry.role === "user"
        ? `┃ ${entry.text}`
        : entry.role === "notice"
          ? `! ${entry.text}`
          : renderMarkdown(entry.text, markdownWidthForColumn(model.width)),
    )
    .join("\n\n")
  const blocks = (model.blocks as ReadonlyArray<TranscriptBlock>)
    .map((block) => {
      if (block._tag === "Permission" && block.status === "pending") {
        const options = ["Allow once", "Always", "Deny"]
          .map((option, index) => `${index === model.permissionSelection ? "›" : " "} ${option}`)
          .join("   ")
        return `${renderBlock(block, model.width)}\n  ${options}`
      }
      return renderBlock(block, model.width)
    })
    .join("\n\n")
  if (model.items.length === 0)
    return welcome + entries + (blocks.length === 0 ? "" : `${model.entries.length === 0 ? "" : "\n\n"}${blocks}`)
  const ordered = (model.items as ReadonlyArray<TranscriptItem>).map((item) => {
    if (item._tag === "Block") return renderBlock(model.blocks[item.index] as TranscriptBlock, model.width)
    const entry = model.entries[item.index]!
    return entry.role === "user"
      ? `┃ ${entry.text}`
      : entry.role === "notice"
        ? `! ${entry.text}`
        : renderMarkdown(entry.text, markdownWidthForColumn(model.width))
  })
  return welcome + ordered.join("\n\n")
}

export const internal = { fittingQueueHint, truncateToWidth, wrapTextToWidth, sidebarFileRows, renderFileRows }

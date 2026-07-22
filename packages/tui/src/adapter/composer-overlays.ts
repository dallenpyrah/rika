import { bg, bold, dim, fg, StyledText, type TextChunk } from "@opentui/core"
import stringWidth from "string-width"
import { displayInput, type Model } from "../view-state"
import { type Command } from "../palette"
import { colors } from "../theme"

import { internal as InternalRendering } from "./rendering"

export const displayCursorOffset = (model: Model): number => {
  let offset = model.cursor
  for (const attachment of model.pastedText) {
    const tokenOffset = model.input.indexOf(attachment.token)
    if (tokenOffset >= 0 && tokenOffset < model.cursor) offset += attachment.label.length - attachment.token.length
  }
  return offset
}

const composerTextChunks = (model: Model, visibleRows = 3): Array<TextChunk> => {
  const displayed = displayInput(model)
  const cursor = Math.max(0, Math.min(displayed.length, displayCursorOffset(model)))
  const before = displayed.slice(0, cursor)
  const lines = displayed.split("\n")
  const cursorLine = before.split("\n").length - 1
  const firstLine = Math.max(0, Math.min(cursorLine - visibleRows + 1, lines.length - visibleRows))
  const chunks: Array<TextChunk> = []
  lines.slice(firstLine, firstLine + visibleRows).forEach((line, index) => {
    if (index > 0) chunks.push(fg(colors.text)("\n"))
    chunks.push(fg(colors.text)(line))
  })
  return chunks
}

const shortcutRows: ReadonlyArray<ReadonlyArray<readonly [string, string]>> = [
  [
    ["Ctrl+O", "command palette"],
    ["Ctrl+R", "prompt history"],
  ],
  [
    ["Ctrl+V", "paste images"],
    ["Shift+Enter", "newline"],
  ],
  [["Ctrl+S", "switch modes"]],
  [
    ["Ctrl+G", "edit in $EDITOR"],
    ["Opt+T", "toggle file tree"],
  ],
  [
    ["@ / @@", "mention files/threads"],
    ["Tab/Shift+Tab", "navigate messages"],
  ],
  [["?", "toggle this help"]],
]

const sidebarShortcutRows: ReadonlyArray<readonly [string, string]> = [
  ["Opt+S", "toggle changed files"],
  ["Enter", "open selected thread"],
]

const shortcutsContent = (model: Model, innerWidth: number): StyledText => {
  const chunks: Array<TextChunk> = []
  const secondColumn = 32
  const rows =
    innerWidth >= 70
      ? shortcutRows
      : shortcutRows.flatMap((row) => row.map((pair) => [pair] as ReadonlyArray<readonly [string, string]>))
  for (const row of rows) {
    let column = 0
    row.forEach(([keys, description], index) => {
      if (index === 1) {
        chunks.push(fg(colors.text)(" ".repeat(Math.max(1, secondColumn - column))))
        column = secondColumn
      }
      chunks.push(fg(colors.blue)(keys))
      chunks.push(fg(colors.text)(` ${description}`.slice(0, Math.max(0, innerWidth - keys.length))))
      column += keys.length + description.length + 1
    })
    chunks.push(fg(colors.text)("\n"))
  }
  chunks.push(fg(colors.text)("\n"))
  chunks.push(bold(fg(colors.amber)("Sidebar")))
  chunks.push(fg(colors.text)("\n"))
  for (const [keys, description] of sidebarShortcutRows) {
    chunks.push(fg(colors.blue)(keys))
    chunks.push(fg(colors.text)(` ${description}`))
    chunks.push(fg(colors.text)("\n"))
  }
  chunks.push(dim(fg(colors.text)("─".repeat(Math.max(1, innerWidth)))))
  chunks.push(fg(colors.text)("\n"))
  chunks.push(...composerTextChunks(model))
  return new StyledText(chunks)
}

const paletteContent = (
  model: Model,
  results: ReadonlyArray<Command>,
  innerWidth: number,
  innerHeight: number,
): StyledText => {
  const compact = innerHeight < results.length + 3
  const chunks: Array<TextChunk> = compact ? [] : [fg(colors.text)("\n")]
  chunks.push(fg(colors.text)(compact ? "\n" : "\n\n"))
  const categoryWidth = 16
  results.forEach((command, index) => {
    if (index > 0) chunks.push(fg(colors.text)("\n"))
    const selected = index === model.palette.selected
    const keybinding = command.keybinding ?? ""
    const label = command.label
    if (innerWidth < 48) {
      const visible = InternalRendering.truncateToWidth(label, innerWidth)
      const padding = " ".repeat(Math.max(0, innerWidth - stringWidth(visible)))
      chunks.push(
        selected
          ? bold(bg(colors.selectionBg)(fg(colors.selectionFg)(`${visible}${padding}`)))
          : bold(fg(colors.text)(visible)),
      )
      return
    }
    const category = command.category.padStart(categoryWidth)
    const used = categoryWidth + 2 + label.length
    const padding = Math.max(1, innerWidth - used - keybinding.length - 1)
    if (selected) {
      chunks.push(bg(colors.selectionBg)(fg(colors.selectionFg)(category)))
      chunks.push(bold(bg(colors.selectionBg)(fg(colors.selectionFg)(`  ${label}`))))
      chunks.push(bg(colors.selectionBg)(fg(colors.selectionFg)(" ".repeat(padding))))
      if (keybinding.length > 0) chunks.push(bold(bg(colors.selectionBg)(fg(colors.selectionHint)(keybinding))))
      chunks.push(bg(colors.selectionBg)(fg(colors.selectionFg)(" ")))
    } else {
      chunks.push(dim(fg(colors.text)(category)))
      chunks.push(bold(fg(colors.text)(`  ${label}`)))
      chunks.push(fg(colors.text)(" ".repeat(padding)))
      if (keybinding.length > 0) chunks.push(bold(fg(colors.blue)(keybinding)))
      chunks.push(fg(colors.text)(" "))
    }
  })
  return new StyledText(chunks)
}

const modeGaugeFill = { low: 2, medium: 19, high: 36, ultra: 54 } as const
const modeAgentLabel = {
  low: "GPT-5.6 Luna low",
  medium: "GPT-5.6 Terra medium",
  high: "GPT-5.6 Sol xhigh",
  ultra: "GPT-5.6 Sol max",
} as const
const modeOracleLabel = {
  low: "GPT-5.6 Sol high",
  medium: "GPT-5.6 Sol high",
  high: "GPT-5.6 Sol max",
  ultra: "GPT-5.6 Sol max",
} as const
const modeDescription = {
  low: "Fast, low-cost mode for small, well-defined tasks",
  medium: "Balanced intelligence, speed, and cost for most tasks",
  high: "Deep reasoning for hard tasks",
  ultra: "The most capable mode for hard, open-ended tasks",
} as const

const modePickerContent = (model: Model, innerWidth: number): StyledText => {
  const modes = ["low", "medium", "high", "ultra"] as const
  const selected = modes[model.modePicker.selected] ?? model.mode
  if (innerWidth < 40)
    return new StyledText([
      bold(fg(colors[selected])(InternalRendering.truncateToWidth(selected, innerWidth))),
      fg(colors.text)("\n"),
      fg(colors.muted)(InternalRendering.truncateToWidth(modeDescription[selected], innerWidth)),
    ])
  const gaugeWidth = Math.min(54, innerWidth)
  const fill = Math.min(gaugeWidth, modeGaugeFill[selected])
  const chunks: Array<TextChunk> = []
  chunks.push(fg(colors[selected])("•".repeat(fill)))
  chunks.push(fg(colors.muted)("·".repeat(Math.max(0, gaugeWidth - fill))))
  chunks.push(fg(colors.text)("\n"))
  const labelStarts = [0, 16, 33, 49].map((start) => Math.floor((start * gaugeWidth) / 54))
  let column = 0
  modes.forEach((mode, index) => {
    const start = labelStarts[index]!
    chunks.push(fg(colors.text)(" ".repeat(Math.max(0, start - column))))
    chunks.push(mode === selected ? bold(fg(colors[mode])(mode)) : fg(colors.muted)(mode))
    column = Math.max(column, start) + mode.length
  })
  chunks.push(fg(colors.text)("\n\n"))
  chunks.push(bold(fg(colors.text)("Agent:")))
  chunks.push(fg(colors.muted)(`  ${modeAgentLabel[selected]}`))
  chunks.push(fg(colors.text)("\n"))
  chunks.push(bold(fg(colors.text)("Oracle:")))
  chunks.push(fg(colors.muted)(` ${modeOracleLabel[selected]}`))
  chunks.push(fg(colors.text)("\n\n"))
  chunks.push(fg(colors.text)(modeDescription[selected]))
  return new StyledText(chunks)
}

export const internal = { composerTextChunks, shortcutsContent, paletteContent, modePickerContent }

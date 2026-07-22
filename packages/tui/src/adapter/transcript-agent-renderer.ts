import { dim, fg, type TextChunk } from "@opentui/core"
import stringWidth from "string-width"
import type { Model } from "../view-state"
import { orderedTranscriptItems, type AgentTerminal } from "../transcript-presenter"
import { colors } from "../theme"
import { renderMarkdownLines } from "../markdown-renderer"
import { markdownWidthForColumn } from "./rendering"
import { internal as InternalRendering } from "./rendering"
import type { UnitLineRange } from "./transcript-model"

export interface TranscriptRendererWriter {
  readonly chunks: ReadonlyArray<TextChunk>
  readonly line: number
  append: (chunk: TextChunk) => void
}

const prefixes = (prefix: string, gap: boolean) => {
  const connector = prefix.lastIndexOf("│")
  return { curl: gap && connector >= 0 ? `${prefix.slice(0, connector)}╰${prefix.slice(connector + 1)}` : prefix }
}

const createTranscriptAgentRenderer = (model: Model, writer: TranscriptRendererWriter) => {
  const appendGap = (prefix: string) => {
    for (let spacer = 0; spacer < 2; spacer += 1) {
      writer.append(fg(colors.text)("\n"))
      writer.append(dim(fg(colors.subtle)(prefix.trimEnd())))
    }
  }
  const renderAgentResponse = (index: number, prefix: string, gap = false): UnitLineRange | undefined => {
    const entry = model.entries[index]
    if (entry?.role !== "assistant" || entry.text.trim().length === 0) return
    const item = orderedTranscriptItems(model).find(
      (candidate) => candidate._tag === "Entry" && candidate.index === index,
    )
    const rows = renderMarkdownLines(
      entry.text.trimEnd(),
      Math.max(1, markdownWidthForColumn(model.width) - stringWidth(prefix)),
    )
    const { curl } = prefixes(prefix, gap)
    const start = writer.line + 1
    if (gap) appendGap(prefix)
    rows.forEach((row, rowIndex) => {
      writer.append(fg(colors.text)("\n"))
      writer.append(dim(fg(colors.subtle)(rowIndex === rows.length - 1 ? curl : prefix)))
      for (const chunk of row) writer.append(chunk)
    })
    return {
      start,
      end: writer.line,
      unit: `entry:${item?.id ?? `${entry.turnId ?? "child"}:assistant:${index}`}`,
      expandable: false,
    }
  }
  const renderAgentError = (
    terminal: Extract<AgentTerminal, { kind: "error" }>,
    ownerId: string,
    prefix: string,
    gap = false,
  ): UnitLineRange | undefined => {
    const text = terminal.text.trim()
    if (text.length === 0) return
    const color = terminal.tone === "failed" ? colors.red : terminal.tone === "cancelled" ? colors.amber : colors.text
    const paint = (value: string) => (terminal.tone === "info" ? dim(fg(color)(value)) : fg(color)(value))
    const rows = InternalRendering.wrapTextToWidth(
      text,
      Math.max(1, markdownWidthForColumn(model.width) - stringWidth(prefix)),
    )
    const { curl } = prefixes(prefix, gap)
    const start = writer.line + 1
    if (gap) appendGap(prefix)
    rows.forEach((row, rowIndex) => {
      writer.append(fg(colors.text)("\n"))
      writer.append(dim(fg(colors.subtle)(rowIndex === rows.length - 1 ? curl : prefix)))
      writer.append(paint(row))
    })
    return { start, end: writer.line, unit: `agent-terminal:${ownerId}`, expandable: false }
  }
  return { renderAgentResponse, renderAgentError }
}

export const internal = { createTranscriptAgentRenderer }

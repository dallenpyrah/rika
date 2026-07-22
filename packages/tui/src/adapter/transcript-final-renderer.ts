import { bold, dim, fg, italic, type TextChunk } from "@opentui/core"
import type { Model, TranscriptBlock } from "../view-state"
import { colors } from "../theme"
import { renderDiffStyled } from "../diff-renderer"
import { renderPierreDiff } from "../pierre-diff"
import { renderBlock } from "./rendering"
import { diffCounts } from "./transcript-model"
import type { TranscriptRendererWriter } from "./transcript-agent-renderer"

const createTranscriptFinalRenderer = (
  model: Model,
  writer: TranscriptRendererWriter,
  statusIcon: (failed: boolean, running: boolean, cancelled?: boolean) => TextChunk,
  marker: (expanded: boolean) => TextChunk,
  highlight: (text: string) => void,
) => {
  const appendStyled = (chunks: ReadonlyArray<TextChunk>) => {
    for (const chunk of chunks) writer.append(chunk)
  }
  const renderChildAgentBody = (block: Extract<TranscriptBlock, { _tag: "ChildAgent" }>, expanded: boolean) => {
    const running = block.status === "running"
    const name = block.name.replace(/^rika-/, "")
    const normalized = name.toLowerCase()
    const display =
      normalized.length === 0 || normalized === "child" || normalized === "task" || normalized === "subagent"
        ? "Subagent"
        : name.charAt(0).toUpperCase() + name.slice(1)
    const phrase =
      block.status === "cancelled"
        ? `${display} cancelled`
        : display === "Oracle"
          ? running
            ? "Oracle exploring"
            : "Oracle has spoken"
          : display === "Librarian"
            ? running
              ? "Librarian is researching"
              : "Librarian researched"
            : `${display} ${running ? "working" : block.status === "failed" ? "failed" : "finished"}`
    writer.append(statusIcon(block.status === "failed", running, block.status === "cancelled"))
    writer.append(fg(colors.text)(` ${phrase}`))
    writer.append(marker(expanded))
    if (expanded) {
      if (block.summary.length > 0) writer.append(dim(fg(colors.text)(`\n  ${block.summary}`)))
      for (const activity of block.activity) writer.append(dim(fg(colors.text)(`\n  ${activity}`)))
    }
  }
  const renderDiffBody = (index: number, selected: boolean, expanded: boolean) => {
    const block = model.blocks[index] as Extract<TranscriptBlock, { _tag: "Diff" }>
    if (expanded) {
      writer.append(bold(fg(selected ? colors.blue : colors.muted)(`Δ ${block.path} ▾\n`)))
      appendStyled(
        (renderPierreDiff(block.patch, { width: model.width }) ?? renderDiffStyled(block.patch, { width: model.width }))
          .chunks,
      )
      return
    }
    const [added, removed] = diffCounts(block.patch)
    const verb = /^--- \/dev\/null$/m.test(block.patch) || /^new file mode /m.test(block.patch) ? "Created" : "Edited"
    if (selected) highlight(`✓ ${verb} ${block.path} +${added} -${removed} ▸`)
    else {
      writer.append(fg(colors.green)("✓"))
      writer.append(fg(colors.text)(` ${verb} ${block.path}`))
      writer.append(fg(colors.green)(` +${added}`))
      writer.append(fg(colors.red)(` -${removed}`))
      writer.append(marker(false))
    }
  }
  const renderReasoningBody = (index: number, selected: boolean) => {
    const block = model.blocks[index] as Extract<TranscriptBlock, { _tag: "Reasoning" }>
    writer.append(selected ? bold(fg(colors.blue)(block.text)) : dim(italic(fg(colors.text)(block.text))))
  }
  const renderPlainBlock = (index: number) => {
    const block = model.blocks[index] as TranscriptBlock
    const color = block._tag === "ContextUsage" ? colors.muted : block._tag === "Error" ? colors.red : colors.text
    writer.append(fg(color)(renderBlock(block, model.width)))
    if (block._tag === "Permission" && block.status === "pending") {
      const options = ["Allow once", "Always", "Deny"]
        .map((option, optionIndex) => `${optionIndex === model.permissionSelection ? "›" : " "} ${option}`)
        .join("   ")
      writer.append(fg(colors.text)(`\n  ${options}`))
    }
  }
  return { renderChildAgentBody, renderDiffBody, renderReasoningBody, renderPlainBlock }
}

export const internal = { createTranscriptFinalRenderer }

import { bold, dim, fg, italic, strikethrough, StyledText, type TextChunk } from "@opentui/core"
import stringWidth from "string-width"
import type { Model, TranscriptBlock } from "../view-state"
import {
  isExpandableUnit,
  isToolOutputDisplayed as isOutputDisplayed,
  toolDetail,
  unitId,
  toolDetails,
  type ToolTranscriptUnit as ToolRow,
  type TranscriptUnit,
} from "../transcript-presenter"
import { colors } from "../theme"
import { renderMarkdownStyled } from "../markdown-renderer"
import { renderDiffStyled, renderPartialDiffStyled } from "../diff-renderer"
import { renderPierreDiff } from "../pierre-diff"
import { highlightShellCommand } from "../syntax-highlight"
import { idleSpinnerFrame, internal as Rendering, markdownWidthForColumn, transcriptStatusIcon } from "./rendering"
import { internal as FinalRenderer } from "./transcript-final-renderer"
import { internal as AgentRenderer } from "./transcript-agent-renderer"
import {
  diffCounts,
  shellCommandText,
  shellExitCode,
  exploreChildLabel,
  markerText,
  cancelledAgentLabel,
  failedAgentLabel,
  toolInputValue,
  type ToolUnit,
  type TranscriptUnitBuild,
  type UnitLineRange,
  internal as TranscriptModel,
} from "./transcript-model"
const transcriptUnitBuilder = (model: Model, spinnerFrame = idleSpinnerFrame) => {
  let chunks: Array<TextChunk> = []
  let line = 0
  const append = (chunk: TextChunk) => {
    chunks.push(chunk)
    line += chunk.text.split("\n").length - 1
  }
  const appendAll = (styled: StyledText) => styled.chunks.forEach(append)
  const addExpandedBodyGutter = (from: number) => {
    const body = chunks.splice(from)
    const bordered: Array<TextChunk> = []
    for (const chunk of body) {
      const parts = chunk.text.split("\n")
      for (const [index, part] of parts.entries()) {
        if (index > 0) {
          bordered.push(fg(colors.text)("\n"))
          bordered.push(dim(fg(colors.subtle)("│ ")))
        }
        if (part.length > 0) bordered.push({ ...chunk, text: part })
      }
    }
    chunks.push(...bordered)
  }
  const statusIcon = transcriptStatusIcon(spinnerFrame)
  const marker = (expanded: boolean): TextChunk => fg(colors.subtle)(expanded ? " ▾" : " ▸")
  const rowExpanded = (id: string): boolean => model.expandedRowKeys.includes(id)
  const highlight = (text: string) => append(bold(fg(colors.blue)(text)))
  let nestedRanges: Array<UnitLineRange> = []
  const renderEntryBody = (index: number) => {
    const entry = model.entries[index]!
    if (entry.role === "assistant") {
      appendAll(renderMarkdownStyled(entry.text.trimEnd(), markdownWidthForColumn(model.width)))
      return
    }
    if (entry.role === "notice") {
      if (entry.text === "cancelled") append(fg(colors.amber)("⊘"))
      else append(fg(colors.amber)(`! ${entry.text}`))
      return
    }
    const wrapWidth = markdownWidthForColumn(model.width)
    const wrapped = entry.text.split("\n").flatMap((current) => {
      if (current.length <= wrapWidth) return [current]
      const parts: Array<string> = []
      let rest = current
      while (rest.length > wrapWidth) {
        const slice = rest.slice(0, wrapWidth)
        const breakAt = slice.lastIndexOf(" ") > wrapWidth / 2 ? slice.lastIndexOf(" ") : wrapWidth
        parts.push(rest.slice(0, breakAt))
        rest = rest.slice(breakAt).trimStart()
      }
      parts.push(rest)
      return parts
    })
    wrapped.forEach((current, lineIndex) => {
      if (lineIndex > 0) append(fg(colors.text)("\n"))
      append(fg(colors.green)("┃ "))
      append(italic(fg(colors.green)(current)))
    })
  }
  const agentRenderer = AgentRenderer.createTranscriptAgentRenderer(model, {
    get chunks() {
      return chunks
    },
    get line() {
      return line
    },
    append,
  })
  const renderExploreBody = (units: ReadonlyArray<ToolUnit>, selected: boolean, expanded: boolean) => {
    const running = units.some((unit) => unit.block.status === "running")
    const complete = units.some((unit) => unit.block.status === "complete")
    const failed = !running && !complete && units.some((unit) => unit.block.status === "failed")
    const cancelled = !running && !complete && !failed && units.some((unit) => unit.block.status === "cancelled")
    const counters = new Map<string, number>()
    for (const unit of units) {
      const counter = unit.block.presentation.counter ?? (unit.kind === "read" ? "file" : "search")
      counters.set(counter, (counters.get(counter) ?? 0) + 1)
    }
    const counts = [...counters]
      .map(([counter, count]) =>
        counter === "search"
          ? TranscriptModel.plural(count, counter).replace("searchs", "searches")
          : TranscriptModel.plural(count, counter),
      )
      .join(", ")
    if (selected)
      highlight(
        `${TranscriptModel.iconChar(failed, running, spinnerFrame, cancelled)} ${running ? "Exploring" : "Explored"} ${counts.length > 0 ? counts : "workspace"}${markerText(expanded)}`,
      )
    else {
      append(statusIcon(failed, running, cancelled))
      append(fg(colors.text)(running ? " Exploring" : " Explored"))
      append(dim(fg(colors.text)(` ${counts.length > 0 ? counts : "workspace"}`)))
      append(marker(expanded))
    }
    if (expanded)
      for (const unit of units) {
        append(fg(colors.text)("\n "))
        const start = line
        append(
          statusIcon(
            unit.block.status === "failed",
            unit.block.status === "running",
            unit.block.status === "cancelled",
          ),
        )
        const label = exploreChildLabel(unit)
        const childId = `tool-child:${unit.block.id}`
        const verbEnd = label.indexOf(" ")
        if (verbEnd === -1) append(fg(colors.text)(` ${label}`))
        else {
          append(fg(colors.text)(` ${label.slice(0, verbEnd)}`))
          append(dim(fg(colors.text)(label.slice(verbEnd))))
        }
        const output =
          unit.block.status === "failed" && isOutputDisplayed(unit.block)
            ? unit.block.output?.split("\n").find((value) => value.length > 0)
            : undefined
        if (output !== undefined) append(dim(fg(colors.text)(` ${output}`)))
        const detail = toolDetails(model, { kind: "tool", group: "explore", blocks: [unit.index], diffs: [] })[0]
        nestedRanges.push({
          start,
          end: line,
          unit: childId,
          expandable: false,
          animated: unit.block.status === "running",
          ...(detail?.target === undefined ? {} : { targets: [detail.target] }),
        })
      }
  }
  const renderEditBody = (
    units: ReadonlyArray<ToolUnit>,
    diffs: ReadonlyArray<number>,
    selected: boolean,
    expanded: boolean,
  ) => {
    const failed = units.some((unit) => unit.block.status === "failed")
    const running = units.some((unit) => unit.block.status === "running")
    const cancelled = units.some((unit) => unit.block.status === "cancelled")
    const paths = [
      ...new Set(
        units.flatMap((unit) =>
          unit.block.files.length > 0
            ? unit.block.files.map((file) => file.path)
            : [TranscriptModel.inputString(toolInputValue(unit.block.input), ["path", "file_path", "file"]) ?? ""],
        ),
      ),
    ]
    const allFiles = units.flatMap((unit) => unit.block.files)
    let added = 0
    let removed = 0
    for (const file of allFiles) {
      added += file.additions
      removed += file.deletions
    }
    for (const diffIndex of diffs) {
      const diff = model.blocks[diffIndex] as Extract<TranscriptBlock, { _tag: "Diff" }>
      const [a, r] = diffCounts(diff.patch)
      added += a
      removed += r
    }
    const creates = diffs.length === 0 && allFiles.length > 0 && allFiles.every((file) => file.kind === "add")
    const label = paths.length === 1 ? paths[0] : TranscriptModel.plural(paths.length, "file")
    const verb = creates
      ? running
        ? "Creating"
        : "Created"
      : paths.length === 1 && units.length === 1
        ? running
          ? units[0]!.block.presentation.activeLabel
          : units[0]!.block.presentation.completeLabel
        : running
          ? "Editing"
          : "Edited"
    const counts = `${added > 0 ? ` +${added}` : ""}${removed > 0 ? ` -${removed}` : ""}`
    if (selected)
      highlight(
        `${TranscriptModel.iconChar(failed, running, spinnerFrame, cancelled)} ${verb} ${label}${counts}${markerText(expanded)}`,
      )
    else {
      append(statusIcon(failed, running, cancelled))
      append(fg(colors.text)(` ${verb}`))
      append(dim(fg(colors.text)(` ${label}`)))
      if (added > 0) append(fg(colors.green)(` +${added}`))
      if (removed > 0) append(fg(colors.red)(` -${removed}`))
      append(marker(expanded))
    }
    if (expanded) {
      const files = allFiles
      if (files.length === 1) {
        const file = files[0]!
        if (file.patch.length > 0) {
          append(fg(colors.text)("\n"))
          appendAll(
            renderPierreDiff(file.patch, { width: model.width }) ??
              (file.preview ? renderPartialDiffStyled(file.patch, { width: model.width }) : undefined) ??
              renderDiffStyled(file.patch, { width: model.width }),
          )
        }
      } else {
        for (const file of files) {
          append(fg(colors.text)("\n  "))
          const start = line
          const childId = `file:${file.key}`
          const childExpanded = rowExpanded(childId) || running
          const fileRunning = running && file.status === "running"
          append(statusIcon(file.status === "failed", fileRunning, cancelled && file.status === "running"))
          append(fg(colors.text)(` ${file.kind === "add" ? "Create" : "Edit"} ${file.path}`))
          if (file.additions > 0) append(fg(colors.green)(` +${file.additions}`))
          if (file.deletions > 0) append(fg(colors.red)(` -${file.deletions}`))
          append(marker(childExpanded))
          if (childExpanded && file.patch.length > 0) {
            append(fg(colors.text)("\n"))
            appendAll(
              renderPierreDiff(file.patch, { width: model.width, indent: 4 }) ??
                (file.preview ? renderPartialDiffStyled(file.patch, { width: model.width, indent: 4 }) : undefined) ??
                renderDiffStyled(file.patch, { width: model.width, indent: 4 }),
            )
          }
          nestedRanges.push({
            start,
            end: line,
            unit: childId,
            expandable: true,
            animated: fileRunning,
            targets: [{ path: file.path }],
          })
        }
      }
      for (const diffIndex of diffs) {
        const diff = model.blocks[diffIndex] as Extract<TranscriptBlock, { _tag: "Diff" }>
        append(fg(colors.text)("\n"))
        const start = line
        appendAll(
          renderPierreDiff(diff.patch, { width: model.width }) ?? renderDiffStyled(diff.patch, { width: model.width }),
        )
        nestedRanges.push({
          start,
          end: line,
          unit: `diff-child:${diffIndex}`,
          expandable: false,
          targets: [{ path: diff.path }],
        })
      }
    }
  }
  const renderShellSingleBody = (unit: ToolUnit, selected: boolean, expanded: boolean) => {
    const command = shellCommandText(unit.block)
    const failed = unit.block.status === "failed"
    const running = unit.block.status === "running"
    const cancelled = unit.block.status === "cancelled"
    const lines = command.split("\n")
    const output = isOutputDisplayed(unit.block) ? unit.block.output : undefined
    const expandable = output !== undefined && output.length > 0
    const exitCode = shellExitCode(unit.block)
    if (selected) {
      const exit = failed ? ` (exit code: ${exitCode ?? 1})` : ""
      const cancellation = cancelled ? " (cancelled)" : ""
      highlight(
        `${running ? spinnerFrame : "$"} ${lines.join("\n    ")}${exit}${cancellation}${expandable ? markerText(expanded) : ""}`,
      )
    } else {
      const highlighted = cancelled ? undefined : highlightShellCommand(command)
      lines.forEach((current, lineIndex) => {
        if (lineIndex === 0) {
          if (running) {
            append(statusIcon(false, true))
            append(fg(colors.text)(" "))
          } else if (cancelled) append(bold(fg(colors.amber)("$ ")))
          else append(dim(fg(colors.text)("$ ")))
          if (cancelled) append(strikethrough(fg(colors.text)(current)))
          else for (const chunk of highlighted?.[lineIndex] ?? []) append(chunk)
        } else if (cancelled) append(strikethrough(fg(colors.text)(`\n    ${current}`)))
        else {
          append(fg(colors.text)("\n    "))
          for (const chunk of highlighted?.[lineIndex] ?? []) append(chunk)
        }
      })
      if (failed) append(fg(colors.red)(` (exit code: ${exitCode ?? 1})`))
      if (cancelled) append(italic(fg(colors.amber)(" (cancelled)")))
      if (expandable) append(marker(expanded))
    }
    if (expanded && output !== undefined) {
      append(fg(colors.text)("\n"))
      append(dim(fg(colors.text)(output.split("\n").slice(0, 12).join("\n"))))
    }
  }
  const renderShellBody = (units: ReadonlyArray<ToolUnit>, selected: boolean, expanded: boolean) => {
    if (units.length === 1) {
      renderShellSingleBody(units[0]!, selected, expanded)
      return
    }
    const failedCount = units.filter((unit) => unit.block.status === "failed").length
    const cancelledCount = units.filter((unit) => unit.block.status === "cancelled").length
    const running = units.some((unit) => unit.block.status === "running")
    if (selected)
      highlight(
        `${TranscriptModel.iconChar(failedCount > 0, running, spinnerFrame, cancelledCount > 0)} ${running ? "Running" : "Ran"} ${TranscriptModel.plural(units.length, "command")}${failedCount > 0 ? `, ${failedCount} failed` : ""}${cancelledCount > 0 ? `, ${cancelledCount} cancelled` : ""}${markerText(expanded)}`,
      )
    else {
      append(statusIcon(failedCount > 0, running, cancelledCount > 0))
      append(fg(colors.text)(running ? " Running" : " Ran"))
      append(fg(colors.text)(` ${TranscriptModel.plural(units.length, "command")}`))
      if (failedCount > 0) append(fg(colors.muted)(`, ${failedCount} failed`))
      if (cancelledCount > 0) append(fg(colors.muted)(`, ${cancelledCount} cancelled`))
      append(marker(expanded))
    }
    if (expanded)
      for (const unit of units) {
        append(fg(colors.text)("\n   "))
        const start = line
        const childId = `tool-child:${unit.block.id}`
        const childExpanded = rowExpanded(childId)
        const output = isOutputDisplayed(unit.block) ? unit.block.output : undefined
        const expandable = output !== undefined && output.length > 0
        const cancelled = unit.block.status === "cancelled"
        if (cancelled) {
          append(bold(fg(colors.amber)("$ ")))
          append(strikethrough(fg(colors.text)(shellCommandText(unit.block).split("\n")[0]!)))
          append(italic(fg(colors.amber)(" (cancelled)")))
        } else {
          append(dim(fg(colors.text)("$ ")))
          for (const chunk of highlightShellCommand(shellCommandText(unit.block))[0] ?? []) append(chunk)
        }
        if (unit.block.status === "failed") append(fg(colors.red)(` (exit code: ${shellExitCode(unit.block) ?? 1})`))
        if (expandable) append(marker(childExpanded))
        if (expandable && childExpanded) {
          append(fg(colors.text)("\n   "))
          append(dim(fg(colors.text)(output!.split("\n").slice(0, 12).join("\n   "))))
        }
        nestedRanges.push({ start, end: line, unit: childId, expandable })
      }
  }
  const renderOtherToolBody = (
    unit: ToolUnit,
    selected: boolean,
    expanded: boolean,
    hasChildren = false,
    hasTerminal = false,
  ) => {
    const failed = unit.block.status === "failed"
    const running = unit.block.status === "running"
    const cancelled = unit.block.status === "cancelled"
    const label = running
      ? unit.block.presentation.activeLabel
      : cancelled && unit.block.presentation.family === "agent"
        ? cancelledAgentLabel(unit.block.presentation.activeLabel)
        : failed && unit.block.presentation.family === "agent"
          ? failedAgentLabel(unit.block.presentation.activeLabel)
          : unit.block.presentation.completeLabel
    const detail = unit.block.detail.length === 0 ? "" : ` ${unit.block.detail}`
    const agent = unit.block.presentation.family === "agent"
    const output = agent || !isOutputDisplayed(unit.block) ? undefined : unit.block.output
    const expandable =
      hasChildren || hasTerminal || (agent ? unit.block.detail.length > 0 : output !== undefined && output.length > 0)
    if (selected)
      highlight(
        `${TranscriptModel.iconChar(failed, running, spinnerFrame, cancelled)} ${label}${agent ? "" : detail}${expandable ? markerText(expanded) : ""}`,
      )
    else {
      append(statusIcon(failed, running, cancelled))
      append(fg(colors.text)(` ${label}`))
      if (!agent && detail.length > 0) append(dim(fg(colors.text)(detail)))
      if (expandable) append(marker(expanded))
    }
    if (expanded && agent && unit.block.detail.length > 0) {
      append(dim(fg(colors.text)(`\n  ${unit.block.detail}`)))
    } else if (expanded && !agent && output !== undefined) {
      append(fg(colors.text)("\n"))
      const body = output.split("\n").slice(0, 12).join("\n")
      append(dim(fg(colors.text)(body)))
    }
  }
  const renderNestedTool = (unit: ToolRow, prefix: string, last: boolean) => {
    const index = unit.blocks[0]!
    const block = model.blocks[index] as Extract<TranscriptBlock, { _tag: "ToolCall" }>
    const id = unitId(model, unit)
    const expanded = rowExpanded(id)
    const running = block.status === "running"
    const failed = block.status === "failed"
    const cancelled = block.status === "cancelled"
    const detail = toolDetail(index, block)
    const children = unit.children ?? []
    const agent = block.presentation.family === "agent"
    const output = agent || !isOutputDisplayed(block) ? undefined : block.output
    const expandable =
      children.length > 0 ||
      unit.terminal !== undefined ||
      (agent && block.detail.length > 0) ||
      (output !== undefined && output.length > 0)
    const rowWidth = markdownWidthForColumn(model.width)
    const visiblePrefix = Rendering.truncateToWidth(prefix, Math.max(0, rowWidth - 8))
    const branchPrefix = `${visiblePrefix}${last ? "└" : "├"} `
    const continuationPrefix = `${visiblePrefix}${last ? " " : "│"}   `
    append(fg(colors.text)("\n"))
    append(dim(fg(colors.subtle)(branchPrefix)))
    const start = line
    if (cancelled && block.presentation.family === "shell") {
      const command = detail.label.startsWith("$ ") ? detail.label.slice(2) : detail.label
      append(bold(fg(colors.amber)("$ ")))
      append(strikethrough(fg(colors.text)(command)))
      append(italic(fg(colors.amber)(" (cancelled)")))
    } else {
      append(statusIcon(failed, running, cancelled))
      const labelLines = Rendering.wrapTextToWidth(
        detail.label,
        rowWidth - stringWidth(continuationPrefix) - (expandable ? 2 : 0),
      )
      for (const [labelIndex, labelLine] of labelLines.entries()) {
        if (labelIndex > 0) {
          append(fg(colors.text)("\n"))
          append(dim(fg(colors.subtle)(continuationPrefix)))
        } else append(fg(colors.text)(" "))
        append(fg(colors.text)(labelLine))
      }
    }
    if (expandable) append(marker(expanded))
    const headerEnd = line
    const rangeIndex = nestedRanges.length
    nestedRanges.push({
      start,
      end: start,
      headerEnd,
      unit: id,
      expandable,
      animated: running,
      ...(detail.target === undefined ? {} : { targets: [detail.target] }),
    })
    const bodyPrefix = `${visiblePrefix}${last ? "  " : "│ "}`
    if (expanded && agent && block.detail.length > 0) {
      append(fg(colors.text)("\n"))
      append(dim(fg(colors.subtle)(`${bodyPrefix}  `)))
      append(dim(fg(colors.text)(block.detail)))
    } else if (expanded && output !== undefined && output.length > 0) {
      const renderedOutput = output.split("\n").slice(0, 12).join(`\n${bodyPrefix}  `)
      append(fg(colors.text)("\n"))
      append(dim(fg(colors.subtle)(`${bodyPrefix}  `)))
      append(dim(fg(colors.text)(renderedOutput)))
    }
    if (expanded)
      for (const [childIndex, child] of children.entries())
        renderNestedTool(child, bodyPrefix, childIndex === children.length - 1 && unit.terminal === undefined)
    if (expanded && unit.terminal !== undefined) {
      const timeline = children.length > 0
      const terminalPrefix = timeline ? `${bodyPrefix}│   ` : `${bodyPrefix}  `
      const range =
        unit.terminal.kind === "answer"
          ? agentRenderer.renderAgentResponse(unit.terminal.entry, terminalPrefix, timeline)
          : agentRenderer.renderAgentError(unit.terminal, block.id, terminalPrefix, timeline)
      if (range !== undefined) nestedRanges.push(range)
    }
    nestedRanges[rangeIndex] = {
      ...nestedRanges[rangeIndex]!,
      end: children.length === 0 ? line : (nestedRanges[rangeIndex + 1]?.start ?? start + 1) - 1,
    }
  }
  const finalRenderer = FinalRenderer.createTranscriptFinalRenderer(
    model,
    {
      get chunks() {
        return chunks
      },
      get line() {
        return line
      },
      append,
    },
    statusIcon,
    marker,
    highlight,
  )
  const isUnitVisible = (unit: TranscriptUnit): boolean => unit.kind !== "reasoning" || rowExpanded(unitId(model, unit))
  const renderUnit = (unit: TranscriptUnit): TranscriptUnitBuild => {
    chunks = []
    line = 0
    nestedRanges = []
    const expandable = isExpandableUnit(model, unit)
    const id = unitId(model, unit)
    const expanded =
      rowExpanded(id) ||
      (unit.kind === "tool" &&
        unit.group === "edit" &&
        unit.blocks.some(
          (block) => (model.blocks[block] as Extract<TranscriptBlock, { _tag: "ToolCall" }>).status === "running",
        ))
    const selected = expandable && model.detailSelection === id
    const start = line
    const chunkStart = chunks.length
    if (unit.kind === "entry") renderEntryBody(unit.entry)
    else if (unit.kind === "reasoning") finalRenderer.renderReasoningBody(unit.block, selected)
    else if (unit.kind === "childAgent")
      finalRenderer.renderChildAgentBody(
        model.blocks[unit.block] as Extract<TranscriptBlock, { _tag: "ChildAgent" }>,
        expanded,
      )
    else if (unit.kind === "diff") finalRenderer.renderDiffBody(unit.block, selected, expanded)
    else if (unit.kind === "block") finalRenderer.renderPlainBlock(unit.block)
    else if (unit.children !== undefined || unit.terminal !== undefined) {
      renderOtherToolBody(
        TranscriptModel.toolUnitsFor(model, unit.blocks)[0]!,
        selected,
        expanded,
        unit.children !== undefined,
        unit.terminal !== undefined,
      )
      if (expanded)
        for (const [childIndex, child] of (unit.children ?? []).entries())
          renderNestedTool(child, "  ", childIndex === (unit.children?.length ?? 0) - 1 && unit.terminal === undefined)
      if (expanded && unit.terminal !== undefined) {
        const timeline = (unit.children?.length ?? 0) > 0
        const prefix = timeline ? "  │   " : "  "
        const ownerId = (model.blocks[unit.blocks[0]!] as Extract<TranscriptBlock, { _tag: "ToolCall" }>).id
        const range =
          unit.terminal.kind === "answer"
            ? agentRenderer.renderAgentResponse(unit.terminal.entry, prefix, timeline)
            : agentRenderer.renderAgentError(unit.terminal, ownerId, prefix, timeline)
        if (range !== undefined) nestedRanges.push(range)
      }
    } else if (unit.group === "explore")
      renderExploreBody(TranscriptModel.toolUnitsFor(model, unit.blocks), selected, expanded)
    else if (unit.group === "edit")
      renderEditBody(TranscriptModel.toolUnitsFor(model, unit.blocks), unit.diffs, selected, expanded)
    else if (unit.group === "shell")
      renderShellBody(TranscriptModel.toolUnitsFor(model, unit.blocks), selected, expanded)
    else
      for (const toolUnit of TranscriptModel.toolUnitsFor(model, unit.blocks))
        renderOtherToolBody(toolUnit, selected, expanded)
    const cancelledAgent =
      unit.kind === "tool" &&
      unit.blocks.some((index) => {
        const block = model.blocks[index] as Extract<TranscriptBlock, { _tag: "ToolCall" }>
        return block.status === "cancelled" && block.presentation.family === "agent"
      })
    if (expanded && cancelledAgent) addExpandedBodyGutter(chunkStart)
    const root: UnitLineRange = {
      start,
      end: nestedRanges.length === 0 ? line : nestedRanges[0]!.start - 1,
      unit: id,
      expandable,
      animated:
        unit.kind === "tool"
          ? unit.blocks.some(
              (index) => (model.blocks[index] as Extract<TranscriptBlock, { _tag: "ToolCall" }>).status === "running",
            )
          : unit.kind === "childAgent"
            ? (model.blocks[unit.block] as Extract<TranscriptBlock, { _tag: "ChildAgent" }>).status === "running"
            : false,
      gapBefore: false,
      ...(unit.kind === "tool"
        ? {
            targets: toolDetails(model, unit).flatMap((detail) => (detail.target === undefined ? [] : [detail.target])),
          }
        : unit.kind === "diff"
          ? { targets: [{ path: (model.blocks[unit.block] as Extract<TranscriptBlock, { _tag: "Diff" }>).path }] }
          : {}),
    }
    return { chunks, lines: line, root, nested: nestedRanges }
  }
  return { renderUnit, isUnitVisible }
}

export const internal = { transcriptUnitBuilder }

import { StyledText, fg, type TextChunk } from "@opentui/core"
import { Function } from "effect"
import type { Model } from "../view-state"
import { orderedTranscriptItems, rows as transcriptUnits } from "../transcript-presenter"
import { colors } from "../theme"
import { idleSpinnerFrame } from "./rendering"
import { type UnitLineRange } from "./transcript-model"
import { internal as InternalTranscriptModel } from "./transcript-model"
import { internal as InternalTranscriptUnitRenderer } from "./transcript-unit-renderer"

export const buildTranscript: {
  (model: Model, spinnerFrame?: string): { styled: StyledText; ranges: ReadonlyArray<UnitLineRange> }
  (spinnerFrame?: string): (model: Model) => { styled: StyledText; ranges: ReadonlyArray<UnitLineRange> }
} = Function.dual(
  (args) => typeof args[0] !== "string",
  (model: Model, spinnerFrame = idleSpinnerFrame): { styled: StyledText; ranges: ReadonlyArray<UnitLineRange> } => {
    const builder = InternalTranscriptUnitRenderer.transcriptUnitBuilder(model, spinnerFrame)
    const chunks: Array<TextChunk> = []
    const ranges: Array<UnitLineRange> = []
    let line = 0
    const append = (chunk: TextChunk) => {
      chunks.push(chunk)
      line += chunk.text.split("\n").length - 1
    }
    let renderedUnits = 0
    if (orderedTranscriptItems(model)[0]?._tag === "Block") append(fg(colors.text)("\n"))
    for (const unit of transcriptUnits(model)) {
      if (!builder.isUnitVisible(unit)) continue
      if (renderedUnits > 0) append(fg(colors.text)("\n\n"))
      renderedUnits += 1
      const built = builder.renderUnit(unit)
      const offset = line
      for (const chunk of built.chunks) chunks.push(chunk)
      line += built.lines
      ranges.push({ ...InternalTranscriptModel.offsetUnitRange(built.root, offset), gapBefore: renderedUnits > 1 })
      for (const nested of built.nested) ranges.push(InternalTranscriptModel.offsetUnitRange(nested, offset))
    }
    return { styled: new StyledText(chunks), ranges }
  },
)

export const renderTranscriptStyled = (model: Model): StyledText => buildTranscript(model).styled

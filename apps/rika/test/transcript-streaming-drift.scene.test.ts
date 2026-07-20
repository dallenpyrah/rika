import { expect, test } from "vitest"
import { Scene } from "./scene"

const ESC = String.fromCharCode(27)
const BELL = String.fromCharCode(7)
const CTRL_C = String.fromCharCode(3)
const clamp = (value: number, limit: number) => Math.max(0, Math.min(limit - 1, value))

const finalTranscriptScreen = (raw: string): ReadonlyArray<string> => {
  const rows = 30
  const cols = 100
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => " "))
  let altScreenSnapshot: ReadonlyArray<string> | undefined
  let row = 0
  let col = 0
  const snapshot = () => grid.map((cells) => cells.join(""))
  const clearAll = () => {
    for (const cells of grid) cells.fill(" ")
  }
  const scrollUp = () => {
    grid.shift()
    grid.push(Array.from({ length: cols }, () => " "))
  }
  let index = 0
  while (index < raw.length) {
    const character = raw[index]!
    if (character === ESC) {
      const kind = raw[index + 1]
      if (kind === "[") {
        let end = index + 2
        while (end < raw.length && !/[@-~]/.test(raw[end]!)) end += 1
        const body = raw.slice(index + 2, end)
        const final = raw[end]
        const parameters = body
          .replace(/^[?>]/, "")
          .split(";")
          .map((part) => Number.parseInt(part, 10))
        const first = Number.isNaN(parameters[0] ?? Number.NaN) ? undefined : parameters[0]
        if (final === "H" || final === "f") {
          row = clamp((first ?? 1) - 1, rows)
          col = clamp((parameters[1] ?? 1) - 1, cols)
        } else if (final === "A") row = clamp(row - (first ?? 1), rows)
        else if (final === "B") row = clamp(row + (first ?? 1), rows)
        else if (final === "C") col = clamp(col + (first ?? 1), cols)
        else if (final === "D") col = clamp(col - (first ?? 1), cols)
        else if (final === "G") col = clamp((first ?? 1) - 1, cols)
        else if (final === "d") row = clamp((first ?? 1) - 1, rows)
        else if (final === "J") {
          if (first === undefined || first === 0)
            for (let target = row; target < rows; target += 1) grid[target]!.fill(" ", target === row ? col : 0)
          else if (first === 1)
            for (let target = 0; target <= row; target += 1) grid[target]!.fill(" ", 0, target === row ? col + 1 : cols)
          else clearAll()
        } else if (final === "K") {
          if (first === undefined || first === 0) grid[row]!.fill(" ", col)
          else if (first === 1) grid[row]!.fill(" ", 0, col + 1)
          else grid[row]!.fill(" ")
        } else if (final === "S") for (let count = 0; count < (first ?? 1); count += 1) scrollUp()
        else if (final === "h" || final === "l") {
          if (body.startsWith("?1049")) {
            if (final === "l") altScreenSnapshot = snapshot()
            clearAll()
            row = 0
            col = 0
          }
        }
        index = end + 1
        continue
      }
      if (kind === "]") {
        let end = index + 2
        while (end < raw.length && raw[end] !== BELL && !(raw[end] === ESC && raw[end + 1] === "\\")) end += 1
        index = raw[end] === BELL ? end + 1 : end + 2
        continue
      }
      if (kind === "M") {
        row = clamp(row - 1, rows)
        index += 2
        continue
      }
      index += kind === "(" || kind === ")" ? 3 : 2
      continue
    }
    if (character === "\r") col = 0
    else if (character === "\n") {
      if (row === rows - 1) scrollUp()
      else row += 1
    } else if (character === "\b") col = clamp(col - 1, cols)
    else if (character === "\t") col = clamp((col + 8) & ~7, cols)
    else if (character >= " ") {
      grid[row]![col] = character
      col = clamp(col + 1, cols)
    }
    index += 1
  }
  return altScreenSnapshot ?? snapshot()
}

const finalScreenShows = (raw: string, needle: string): boolean =>
  finalTranscriptScreen(raw).some((line) => line.includes(needle))

const wheelUp = (column: number, row: number, times: number) =>
  Array.from({ length: times }, () => `${ESC}[<64;${column};${row}M`).join("")

const parentResponse = `## Parent findings\n\n${Array.from(
  { length: 60 },
  (_, index) => `- DRIFT_LINE_${String(index).padStart(3, "0")} the parent recorded this`,
).join("\n")}`

const childResponse = `## Child stream\n\n${Array.from(
  { length: 60 },
  (_, index) => `- CHILD_LINE_${String(index).padStart(3, "0")} the child streamed this`,
).join("\n")}`

test(
  "keeps the scrolled-up reading position while later content streams in",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.textPart(parentResponse),
          Scene.model.toolCall("task", { prompt: "Stream more findings." }, "drift-child"),
        ]),
        Scene.model.text(childResponse, 150),
        Scene.model.text("DRIFT_TAIL_MARKER"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "TRIGGER_STREAM_DRIFT report the findings.\r"),
        Scene.action.writeAfter("DRIFT_LINE_059", wheelUp(10, 10, 8), 50),
        Scene.action.writeAfterDelay(CTRL_C, 2500),
      ],
    }).then((result) => {
      expect(result.actionsCompleted, result.output).toBe(3)
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
      const screen = finalTranscriptScreen(result.rawOutput).join("\n")
      expect(finalScreenShows(result.rawOutput, "DRIFT_LINE_0"), screen).toBe(true)
      expect(finalScreenShows(result.rawOutput, "CHILD_LINE_"), screen).toBe(false)
      expect(finalScreenShows(result.rawOutput, "DRIFT_TAIL_MARKER"), screen).toBe(false)
    }),
  60_000,
)

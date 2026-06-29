import { Common } from "@rika/schema"
import {
  getFiletypeFromFileName,
  getSharedHighlighter,
  renderDiffWithHighlighter,
  type FileDiffMetadata,
  type ThemedDiffResult,
} from "@pierre/diffs"
import { Effect } from "effect"

export interface DiffToken {
  readonly text: string
  readonly color?: string
}

export type DiffRow =
  | { readonly kind: "separator" }
  | {
      readonly kind: "line"
      readonly marker: " " | "+" | "-"
      readonly line: number
      readonly tokens: ReadonlyArray<DiffToken>
    }

export interface RenderedDiff {
  readonly rows: ReadonlyArray<DiffRow>
  readonly highlighted: boolean
}

type FileDiffHunk = FileDiffMetadata["hunks"][number]
type FileDiffHunkContent = FileDiffHunk["hunkContent"][number]

export class DiffRenderCache {
  private readonly rendered = new Map<string, RenderedDiff>()

  ensure(fileDiff: Common.JsonValue): Effect.Effect<void> {
    const diff = asFileDiff(fileDiff)
    if (diff === undefined) return Effect.void
    const key = cacheKey(diff)
    if (this.rendered.has(key)) return Effect.void
    return Effect.tryPromise(async () => {
      this.rendered.set(key, await renderHighlighted(diff))
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          this.rendered.set(key, renderPlain(diff))
        }),
      ),
      Effect.asVoid,
    )
  }

  render(fileDiff: Common.JsonValue): RenderedDiff {
    const diff = asFileDiff(fileDiff)
    if (diff === undefined) return { rows: [], highlighted: false }
    return this.rendered.get(cacheKey(diff)) ?? renderPlain(diff)
  }
}

const theme = "github-dark"
const renderOptions = {
  theme,
  useTokenTransformer: false,
  tokenizeMaxLineLength: 1000,
  lineDiffType: "word-alt",
  maxLineDiffLength: 1000,
} as const

const renderHighlighted = async (diff: FileDiffMetadata): Promise<RenderedDiff> => {
  const language = diff.lang ?? getFiletypeFromFileName(diff.name)
  const highlighter = await getSharedHighlighter({ themes: [theme], langs: [language] })
  const rendered = renderDiffWithHighlighter(diff, highlighter, renderOptions)
  return { rows: limitRows(rowsFromRendered(diff, rendered)), highlighted: true }
}

const rowsFromRendered = (diff: FileDiffMetadata, rendered: ThemedDiffResult): ReadonlyArray<DiffRow> =>
  rowsFromDiff(diff, {
    additions: rendered.code.additionLines.map((line) => stripFinalNewline(tokensFromNode(line))),
    deletions: rendered.code.deletionLines.map((line) => stripFinalNewline(tokensFromNode(line))),
  })

const renderPlain = (diff: FileDiffMetadata): RenderedDiff => ({
  rows: limitRows(
    rowsFromDiff(diff, {
      additions: diff.additionLines.map((line) => [{ text: cleanLine(line), color: "#98c379" }]),
      deletions: diff.deletionLines.map((line) => [{ text: cleanLine(line), color: "#e06c75" }]),
    }),
  ),
  highlighted: false,
})

const rowsFromDiff = (
  diff: FileDiffMetadata,
  lines: {
    readonly additions: ReadonlyArray<ReadonlyArray<DiffToken>>
    readonly deletions: ReadonlyArray<ReadonlyArray<DiffToken>>
  },
): ReadonlyArray<DiffRow> => {
  const rows: Array<DiffRow> = []
  for (const hunk of diff.hunks) {
    if (rows.length > 0 || hunk.collapsedBefore > 0 || hunk.additionStart > 1) rows.push({ kind: "separator" })
    let deletionLine = hunk.deletionStart
    let additionLine = hunk.additionStart
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let index = 0; index < content.lines; index += 1) {
          rows.push({
            kind: "line",
            marker: " ",
            line: additionLine,
            tokens:
              lines.additions[content.additionLineIndex + index] ??
              lines.deletions[content.deletionLineIndex + index] ??
              [],
          })
          deletionLine += 1
          additionLine += 1
        }
      } else {
        for (let index = 0; index < content.deletions; index += 1) {
          rows.push({
            kind: "line",
            marker: "-",
            line: deletionLine,
            tokens: lines.deletions[content.deletionLineIndex + index] ?? [],
          })
          deletionLine += 1
        }
        for (let index = 0; index < content.additions; index += 1) {
          rows.push({
            kind: "line",
            marker: "+",
            line: additionLine,
            tokens: lines.additions[content.additionLineIndex + index] ?? [],
          })
          additionLine += 1
        }
      }
    }
  }
  return rows
}

const tokensFromNode = (node: unknown, inheritedColor?: string): ReadonlyArray<DiffToken> => {
  const current = asHast(node)
  if (current === undefined) return []
  if (current.type === "text") {
    const text = typeof current.value === "string" ? current.value : ""
    return text.length === 0 ? [] : [{ text, ...(inheritedColor === undefined ? {} : { color: inheritedColor }) }]
  }
  const color = colorFromStyle(current.properties?.style) ?? inheritedColor
  return (current.children ?? []).flatMap((child) => tokensFromNode(child, color))
}

const stripFinalNewline = (tokens: ReadonlyArray<DiffToken>): ReadonlyArray<DiffToken> => {
  if (tokens.length === 0) return tokens
  const last = tokens[tokens.length - 1]
  if (last === undefined) return tokens
  const text = cleanLine(last.text)
  if (text === last.text) return tokens
  return [...tokens.slice(0, -1), { ...last, text }]
}

const cleanLine = (text: string): string => text.replace(/\r?\n$/, "")

const colorFromStyle = (style: unknown): string | undefined => {
  if (typeof style !== "string") return undefined
  const match = /(?:^|;)\s*color\s*:\s*(#[0-9a-fA-F]{6})/.exec(style)
  return match?.[1]
}

const limitRows = (rows: ReadonlyArray<DiffRow>): ReadonlyArray<DiffRow> => {
  const kept: Array<DiffRow> = []
  let size = 0
  for (const row of rows) {
    const rowSize = row.kind === "separator" ? 3 : row.tokens.reduce((total, token) => total + token.text.length, 0) + 8
    if (kept.length > 0 && size + rowSize > 12000) {
      kept.push({ kind: "separator" })
      return kept
    }
    kept.push(row)
    size += rowSize
  }
  return kept
}

const cacheKey = (diff: FileDiffMetadata): string => diff.cacheKey ?? JSON.stringify(diff)

const asFileDiff = (value: Common.JsonValue): FileDiffMetadata | undefined => {
  if (!isObject(value)) return undefined
  const name = stringField(value, "name")
  const type = changeType(value.type)
  const hunks = arrayField(value, "hunks")
    ?.map(asHunk)
    .filter((hunk): hunk is FileDiffHunk => hunk !== undefined)
  const deletionLines = stringArrayField(value, "deletionLines")
  const additionLines = stringArrayField(value, "additionLines")
  const prevName = stringField(value, "prevName")
  const newObjectId = stringField(value, "newObjectId")
  const prevObjectId = stringField(value, "prevObjectId")
  const mode = stringField(value, "mode")
  const prevMode = stringField(value, "prevMode")
  const key = stringField(value, "cacheKey")
  if (name === undefined || type === undefined || hunks === undefined) return undefined
  return {
    name,
    type,
    hunks,
    splitLineCount: numberField(value, "splitLineCount") ?? 0,
    unifiedLineCount: numberField(value, "unifiedLineCount") ?? 0,
    isPartial: booleanField(value, "isPartial") ?? false,
    deletionLines,
    additionLines,
    ...(prevName === undefined ? {} : { prevName }),
    ...(newObjectId === undefined ? {} : { newObjectId }),
    ...(prevObjectId === undefined ? {} : { prevObjectId }),
    ...(mode === undefined ? {} : { mode }),
    ...(prevMode === undefined ? {} : { prevMode }),
    ...(key === undefined ? {} : { cacheKey: key }),
  }
}

const asHunk = (value: Common.JsonValue): FileDiffHunk | undefined => {
  if (!isObject(value)) return undefined
  const hunkContent = arrayField(value, "hunkContent")
    ?.map(asHunkContent)
    .filter((content): content is FileDiffHunkContent => content !== undefined)
  const hunkContext = stringField(value, "hunkContext")
  const hunkSpecs = stringField(value, "hunkSpecs")
  if (hunkContent === undefined) return undefined
  return {
    collapsedBefore: numberField(value, "collapsedBefore") ?? 0,
    additionStart: numberField(value, "additionStart") ?? 0,
    additionCount: numberField(value, "additionCount") ?? 0,
    additionLines: numberField(value, "additionLines") ?? 0,
    additionLineIndex: numberField(value, "additionLineIndex") ?? 0,
    deletionStart: numberField(value, "deletionStart") ?? 0,
    deletionCount: numberField(value, "deletionCount") ?? 0,
    deletionLines: numberField(value, "deletionLines") ?? 0,
    deletionLineIndex: numberField(value, "deletionLineIndex") ?? 0,
    hunkContent,
    ...(hunkContext === undefined ? {} : { hunkContext }),
    ...(hunkSpecs === undefined ? {} : { hunkSpecs }),
    splitLineStart: numberField(value, "splitLineStart") ?? 0,
    splitLineCount: numberField(value, "splitLineCount") ?? 0,
    unifiedLineStart: numberField(value, "unifiedLineStart") ?? 0,
    unifiedLineCount: numberField(value, "unifiedLineCount") ?? 0,
    noEOFCRDeletions: booleanField(value, "noEOFCRDeletions") ?? false,
    noEOFCRAdditions: booleanField(value, "noEOFCRAdditions") ?? false,
  }
}

const asHunkContent = (value: Common.JsonValue): FileDiffHunkContent | undefined => {
  if (!isObject(value)) return undefined
  if (value.type === "context") {
    return {
      type: "context",
      lines: numberField(value, "lines") ?? 0,
      additionLineIndex: numberField(value, "additionLineIndex") ?? 0,
      deletionLineIndex: numberField(value, "deletionLineIndex") ?? 0,
    }
  }
  if (value.type === "change") {
    return {
      type: "change",
      deletions: numberField(value, "deletions") ?? 0,
      deletionLineIndex: numberField(value, "deletionLineIndex") ?? 0,
      additions: numberField(value, "additions") ?? 0,
      additionLineIndex: numberField(value, "additionLineIndex") ?? 0,
    }
  }
  return undefined
}

const changeType = (value: Common.JsonValue | undefined): FileDiffMetadata["type"] | undefined => {
  if (
    value === "change" ||
    value === "rename-pure" ||
    value === "rename-changed" ||
    value === "new" ||
    value === "deleted"
  ) {
    return value
  }
  return undefined
}

const stringField = (value: Record<string, Common.JsonValue>, key: string): string | undefined => {
  const field = value[key]
  return typeof field === "string" && field.length > 0 ? field : undefined
}

const numberField = (value: Record<string, Common.JsonValue>, key: string): number | undefined => {
  const field = value[key]
  return typeof field === "number" && Number.isFinite(field) ? field : undefined
}

const booleanField = (value: Record<string, Common.JsonValue>, key: string): boolean | undefined => {
  const field = value[key]
  return typeof field === "boolean" ? field : undefined
}

const arrayField = (
  value: Record<string, Common.JsonValue>,
  key: string,
): ReadonlyArray<Common.JsonValue> | undefined => {
  const field = value[key]
  return Array.isArray(field) ? field : undefined
}

const stringArrayField = (value: Record<string, Common.JsonValue>, key: string): Array<string> =>
  arrayField(value, key)?.filter((item): item is string => typeof item === "string") ?? []

const asHast = (
  value: unknown,
):
  | {
      readonly type?: unknown
      readonly value?: unknown
      readonly properties?: { readonly style?: unknown }
      readonly children?: ReadonlyArray<unknown>
    }
  | undefined => (typeof value === "object" && value !== null ? value : undefined)

const isObject = (value: unknown): value is Record<string, Common.JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

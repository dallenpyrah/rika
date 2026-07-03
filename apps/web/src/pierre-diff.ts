import { Common } from "@rika/schema"
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs"

export interface WebPierreDiff {
  readonly payload_id: string
  readonly file_name: string
  readonly additions: number
  readonly deletions: number
  readonly file_diff: FileDiffMetadata
}

export interface PierreDiffMountInput {
  readonly container: HTMLElement
  readonly file_diff: FileDiffMetadata
  readonly theme_type: "light" | "dark"
  readonly onRenderError: (message: string) => void
}

export interface PierreDiffHandle {
  readonly update: (fileDiff: FileDiffMetadata) => void
  readonly destroy: () => void
}

export const mountPierreDiff = (input: PierreDiffMountInput): PierreDiffHandle => {
  const instance = new FileDiff({
    disableErrorHandling: false,
    diffStyle: "unified",
    overflow: "scroll",
    themeType: input.theme_type,
  })
  render(instance, input.container, input.file_diff, input.onRenderError)
  return {
    update: (fileDiff) => render(instance, input.container, fileDiff, input.onRenderError, true),
    destroy: () => {
      try {
        instance.cleanUp()
      } finally {
        input.container.replaceChildren()
      }
    },
  }
}

export const collectPierreDiffPayloads = (
  value: Common.JsonValue | undefined,
): ReadonlyArray<Record<string, Common.JsonValue>> => {
  if (value === undefined) return []
  const payloads: Array<Record<string, Common.JsonValue>> = []
  collect(value, payloads)
  return payloads
}

export const toWebPierreDiff = (
  payload: Record<string, Common.JsonValue>,
  payloadId: string,
): WebPierreDiff | undefined => {
  const fileDiff = asFileDiffMetadata(payload.file_diff)
  if (fileDiff === undefined) return undefined
  return toWebPierreDiffFromFileDiff(fileDiff, payloadId, payloadFileName(payload))
}

export const toWebPierreDiffFromFileDiff = (
  fileDiff: FileDiffMetadata,
  payloadId: string,
  fileName?: string,
): WebPierreDiff => {
  const stats = diffStats(fileDiff)
  return {
    payload_id: payloadId,
    file_name: fileName ?? fileDiff.name,
    additions: stats.additions,
    deletions: stats.deletions,
    file_diff: fileDiff,
  }
}

export const payloadFileName = (payload: Record<string, Common.JsonValue>): string | undefined => {
  const explicit = stringField(payload, "file_name")
  if (explicit !== undefined) return explicit
  const fileDiff = payload.file_diff
  if (!isObject(fileDiff)) return undefined
  return stringField(fileDiff, "name")
}

export const asFileDiffMetadata = (value: unknown): FileDiffMetadata | undefined => {
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
  const lang = stringField(value, "lang")
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
    ...(lang === undefined ? {} : { lang }),
  }
}

type FileDiffHunk = FileDiffMetadata["hunks"][number]
type FileDiffHunkContent = FileDiffHunk["hunkContent"][number]

const render = (
  instance: FileDiff,
  container: HTMLElement,
  fileDiff: FileDiffMetadata,
  onRenderError: (message: string) => void,
  forceRender = false,
): void => {
  try {
    instance.render({ containerWrapper: container, fileDiff, forceRender })
  } catch (cause) {
    onRenderError(errorMessage(cause))
  }
}

const collect = (value: Common.JsonValue, payloads: Array<Record<string, Common.JsonValue>>): void => {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, payloads)
    return
  }
  if (!isObject(value)) return
  if (isPierreDiffPayload(value)) {
    payloads.push(value)
    return
  }
  for (const item of Object.values(value)) collect(item, payloads)
}

const isPierreDiffPayload = (value: Record<string, Common.JsonValue>): boolean =>
  value.kind === "diff" && value.renderer === "@pierre/diffs" && value.file_diff !== undefined

const diffStats = (fileDiff: FileDiffMetadata): { readonly additions: number; readonly deletions: number } => {
  let additions = 0
  let deletions = 0
  for (const hunk of fileDiff.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type === "change") {
        additions += content.additions
        deletions += content.deletions
      }
    }
  }
  return { additions, deletions }
}

const asHunk = (value: unknown): FileDiffHunk | undefined => {
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

const asHunkContent = (value: unknown): FileDiffHunkContent | undefined => {
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

const changeType = (value: unknown): FileDiffMetadata["type"] | undefined => {
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

const stringField = (value: Record<string, unknown>, key: string): string | undefined => {
  const field = value[key]
  return typeof field === "string" && field.length > 0 ? field : undefined
}

const numberField = (value: Record<string, unknown>, key: string): number | undefined => {
  const field = value[key]
  return typeof field === "number" && Number.isFinite(field) ? field : undefined
}

const booleanField = (value: Record<string, unknown>, key: string): boolean | undefined => {
  const field = value[key]
  return typeof field === "boolean" ? field : undefined
}

const arrayField = (value: Record<string, unknown>, key: string): ReadonlyArray<unknown> | undefined => {
  const field = value[key]
  return Array.isArray(field) ? field : undefined
}

const stringArrayField = (value: Record<string, unknown>, key: string): Array<string> =>
  arrayField(value, key)?.filter((item): item is string => typeof item === "string") ?? []

const isObject = (value: unknown): value is Record<string, Common.JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

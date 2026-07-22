import { Function } from "effect"
import stringWidth from "string-width"
import { displayInput } from "./composer"
import { idle, isReady, Mode, type Model } from "./model"

const clampSidebarWidth = (width: number, terminalWidth: number): number =>
  Math.max(24, Math.min(width, Math.max(24, terminalWidth - 40)))

export const initial: {
  (workspace: string, mode?: Mode): Model
  (mode?: Mode): (workspace: string) => Model
} = Function.dual(
  (args) => args.length > 1 || !Mode.literals.includes(args[0]),
  (workspace: string, mode: Mode = "medium"): Model => ({
    workspace,
    mode,
    entries: [],
    blocks: [],
    items: [],
    input: "",
    cursor: 0,
    pastedText: [],
    history: [],
    historyComposers: [],
    historySearch: "",
    busy: false,
    paletteOpen: false,
    palette: { open: false, query: "", selected: 0 },
    modePicker: { open: false, selected: 0 },
    filePicker: { open: false, query: "", selected: 0, items: idle },
    threadSwitcher: { open: false, query: "", selected: 0, kind: "switch", previewScroll: 0 },
    shortcutsOpen: false,
    shortcutsTrigger: undefined,
    composerHeight: 5,
    width: 80,
    height: 24,
    scrollOffset: 0,
    scrollFollow: true,
    threads: [],
    workspaceFilesOpen: false,
    threadSidebar: { open: false, focused: false, selected: 0, scrollTop: 0 },
    permissionSelection: 0,
    queueSelection: undefined,
    queue: [],
    expandedRowKeys: [],
    seenEventIds: [],
    seenExecutionEventKeys: [],
    childExecutionOutcomes: {},
    activeTurnId: undefined,
    fastMode: false,
    changedFilesOpen: false,
    changedFiles: idle,
    sidebarWidth: 36,
    threadLoading: false,
    threadPreview: idle,
  }),
)

export const isNarrow = (model: Model): boolean => model.width < 60

export const threadSidebarWidth = 36

export const boundedThreadSidebarWidth = (terminalWidth: number): number =>
  Math.min(threadSidebarWidth, Math.max(8, terminalWidth - 24))

export const threadSidebarLayoutWidth = (model: Model): number =>
  model.threadSidebar.open ? boundedThreadSidebarWidth(model.width) : 0

export const fileSidebarLayoutWidth = (model: Model): number => {
  const visible =
    !isNarrow(model) &&
    ((model.changedFilesOpen && isReady(model.changedFiles)) ||
      (model.workspaceFilesOpen && isReady(model.filePicker.items)))
  return visible ? Math.max(0, Math.min(model.sidebarWidth, model.width - threadSidebarLayoutWidth(model) - 4)) : 0
}

export const contentColumnWidth = (model: Model): number =>
  Math.max(1, model.width - fileSidebarLayoutWidth(model) - threadSidebarLayoutWidth(model))

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

const wrappedRowsForLine = (text: string, width: number): number => {
  if (width <= 0) return 1
  let rows = 1
  let column = 0
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const cells = stringWidth(segment)
    if (cells === 0) continue
    if (column + cells > width) {
      rows += 1
      column = cells
    } else column += cells
  }
  return rows
}

export const wrappedRowCount: {
  (text: string, width: number): number
  (width: number): (text: string) => number
} = Function.dual(2, (text: string, width: number): number =>
  text.split("\n").reduce((rows, line) => rows + wrappedRowsForLine(line, width), 0),
)

export const queueContentWidth = (model: Model): number => Math.max(1, contentColumnWidth(model) - 6)

export const inputRows = (model: Model): number =>
  Math.min(8, Math.max(1, wrappedRowCount(displayInput(model), Math.max(1, contentColumnWidth(model) - 4))))

export const composerHeightLimit = (terminalHeight: number): number =>
  Math.max(1, Math.min(5, terminalHeight), terminalHeight - 4)

export const composerHeight = (model: Model): number =>
  Math.min(composerHeightLimit(model.height), Math.max(5, model.composerHeight, inputRows(model) + 2))

export const internal = { clampSidebarWidth }

import {
  BoxRenderable,
  EditBufferRenderable,
  ScrollBarRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
  CliRenderEvents,
  RGBA,
  StyledText,
  type KeyEvent,
  type MouseEvent,
  type PasteEvent,
  SystemClock,
  type Clock as OpenTuiClock,
  type TimerHandle,
} from "@opentui/core"
import type { Fiber } from "effect"
import type { Key } from "../keys"
import { boundedThreadSidebarWidth, type Model } from "../view-state"
import { pinnedRowWindow, type PathTarget, type RowWindowState } from "../transcript-presenter"
import type { Handlers, SurfaceOptions } from "./contracts"
import { colors, spacing } from "../theme"
import { ToolSpinner, type ChangedFileRow } from "./rendering"

const typingCursorStyle = { style: "block", blinking: true } as const

export const cutoutBackground = (renderer: CliRenderer): RGBA => {
  const background: unknown = Reflect.get(renderer, "backgroundColor")
  return background instanceof RGBA && background.a > 0 ? RGBA.defaultBackground(background) : RGBA.defaultBackground()
}

export class SidebarScrollBoxRenderable extends ScrollBoxRenderable {
  onWindowChanged: (() => void) | undefined
  private virtualHeight = 0

  override get scrollHeight(): number {
    return this.virtualHeight
  }

  override get scrollTop(): number {
    return super.scrollTop
  }

  override set scrollTop(value: number) {
    this.applyVirtualGeometry()
    super.scrollTop = value
    this.content.translateY = 0
    this.onWindowChanged?.()
  }

  setVirtualHeight(value: number): void {
    const height = Math.max(0, Math.floor(value))
    this.virtualHeight = height
    if (this.applyVirtualGeometry()) this.onWindowChanged?.()
  }

  syncVirtualScroll(): void {
    if (this.applyVirtualGeometry()) this.onWindowChanged?.()
  }

  override render(...args: Parameters<ScrollBoxRenderable["render"]>): void {
    this.applyVirtualGeometry()
    super.render(...args)
  }

  private applyVirtualGeometry(): boolean {
    const previousTop = super.scrollTop
    this.verticalScrollBar.viewportSize = this.viewport.height
    this.verticalScrollBar.scrollSize = Math.max(this.virtualHeight, this.viewport.height)
    this.verticalScrollBar.scrollPosition = Math.min(
      previousTop,
      Math.max(0, this.virtualHeight - this.viewport.height),
    )
    this.content.translateY = 0
    return super.scrollTop !== previousTop
  }
}

export class ProjectedEditorRenderable extends EditBufferRenderable {
  sync(text: string, cursor: number): void {
    if (this.plainText !== text) this.setText(text)
    this.cursorOffset = Math.max(0, Math.min(text.length, cursor))
  }
}

export interface TranscriptRangeBundle {
  readonly key: string
  readonly descriptors: ReadonlyArray<TranscriptRenderableDescriptor>
}
export interface TranscriptUnitCacheEntry {
  readonly revision: string
  readonly bundles: ReadonlyArray<TranscriptRangeBundle>
}
export interface TranscriptRenderableRecord {
  readonly key: string
  revision: string
  readonly renderable: TextRenderable
  spinnerChunk?: number
}
export interface TranscriptRenderableDescriptor {
  readonly key: string
  readonly revision: string
  readonly content: StyledText
  readonly selectable?: boolean
  readonly spinnerChunk?: number
  readonly targets?: ReadonlyArray<PathTarget>
  readonly onMouseDown?: TextRenderable["onMouseDown"]
}
export interface TranscriptRenderInput {
  readonly entries: Model["entries"]
  readonly blocks: Model["blocks"]
  readonly items: Model["items"]
  readonly expandedRowKeys: Model["expandedRowKeys"]
  readonly detailSelection: Model["detailSelection"]
  readonly permissionSelection: number
  readonly width: number
  readonly windowEnd: number
  readonly rowWindowEnd: number
}

export interface SurfaceTargetCallbacks {
  readonly onTranscriptWheel: (event: MouseEvent) => void
  readonly onTranscriptScrollbarChange: (position: number) => void
  readonly onThreadSidebarMouseDown: TextRenderable["onMouseDown"]
  readonly onChangedFilesScroll: NonNullable<ScrollBoxRenderable["onMouseScroll"]>
  readonly onChangedFilesWindow: () => void
  readonly onChangedFilesScrollbarChange: () => void
  readonly onChangedFilesMouseDown: TextRenderable["onMouseDown"]
  readonly onChangedFilesMouseHover: (event: MouseEvent) => void
  readonly onChangedFilesMouseOut: () => void
  readonly onComposerMouseDown: BoxRenderable["onMouseDown"]
  readonly onComposerMouseMove: BoxRenderable["onMouseMove"]
  readonly onComposerMouseOut: BoxRenderable["onMouseOut"]
  readonly onRootMouseDrag: BoxRenderable["onMouseDrag"]
  readonly onRootMouseUp: BoxRenderable["onMouseUp"]
  readonly onSidebarMouseDown: ScrollBoxRenderable["onMouseDown"]
  readonly onSidebarMouseMove: ScrollBoxRenderable["onMouseMove"]
  readonly onSidebarMouseOut: ScrollBoxRenderable["onMouseOut"]
  readonly onPaletteScroll: BoxRenderable["onMouseScroll"]
  readonly onKey: (key: KeyEvent) => void
  readonly onPaste: (event: PasteEvent) => void
  readonly onResize: (width: number, height: number) => void
  readonly onSelection: (selection: { getSelectedText: () => string }) => void
  readonly recordRenderedTranscriptScroll: () => void
}

export interface SurfaceTarget {
  junkBuffer: Array<Key>
  junkTimer: Fiber.Fiber<void> | undefined
  welcomePhase: number
  welcomeChild: TextRenderable | undefined
  welcomeKey: string
  welcomeTimer: Fiber.Fiber<void> | undefined
  toastTimer: Fiber.Fiber<void> | undefined
  lastPaste: { readonly text: string; readonly at: number } | undefined
  model: Model | undefined
  transcriptChildren: Array<TextRenderable>
  transcriptRecords: Map<string, TranscriptRenderableRecord>
  transcriptUnitCache: Map<string, TranscriptUnitCacheEntry>
  transcriptRenderInput: TranscriptRenderInput | undefined
  composerDrag: { readonly startY: number; readonly startHeight: number } | undefined
  sidebarDrag: { readonly startX: number; readonly startWidth: number } | undefined
  pointerShape: string
  changedRows: ReadonlyArray<ChangedFileRow>
  changedFilesHoveredRow: number | undefined
  sidebarRowsSource: unknown
  sidebarRowsView: "changed" | "workspace" | undefined
  sidebarRowsWidth: number
  sidebarWindowStart: number
  sidebarWindowEnd: number
  sidebarWindowHoveredRow: number | undefined
  sidebarLayoutFrame: (() => void) | undefined
  scrollProgrammatic: boolean
  scrollFramePending: boolean
  wheelTimer: TimerHandle | undefined
  wheelDirection: "up" | "down" | undefined
  wheelScrollBy: number
  userScrollDetached: boolean
  loaderPhase: number
  loaderTimer: TimerHandle | undefined
  clock: OpenTuiClock
  toolSpinner: ToolSpinner
  transcriptViewportRows: number
  renderedTranscriptScrollTop: number
  transcriptWindowEnd: number
  transcriptRowWindow: RowWindowState
  transcriptRowTotal: number
  transcriptWindowThread: string | undefined
  transcriptAnchorFrame: (() => void) | undefined
  transcriptAnchorScrollBy: number
  transcriptAnchorNearBottom: boolean
  pendingTranscriptAnchor:
    | {
        readonly anchor: { readonly key: string; readonly screenY: number } | undefined
        readonly threadId: string | undefined
        readonly scrollHeight: number
        readonly scrollBy: number
        readonly nearBottom: boolean
      }
    | undefined
  scrollbarSyncing: boolean
  scrollGeneration: number
  destroyed: boolean
  focusedEditor: ProjectedEditorRenderable | undefined
  cursorRestoreFrame: (() => void) | undefined
  main: BoxRenderable
  contentColumn: BoxRenderable
  transcriptRow: BoxRenderable
  transcriptScroll: ScrollBoxRenderable
  transcriptScrollbar: ScrollBarRenderable
  input: TextRenderable
  composerEditor: ProjectedEditorRenderable
  inputBox: BoxRenderable
  queueBox: BoxRenderable
  queueText: TextRenderable
  queueHint: TextRenderable
  queueLeftJoint: TextRenderable
  queueRightJoint: TextRenderable
  modeLabel: TextRenderable
  workspaceLabel: TextRenderable
  paletteBox: BoxRenderable
  palette: TextRenderable
  overlayEditor: ProjectedEditorRenderable
  sidebar: TextRenderable
  changedFilesBox: SidebarScrollBoxRenderable
  changedFilesText: TextRenderable
  statusLabel: TextRenderable
  toastBox: BoxRenderable
  toast: TextRenderable
}

const makeSurfaceTarget = (
  renderer: CliRenderer,
  handlers: Handlers,
  options: SurfaceOptions,
  callbacks: SurfaceTargetCallbacks,
): SurfaceTarget => {
  void handlers
  const target = {} as SurfaceTarget
  target.junkBuffer = []
  target.junkTimer = undefined

  target.welcomePhase = 0
  target.welcomeChild = undefined
  target.welcomeKey = ""
  target.welcomeTimer = undefined
  target.toastTimer = undefined
  target.lastPaste = undefined
  target.model = undefined
  target.transcriptChildren = []
  target.transcriptRecords = new Map()
  target.transcriptUnitCache = new Map()
  target.transcriptRenderInput = undefined
  target.composerDrag = undefined
  target.sidebarDrag = undefined
  target.pointerShape = "default"
  target.changedRows = []
  target.changedFilesHoveredRow = undefined
  target.sidebarRowsSource = undefined
  target.sidebarRowsView = undefined
  target.sidebarRowsWidth = 0
  target.sidebarWindowStart = -1
  target.sidebarWindowEnd = -1
  target.sidebarWindowHoveredRow = undefined
  target.sidebarLayoutFrame = undefined
  target.scrollProgrammatic = false
  target.scrollFramePending = false
  target.wheelTimer = undefined
  target.wheelDirection = undefined
  target.wheelScrollBy = 0
  target.userScrollDetached = false
  target.loaderPhase = 0
  target.loaderTimer = undefined
  target.clock = options.clock ?? new SystemClock()
  target.toolSpinner = new ToolSpinner()
  target.transcriptViewportRows = 0
  target.renderedTranscriptScrollTop = 0
  target.transcriptWindowEnd = 0
  target.transcriptRowWindow = pinnedRowWindow
  target.transcriptRowTotal = 0
  target.transcriptWindowThread = undefined
  target.transcriptAnchorFrame = undefined
  target.transcriptAnchorScrollBy = 0
  target.transcriptAnchorNearBottom = false
  target.pendingTranscriptAnchor = undefined
  target.scrollbarSyncing = false
  target.scrollGeneration = 0
  target.destroyed = false
  target.focusedEditor = undefined
  target.cursorRestoreFrame = undefined

  target.main = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "row" })
  target.contentColumn = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "column" })
  target.transcriptRow = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "row" })
  const transcriptBackground = cutoutBackground(renderer)
  target.transcriptScroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    scrollY: true,
    stickyScroll: true,
    stickyStart: "bottom",
    viewportCulling: true,
    verticalScrollbarOptions: { visible: false },
    rootOptions: { backgroundColor: transcriptBackground },
    wrapperOptions: { backgroundColor: transcriptBackground },
    viewportOptions: { backgroundColor: transcriptBackground },
    contentOptions: {
      flexDirection: "column",
      justifyContent: "flex-end",
      backgroundColor: transcriptBackground,
      paddingTop: spacing.transcript,
      paddingBottom: 0,
      paddingLeft: spacing.transcript,
      paddingRight: spacing.transcript + 1,
    },
    onMouseScroll: callbacks.onTranscriptWheel,
  })
  target.transcriptScroll.verticalScrollBar.visible = false
  target.transcriptScrollbar = new ScrollBarRenderable(renderer, {
    orientation: "vertical",
    showArrows: false,
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    width: 1,
    visible: false,
    trackOptions: { foregroundColor: colors.text, backgroundColor: colors.muted },
    onChange: callbacks.onTranscriptScrollbarChange,
  })
  target.queueBox = new BoxRenderable(renderer, {
    border: true,
    borderStyle: "rounded",
    borderColor: colors.text,
    focusedBorderColor: colors.text,
    minHeight: 3,
    paddingLeft: spacing.inputHorizontal,
    paddingRight: spacing.inputHorizontal,
    marginLeft: 1,
    marginRight: 1,
    marginBottom: -1,
    flexShrink: 0,
    visible: false,
  })
  target.queueText = new TextRenderable(renderer, { content: "", wrapMode: "word", selectable: false })
  target.queueHint = new TextRenderable(renderer, {
    content: "",
    position: "absolute",
    top: 0,
    right: 1,
    zIndex: 10,
    selectable: false,
  })
  target.queueBox.add(target.queueText)
  target.queueBox.add(target.queueHint)
  target.queueLeftJoint = new TextRenderable(renderer, {
    content: "┴",
    position: "absolute",
    left: 1,
    top: 0,
    zIndex: 40,
    fg: colors.text,
    visible: false,
    selectable: false,
  })
  target.queueRightJoint = new TextRenderable(renderer, {
    content: "┴",
    position: "absolute",
    right: 1,
    top: 0,
    zIndex: 40,
    fg: colors.text,
    visible: false,
    selectable: false,
  })
  target.inputBox = new BoxRenderable(renderer, {
    border: true,
    borderStyle: "rounded",
    borderColor: colors.text,
    focusedBorderColor: colors.text,
    minHeight: spacing.inputHeight,
    paddingLeft: spacing.inputHorizontal,
    paddingRight: spacing.inputHorizontal,
    flexShrink: 0,
    overflow: "hidden",
  })
  target.input = new TextRenderable(renderer, { content: "", fg: colors.text, wrapMode: "word", visible: false })
  target.composerEditor = new ProjectedEditorRenderable(renderer, {
    height: 1,
    textColor: colors.text,
    backgroundColor: "transparent",
    selectable: false,
    wrapMode: "word",
    showCursor: true,
    cursorColor: colors.text,
    cursorStyle: typingCursorStyle,
  })
  target.modeLabel = new TextRenderable(renderer, {
    content: "",
    position: "absolute",
    top: 0,
    right: 2,
    zIndex: 30,
    selectable: false,
  })
  target.workspaceLabel = new TextRenderable(renderer, {
    content: "",
    position: "absolute",
    bottom: 0,
    right: 2,
    zIndex: 10,
    selectable: false,
  })
  target.statusLabel = new TextRenderable(renderer, {
    content: "",
    position: "absolute",
    bottom: 0,
    left: 1,
    zIndex: 30,
    selectable: false,
  })
  target.toastBox = new BoxRenderable(renderer, {
    visible: false,
    position: "absolute",
    top: 1,
    right: 2,
    height: 3,
    zIndex: 40,
    border: true,
    borderStyle: "rounded",
    borderColor: colors.green,
    focusedBorderColor: colors.green,
    backgroundColor: colors.surface,
    paddingLeft: 1,
    paddingRight: 1,
    overflow: "hidden",
  })
  target.toast = new TextRenderable(renderer, { content: "", fg: colors.text })
  target.toastBox.add(target.toast)
  target.paletteBox = new BoxRenderable(renderer, {
    visible: false,
    position: "absolute",
    width: 76,
    height: spacing.overlayHeight,
    top: spacing.overlayTop,
    left: 2,
    zIndex: 20,
    border: true,
    borderStyle: "rounded",
    borderColor: colors.text,
    focusedBorderColor: colors.text,
    backgroundColor: colors.surface,
    paddingLeft: 1,
    paddingRight: 1,
    overflow: "hidden",
  })
  target.palette = new TextRenderable(renderer, { content: "", fg: colors.text, wrapMode: "word" })
  target.overlayEditor = new ProjectedEditorRenderable(renderer, {
    visible: false,
    position: "absolute",
    left: 1,
    top: 0,
    width: 1,
    height: 1,
    zIndex: 1,
    textColor: colors.text,
    backgroundColor: "transparent",
    selectable: false,
    wrapMode: "none",
    showCursor: true,
    cursorColor: colors.text,
    cursorStyle: typingCursorStyle,
  })
  target.sidebar = new TextRenderable(renderer, {
    content: "",
    width: boundedThreadSidebarWidth(renderer.terminalWidth),
    flexShrink: 0,
    visible: false,
    fg: colors.text,
    wrapMode: "none",
    selectable: false,
  })
  target.sidebar.onMouseDown = callbacks.onThreadSidebarMouseDown
  target.changedFilesBox = new SidebarScrollBoxRenderable(renderer, {
    visible: false,
    width: 34,
    flexShrink: 0,
    border: true,
    borderStyle: "rounded",
    borderColor: colors.text,
    focusedBorderColor: colors.text,
    paddingLeft: 1,
    paddingRight: 1,
    scrollY: true,
    viewportCulling: true,
    verticalScrollbarOptions: { marginRight: 1 },
    onMouseScroll: callbacks.onChangedFilesScroll,
  })
  target.changedFilesBox.onWindowChanged = callbacks.onChangedFilesWindow
  target.changedFilesText = new TextRenderable(renderer, {
    content: "",
    fg: colors.text,
    selectable: false,
    wrapMode: "none",
  })
  target.changedFilesBox.add(target.changedFilesText)
  target.changedFilesBox.verticalScrollBar.on?.("change", callbacks.onChangedFilesScrollbarChange)
  target.changedFilesText.onMouseDown = callbacks.onChangedFilesMouseDown
  target.changedFilesText.onMouseOver = callbacks.onChangedFilesMouseHover
  target.changedFilesText.onMouseMove = callbacks.onChangedFilesMouseHover
  target.changedFilesText.onMouseOut = callbacks.onChangedFilesMouseOut
  target.inputBox.onMouseDown = callbacks.onComposerMouseDown
  target.inputBox.onMouseOver = callbacks.onComposerMouseMove
  target.inputBox.onMouseMove = callbacks.onComposerMouseMove
  target.inputBox.onMouseOut = callbacks.onComposerMouseOut
  renderer.root.onMouseDrag = callbacks.onRootMouseDrag
  renderer.root.onMouseUp = callbacks.onRootMouseUp
  renderer.root.onMouseDragEnd = callbacks.onRootMouseUp
  target.changedFilesBox.onMouseDown = callbacks.onSidebarMouseDown
  target.changedFilesBox.onMouseOver = callbacks.onSidebarMouseMove
  target.changedFilesBox.onMouseMove = callbacks.onSidebarMouseMove
  target.changedFilesBox.onMouseOut = callbacks.onSidebarMouseOut
  target.inputBox.add(target.input)
  target.inputBox.add(target.composerEditor)
  target.paletteBox.add(target.palette)
  target.paletteBox.add(target.overlayEditor)
  target.transcriptRow.add(target.transcriptScroll)
  target.transcriptRow.add(target.transcriptScrollbar)
  target.contentColumn.add(target.transcriptRow)
  target.contentColumn.add(target.queueBox)
  target.contentColumn.add(target.inputBox)
  target.contentColumn.add(target.queueLeftJoint)
  target.contentColumn.add(target.queueRightJoint)
  target.main.add(target.sidebar)
  target.main.add(target.contentColumn)
  target.main.add(target.changedFilesBox)
  renderer.root.add(target.main)
  renderer.root.add(target.modeLabel)
  renderer.root.add(target.statusLabel)
  renderer.root.add(target.workspaceLabel)
  renderer.root.add(target.paletteBox)
  renderer.root.add(target.toastBox)
  target.paletteBox.onMouseScroll = callbacks.onPaletteScroll
  renderer.keyInput.on("keypress", callbacks.onKey)
  renderer.keyInput.on("paste", callbacks.onPaste)
  renderer.on(CliRenderEvents.RESIZE, callbacks.onResize)
  renderer.on(CliRenderEvents.SELECTION, callbacks.onSelection)
  renderer.on(CliRenderEvents.FRAME, callbacks.recordRenderedTranscriptScroll)
  return target
}

export const internal = { makeSurfaceTarget }

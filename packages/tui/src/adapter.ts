import {
  BoxRenderable,
  ScrollBarRenderable,
  ScrollBoxRenderable,
  type CliRenderer,
  CliRenderEvents,
  TextRenderable,
  createCliRenderer,
  dim,
  fg,
  StyledText,
} from "@opentui/core"
import type { ColorInput, KeyEvent, MouseEvent, PasteEvent } from "@opentui/core"
import { Effect, Fiber, Schedule } from "effect"
import stringWidth from "string-width"
import { contentColumnWidth, formatActivity, type Model } from "./view-state"
import { colors, spacing } from "./theme"

export {
  spinnerFrames,
  statusSpinnerFrames,
  spinnerInterval,
  idleSpinnerFrame,
  ToolSpinner,
  loaderFrame,
  renderBlock,
  renderSidebar,
  renderChangedFiles,
  renderTranscript,
} from "./adapter/rendering"
export { AdapterError } from "./adapter/rendering"
export { maxMountedTranscriptEntries, boundedTranscriptModel, type UnitLineRange } from "./adapter/transcript-model"
export { maxMountedTranscriptRows } from "./transcript-presenter"
export { clipStyledLine, previewBoxRows } from "./adapter/thread-switcher"
export { buildTranscript, renderTranscriptStyled } from "./adapter/transcript-renderer"
import {
  ToolSpinner,
  spinnerFrames,
  spinnerInterval,
  idleSpinnerFrame,
  loaderFrame,
  renderSidebar,
  renderChangedFiles,
  sidebarInnerWidth,
  adapterError,
} from "./adapter/rendering"
import { internal as InternalRendering } from "./adapter/rendering"
import { panelLoading } from "./adapter/welcome"
import {
  ProjectedEditorRenderable,
  SidebarScrollBoxRenderable,
  type SurfaceTarget,
  type SurfaceTargetCallbacks,
} from "./adapter/surface-target"
import { internal as InternalSurfaceTarget } from "./adapter/surface-target"
import { type SurfaceInputBundle } from "./adapter/surface-input"
import { internal as InternalSurfaceInput } from "./adapter/surface-input"
import { type SurfaceTranscriptBundle } from "./adapter/surface-transcript"
import { internal as InternalSurfaceTranscript } from "./adapter/surface-transcript"
import { type SurfaceUpdateDependencies } from "./adapter/surface-update"
import { internal as InternalSurfaceUpdate } from "./adapter/surface-update"
import type { Handlers, SurfaceOptions } from "./adapter/contracts"

export type { Handlers, SurfaceOptions } from "./adapter/contracts"

export class Surface {
  private readonly target: SurfaceTarget
  private readonly surfaceTranscript: SurfaceTranscriptBundle
  private readonly surfaceInput: SurfaceInputBundle
  private readonly surfaceUpdateDependencies: SurfaceUpdateDependencies
  private get transcriptChildren() {
    return this.target.transcriptChildren
  }
  private get transcriptRecords() {
    return this.target.transcriptRecords
  }
  private get transcriptWindowEnd() {
    return this.target.transcriptWindowEnd
  }
  private get transcriptRowWindow() {
    return this.target.transcriptRowWindow
  }
  private get transcriptAnchorScrollBy() {
    return this.target.transcriptAnchorScrollBy
  }
  private get pendingTranscriptAnchor() {
    return this.target.pendingTranscriptAnchor
  }
  private get changedRows() {
    return this.target.changedRows
  }
  get main(): BoxRenderable {
    return this.target.main
  }
  get contentColumn(): BoxRenderable {
    return this.target.contentColumn
  }
  get transcriptRow(): BoxRenderable {
    return this.target.transcriptRow
  }
  get transcriptScroll(): ScrollBoxRenderable {
    return this.target.transcriptScroll
  }
  get transcriptScrollbar(): ScrollBarRenderable {
    return this.target.transcriptScrollbar
  }
  get input(): TextRenderable {
    return this.target.input
  }
  get composerEditor(): ProjectedEditorRenderable {
    return this.target.composerEditor
  }
  get inputBox(): BoxRenderable {
    return this.target.inputBox
  }
  get queueBox(): BoxRenderable {
    return this.target.queueBox
  }
  get queueText(): TextRenderable {
    return this.target.queueText
  }
  get queueHint(): TextRenderable {
    return this.target.queueHint
  }
  get queueLeftJoint(): TextRenderable {
    return this.target.queueLeftJoint
  }
  get queueRightJoint(): TextRenderable {
    return this.target.queueRightJoint
  }
  get modeLabel(): TextRenderable {
    return this.target.modeLabel
  }
  get workspaceLabel(): TextRenderable {
    return this.target.workspaceLabel
  }
  get paletteBox(): BoxRenderable {
    return this.target.paletteBox
  }
  get palette(): TextRenderable {
    return this.target.palette
  }
  get overlayEditor(): ProjectedEditorRenderable {
    return this.target.overlayEditor
  }
  get sidebar(): TextRenderable {
    return this.target.sidebar
  }
  get changedFilesBox(): SidebarScrollBoxRenderable {
    return this.target.changedFilesBox
  }
  get changedFilesText(): TextRenderable {
    return this.target.changedFilesText
  }
  get statusLabel(): TextRenderable {
    return this.target.statusLabel
  }
  get toastBox(): BoxRenderable {
    return this.target.toastBox
  }
  get toast(): TextRenderable {
    return this.target.toast
  }
  private readonly recordRenderedTranscriptScroll = () => {
    this.target.renderedTranscriptScrollTop = this.transcriptScroll.scrollTop
  }

  private get surfaceTargetCallbacks(): SurfaceTargetCallbacks {
    return {
      onTranscriptWheel: this.handleTranscriptWheel,
      onTranscriptScrollbarChange: this.onTranscriptScrollbarChange,
      onThreadSidebarMouseDown: this.onThreadSidebarMouseDown,
      onChangedFilesScroll: this.onChangedFilesScroll,
      onChangedFilesWindow: this.onChangedFilesWindow,
      onChangedFilesScrollbarChange: this.onChangedFilesScrollbarChange,
      onChangedFilesMouseDown: this.onChangedFilesMouseDown,
      onChangedFilesMouseHover: this.onChangedFilesMouseHover,
      onChangedFilesMouseOut: this.onChangedFilesMouseOut,
      onComposerMouseDown: this.onComposerMouseDown,
      onComposerMouseMove: this.onComposerMouseMove,
      onComposerMouseOut: this.onComposerMouseOut,
      onRootMouseDrag: this.onRootMouseDrag,
      onRootMouseUp: this.onRootMouseUp,
      onSidebarMouseDown: this.onSidebarMouseDown,
      onSidebarMouseMove: this.onSidebarMouseMove,
      onSidebarMouseOut: this.onSidebarMouseOut,
      onPaletteScroll: this.onPaletteScroll,
      onKey: this.onKey,
      onPaste: this.onPaste,
      onResize: this.onResize,
      onSelection: this.onSelection,
      recordRenderedTranscriptScroll: this.recordRenderedTranscriptScroll,
    }
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly handlers: Handlers,
    private readonly options: SurfaceOptions = {},
  ) {
    this.target = InternalSurfaceTarget.makeSurfaceTarget(renderer, handlers, options, this.surfaceTargetCallbacks)
    this.surfaceTranscript = InternalSurfaceTranscript.createSurfaceTranscript(this.target, renderer, handlers, {
      update: (preserveAnchor) => {
        if (this.target.model !== undefined) this.update(this.target.model, preserveAnchor)
      },
      defer: (action) => this.defer(action),
      restoreFocusedCursor: () => this.restoreFocusedCursor(),
    })
    this.surfaceUpdateDependencies = {
      target: this.target,
      renderer: this.renderer,
      handlers: this.handlers,
      options: this.options,
      callbacks: {
        captureTranscriptAnchor: this.surfaceTranscript.captureTranscriptAnchor,
        buildTranscriptUnitBundles: this.surfaceTranscript.buildTranscriptUnitBundles,
        setWelcomeChild: this.surfaceTranscript.setWelcomeChild,
        transcriptChanged: this.surfaceTranscript.transcriptChanged,
        reconcileTranscript: this.surfaceTranscript.reconcileTranscript,
        welcomeWidthFor: (current) => this.welcomeWidthFor(current),
        repeated: (duration, action) => this.repeated(duration, action),
        cancelTimer: (timer) => this.cancelTimer(timer),
        refreshSidebarRows: (current) => this.refreshSidebarRows(current),
        refreshSidebarAfterLayout: () => this.refreshSidebarAfterLayout(),
        anchorTranscriptAfterLayout: this.surfaceTranscript.anchorTranscriptAfterLayout,
        clampTranscriptScrollTop: this.surfaceTranscript.clampTranscriptScrollTop,
        syncTranscriptScrollbar: this.surfaceTranscript.syncTranscriptScrollbar,
        reportTranscriptScroll: this.reportTranscriptScroll,
        followTranscriptAfterLayout: this.surfaceTranscript.followTranscriptAfterLayout,
        tickLoader: () => this.tickLoader(),
        setPointerShape: (shape) => this.setPointerShape(shape),
        syncOverlayEditor: (text, cursor, top, height, width) =>
          this.syncOverlayEditor(text, cursor, top, height, width),
        focusEditor: (editor) => this.focusEditor(editor),
      },
    }
    this.surfaceInput = InternalSurfaceInput.createSurfaceInput(this.target, renderer, handlers, options, {
      atMountedTranscriptBottom: this.surfaceTranscript.atMountedTranscriptBottom,
      atTranscriptBottom: this.surfaceTranscript.atTranscriptBottom,
      queuePendingTranscriptScroll: this.surfaceTranscript.queuePendingTranscriptScroll,
      shiftTranscriptWindow: this.surfaceTranscript.shiftTranscriptWindow,
      reportTranscriptScroll: this.reportTranscriptScroll,
      refreshSidebarRows: () => {
        if (this.target.model !== undefined) this.refreshSidebarRows(this.target.model)
      },
      cancelTimer: (timer) => this.cancelTimer(timer),
      delayed: (duration, action) => this.delayed(duration, action),
    })
  }

  private readonly onTranscriptScrollbarChange = (position: number) => {
    if (this.target.scrollbarSyncing || this.target.destroyed) return
    this.transcriptScroll.scrollTop = position
    if (!this.surfaceTranscript.atTranscriptBottom() && this.target.model?.scrollFollow === true) {
      this.target.userScrollDetached = true
      this.transcriptScroll.stickyScroll = false
    }
    this.surfaceTranscript.queueTranscriptScroll(() => this.reportTranscriptScroll())
  }
  private readonly onThreadSidebarMouseDown: TextRenderable["onMouseDown"] = (event) => {
    if (event.button !== 0) return
    const index = (this.target.model?.threadSidebar.scrollTop ?? 0) + Math.floor(event.y - this.sidebar.screenY)
    if (index < 0 || index >= (this.target.model?.threads.length ?? 0)) return
    event.stopPropagation()
    this.handlers.threadSidebarSelect?.(index)
  }
  private readonly onChangedFilesScroll = () => this.defer(() => this.refreshSidebarWindow())
  private readonly onChangedFilesWindow = () => {
    this.refreshSidebarWindow()
  }
  private readonly onChangedFilesScrollbarChange = () => {
    this.changedFilesBox.syncVirtualScroll()
    this.refreshSidebarWindow()
  }
  private readonly onChangedFilesMouseDown: TextRenderable["onMouseDown"] = (event) => {
    if (event.button !== 0) return
    const row = this.target.sidebarWindowStart + Math.floor(event.y - this.changedFilesText.screenY)
    const file = this.target.changedRows[row]?.file
    if (file === undefined) return
    event.stopPropagation()
    this.handlers.openPath?.({ path: file.path })
  }
  private readonly onChangedFilesMouseHover = (event: MouseEvent) => {
    const row = this.target.sidebarWindowStart + Math.floor(event.y - this.changedFilesText.screenY)
    const hoveredRow = this.target.changedRows[row]?.file === undefined ? undefined : row
    if (hoveredRow === this.target.changedFilesHoveredRow) return
    this.target.changedFilesHoveredRow = hoveredRow
    this.refreshSidebarWindow(true)
    this.renderer.setMousePointer(hoveredRow === undefined ? "default" : "pointer")
    this.renderer.requestRender()
  }
  private readonly onChangedFilesMouseOut = () => {
    if (this.target.changedFilesHoveredRow === undefined) return
    this.target.changedFilesHoveredRow = undefined
    this.refreshSidebarWindow(true)
    this.renderer.setMousePointer("default")
    this.renderer.requestRender()
  }
  private readonly onPaletteScroll = (event: MouseEvent) => {
    if (this.target.model?.threadSwitcher.open !== true || event.scroll === undefined) return
    event.stopPropagation()
    this.handlers.threadPreviewScroll?.(event.scroll.direction === "up" ? 3 : -3)
  }

  private readonly onKey = (key: KeyEvent) => this.surfaceInput.onKey(key)
  private readonly handleTranscriptWheel = (event: MouseEvent): void =>
    this.surfaceTranscript.handleTranscriptWheel(event)
  private readonly reportTranscriptScroll = (nearBottom = false): void =>
    this.surfaceTranscript.reportTranscriptScroll(nearBottom)
  private cancelTimer(timer: Fiber.Fiber<void> | undefined): void {
    timer?.interruptUnsafe()
  }

  private defer(action: () => void): void {
    Effect.runFork(Effect.yieldNow.pipe(Effect.andThen(Effect.sync(action))))
  }

  private delayed(duration: number, action: () => void): Fiber.Fiber<void> {
    return Effect.runFork(Effect.sleep(duration).pipe(Effect.andThen(Effect.sync(action))))
  }

  private repeated(duration: number, action: () => void): Fiber.Fiber<void> {
    return Effect.runFork(
      Effect.sleep(duration).pipe(
        Effect.andThen(Effect.sync(action)),
        Effect.repeat(Schedule.spaced(duration)),
        Effect.asVoid,
      ),
    )
  }

  private tickLoader(): void {
    this.target.loaderPhase += 1
    this.target.toolSpinner.step()
    const current = this.target.model
    if (current !== undefined) {
      const label = formatActivity(current.activity) ?? panelLoading(current)
      if (label !== undefined)
        this.statusLabel.content = new StyledText([
          fg(colors.text)(" "),
          fg(colors.blue)(loaderFrame(label, this.target.loaderPhase)),
          dim(fg(colors.text)(` ${label} `)),
        ])
      const glyph = this.target.toolSpinner.toBraille()
      for (const record of this.target.transcriptRecords.values()) {
        if (record.spinnerChunk === undefined) continue
        const content = record.renderable.content
        const chunks = [...content.chunks]
        const chunk = chunks[record.spinnerChunk]
        if (chunk === undefined) continue
        chunks[record.spinnerChunk] = { ...chunk, text: glyph }
        record.renderable.content = new StyledText(chunks)
      }
      if (current.threadSidebar.open)
        this.sidebar.content = renderSidebar(current, spinnerFrames[this.target.loaderPhase % spinnerFrames.length]!)
    }
    this.renderer.requestRender()
  }

  private readonly onPaste = (event: PasteEvent) => this.surfaceInput.onPaste(event)
  private readonly onResize = (width: number, height: number) => this.surfaceInput.onResize(width, height)
  private readonly setPointerShape = (shape: "ns-resize" | "ew-resize" | "default") =>
    this.surfaceInput.setPointerShape(shape)
  private readonly onSidebarMouseMove = (event: MouseEvent) => this.surfaceInput.onSidebarMouseMove(event)
  private readonly onSidebarMouseOut = () => this.surfaceInput.onSidebarMouseOut()
  private readonly onSidebarMouseDown = (event: MouseEvent) => this.surfaceInput.onSidebarMouseDown(event)
  private readonly onRootMouseDrag = (event: MouseEvent) => this.surfaceInput.onRootMouseDrag(event)
  private readonly onRootMouseUp = (event: MouseEvent) => this.surfaceInput.onRootMouseUp(event)
  private readonly onComposerMouseMove = (event: MouseEvent) => this.surfaceInput.onComposerMouseMove(event)
  private readonly onComposerMouseOut = () => this.surfaceInput.onComposerMouseOut()
  private readonly onComposerMouseDown = (event: MouseEvent) => this.surfaceInput.onComposerMouseDown(event)
  private refreshSidebarRows(model: Model): void {
    const view = model.changedFilesOpen ? "changed" : "workspace"
    const source = view === "changed" ? model.changedFiles : model.filePicker.items
    const width = sidebarInnerWidth(model)
    if (
      this.target.sidebarRowsView !== view ||
      this.target.sidebarRowsSource !== source ||
      (this.target.sidebarDrag === undefined && this.target.sidebarRowsWidth !== width)
    ) {
      this.target.sidebarRowsView = view
      this.target.sidebarRowsSource = source
      this.target.sidebarRowsWidth = width
      this.target.changedRows = InternalRendering.sidebarFileRows(model, width)
      this.changedFilesBox.setVirtualHeight(this.target.changedRows.length)
      this.target.sidebarWindowStart = -1
      this.target.sidebarWindowEnd = -1
    }
    this.refreshSidebarWindow()
  }
  private refreshSidebarWindow(force = false): boolean {
    if (!this.changedFilesBox.visible) return false
    const viewportRows = Math.max(1, this.changedFilesBox.viewport.height || (this.target.model?.height ?? 1) - 2)
    const scrollTop = Math.min(
      Math.max(0, Math.floor(this.changedFilesBox.scrollTop)),
      Math.max(0, this.target.changedRows.length - viewportRows),
    )
    const start = scrollTop
    const end = Math.min(this.target.changedRows.length, scrollTop + viewportRows)
    if (
      !force &&
      start === this.target.sidebarWindowStart &&
      end === this.target.sidebarWindowEnd &&
      this.target.changedFilesHoveredRow === this.target.sidebarWindowHoveredRow
    )
      return false
    this.target.sidebarWindowStart = start
    this.target.sidebarWindowEnd = end
    this.target.sidebarWindowHoveredRow = this.target.changedFilesHoveredRow
    this.changedFilesText.content = InternalRendering.renderFileRows(
      this.target.changedRows.slice(start, end),
      this.target.changedFilesHoveredRow === undefined ? undefined : this.target.changedFilesHoveredRow - start,
    )
    return true
  }
  private refreshSidebarAfterLayout(): void {
    if (this.target.sidebarLayoutFrame !== undefined) return
    const refresh = () => {
      this.renderer.off(CliRenderEvents.FRAME, refresh)
      this.target.sidebarLayoutFrame = undefined
      if (this.target.destroyed) return
      this.changedFilesBox.syncVirtualScroll()
      if (this.refreshSidebarWindow()) this.renderer.requestRender()
    }
    this.target.sidebarLayoutFrame = refresh
    this.renderer.on(CliRenderEvents.FRAME, refresh)
  }
  private welcomeWidthFor(model: Model): number {
    return Math.max(1, contentColumnWidth(model) - spacing.transcript * 2)
  }
  showToast(message: string, color: ColorInput = colors.green): void {
    const terminalWidth = Math.max(1, this.target.model?.width ?? this.renderer.width)
    const right = Math.min(2, Math.max(0, terminalWidth - 1))
    const width = Math.max(1, Math.min(stringWidth(message) + 6, terminalWidth - right))
    const visibleMessage = InternalRendering.truncateToWidth(message, Math.max(0, width - 6))
    this.toast.content = new StyledText([fg(color)("✓ "), fg(colors.text)(visibleMessage)])
    this.toastBox.borderColor = color
    this.toastBox.right = right
    this.toastBox.width = width
    this.toastBox.visible = true
    this.renderer.requestRender()
    this.cancelTimer(this.target.toastTimer)
    this.target.toastTimer = this.delayed(2500, () => {
      this.toastBox.visible = false
      this.target.toastTimer = undefined
      this.renderer.requestRender()
    })
  }
  private readonly onSelection = (selection: { getSelectedText: () => string }) => {
    const text = selection.getSelectedText().trimEnd()
    if (text.length === 0) return
    this.renderer.copyToClipboardOSC52(text)
    this.showToast("Selection copied to clipboard")
  }

  update(model: Model, preserveTranscriptAnchor = false): void {
    InternalSurfaceUpdate.updateSurface(this.surfaceUpdateDependencies, model, preserveTranscriptAnchor)
  }
  private syncOverlayEditor(text: string, cursor: number, top: number, height: number, width: number): void {
    this.overlayEditor.visible = true
    this.overlayEditor.top = top
    this.overlayEditor.width = Math.max(1, width)
    this.overlayEditor.height = Math.max(1, height)
    this.overlayEditor.sync(text, cursor)
  }

  private focusEditor(editor: ProjectedEditorRenderable | undefined): void {
    if (editor === this.target.focusedEditor) return
    this.target.focusedEditor?.blur()
    this.target.focusedEditor = editor
    this.target.focusedEditor?.focus()
    if (this.target.focusedEditor !== undefined) this.target.focusedEditor.showCursor = true
  }

  private restoreFocusedCursor(): void {
    if (this.target.focusedEditor === undefined || this.target.cursorRestoreFrame !== undefined) return
    const restore = () => {
      this.target.cursorRestoreFrame = undefined
      if (this.target.destroyed || this.target.focusedEditor === undefined) return
      this.target.focusedEditor.focus()
      this.target.focusedEditor.showCursor = true
      this.renderer.requestRender()
    }
    this.target.cursorRestoreFrame = restore
    this.renderer.once(CliRenderEvents.FRAME, restore)
    this.renderer.requestRender()
  }

  destroy(): void {
    this.target.destroyed = true
    this.target.scrollGeneration += 1
    if (this.target.cursorRestoreFrame !== undefined)
      this.renderer.off(CliRenderEvents.FRAME, this.target.cursorRestoreFrame)
    this.target.cursorRestoreFrame = undefined
    if (this.target.transcriptAnchorFrame !== undefined)
      this.renderer.off(CliRenderEvents.FRAME, this.target.transcriptAnchorFrame)
    this.target.transcriptAnchorFrame = undefined
    this.renderer.off(CliRenderEvents.FRAME, this.recordRenderedTranscriptScroll)
    if (this.target.sidebarLayoutFrame !== undefined)
      this.renderer.off(CliRenderEvents.FRAME, this.target.sidebarLayoutFrame)
    this.target.sidebarLayoutFrame = undefined
    this.target.transcriptAnchorScrollBy = 0
    this.target.pendingTranscriptAnchor = undefined
    this.surfaceTranscript.cancelWheelReport()
    if (this.target.loaderTimer !== undefined) this.target.clock.clearInterval(this.target.loaderTimer)
    this.target.loaderTimer = undefined
    this.cancelTimer(this.target.welcomeTimer)
    this.target.welcomeTimer = undefined
    this.cancelTimer(this.target.toastTimer)
    this.target.toastTimer = undefined
    this.surfaceInput.dispose()
    this.focusEditor(undefined)
    this.target.composerDrag = undefined
    this.target.sidebarDrag = undefined
    this.setPointerShape("default")
    this.target.model = undefined
    this.surfaceTranscript.clearTranscriptChildren()
    this.renderer.root.onMouseDrag = undefined
    this.renderer.root.onMouseUp = undefined
    this.renderer.root.onMouseDragEnd = undefined
    this.renderer.keyInput.off("keypress", this.onKey)
    this.renderer.keyInput.off("paste", this.onPaste)
    this.renderer.off(CliRenderEvents.RESIZE, this.onResize)
    this.renderer.off(CliRenderEvents.SELECTION, this.onSelection)
  }
}

export const create = (handlers: Handlers) =>
  Effect.tryPromise({
    try: () =>
      createCliRenderer({
        screenMode: "alternate-screen",
        exitOnCtrlC: false,
        useMouse: true,
        enableMouseMovement: true,
      }),
    catch: adapterError,
  }).pipe(
    Effect.flatMap((renderer) =>
      Effect.try({
        try: () => {
          let surface: Surface | undefined
          let released = false
          const releaseTerminal = () => {
            if (released) return
            released = true
            try {
              surface?.destroy()
            } catch {
            } finally {
              try {
                renderer.destroy()
              } catch {}
            }
          }
          const suspendTerminal = () => {
            if (released) return
            try {
              renderer.suspend()
            } catch (cause) {
              releaseTerminal()
              throw cause
            }
          }
          const resumeTerminal = () => {
            if (released) return
            try {
              renderer.resume()
            } catch (cause) {
              releaseTerminal()
              throw cause
            }
          }
          try {
            renderer.setBackgroundColor("transparent")
            handlers.resize(renderer.terminalWidth, renderer.terminalHeight)
            surface = new Surface(renderer, handlers)
            return { surface, releaseTerminal, suspendTerminal, resumeTerminal }
          } catch (cause) {
            releaseTerminal()
            throw cause
          }
        },
        catch: adapterError,
      }),
    ),
  )

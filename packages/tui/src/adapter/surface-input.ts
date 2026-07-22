import { Clock, Effect, type Fiber } from "effect"
import {
  decodePasteBytes,
  stripAnsiSequences,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
  type PasteEvent,
} from "@opentui/core"
import stringWidth from "string-width"
import { fromOpenTui, type Key } from "../keys"
import { filter } from "../palette"
import { colors } from "../theme"
import { filteredFiles, pastedTextTokenAt, type Model } from "../view-state"
import type { Handlers, SurfaceOptions } from "./contracts"
import { internal as InternalComposerOverlays } from "./composer-overlays"
import { internal as InternalThreadSwitcher } from "./thread-switcher"
import type { ProjectedEditorRenderable, SurfaceTarget } from "./surface-target"

const mouseSequencePattern = new RegExp(`^(?:${String.fromCharCode(27)}?\\[)?<?\\d+(?:;\\d+)*[Mm]?$`)

export interface SurfaceInputDependencies {
  readonly atMountedTranscriptBottom: () => boolean
  readonly atTranscriptBottom: (near?: boolean) => boolean
  readonly queuePendingTranscriptScroll: (scrollBy: number, nearBottom?: boolean) => boolean
  readonly shiftTranscriptWindow: (
    delta: number,
    preserveAnchor: boolean,
    scrollBy?: number,
    nearBottom?: boolean,
  ) => boolean
  readonly reportTranscriptScroll: (nearBottom?: boolean) => void
  readonly refreshSidebarRows: () => void
  readonly cancelTimer: (timer: Fiber.Fiber<void> | undefined) => void
  readonly delayed: (duration: number, action: () => void) => Fiber.Fiber<void>
}

export interface SurfaceInputBundle {
  readonly onKey: (key: KeyEvent) => void
  readonly onPaste: (event: PasteEvent) => void
  readonly onResize: (width: number, height: number) => void
  readonly onSidebarMouseMove: (event: MouseEvent) => void
  readonly onSidebarMouseOut: () => void
  readonly onSidebarMouseDown: (event: MouseEvent) => void
  readonly onRootMouseDrag: (event: MouseEvent) => void
  readonly onRootMouseUp: (event: MouseEvent) => void
  readonly onComposerMouseMove: (event: MouseEvent) => void
  readonly onComposerMouseOut: () => void
  readonly onComposerMouseDown: (event: MouseEvent) => void
  readonly setPointerShape: (shape: "ns-resize" | "ew-resize" | "default") => void
  readonly dispose: () => void
}

const updateSurfaceOverlay = (
  target: SurfaceTarget,
  model: Model,
  layout: {
    readonly composerTop: number
    readonly contentLeft: number
    readonly contentWidth: number
    readonly threadSidebarVisible: boolean
  },
  callbacks: {
    readonly syncOverlayEditor: (text: string, cursor: number, top: number, height: number, width: number) => void
    readonly focusEditor: (editor: ProjectedEditorRenderable | undefined) => void
  },
): void => {
  const { composerTop, contentLeft, contentWidth, threadSidebarVisible } = layout
  const overlay = model.threadSwitcher.open
    ? ("threads" as const)
    : model.filePicker.open
      ? ("files" as const)
      : model.modePicker.open
        ? ("modes" as const)
        : model.palette.open || model.paletteOpen
          ? ("palette" as const)
          : undefined
  target.paletteBox.visible = overlay !== undefined
  target.palette.visible = target.paletteBox.visible
  target.paletteBox.bottomTitle = ""
  let cursorEditor: ProjectedEditorRenderable | undefined =
    model.shortcutsOpen || (threadSidebarVisible && model.threadSidebar.focused) ? undefined : target.composerEditor
  if (overlay === "palette") {
    const results = filter(model.palette.query)
    const boxWidth = Math.max(1, Math.min(80, model.width - 4))
    const boxHeight = Math.min(Math.max(1, composerTop), results.length + 5)
    target.paletteBox.width = boxWidth
    target.paletteBox.height = boxHeight
    target.paletteBox.left = Math.max(0, Math.floor((model.width - boxWidth) / 2))
    target.paletteBox.top = Math.max(0, Math.floor((composerTop - boxHeight) / 2))
    target.paletteBox.title = " Command Palette "
    target.paletteBox.titleColor = colors.amber
    target.paletteBox.titleAlignment = "left"
    target.palette.content = InternalComposerOverlays.paletteContent(
      model,
      results,
      Math.max(1, boxWidth - 4),
      Math.max(1, boxHeight - 2),
    )
    callbacks.syncOverlayEditor(
      `> ${model.palette.query}`,
      2 + model.palette.query.length,
      0,
      boxHeight - 2,
      boxWidth - 4,
    )
    cursorEditor = target.overlayEditor
  } else if (overlay === "modes") {
    const boxWidth = Math.min(58, contentWidth)
    const boxHeight = Math.min(9, Math.max(1, composerTop))
    target.paletteBox.width = boxWidth
    target.paletteBox.height = boxHeight
    target.paletteBox.left = contentLeft + Math.max(0, contentWidth - boxWidth)
    target.paletteBox.top = Math.max(0, composerTop - boxHeight)
    target.paletteBox.title = ""
    target.paletteBox.bottomTitle = " ←→ turn · esc"
    target.paletteBox.bottomTitleAlignment = "right"
    target.palette.content = InternalComposerOverlays.modePickerContent(model, Math.max(1, boxWidth - 4))
    cursorEditor = undefined
  } else if (overlay === "files") {
    const entries = filteredFiles(model).map((file) => `@${file}`)
    const maxRows = Math.max(1, Math.min(20, composerTop - 1))
    const visibleEntries = entries.slice(0, Math.max(1, maxRows))
    const innerWidth = Math.max(...visibleEntries.map((entry) => stringWidth(entry)), 19)
    const availableWidth = contentWidth > 4 ? contentWidth - 4 : contentWidth
    const boxWidth = Math.max(1, Math.min(innerWidth + 4, availableWidth))
    const boxHeight = Math.min(Math.max(1, composerTop), Math.max(3, visibleEntries.length + 2))
    target.paletteBox.width = boxWidth
    target.paletteBox.height = boxHeight
    target.paletteBox.left = contentLeft + Math.min(2, Math.max(0, contentWidth - boxWidth))
    target.paletteBox.top = Math.max(0, composerTop - boxHeight)
    target.paletteBox.title = ""
    target.palette.content = InternalThreadSwitcher.filePickerContent(model, visibleEntries, Math.max(1, boxWidth - 4))
  } else if (overlay === "threads") {
    const overlayWidth = Math.max(1, Math.min(140, model.width - 4))
    const overlayHeight = Math.min(Math.max(1, composerTop), Math.max(6, composerTop - 2))
    target.paletteBox.width = overlayWidth
    target.paletteBox.height = overlayHeight
    target.paletteBox.left = Math.max(0, Math.floor((model.width - overlayWidth) / 2))
    target.paletteBox.top = Math.max(0, composerTop - overlayHeight)
    target.paletteBox.title = model.threadSwitcher.kind === "mention" ? " Mention Thread " : " Switch Thread "
    target.paletteBox.titleAlignment = "left"
    target.paletteBox.bottomTitle = " Opt+W/Ctrl+T all workspaces · Esc close "
    target.paletteBox.bottomTitleAlignment = "right"
    target.palette.content = InternalThreadSwitcher.threadSwitcherContent(
      model,
      Math.max(1, overlayWidth - 4),
      Math.max(1, overlayHeight - 2),
    )
    callbacks.syncOverlayEditor(
      `> ${model.threadSwitcher.query}`,
      2 + model.threadSwitcher.query.length,
      1,
      overlayHeight - 2,
      InternalThreadSwitcher.threadSwitcherListWidth(model, overlayWidth - 4),
    )
    cursorEditor = target.overlayEditor
  }
  callbacks.focusEditor(cursorEditor)
  if (cursorEditor !== target.overlayEditor) target.overlayEditor.visible = false
}

const createSurfaceInput = (
  target: SurfaceTarget,
  renderer: CliRenderer,
  handlers: Handlers,
  _options: SurfaceOptions,
  dependencies: SurfaceInputDependencies,
): SurfaceInputBundle => {
  const flushJunkBuffer = () => {
    dependencies.cancelTimer(target.junkTimer)
    target.junkTimer = undefined
    const pending = target.junkBuffer
    target.junkBuffer = []
    for (const buffered of pending) handlers.key(buffered)
  }
  const armJunkBuffer = (mapped: Key) => {
    dependencies.cancelTimer(target.junkTimer)
    target.junkBuffer = [mapped]
    target.junkTimer = dependencies.delayed(40, flushJunkBuffer)
  }
  const suppressMouseJunk = (mapped: Key): boolean => {
    if (mapped.ctrl || mapped.alt || mapped.meta || mapped.eventType === "release") return false
    if (mapped.sequence.length > 1 && mouseSequencePattern.test(mapped.sequence)) return true
    if (target.junkBuffer.length > 0) {
      if (/^[\d;]$/.test(mapped.sequence) && target.junkBuffer.length < 24) {
        target.junkBuffer.push(mapped)
        dependencies.cancelTimer(target.junkTimer)
        target.junkTimer = dependencies.delayed(40, flushJunkBuffer)
        return true
      }
      if (mapped.sequence === "M" || mapped.sequence === "m") {
        dependencies.cancelTimer(target.junkTimer)
        target.junkTimer = undefined
        target.junkBuffer = []
        return true
      }
      if (mapped.sequence === "<") {
        armJunkBuffer(mapped)
        return true
      }
      flushJunkBuffer()
      return false
    }
    if (mapped.sequence === "<") {
      armJunkBuffer(mapped)
      return true
    }
    return false
  }
  const setPointerShape = (shape: "ns-resize" | "ew-resize" | "default") => {
    if (target.pointerShape === shape) return
    target.pointerShape = shape
    const output = renderer as unknown as {
      stdout?: NodeJS.WriteStream
      realStdoutWrite?: NodeJS.WriteStream["write"]
    }
    if (output.stdout !== undefined && output.realStdoutWrite !== undefined) {
      output.realStdoutWrite.call(output.stdout, `\u001b]22;${shape}\u001b\\`)
      return
    }
    renderer.setMousePointer(shape === "default" ? "default" : "move")
  }
  const setComposerResizePointer = (active: boolean) => setPointerShape(active ? "ns-resize" : "default")
  const setSidebarResizePointer = (active: boolean) => setPointerShape(active ? "ew-resize" : "default")
  const onComposerMouseDrag = (event: MouseEvent) => {
    if (target.composerDrag === undefined) return
    handlers.composerResize?.(target.composerDrag.startHeight - (event.y - target.composerDrag.startY))
    event.preventDefault()
    event.stopPropagation()
  }
  const onComposerMouseUp = (event: MouseEvent) => {
    if (target.composerDrag === undefined) return
    target.composerDrag = undefined
    setComposerResizePointer(event.y === target.inputBox.y)
    event.preventDefault()
    event.stopPropagation()
  }
  return {
    onKey: (key) => {
      const mapped = fromOpenTui(key)
      if (suppressMouseJunk(mapped)) return
      if (!mapped.ctrl && !mapped.alt && !mapped.meta && mapped.name === "pageup") {
        target.userScrollDetached = true
        target.transcriptScroll.stickyScroll = false
        const amount = Math.max(1, target.transcriptScroll.viewport.height - 1)
        if (dependencies.queuePendingTranscriptScroll(-amount)) return
        if (target.transcriptScroll.scrollTop <= 1 && dependencies.shiftTranscriptWindow(-100, true, -amount)) return
        target.transcriptScroll.scrollBy(-amount)
        dependencies.reportTranscriptScroll()
      } else if (!mapped.ctrl && !mapped.alt && !mapped.meta && mapped.name === "pagedown") {
        target.transcriptScroll.stickyScroll = false
        const amount = Math.max(1, target.transcriptScroll.viewport.height - 1)
        if (dependencies.queuePendingTranscriptScroll(amount, true)) return
        if (dependencies.atMountedTranscriptBottom() && dependencies.shiftTranscriptWindow(100, true, amount, true))
          return
        target.transcriptScroll.scrollBy(amount)
        dependencies.reportTranscriptScroll(true)
      } else if (!mapped.ctrl && !mapped.alt && !mapped.meta && mapped.name === "end") {
        target.userScrollDetached = false
        handlers.scrollFollow?.()
      } else if (mapped.ctrl && mapped.name === "v" && handlers.pasteImage !== undefined) handlers.pasteImage()
      else handlers.key(mapped)
    },
    onPaste: (event) => {
      const mediaType = event.metadata?.mimeType?.toLowerCase()
      if (event.metadata?.kind === "binary" || mediaType?.startsWith("image/") === true) {
        if (event.bytes.length > 0)
          handlers.pasteImage?.(mediaType === undefined ? { bytes: event.bytes } : { bytes: event.bytes, mediaType })
        return
      }
      const text = stripAnsiSequences(decodePasteBytes(event.bytes))
      if (text.length === 0) return
      const now = Effect.runSync(Clock.currentTimeMillis)
      const attachment = target.model?.pastedText.findLast(
        (candidate) => candidate.type === "text" && candidate.value === text,
      )
      if (target.lastPaste?.text === text && now - target.lastPaste.at < 500 && attachment !== undefined) {
        handlers.expandPaste?.(attachment.token)
        target.lastPaste = undefined
        return
      }
      target.lastPaste = { text, at: now }
      handlers.paste?.(text)
    },
    onResize: (width, height) => {
      let current = { width, height }
      if ((renderer as unknown as { readonly _usesProcessStdout?: boolean })._usesProcessStdout === true) {
        const stream = (renderer as unknown as { readonly stdout?: NodeJS.WriteStream }).stdout
        current = {
          width: Number.isInteger(stream?.columns) && stream!.columns! > 0 ? stream!.columns! : width,
          height: Number.isInteger(stream?.rows) && stream!.rows! > 0 ? stream!.rows! : height,
        }
      }
      if (
        (current.width !== width || current.height !== height) &&
        (renderer.terminalWidth !== current.width || renderer.terminalHeight !== current.height)
      )
        renderer.resize(current.width, current.height)
      handlers.resize(current.width, current.height)
    },
    onSidebarMouseMove: (event) => {
      if (target.sidebarDrag === undefined) setSidebarResizePointer(event.x === target.changedFilesBox.x)
    },
    onSidebarMouseOut: () => {
      if (target.sidebarDrag === undefined) setSidebarResizePointer(false)
    },
    onSidebarMouseDown: (event) => {
      if (event.button !== 0 || target.model === undefined || event.x !== target.changedFilesBox.x) return
      target.sidebarDrag = { startX: event.x, startWidth: target.model.sidebarWidth }
      setSidebarResizePointer(true)
      event.preventDefault()
      event.stopPropagation()
    },
    onRootMouseDrag: (event) => {
      if (target.sidebarDrag !== undefined) {
        handlers.sidebarResize?.(target.sidebarDrag.startWidth + (target.sidebarDrag.startX - event.x))
        event.preventDefault()
        event.stopPropagation()
        return
      }
      onComposerMouseDrag(event)
    },
    onRootMouseUp: (event) => {
      if (target.sidebarDrag !== undefined) {
        target.sidebarDrag = undefined
        target.sidebarRowsWidth = 0
        dependencies.refreshSidebarRows()
        setSidebarResizePointer(event.x === target.changedFilesBox.x)
        event.preventDefault()
        event.stopPropagation()
        return
      }
      onComposerMouseUp(event)
    },
    onComposerMouseMove: (event) =>
      setComposerResizePointer(target.model?.shortcutsOpen !== true && event.y === target.inputBox.y),
    onComposerMouseOut: () => {
      if (target.composerDrag === undefined) setComposerResizePointer(false)
    },
    onComposerMouseDown: (event) => {
      const model = target.model
      if (event.button !== 0 || model === undefined || model.shortcutsOpen) return
      if (event.y !== target.inputBox.y) {
        const row = event.y - target.composerEditor.y
        const column = event.x - target.composerEditor.x
        const token = pastedTextTokenAt(model, row * Math.max(1, target.composerEditor.width) + column)
        if (token !== undefined) handlers.expandPaste?.(token)
        return
      }
      target.composerDrag = { startY: event.y, startHeight: target.inputBox.height }
      setComposerResizePointer(true)
      event.preventDefault()
      event.stopPropagation()
    },
    setPointerShape,
    dispose: () => {
      dependencies.cancelTimer(target.junkTimer)
      target.junkTimer = undefined
      target.junkBuffer = []
    },
  }
}

export const internal = { updateSurfaceOverlay, createSurfaceInput }

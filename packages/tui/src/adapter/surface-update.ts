import {
  CliRenderEvents,
  StyledText,
  TextRenderable,
  bold,
  dim,
  fg,
  type CliRenderer,
  type TextChunk,
} from "@opentui/core"
import stringWidth from "string-width"
import { colors, spacing } from "../theme"
import {
  includeRowEnd,
  maxMountedTranscriptRows,
  pinnedRowWindow,
  relocateRowEnd,
  rowWindowStart,
} from "../transcript-presenter"
import {
  boundedThreadSidebarWidth,
  composerHeight,
  contentColumnWidth,
  displayInput,
  fileSidebarLayoutWidth,
  formatActivity,
  isNarrow,
  queueContentWidth,
  readyOr,
  threadSidebarLayoutWidth,
  wrappedRowCount,
  type Model,
  type QueueItem,
  type ThreadItem,
} from "../view-state"
import type { Handlers, SurfaceOptions } from "./contracts"
import { displayCursorOffset } from "./composer-overlays"
import { internal as InternalComposerOverlays } from "./composer-overlays"
import { internal as InternalSurfaceInput } from "./surface-input"
import {
  loaderFrame,
  queueEditingHint,
  queueHintWidth,
  queueItemLabel,
  queueNavigationHint,
  renderSidebar,
  spinnerFrames,
  spinnerInterval,
} from "./rendering"
import { internal as InternalRendering } from "./rendering"
import { boundedTranscriptModel, maxMountedTranscriptEntries } from "./transcript-model"
import { internal as InternalTranscriptModel } from "./transcript-model"
import { internal as TranscriptUnitRenderer } from "./transcript-unit-renderer"
import { unitId as transcriptUnitId, rows as transcriptUnits } from "../transcript-presenter"
import {
  cutoutBackground,
  ProjectedEditorRenderable,
  type SurfaceTarget,
  type TranscriptRangeBundle,
  type TranscriptRenderableDescriptor,
  type TranscriptRenderInput,
  type TranscriptUnitCacheEntry,
} from "./surface-target"
import { compactWorkspace, formatCost, panelLoading, welcomeMarkFrames } from "./welcome"
import { internal as InternalWelcome } from "./welcome"

export interface SurfaceUpdateCallbacks {
  readonly captureTranscriptAnchor: () => { readonly key: string; readonly screenY: number } | undefined
  readonly buildTranscriptUnitBundles: (
    builder: ReturnType<typeof TranscriptUnitRenderer.transcriptUnitBuilder>,
    unit: Parameters<ReturnType<typeof TranscriptUnitRenderer.transcriptUnitBuilder>["renderUnit"]>[0],
    revision: string,
    toolSpinnerGlyph: string,
  ) => TranscriptUnitCacheEntry
  readonly setWelcomeChild: (child: TextRenderable) => void
  readonly transcriptChanged: (input: TranscriptRenderInput) => boolean
  readonly reconcileTranscript: (descriptors: ReadonlyArray<TranscriptRenderableDescriptor>) => void
  readonly welcomeWidthFor: (model: Model) => number
  readonly repeated: (duration: number, action: () => void) => import("effect").Fiber.Fiber<void>
  readonly cancelTimer: (timer: import("effect").Fiber.Fiber<void> | undefined) => void
  readonly refreshSidebarRows: (model: Model) => void
  readonly refreshSidebarAfterLayout: () => void
  readonly anchorTranscriptAfterLayout: () => void
  readonly clampTranscriptScrollTop: (offset: number) => number
  readonly syncTranscriptScrollbar: () => void
  readonly reportTranscriptScroll: (nearBottom?: boolean) => void
  readonly followTranscriptAfterLayout: () => void
  readonly tickLoader: () => void
  readonly setPointerShape: (shape: "ns-resize" | "ew-resize" | "default") => void
  readonly syncOverlayEditor: (text: string, cursor: number, top: number, height: number, width: number) => void
  readonly focusEditor: (editor: ProjectedEditorRenderable | undefined) => void
}

export interface SurfaceUpdateDependencies {
  readonly target: SurfaceTarget
  readonly renderer: CliRenderer
  readonly handlers: Handlers
  readonly options: SurfaceOptions
  readonly callbacks: SurfaceUpdateCallbacks
}

const updateSurface = (
  dependencies: SurfaceUpdateDependencies,
  model: Model,
  preserveTranscriptAnchor = false,
): void => {
  const { target, renderer, handlers, options, callbacks } = dependencies

  const previousScrollHeight = target.transcriptScroll.scrollHeight
  const previousModel = target.model
  if (
    previousModel?.currentThreadId !== model.currentThreadId ||
    (previousModel?.scrollFollow === false && model.scrollFollow)
  )
    target.userScrollDetached = false
  const scrollFollow = model.scrollFollow && !target.userScrollDetached
  const transcriptLayoutChanged =
    previousModel !== undefined &&
    (previousModel.items !== model.items ||
      previousModel.entries !== model.entries ||
      previousModel.blocks !== model.blocks ||
      previousModel.expandedRowKeys !== model.expandedRowKeys ||
      contentColumnWidth(previousModel) !== contentColumnWidth(model))
  const transcriptDetachedSameThread =
    previousModel !== undefined &&
    previousModel.currentThreadId === model.currentThreadId &&
    !scrollFollow &&
    (model.entries.length > 0 || model.blocks.length > 0) &&
    transcriptLayoutChanged &&
    target.pendingTranscriptAnchor === undefined &&
    target.wheelTimer === undefined
  const preserveTranscriptPosition = preserveTranscriptAnchor || transcriptDetachedSameThread
  const transcriptAnchor = preserveTranscriptPosition ? callbacks.captureTranscriptAnchor() : undefined
  const previousItems = previousModel?.items.length ?? 0
  if (target.transcriptWindowThread !== model.currentThreadId) {
    if (target.transcriptAnchorFrame !== undefined) renderer.off(CliRenderEvents.FRAME, target.transcriptAnchorFrame)
    target.transcriptAnchorFrame = undefined
    target.pendingTranscriptAnchor = undefined
    target.transcriptAnchorScrollBy = 0
    target.transcriptAnchorNearBottom = false
    target.transcriptWindowThread = model.currentThreadId
    target.transcriptWindowEnd = model.items.length
    target.transcriptRowWindow = pinnedRowWindow
    target.transcriptRowTotal = 0
  } else if (preserveTranscriptAnchor)
    target.transcriptWindowEnd = Math.min(
      model.items.length,
      target.transcriptWindowEnd + Math.max(0, model.items.length - previousItems),
    )
  else if (scrollFollow || target.transcriptWindowEnd === 0) {
    target.transcriptWindowEnd = model.items.length
    target.transcriptRowWindow = pinnedRowWindow
  } else
    target.transcriptWindowEnd =
      model.items.length <= maxMountedTranscriptEntries
        ? model.items.length
        : Math.min(target.transcriptWindowEnd, model.items.length)
  target.model = model
  target.queueHint.bg = cutoutBackground(renderer)
  target.modeLabel.bg = cutoutBackground(renderer)
  target.workspaceLabel.bg = cutoutBackground(renderer)
  target.statusLabel.bg = cutoutBackground(renderer)
  if (model.shortcutsOpen) callbacks.setPointerShape("default")
  const inputHeight = composerHeight(model)
  const renderedInputHeight = model.shortcutsOpen
    ? Math.min(Math.max(1, model.height - 4), spacing.inputHeight + 12)
    : model.queue.length > 0
      ? Math.min(inputHeight, Math.max(1, model.height - 2))
      : inputHeight
  target.inputBox.minHeight = Math.min(spacing.inputHeight, renderedInputHeight)
  const sidebarWidth = fileSidebarLayoutWidth(model)
  const sidebarVisible = sidebarWidth > 0
  const contentLeft = threadSidebarLayoutWidth(model)
  const threadSidebarVisible = contentLeft > 0
  const contentWidth = contentColumnWidth(model)
  const modeColor = colors[model.mode]
  const isWelcome = model.entries.length === 0 && model.blocks.length === 0
  target.transcriptScroll.content.justifyContent = isWelcome ? "flex-start" : "flex-end"
  const animateWelcome =
    isWelcome &&
    !model.threadSwitcher.open &&
    !model.filePicker.open &&
    !model.modePicker.open &&
    !model.palette.open &&
    !model.paletteOpen
  if (isWelcome) {
    target.transcriptRenderInput = undefined
    const welcomeWidth = callbacks.welcomeWidthFor(model)
    const welcomeKey = `${welcomeWidth}:${model.height}:${target.welcomePhase}:${model.mode}`
    const existingWelcome = target.transcriptChildren.length === 1 ? target.welcomeChild : undefined
    if (existingWelcome === undefined) {
      const child = new TextRenderable(renderer, {
        content: InternalWelcome.welcomeContent(welcomeWidth, model.height, target.welcomePhase, model.mode),
        fg: modeColor,
        wrapMode: "word",
        selectable: true,
      })
      callbacks.setWelcomeChild(child)
      target.welcomeChild = child
      target.welcomeKey = welcomeKey
    } else if (target.welcomeKey !== welcomeKey) {
      target.welcomeKey = welcomeKey
      existingWelcome.fg = modeColor
      existingWelcome.content = InternalWelcome.welcomeContent(
        welcomeWidth,
        model.height,
        target.welcomePhase,
        model.mode,
      )
    }
  } else {
    const renderModel = sidebarWidth === 0 && !threadSidebarVisible ? model : { ...model, width: contentWidth }
    const transcriptInput = {
      entries: renderModel.entries,
      blocks: renderModel.blocks,
      items: renderModel.items,
      expandedRowKeys: renderModel.expandedRowKeys,
      detailSelection: renderModel.detailSelection,
      permissionSelection: renderModel.permissionSelection,
      width: renderModel.width,
      windowEnd: target.transcriptWindowEnd,
      rowWindowEnd: target.transcriptRowWindow.end,
    }
    if (callbacks.transcriptChanged(transcriptInput)) {
      const toolSpinnerGlyph = target.toolSpinner.toBraille()
      const boundedModel = boundedTranscriptModel(renderModel, target.transcriptWindowEnd)
      const builder = TranscriptUnitRenderer.transcriptUnitBuilder(boundedModel, toolSpinnerGlyph)
      const expandedSet = new Set(boundedModel.expandedRowKeys)
      const nextCache = new Map<string, TranscriptUnitCacheEntry>()
      const orderedBundles: Array<{ readonly gapBefore: boolean; readonly bundle: TranscriptRangeBundle }> = []
      let renderedUnits = 0
      for (const unit of transcriptUnits(boundedModel)) {
        if (!builder.isUnitVisible(unit)) continue
        renderedUnits += 1
        const gapBefore = renderedUnits > 1
        const unitKey = transcriptUnitId(boundedModel, unit)
        const revision = InternalTranscriptModel.transcriptUnitRevision(boundedModel, unit, unitKey, expandedSet)
        const cached = target.transcriptUnitCache.get(unitKey)
        const entry =
          cached !== undefined && cached.revision === revision
            ? cached
            : callbacks.buildTranscriptUnitBundles(builder, unit, revision, toolSpinnerGlyph)
        nextCache.set(unitKey, entry)
        for (const [index, bundle] of entry.bundles.entries())
          orderedBundles.push({ gapBefore: index === 0 && gapBefore, bundle })
      }
      target.transcriptUnitCache = nextCache
      const totalRows = orderedBundles.length
      const limit = maxMountedTranscriptRows
      let rowEnd = totalRows
      if (target.transcriptRowWindow.end !== 0) {
        const anchorIndex =
          target.transcriptRowWindow.anchorKey === undefined
            ? -1
            : orderedBundles.findIndex(({ bundle }) => bundle.key === target.transcriptRowWindow.anchorKey)
        rowEnd = relocateRowEnd(target.transcriptRowWindow, anchorIndex, totalRows, limit)
      }
      const previousSelection = target.transcriptRenderInput?.detailSelection
      if (renderModel.detailSelection !== undefined && renderModel.detailSelection !== previousSelection) {
        const selectionIndex = orderedBundles.findIndex(({ bundle }) => bundle.key === renderModel.detailSelection)
        const included = includeRowEnd(rowEnd, selectionIndex, totalRows, limit)
        if (included !== rowEnd) {
          rowEnd = included
          if (target.transcriptRowWindow.end === 0 && rowEnd < totalRows)
            target.transcriptRowWindow = { end: rowEnd, pendingDelta: 0 }
        }
      }
      const mounted =
        target.transcriptRowWindow.end === 0
          ? orderedBundles.slice(-limit)
          : orderedBundles.slice(rowWindowStart(rowEnd, limit), rowEnd)
      target.transcriptRowTotal = totalRows
      if (target.transcriptRowWindow.end !== 0)
        target.transcriptRowWindow = {
          end: rowEnd,
          pendingDelta: 0,
          ...(mounted[0] === undefined ? {} : { anchorKey: mounted[0].bundle.key }),
        }
      const descriptors: Array<TranscriptRenderableDescriptor> = []
      for (const { gapBefore, bundle } of mounted) {
        if (gapBefore)
          descriptors.push({
            key: `${bundle.key}:gap`,
            revision: "gap",
            content: new StyledText([fg(colors.text)(" ")]),
          })
        descriptors.push(...bundle.descriptors)
      }
      callbacks.reconcileTranscript(descriptors)
      target.transcriptRenderInput = { ...transcriptInput, rowWindowEnd: target.transcriptRowWindow.end }
    }
  }
  if (options.animate !== false && animateWelcome && target.welcomeTimer === undefined) {
    target.welcomeTimer = callbacks.repeated(80, () => {
      const current = target.model
      if (current === undefined || current.entries.length > 0 || current.blocks.length > 0) return
      target.welcomePhase = (target.welcomePhase + 1) % welcomeMarkFrames.length
      const welcome = target.welcomeChild
      if (welcome === undefined) return
      const width = callbacks.welcomeWidthFor(current)
      target.welcomeKey = `${width}:${current.height}:${target.welcomePhase}:${current.mode}`
      welcome.content = InternalWelcome.welcomeContent(width, current.height, target.welcomePhase, current.mode)
      renderer.requestRender()
    })
  } else if ((options.animate === false || !animateWelcome) && target.welcomeTimer !== undefined) {
    callbacks.cancelTimer(target.welcomeTimer)
    target.welcomeTimer = undefined
  }
  const queue = model.queue as ReadonlyArray<QueueItem>
  target.queueBox.marginLeft = contentWidth <= 4 ? 0 : 1
  target.queueBox.marginRight = contentWidth <= 4 ? 0 : 1
  target.queueBox.visible = queue.length > 0
  const queueTextWidth = queueContentWidth(model)
  const queueLength = queue.length
  const selectedIndex = queue.findIndex((item) => item.id === model.queueSelection)
  const editIndex = queue.findIndex((item) => item.id === model.editingTurnId)
  const hintIndex = editIndex >= 0 ? editIndex : selectedIndex
  const editing = model.editingTurnId !== undefined && editIndex >= 0
  const hintSegments =
    hintIndex < 0
      ? []
      : InternalRendering.fittingQueueHint(editing ? queueEditingHint : queueNavigationHint, queueTextWidth)
  const hintWidth = queueHintWidth(hintSegments)
  const labels = queue.map((item, index) => {
    const label = queueItemLabel(item)
    if (index !== hintIndex || hintSegments.length === 0) return label
    const [first = "", ...remaining] = label.split("\n")
    const width = queueTextWidth - hintWidth
    const inline =
      stringWidth(first) <= width ? first : `${InternalRendering.truncateToWidth(first, Math.max(1, width - 1))}…`
    return [inline, ...remaining].join("\n")
  })
  const heights = labels.map((label) => wrappedRowCount(label, queueTextWidth))
  const queueRows = heights.reduce((sum, rows) => sum + rows, 0)
  const queueBoxHeight = Math.min(
    Math.max(1, model.height),
    Math.min(Math.max(3, model.height - renderedInputHeight - 2), Math.max(3, queueRows + 2)),
  )
  target.queueBox.minHeight = Math.min(3, queueBoxHeight)
  target.queueBox.height = queueBoxHeight
  const availableRows = Math.max(1, queueBoxHeight - 2)
  const clampToRows = (text: string, rows: number): string =>
    wrappedRowCount(text, queueTextWidth) <= rows
      ? text
      : `${InternalRendering.truncateToWidth(text.replace(/\n/g, " "), Math.max(1, rows * queueTextWidth - 1))}…`
  const focusIndex = hintIndex < 0 ? queueLength - 1 : hintIndex
  let start = focusIndex
  let end = focusIndex + 1
  let used = Math.min(availableRows, heights[focusIndex] ?? 0)
  while (end < queueLength && used + heights[end]! <= availableRows) used += heights[end++]!
  while (start > 0 && used + heights[start - 1]! <= availableRows) used += heights[--start]!
  const queueChunks: Array<TextChunk> = []
  let hintTop = 0
  let renderedRows = 0
  for (const [offset, item] of queue.slice(start, end).entries()) {
    const index = start + offset
    const label = clampToRows(labels[index]!, availableRows)
    const labelRows = wrappedRowCount(label, queueTextWidth)
    if (index === hintIndex && hintSegments.length > 0) hintTop = renderedRows
    queueChunks.push(item.id === model.queueSelection ? bold(fg(colors.text)(label)) : fg(colors.subtle)(label))
    renderedRows += labelRows
    if (index < end - 1) queueChunks.push(fg(colors.text)("\n"))
  }
  target.queueText.content = new StyledText(queueChunks)
  target.queueHint.top = hintTop
  const hintChunks: Array<TextChunk> = []
  for (const [index, segment] of hintSegments.entries()) {
    hintChunks.push(dim(fg(colors.text)(index === 0 ? " " : " · ")))
    hintChunks.push(fg(colors[model.mode])(segment.accent))
    if (segment.suffix.length > 0) hintChunks.push(dim(fg(colors.text)(segment.suffix)))
  }
  if (hintSegments.length > 0) hintChunks.push(dim(fg(colors.text)(" ")))
  target.queueHint.content = new StyledText(hintChunks)
  target.queueHint.visible = hintSegments.length > 0
  target.queueLeftJoint.visible = queue.length > 0
  target.queueRightJoint.visible = queue.length > 0
  target.inputBox.borderColor = colors.text
  const costText = model.costUsd !== undefined ? formatCost(model.costUsd) : model.busy ? "$····" : ""
  target.inputBox.title = ""
  const modeChunks: Array<TextChunk> = []
  if (costText.length > 0) {
    modeChunks.push(dim(fg(colors.text)(` ${costText} `)))
    modeChunks.push(fg(colors.text)("─"))
  }
  modeChunks.push(fg(colors.text)(" "))
  if (model.fastMode) modeChunks.push(fg(colors.amber)("↯"))
  modeChunks.push(fg(colors[model.mode])(model.mode))
  modeChunks.push(fg(colors.text)(" "))
  target.modeLabel.right = sidebarWidth + 2
  target.modeLabel.width = modeChunks.reduce((total, chunk) => total + stringWidth(chunk.text), 0)
  target.modeLabel.content = new StyledText(modeChunks)
  const workspaceTitle = isNarrow(model)
    ? ""
    : ` ${compactWorkspace(model.workspace)}${model.branch === undefined ? "" : ` (${model.branch})`} `
  const panelLoadingLabel = panelLoading(model)
  const activityLabel = formatActivity(model.activity)
  if (activityLabel !== undefined || panelLoadingLabel !== undefined) {
    const statusName = activityLabel ?? panelLoadingLabel!
    target.inputBox.bottomTitle = ""
    target.statusLabel.content = new StyledText([
      fg(colors.text)(" "),
      fg(colors.blue)(loaderFrame(statusName, target.loaderPhase)),
      dim(fg(colors.text)(` ${statusName} `)),
    ])
  } else {
    target.inputBox.bottomTitle = ""
    target.statusLabel.content = ""
  }
  target.workspaceLabel.right = sidebarWidth + 2
  target.workspaceLabel.content = new StyledText([dim(fg(colors.text)(workspaceTitle))])
  target.inputBox.height = renderedInputHeight
  const queueHeight = queue.length > 0 ? target.queueBox.height - 1 : 0
  target.modeLabel.top = model.height - renderedInputHeight
  target.queueLeftJoint.top = model.height - renderedInputHeight
  target.queueRightJoint.top = model.height - renderedInputHeight
  target.transcriptViewportRows = Math.max(1, model.height - renderedInputHeight - queueHeight)
  target.transcriptScroll.content.minHeight = target.transcriptViewportRows
  target.input.visible = model.shortcutsOpen
  target.input.content = model.shortcutsOpen
    ? InternalComposerOverlays.shortcutsContent(model, Math.max(1, contentWidth - 4))
    : ""
  target.composerEditor.visible = !model.shortcutsOpen
  target.composerEditor.height = Math.max(1, renderedInputHeight - 2)
  target.composerEditor.sync(displayInput(model), displayCursorOffset(model))
  target.sidebar.visible = threadSidebarVisible
  target.sidebar.width = boundedThreadSidebarWidth(model.width)
  target.sidebar.content = threadSidebarVisible
    ? renderSidebar(model, spinnerFrames[target.loaderPhase % spinnerFrames.length]!)
    : ""
  target.changedFilesBox.visible = sidebarVisible
  if (target.changedFilesBox.visible) {
    target.changedFilesBox.width = Math.max(1, sidebarWidth - 2)
    target.changedFilesBox.title = model.changedFilesOpen
      ? ` Changed files (${readyOr(model.changedFiles, []).length}) `
      : ` Files (${readyOr(model.filePicker.items, []).length}) `
    target.changedFilesBox.titleAlignment = "left"
    callbacks.refreshSidebarRows(model)
    if (
      previousModel === undefined ||
      previousModel.width !== model.width ||
      previousModel.height !== model.height ||
      previousModel.sidebarWidth !== model.sidebarWidth ||
      previousModel.changedFilesOpen !== model.changedFilesOpen ||
      previousModel.changedFiles !== model.changedFiles ||
      previousModel.workspaceFilesOpen !== model.workspaceFilesOpen ||
      previousModel.filePicker.items !== model.filePicker.items
    )
      callbacks.refreshSidebarAfterLayout()
  } else {
    target.changedFilesHoveredRow = undefined
  }
  target.transcriptScroll.stickyScroll = scrollFollow
  callbacks.anchorTranscriptAfterLayout()
  if (preserveTranscriptPosition) {
    const pending = target.pendingTranscriptAnchor
    target.pendingTranscriptAnchor =
      pending !== undefined && pending.threadId === model.currentThreadId
        ? {
            ...pending,
            scrollBy: pending.scrollBy + target.transcriptAnchorScrollBy,
            nearBottom: target.transcriptAnchorScrollBy === 0 ? pending.nearBottom : target.transcriptAnchorNearBottom,
          }
        : {
            anchor: transcriptAnchor,
            threadId: model.currentThreadId,
            scrollHeight: previousScrollHeight,
            scrollBy: target.transcriptAnchorScrollBy,
            nearBottom: target.transcriptAnchorNearBottom,
          }
    target.transcriptAnchorScrollBy = 0
    target.transcriptAnchorNearBottom = false
    if (target.transcriptAnchorFrame === undefined) {
      const restore = () => {
        target.transcriptAnchorFrame = undefined
        const current = target.pendingTranscriptAnchor
        target.pendingTranscriptAnchor = undefined
        if (current === undefined || target.model?.currentThreadId !== current.threadId || target.destroyed) return
        if (target.model?.scrollFollow === true && !target.userScrollDetached) return
        const anchored = current.anchor === undefined ? undefined : target.transcriptRecords.get(current.anchor.key)
        const anchorScreenY = current.anchor?.screenY
        const offset =
          anchored === undefined || anchorScreenY === undefined
            ? target.transcriptScroll.scrollHeight - current.scrollHeight
            : anchored.renderable.screenY - anchorScreenY
        target.scrollProgrammatic = true
        target.transcriptScroll.scrollTop = callbacks.clampTranscriptScrollTop(
          target.transcriptScroll.scrollTop + offset,
        )
        if (current.scrollBy !== 0)
          target.transcriptScroll.scrollTop = callbacks.clampTranscriptScrollTop(
            target.transcriptScroll.scrollTop + current.scrollBy,
          )
        target.scrollProgrammatic = false
        callbacks.syncTranscriptScrollbar()
        if (current.scrollBy === 0) handlers.scrollGeometry?.(target.transcriptScroll.scrollTop)
        else callbacks.reportTranscriptScroll(current.nearBottom)
        renderer.requestRender()
      }
      target.transcriptAnchorFrame = restore
      renderer.once(CliRenderEvents.FRAME, restore)
      target.clock.setTimeout(() => {
        if (target.transcriptAnchorFrame === restore && !target.destroyed) {
          renderer.off(CliRenderEvents.FRAME, restore)
          restore()
        }
      }, 16)
    }
  } else if (target.pendingTranscriptAnchor !== undefined) renderer.requestRender()
  else if (scrollFollow) callbacks.followTranscriptAfterLayout()
  else if (target.wheelTimer === undefined && Math.abs(target.transcriptScroll.scrollTop - model.scrollOffset) > 1) {
    target.scrollProgrammatic = true
    target.transcriptScroll.scrollTop = callbacks.clampTranscriptScrollTop(model.scrollOffset)
    target.scrollProgrammatic = false
  }
  const loaderActive =
    model.busy ||
    model.activity !== undefined ||
    panelLoadingLabel !== undefined ||
    (model.threadSidebar.open &&
      (model.threads as ReadonlyArray<ThreadItem>).some((thread) => thread.status !== "idle"))
  if (options.animate !== false && loaderActive && target.loaderTimer === undefined) {
    target.loaderTimer = target.clock.setInterval(() => callbacks.tickLoader(), spinnerInterval)
  } else if ((options.animate === false || !loaderActive) && target.loaderTimer !== undefined) {
    target.clock.clearInterval(target.loaderTimer)
    target.loaderTimer = undefined
  }
  const composerTop = model.height - renderedInputHeight
  InternalSurfaceInput.updateSurfaceOverlay(
    target,
    model,
    { composerTop, contentLeft, contentWidth, threadSidebarVisible },
    callbacks,
  )
  renderer.requestRender()
}

export const internal = { updateSurface }

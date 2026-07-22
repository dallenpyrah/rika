import { StyledText, TextRenderable, fg, type CliRenderer, type MouseEvent, type TextChunk } from "@opentui/core"
import stringWidth from "string-width"
import { colors } from "../theme"
import {
  escapePathTarget,
  maxMountedTranscriptRows,
  pinnedRowWindow,
  resolveRowEnd,
  shiftRowEnd,
  type TranscriptUnit,
} from "../transcript-presenter"
import { atBottomWithin, clampScrollTop, maxScrollTop, type ViewportMetrics } from "../transcript-viewport"
import type { Handlers } from "./contracts"
import { maxMountedTranscriptEntries } from "./transcript-model"
import { internal as TranscriptUnitRenderer } from "./transcript-unit-renderer"
import { splitStyledLines } from "./thread-switcher"
import type {
  SurfaceTarget,
  TranscriptRangeBundle,
  TranscriptRenderableDescriptor,
  TranscriptRenderInput,
  TranscriptUnitCacheEntry,
} from "./surface-target"

export interface SurfaceTranscriptCallbacks {
  readonly update: (preserveAnchor: boolean) => void
  readonly defer: (action: () => void) => void
  readonly restoreFocusedCursor: () => void
}

const createSurfaceTranscript = (
  target: SurfaceTarget,
  renderer: CliRenderer,
  handlers: Handlers,
  callbacks: SurfaceTranscriptCallbacks,
) => {
  const transcriptMetrics = (): ViewportMetrics => ({
    scrollTop: target.transcriptScroll.scrollTop,
    scrollHeight: target.transcriptScroll.scrollHeight,
    viewportHeight: target.transcriptScroll.viewport.height,
  })
  const atMountedTranscriptBottom = (): boolean => atBottomWithin(transcriptMetrics(), 1)
  const atTranscriptBottom = (near = false): boolean =>
    atBottomWithin(transcriptMetrics(), near ? 1 : 0) &&
    target.transcriptWindowEnd >= (target.model?.items.length ?? 0) &&
    (target.transcriptRowWindow.end === 0 || target.transcriptRowWindow.end >= target.transcriptRowTotal)
  const clampTranscriptScrollTop = (scrollTop: number): number =>
    clampScrollTop(scrollTop, { ...transcriptMetrics(), scrollTop })
  const captureTranscriptAnchor = () => {
    const viewportTop = target.transcriptScroll.screenY
    const drift = target.transcriptScroll.scrollTop - target.renderedTranscriptScrollTop
    const first = [...target.transcriptRecords.values()]
      .filter(({ renderable }) => renderable.height > 0 && renderable.screenY + drift + renderable.height > viewportTop)
      .toSorted((left, right) => left.renderable.screenY - right.renderable.screenY)[0]
    return first === undefined ? undefined : { key: first.key, screenY: first.renderable.screenY + drift }
  }
  const syncTranscriptScrollbar = (): void => {
    if (target.destroyed) return
    const viewportHeight = target.transcriptViewportRows
    const scrollHeight = target.transcriptScroll.scrollHeight
    const overflowing = viewportHeight > 0 && scrollHeight > viewportHeight
    target.transcriptScrollbar.scrollSize = scrollHeight
    target.transcriptScrollbar.viewportSize = Math.max(1, viewportHeight)
    target.scrollbarSyncing = true
    target.transcriptScrollbar.scrollPosition = target.transcriptScroll.scrollTop
    target.scrollbarSyncing = false
    if (target.transcriptScrollbar.visible !== overflowing) target.transcriptScrollbar.visible = overflowing
  }
  const reportTranscriptScroll = (nearBottom = false): void => {
    if (target.scrollProgrammatic || target.destroyed) return
    syncTranscriptScrollbar()
    if (atTranscriptBottom(nearBottom)) {
      target.userScrollDetached = false
      handlers.scrollFollow?.()
    } else handlers.scroll?.(target.transcriptScroll.scrollTop)
  }
  const queueTranscriptScroll = (action: () => void): void => {
    const generation = target.scrollGeneration
    callbacks.defer(() => {
      if (target.destroyed || generation !== target.scrollGeneration) return
      action()
    })
  }
  const shiftTranscriptWindow = (delta: number, preserveAnchor: boolean, scrollBy = 0, nearBottom = false): boolean => {
    const model = target.model
    if (model === undefined) return false
    const currentRowEnd = resolveRowEnd(target.transcriptRowWindow, target.transcriptRowTotal, maxMountedTranscriptRows)
    const shiftedRowEnd = shiftRowEnd(
      target.transcriptRowWindow,
      delta,
      target.transcriptRowTotal,
      maxMountedTranscriptRows,
    )
    if (shiftedRowEnd !== currentRowEnd) {
      target.transcriptRowWindow = {
        end: currentRowEnd,
        pendingDelta: delta,
        ...(target.transcriptRowWindow.anchorKey === undefined
          ? {}
          : { anchorKey: target.transcriptRowWindow.anchorKey }),
      }
      target.transcriptRenderInput = undefined
      target.transcriptAnchorScrollBy = scrollBy
      target.transcriptAnchorNearBottom = nearBottom
      callbacks.update(preserveAnchor)
      return true
    }
    const minimumEnd = Math.min(maxMountedTranscriptEntries, model.items.length)
    const end = Math.min(model.items.length, Math.max(minimumEnd, target.transcriptWindowEnd + delta))
    if (end === target.transcriptWindowEnd) return false
    target.transcriptWindowEnd = end
    if (target.transcriptRowWindow.end !== 0)
      target.transcriptRowWindow = { ...target.transcriptRowWindow, pendingDelta: delta }
    target.transcriptRenderInput = undefined
    target.transcriptAnchorScrollBy = scrollBy
    target.transcriptAnchorNearBottom = nearBottom
    callbacks.update(preserveAnchor)
    return true
  }
  const queuePendingTranscriptScroll = (scrollBy: number, nearBottom = false): boolean => {
    const pending = target.pendingTranscriptAnchor
    if (pending === undefined || pending.threadId !== target.model?.currentThreadId) return false
    target.pendingTranscriptAnchor = { ...pending, scrollBy: pending.scrollBy + scrollBy, nearBottom }
    renderer.requestRender()
    return true
  }
  const handleTranscriptScroll = (): void => {
    if (target.transcriptScroll.scrollTop <= 1 && shiftTranscriptWindow(-100, true)) return
    reportTranscriptScroll()
  }
  const handleTranscriptWheel = (event: MouseEvent): void => {
    const direction = event.scroll?.direction
    if (direction !== "up" && direction !== "down") return
    if (direction === "up") {
      const detach = !target.userScrollDetached && target.model?.scrollFollow === true
      target.userScrollDetached = true
      target.transcriptScroll.stickyScroll = false
      if (detach) handlers.scroll?.(target.transcriptScroll.scrollTop)
    }
    if (target.pendingTranscriptAnchor !== undefined) {
      queuePendingTranscriptScroll((direction === "down" ? 1 : -1) * Math.max(1, event.scroll?.delta ?? 1))
      return
    }
    target.wheelDirection = direction
    if (direction === "down" && atMountedTranscriptBottom()) target.wheelScrollBy += event.scroll?.delta ?? 1
    if (target.wheelTimer === undefined)
      target.wheelTimer = target.clock.setTimeout(() => {
        target.wheelTimer = undefined
        const pendingDirection = target.wheelDirection
        const scrollBy = target.wheelScrollBy
        target.wheelDirection = undefined
        target.wheelScrollBy = 0
        if (pendingDirection === "down" && atMountedTranscriptBottom() && shiftTranscriptWindow(100, true, scrollBy))
          return
        handleTranscriptScroll()
      }, 16)
  }
  const cancelWheelReport = (): void => {
    if (target.wheelTimer === undefined) return
    target.clock.clearTimeout(target.wheelTimer)
    target.wheelTimer = undefined
    target.wheelDirection = undefined
    target.wheelScrollBy = 0
  }
  const anchorTranscriptAfterLayout = (): void =>
    callbacks.defer(() => {
      if (target.model !== undefined) syncTranscriptScrollbar()
    })
  const followTranscriptAfterLayout = (): void => {
    if (target.scrollFramePending) return
    target.scrollFramePending = true
    callbacks.defer(() => {
      target.scrollFramePending = false
      if (target.model?.scrollFollow !== true || target.userScrollDetached) return
      target.scrollProgrammatic = true
      target.transcriptScroll.scrollTo(maxScrollTop(transcriptMetrics()))
      target.scrollProgrammatic = false
      syncTranscriptScrollbar()
      renderer.requestRender()
    })
  }
  const clearTranscriptChildren = (): void => {
    target.welcomeChild = undefined
    for (const child of target.transcriptChildren) {
      target.transcriptScroll.content.remove(child)
      child.destroy()
    }
    target.transcriptChildren = []
    target.transcriptRecords.clear()
    target.transcriptUnitCache.clear()
    target.transcriptRenderInput = undefined
    target.transcriptRowWindow = pinnedRowWindow
    target.transcriptRowTotal = 0
  }
  const buildTranscriptUnitBundles = (
    builder: ReturnType<typeof TranscriptUnitRenderer.transcriptUnitBuilder>,
    unit: TranscriptUnit,
    revision: string,
    glyph: string,
  ): TranscriptUnitCacheEntry => {
    const built = builder.renderUnit(unit)
    const styledLines = splitStyledLines(new StyledText([...built.chunks]))
    const bundles: Array<TranscriptRangeBundle> = []
    for (const [rangeIndex, range] of [built.root, ...built.nested].entries()) {
      const descriptors: Array<TranscriptRenderableDescriptor> = []
      const headerEnd = range.headerEnd ?? range.start
      const joinLines = (lines: ReadonlyArray<ReadonlyArray<TextChunk>>): Array<TextChunk> =>
        lines.flatMap((line, index) => (index < lines.length - 1 ? [...line, fg(colors.text)("\n")] : [...line]))
      const headerContent = new StyledText(joinLines(styledLines.slice(range.start, headerEnd + 1)))
      const spinnerChunk =
        range.animated === true ? headerContent.chunks.findIndex((chunk) => chunk.text === glyph) : -1
      descriptors.push({
        key: `${range.unit}:header`,
        revision: `${revision}#${rangeIndex}h`,
        content: headerContent,
        selectable: !range.expandable,
        ...(range.targets === undefined ? {} : { targets: range.targets }),
        ...(spinnerChunk < 0 ? {} : { spinnerChunk }),
        ...(range.expandable
          ? {
              onMouseDown: (event: MouseEvent) => {
                if (event.button !== 0) return
                event.stopPropagation()
                handlers.clickToggle?.(range.unit)
              },
            }
          : {}),
      })
      const body = joinLines(styledLines.slice(headerEnd + 1, range.end + 1))
      if (body.length > 0)
        descriptors.push({
          key: `${range.unit}:body`,
          revision: `${revision}#${rangeIndex}b`,
          content: new StyledText(body),
          ...(range.targets === undefined ? {} : { targets: range.targets }),
        })
      bundles.push({ key: range.unit, descriptors })
    }
    return { revision, bundles }
  }
  const setWelcomeChild = (child: TextRenderable): void => {
    clearTranscriptChildren()
    target.transcriptChildren = [child]
    target.transcriptScroll.content.add(child)
  }
  const reconcileTranscript = (descriptors: ReadonlyArray<TranscriptRenderableDescriptor>): void => {
    if (target.welcomeChild !== undefined) clearTranscriptChildren()
    const desiredKeys = new Set(descriptors.map(({ key }) => key))
    const selected = new Set(renderer.getSelection()?.touchedRenderables ?? [])
    const pinned = [...target.transcriptRecords.values()].filter(
      (record) => !desiredKeys.has(record.key) && selected.has(record.renderable),
    )
    for (const record of target.transcriptRecords.values()) {
      if (desiredKeys.has(record.key) || selected.has(record.renderable)) continue
      target.transcriptScroll.content.remove(record.renderable)
      record.renderable.destroy()
      target.transcriptRecords.delete(record.key)
    }
    const desired = descriptors.map((descriptor) => {
      const handleMouseDown = (renderable: TextRenderable, event: MouseEvent) => {
        if (event.button === 0) {
          const line = descriptor.content.chunks
            .map((chunk) => chunk.text)
            .join("")
            .split("\n")[event.y - renderable.screenY]
          if (line !== undefined)
            for (const pathTarget of descriptor.targets ?? []) {
              const label = escapePathTarget(pathTarget.path)
              let offset = line.indexOf(label)
              while (offset >= 0) {
                const start = stringWidth(line.slice(0, offset))
                if (
                  event.x - renderable.screenX >= start &&
                  event.x - renderable.screenX < start + stringWidth(label)
                ) {
                  event.stopPropagation()
                  handlers.openPath?.(pathTarget)
                  callbacks.restoreFocusedCursor()
                  return
                }
                offset = line.indexOf(label, offset + label.length)
              }
            }
        }
        descriptor.onMouseDown?.(event)
        callbacks.restoreFocusedCursor()
      }
      const existing = target.transcriptRecords.get(descriptor.key)
      if (existing !== undefined) {
        if (existing.revision !== descriptor.revision) {
          existing.revision = descriptor.revision
          existing.renderable.content = descriptor.content
        }
        if (descriptor.spinnerChunk === undefined) delete existing.spinnerChunk
        else existing.spinnerChunk = descriptor.spinnerChunk
        existing.renderable.selectable = descriptor.selectable ?? true
        existing.renderable.onMouseDown = (event) => handleMouseDown(existing.renderable, event)
        return existing
      }
      const renderable = new TextRenderable(renderer, {
        content: descriptor.content,
        wrapMode: "word",
        selectable: descriptor.selectable ?? true,
      })
      renderable.onMouseDown = (event) => handleMouseDown(renderable, event)
      const record = {
        key: descriptor.key,
        revision: descriptor.revision,
        renderable,
        ...(descriptor.spinnerChunk === undefined ? {} : { spinnerChunk: descriptor.spinnerChunk }),
      }
      target.transcriptRecords.set(record.key, record)
      return record
    })
    const children = [...pinned, ...desired].map(({ renderable }) => renderable)
    const current = [...target.transcriptScroll.content.getChildren()]
    children.forEach((child, index) => {
      if (current[index] === child) return
      const previous = current.indexOf(child)
      if (previous >= 0) current.splice(previous, 1)
      current.splice(index, 0, child)
      target.transcriptScroll.content.add(child, index)
    })
    target.transcriptChildren = children
  }
  const transcriptChanged = (input: TranscriptRenderInput): boolean => {
    const previous = target.transcriptRenderInput
    return (
      previous === undefined ||
      previous.entries !== input.entries ||
      previous.blocks !== input.blocks ||
      previous.items !== input.items ||
      previous.expandedRowKeys !== input.expandedRowKeys ||
      previous.detailSelection !== input.detailSelection ||
      previous.permissionSelection !== input.permissionSelection ||
      previous.width !== input.width ||
      previous.windowEnd !== input.windowEnd ||
      previous.rowWindowEnd !== input.rowWindowEnd
    )
  }
  return {
    transcriptMetrics,
    atMountedTranscriptBottom,
    atTranscriptBottom,
    clampTranscriptScrollTop,
    captureTranscriptAnchor,
    handleTranscriptWheel,
    cancelWheelReport,
    shiftTranscriptWindow,
    queuePendingTranscriptScroll,
    reportTranscriptScroll,
    syncTranscriptScrollbar,
    queueTranscriptScroll,
    anchorTranscriptAfterLayout,
    followTranscriptAfterLayout,
    clearTranscriptChildren,
    buildTranscriptUnitBundles,
    setWelcomeChild,
    reconcileTranscript,
    transcriptChanged,
  }
}

export type SurfaceTranscriptBundle = ReturnType<typeof createSurfaceTranscript>

export const internal = { createSurfaceTranscript }

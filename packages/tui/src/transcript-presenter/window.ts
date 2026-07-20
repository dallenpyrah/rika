export const maxMountedTranscriptRows = 240

export interface RowWindowState {
  readonly end: number
  readonly anchorKey?: string
  readonly pendingDelta: number
}

export const pinnedRowWindow: RowWindowState = { end: 0, pendingDelta: 0 }

export const isRowWindowPinned = (window: RowWindowState): boolean => window.end === 0

export const minimumRowEnd = (total: number, limit: number): number => Math.min(limit, Math.max(0, total))

export const resolveRowEnd = (window: RowWindowState, total: number, limit: number): number =>
  window.end === 0 ? total : Math.min(total, Math.max(minimumRowEnd(total, limit), window.end))

export const rowWindowStart = (end: number, limit: number): number => Math.max(0, end - limit)

export const shiftRowEnd = (window: RowWindowState, delta: number, total: number, limit: number): number => {
  const current = resolveRowEnd(window, total, limit)
  return Math.min(total, Math.max(minimumRowEnd(total, limit), current + delta))
}

export const relocateRowEnd = (window: RowWindowState, anchorIndex: number, total: number, limit: number): number => {
  const located =
    anchorIndex >= 0 ? anchorIndex + minimumRowEnd(total, limit) : Math.min(total, Math.max(1, window.end))
  return Math.min(total, Math.max(minimumRowEnd(total, limit), located + window.pendingDelta))
}

export const includeRowEnd = (end: number, index: number, total: number, limit: number): number => {
  if (index < 0 || (index >= rowWindowStart(end, limit) && index < end)) return end
  return Math.min(total, Math.max(minimumRowEnd(total, limit), index + 1))
}

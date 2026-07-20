import { Function } from "effect"

export interface ViewportAnchor {
  readonly unitId: string
  readonly offset: number
}

export type ViewportState =
  | { readonly _tag: "Following" }
  | { readonly _tag: "Anchored"; readonly anchor: ViewportAnchor | undefined }

export interface ViewportWindow {
  readonly end: number
}

export interface ViewportMetrics {
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly viewportHeight: number
}

export const following: ViewportState = { _tag: "Following" }

export const anchored = (anchor?: ViewportAnchor): ViewportState => ({ _tag: "Anchored", anchor })

export const isFollowing = (state: ViewportState): boolean => state._tag === "Following"

export const isAnchored = (state: ViewportState): boolean => state._tag === "Anchored"

export const anchorOf = (state: ViewportState): ViewportAnchor | undefined =>
  state._tag === "Anchored" ? state.anchor : undefined

export const maxScrollTop = (metrics: ViewportMetrics): number =>
  Math.max(0, metrics.scrollHeight - metrics.viewportHeight)

export const atBottom = (metrics: ViewportMetrics): boolean => metrics.scrollTop >= maxScrollTop(metrics)

export const clampScrollTop: {
  (metrics: ViewportMetrics): (scrollTop: number) => number
  (scrollTop: number, metrics: ViewportMetrics): number
} = Function.dual(2, (scrollTop: number, metrics: ViewportMetrics): number =>
  Math.max(0, Math.min(scrollTop, maxScrollTop(metrics))),
)

export const detach = (anchor?: ViewportAnchor): ViewportState => anchored(anchor)

export const follow = (): ViewportState => following

export const reanchor: {
  (anchor: ViewportAnchor | undefined): (state: ViewportState) => ViewportState
  (state: ViewportState, anchor: ViewportAnchor | undefined): ViewportState
} = Function.dual(
  2,
  (state: ViewportState, anchor: ViewportAnchor | undefined): ViewportState =>
    state._tag === "Anchored" ? anchored(anchor) : state,
)

export const contentChanged = (state: ViewportState): ViewportState => state

export const resized = (state: ViewportState): ViewportState => state

export const toggled = (anchor: ViewportAnchor | undefined): ViewportState => anchored(anchor)

export const settle: {
  (anchor: ViewportAnchor | undefined): (metrics: ViewportMetrics) => ViewportState
  (metrics: ViewportMetrics, anchor: ViewportAnchor | undefined): ViewportState
} = Function.dual(
  2,
  (metrics: ViewportMetrics, anchor: ViewportAnchor | undefined): ViewportState =>
    atBottom(metrics) ? following : anchored(anchor),
)

export const initialWindow = (total: number): ViewportWindow => ({ end: Math.max(0, total) })

export const windowStart: {
  (limit: number): (window: ViewportWindow) => number
  (window: ViewportWindow, limit: number): number
} = Function.dual(2, (window: ViewportWindow, limit: number): number => Math.max(0, window.end - limit))

export const atWindowTop: {
  (limit: number): (window: ViewportWindow) => boolean
  (window: ViewportWindow, limit: number): boolean
} = Function.dual(2, (window: ViewportWindow, limit: number): boolean => windowStart(window, limit) <= 0)

export const atWindowBottom: {
  (total: number): (window: ViewportWindow) => boolean
  (window: ViewportWindow, total: number): boolean
} = Function.dual(2, (window: ViewportWindow, total: number): boolean => window.end >= total)

export const advanceWindow: {
  (delta: number, total: number, limit: number): (window: ViewportWindow) => ViewportWindow
  (window: ViewportWindow, delta: number, total: number, limit: number): ViewportWindow
} = Function.dual(4, (window: ViewportWindow, delta: number, total: number, limit: number): ViewportWindow => {
  const minimumEnd = Math.min(limit, total)
  const end = Math.min(total, Math.max(minimumEnd, window.end + delta))
  return { end }
})

export const clampWindow: {
  (total: number, limit: number, pinned: boolean): (window: ViewportWindow) => ViewportWindow
  (window: ViewportWindow, total: number, limit: number, pinned: boolean): ViewportWindow
} = Function.dual(4, (window: ViewportWindow, total: number, limit: number, pinned: boolean): ViewportWindow => {
  if (pinned || window.end === 0) return { end: total }
  const minimumEnd = Math.min(limit, total)
  return { end: Math.min(total, Math.max(minimumEnd, window.end)) }
})

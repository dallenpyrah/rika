import type { Clock as OpenTuiClock } from "@opentui/core"
import type { Key } from "../keys"
import type { PathTarget } from "../transcript-presenter"

export interface Handlers {
  readonly key: (key: Key) => void
  readonly scroll?: (offset: number) => void
  readonly scrollGeometry?: (offset: number) => void
  readonly scrollFollow?: () => void
  readonly paste?: (text: string) => void
  readonly pasteImage?: (image?: { readonly bytes: Uint8Array; readonly mediaType?: string }) => void
  readonly expandPaste?: (token: string) => void
  readonly clickToggle?: (unit: string) => void
  readonly composerResize?: (height: number) => void
  readonly sidebarResize?: (width: number) => void
  readonly threadSidebarSelect?: (index: number) => void
  readonly threadPreviewScroll?: (offset: number) => void
  readonly openPath?: (target: PathTarget) => void
  readonly resize: (width: number, height: number) => void
}

export interface SurfaceOptions {
  readonly animate?: boolean
  readonly clock?: OpenTuiClock
}

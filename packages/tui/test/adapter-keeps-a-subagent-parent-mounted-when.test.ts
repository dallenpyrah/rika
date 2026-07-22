import { expect, test, vi } from "vitest"
import { it } from "@effect/vitest"
import * as Transcript from "@rika/transcript"
import { Effect } from "effect"

const windowUnitToolCall = (id: string, family: "agent" | "explore") => ({
  _tag: "ToolCall" as const,
  id,
  name: family === "agent" ? "task" : "read",
  input: "{}",
  status: "complete" as const,
  presentation: {
    family,
    action: family === "agent" ? "task" : "read",
    activeLabel: family === "agent" ? "Exploring" : "Reading",
    completeLabel: family === "agent" ? "Explored" : "Read",
  },
  detail: id,
  files: [],
})

const opentui = vi.hoisted(() => {
  const boxChildren: Array<object> = []
  const keyHandlers = new Set<(key: object) => void>()
  const pasteHandlers = new Set<(event: object) => void>()
  const resizeHandlers = new Set<(width: number, height: number) => void>()
  const frameHandlers = new Set<() => void>()
  const selectionHandlers = new Set<(selection: object) => void>()
  const rootChildren: Array<object> = []
  const requestRender = vi.fn()
  const textRenderables: Array<TextRenderable> = []

  class TextRenderable {
    content = ""
    fg = ""
    visible = true

    constructor(
      readonly renderer: object,
      options: Record<string, unknown>,
    ) {
      Object.assign(this, options)
      textRenderables.push(this)
    }

    destroy() {}
  }

  class EditBufferRenderable extends TextRenderable {
    plainText = ""
    cursorOffset = 0
    focused = false
    showCursor = true
    declare cursorStyle: unknown

    setText(text: string) {
      this.plainText = text
    }

    focus() {
      this.focused = true
    }

    blur() {
      this.focused = false
    }
  }

  class BoxRenderable {
    borderColor = ""
    title = ""
    titleColor = ""
    bottomTitle = ""
    readonly children: Array<object> = []

    constructor(
      readonly renderer: object,
      options: Record<string, unknown>,
    ) {
      Object.assign(this, options)
    }

    add(child: object, index?: number) {
      boxChildren.push(child)
      const previous = this.children.indexOf(child)
      if (previous >= 0) this.children.splice(previous, 1)
      if (index === undefined || index >= this.children.length) this.children.push(child)
      else this.children.splice(index, 0, child)
    }

    remove(child: object) {
      const index = this.children.indexOf(child)
      if (index >= 0) this.children.splice(index, 1)
    }

    getChildren() {
      return [...this.children]
    }
  }

  class ScrollBoxRenderable extends BoxRenderable {
    scrollTop = 0
    scrollHeight = 24
    stickyScroll = true
    viewport = { height: 24 }
    content = new BoxRenderable(this.renderer, { minHeight: 0, justifyContent: "flex-end" })
    verticalScrollBar = { visible: true }

    scrollTo(offset: number) {
      this.scrollTop = offset
    }
  }

  class ScrollBarRenderable {
    scrollSize = 0
    scrollPosition = 0
    viewportSize = 0
    visible = true

    constructor(
      readonly renderer: object,
      options: Record<string, unknown>,
    ) {
      Object.assign(this, options)
    }

    destroy() {}
  }

  class RGBA {
    a = 0

    constructor(readonly token: string = "rgba") {}

    static defaultBackground() {
      return new RGBA("default-bg")
    }

    static defaultForeground() {
      return new RGBA("default-fg")
    }

    static fromIndex(index: number) {
      return new RGBA(`ansi-${index}`)
    }
  }

  class SystemClock {
    now() {
      return 0
    }

    setTimeout(_action: () => void, _delay: number) {
      return 0
    }

    clearTimeout(_handle: number) {}

    setInterval(_action: () => void, _delay: number) {
      return 0
    }

    clearInterval(_handle: number) {}
  }

  const renderer = {
    _usesProcessStdout: true,
    stdout: { write: vi.fn() },
    realStdoutWrite: vi.fn(),
    terminalWidth: 80,
    terminalHeight: 24,
    destroy: vi.fn(),
    suspend: vi.fn(),
    resume: vi.fn(),
    setBackgroundColor: vi.fn(),
    root: {
      add: vi.fn((child: object) => {
        rootChildren.push(child)
      }),
    },
    keyInput: {
      on(event: string, handler: (key: object) => void) {
        ;(event === "paste" ? pasteHandlers : keyHandlers).add(handler)
      },
      off(event: string, handler: (key: object) => void) {
        ;(event === "paste" ? pasteHandlers : keyHandlers).delete(handler)
      },
    },
    on(event: string, handler: (width: number, height: number) => void) {
      if (event === "selection") selectionHandlers.add(handler as unknown as (selection: object) => void)
      else if (event === "frame") frameHandlers.add(handler as unknown as () => void)
      else resizeHandlers.add(handler)
    },
    off(event: string, handler: (width: number, height: number) => void) {
      if (event === "selection") selectionHandlers.delete(handler as unknown as (selection: object) => void)
      else if (event === "frame") frameHandlers.delete(handler as unknown as () => void)
      else resizeHandlers.delete(handler)
    },
    requestRender,
    resize: vi.fn((width: number, height: number) => {
      renderer.terminalWidth = width
      renderer.terminalHeight = height
      for (const handler of resizeHandlers) handler(width, height)
    }),
    getSelection: () => null,
    copyToClipboardOSC52: vi.fn(),
    setMousePointer: vi.fn(),
  }

  return {
    BoxRenderable,
    EditBufferRenderable,
    RGBA,
    ScrollBarRenderable,
    ScrollBoxRenderable,
    SystemClock,
    TextRenderable,
    boxChildren,
    createCliRenderer: vi.fn(() => Effect.runPromise(Effect.succeed(renderer))),
    frameHandlers,
    keyHandlers,
    pasteHandlers,
    renderer,
    requestRender,
    resizeHandlers,
    selectionHandlers,
    textRenderables,
    rootChildren,
  }
})

vi.mock("@opentui/core", () => ({
  BoxRenderable: opentui.BoxRenderable,
  EditBufferRenderable: opentui.EditBufferRenderable,
  RGBA: opentui.RGBA,
  ScrollBarRenderable: opentui.ScrollBarRenderable,
  ScrollBoxRenderable: opentui.ScrollBoxRenderable,
  SystemClock: opentui.SystemClock,
  CliRenderEvents: { FRAME: "frame", RESIZE: "resize", SELECTION: "selection" },
  TextRenderable: opentui.TextRenderable,
  createCliRenderer: opentui.createCliRenderer,
  decodePasteBytes: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
  fg: (color: string) => (text: string) => ({ text, fg: color }),
  bg: (_color: string) => (chunk: { text: string }) => chunk,
  bold: (chunk: { text: string }) => chunk,
  italic: (chunk: { text: string }) => chunk,
  dim: (chunk: { text: string }) => chunk,
  underline: (chunk: { text: string }) => chunk,
  strikethrough: (chunk: { text: string }) => chunk,
  link: () => (chunk: { text: string }) => chunk,
  StyledText: class StyledText {
    constructor(readonly chunks: ReadonlyArray<{ text: string }>) {}
  },
  stripAnsiSequences: (text: string) => text,
}))

import { boundedTranscriptModel, create } from "../src/adapter"
import { initial, type Model } from "../src/view-state"

const handlers = () => ({ key: vi.fn(), resize: vi.fn() })

const model = (changes: Partial<Model> = {}): Model => ({ ...initial("/workspace", "medium"), ...changes })

const createScoped = (callbacks: Parameters<typeof create>[0]) =>
  Effect.acquireRelease(create(callbacks), (created) => Effect.sync(created.releaseTerminal))

test("keeps a subagent parent mounted when its child window exceeds the transcript limit", () => {
  const parent = {
    _tag: "ToolCall" as const,
    id: "agent",
    name: "oracle",
    input: "{}",
    status: "running" as const,
    presentation: {
      family: "agent" as const,
      action: "oracle",
      activeLabel: "Oracle exploring",
      completeLabel: "Oracle has spoken",
    },
    detail: "Review the code",
    files: [],
  }
  const children = Array.from({ length: 205 }, (_, index) => ({
    _tag: "ToolCall" as const,
    id: `child-${index}`,
    name: "read",
    input: `{"path":"src/${index}.ts"}`,
    status: "complete" as const,
    presentation: {
      family: "explore" as const,
      action: "read",
      activeLabel: "Exploring",
      completeLabel: "Explored",
      counter: "file" as const,
    },
    detail: `src/${index}.ts`,
    files: [],
  }))
  const state = model({
    blocks: [parent, ...children],
    items: [
      { _tag: "Block", index: 0, id: "tool:agent", turnId: "turn" },
      ...children.map((_, index) => ({
        _tag: "Block" as const,
        index: index + 1,
        id: `tool:child-${index}`,
        turnId: "child",
        parentId: "agent",
      })),
    ],
  })

  const bounded = boundedTranscriptModel(state)

  expect(bounded.items).toHaveLength(206)
  expect(bounded.blocks[0]).toMatchObject({ _tag: "ToolCall", id: "agent" })
  expect(bounded.items[0]).toMatchObject({ _tag: "Block", index: 0, id: "tool:agent" })
})

test("keeps a subagent's direct tool calls mounted whenever its nested child survives the window", () => {
  const layout: ReadonlyArray<{
    readonly id: string
    readonly family: "agent" | "explore"
    readonly parentId?: string
  }> = [
    { id: "agent", family: "agent" },
    ...Array.from({ length: 30 }, (_, index) => ({
      id: `agent-tool-${index}`,
      family: "explore" as const,
      parentId: "agent",
    })),
    { id: "nested", family: "agent", parentId: "agent" },
    ...Array.from({ length: 250 }, (_, index) => ({
      id: `nested-child-${index}`,
      family: "explore" as const,
      parentId: "nested",
    })),
  ]
  const blocks = layout.map((entry) => windowUnitToolCall(entry.id, entry.family))
  const state = model({
    blocks,
    items: layout.map((entry, index) =>
      entry.parentId === undefined
        ? { _tag: "Block" as const, index, id: `tool:${entry.id}`, turnId: "turn" }
        : { _tag: "Block" as const, index, id: `tool:${entry.id}`, turnId: "child", parentId: entry.parentId },
    ),
  })

  const bounded = boundedTranscriptModel(state)
  const mountedIds = new Set(
    (bounded.blocks as ReadonlyArray<Transcript.Block>).flatMap((block) =>
      block._tag === "ToolCall" ? [block.id] : [],
    ),
  )

  expect([...mountedIds].some((id) => id.startsWith("nested-child-"))).toBe(true)
  expect(mountedIds.has("nested")).toBe(true)
  for (let index = 0; index < 30; index += 1)
    expect(mountedIds.has(`agent-tool-${index}`), `agent-tool-${index} should stay mounted with the nested child`).toBe(
      true,
    )
})

it.effect("mounts a bounded transcript window for large histories", () =>
  Effect.gen(function* () {
    const { surface } = yield* createScoped(handlers())
    surface.update(
      model({
        entries: Array.from({ length: 1_000 }, (_, index) => ({
          role: "assistant" as const,
          text: `answer ${index}`,
          turnId: `turn-${index}`,
        })),
      }),
    )

    expect(
      (surface as unknown as { transcriptChildren: ReadonlyArray<object> }).transcriptChildren.length,
    ).toBeLessThanOrEqual(400)
  }),
)

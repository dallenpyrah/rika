import { expect, test, vi } from "vitest"
import { Effect } from "effect"

const agentToolBlock = (status: "running" | "complete" | "failed" | "cancelled", detail = "Investigate the crash") => ({
  _tag: "ToolCall" as const,
  id: "agent",
  name: "task",
  input: "{}",
  status,
  presentation: {
    family: "agent" as const,
    action: "task",
    activeLabel: "Subagent working",
    completeLabel: "Subagent finished",
  },
  detail,
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

import { buildTranscript } from "../src/adapter"
import { initial, type Model } from "../src/view-state"
import { colors } from "../src/theme"

const model = (changes: Partial<Model> = {}): Model => ({ ...initial("/workspace", "medium"), ...changes })

test("matches Amp edit, wait, explore, and subagent row shapes", () => {
  const presentation = {
    edit: { family: "edit" as const, action: "edit", activeLabel: "Editing", completeLabel: "Edited" },
    direct: { family: "direct" as const, action: "status", activeLabel: "Waiting for", completeLabel: "Waited for" },
    explore: {
      family: "explore" as const,
      action: "grep",
      activeLabel: "Exploring",
      completeLabel: "Explored",
      counter: "search" as const,
    },
    agent: {
      family: "agent" as const,
      action: "task",
      activeLabel: "Subagent working",
      completeLabel: "Subagent finished",
    },
  }
  const patch = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new"
  const state = model({
    blocks: [
      {
        _tag: "ToolCall",
        id: "patch",
        name: "edit",
        input: "{}",
        status: "running",
        presentation: presentation.edit,
        detail: "",
        files: [
          {
            key: "patch:0",
            path: "src/a.ts",
            kind: "update",
            patch,
            additions: 1,
            deletions: 1,
            preview: true,
            status: "running",
          },
        ],
      },
      {
        _tag: "ToolCall",
        id: "wait",
        name: "shell_command_status",
        input: JSON.stringify({ processId: "1" }),
        output: "done",
        status: "complete",
        presentation: presentation.direct,
        detail: "bun test",
        files: [],
      },
      {
        _tag: "ToolCall",
        id: "grep",
        name: "grep",
        input: JSON.stringify({ path: "src", pattern: "needle" }),
        output: "src/a.ts:1:needle",
        status: "failed",
        presentation: presentation.explore,
        detail: 'src "needle"',
        files: [],
      },
      {
        _tag: "ToolCall",
        id: "task",
        name: "task",
        input: "{}",
        output: "child result",
        status: "complete",
        presentation: presentation.agent,
        detail: "Fix packaging integration tests",
        files: [],
      },
    ],
    expandedRowKeys: ["tool:grep", "tool:task"],
  })
  const built = buildTranscript(state)
  const text = built.styled.chunks.map((chunk) => chunk.text).join("")
  expect(text).toContain("Editing src/a.ts +1 -1 ▾\n")
  expect(text).toContain("- old")
  expect(text).not.toContain("Edit src/a.ts")
  expect(text).toContain("Waited for bun test ▸")
  expect(text).toContain('✕ Grep src "needle" src/a.ts:1:needle')
  expect(text).toContain("Subagent finished ▾")
  expect(text).toContain("Fix packaging integration tests")
  expect(text).not.toContain("Subagent finished Fix packaging integration tests")
})

test("renders an expanded failed subagent's failure text in red", () => {
  const state = model({
    blocks: [agentToolBlock("failed")],
    items: [{ _tag: "Block", index: 0, id: "tool:agent" }],
    childExecutionOutcomes: { agent: { status: "failed", reason: "network exploded" } },
    expandedRowKeys: ["tool:agent"],
  })
  const built = buildTranscript(state)
  const chunk = built.styled.chunks.find((current) => current.text.includes("network exploded")) as
    | { readonly text: string; readonly fg?: string }
    | undefined
  expect(chunk).toBeDefined()
  expect(chunk?.fg).toBe(colors.red)
})

test("tones a cancelled subagent amber and an empty completed subagent dim", () => {
  const cancelled = model({
    blocks: [agentToolBlock("cancelled")],
    items: [{ _tag: "Block", index: 0, id: "tool:agent" }],
    childExecutionOutcomes: { agent: { status: "cancelled", reason: "user stopped the run" } },
    expandedRowKeys: ["tool:agent"],
  })
  const cancelledChunk = buildTranscript(cancelled).styled.chunks.find((current) =>
    current.text.includes("user stopped the run"),
  ) as { readonly text: string; readonly fg?: string } | undefined
  expect(cancelledChunk?.fg).toBe(colors.amber)

  const completed = model({
    blocks: [agentToolBlock("complete")],
    items: [{ _tag: "Block", index: 0, id: "tool:agent" }],
    expandedRowKeys: ["tool:agent"],
  })
  const built = buildTranscript(completed)
  const infoChunk = built.styled.chunks.find((current) => current.text.includes("finished without a final message")) as
    | { readonly text: string; readonly fg?: string }
    | undefined
  expect(infoChunk).toBeDefined()
  expect(infoChunk?.fg).toBe(colors.text)
})

test("renders a completed subagent's final answer, not a blank terminal", () => {
  const state = model({
    entries: [{ role: "assistant", text: "The bug was a missing await." }],
    blocks: [agentToolBlock("complete")],
    items: [
      { _tag: "Block", index: 0, id: "tool:agent" },
      { _tag: "Entry", index: 0, id: "answer:0", parentId: "agent" },
    ],
    expandedRowKeys: ["tool:agent"],
  })
  const text = buildTranscript(state)
    .styled.chunks.map((current) => current.text)
    .join("")
  expect(text).toContain("The bug was a missing await.")
  expect(text).not.toContain("finished without a final message")
})

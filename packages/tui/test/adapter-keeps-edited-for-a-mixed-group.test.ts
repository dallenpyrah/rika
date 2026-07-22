import { expect, test, vi } from "vitest"
import { Effect } from "effect"

const shell = (id: string, command: string, output: string) => ({
  _tag: "ToolCall" as const,
  id,
  name: "bash",
  input: JSON.stringify({ command }),
  output,
  status: "complete" as const,
  presentation: { family: "shell" as const, action: "command", activeLabel: "Running", completeLabel: "Ran" },
  detail: command,
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

const nonEmptyLines = (text: string) => text.split("\n").filter((line) => line.length > 0)

const model = (changes: Partial<Model> = {}): Model => ({ ...initial("/workspace", "medium"), ...changes })

const editToolBlock = {
  _tag: "ToolCall",
  id: "patch",
  name: "edit",
  input: "{}",
  status: "complete",
  presentation: {
    family: "edit",
    action: "edit",
    activeLabel: "Editing",
    completeLabel: "Edited",
  },
  detail: "",
  files: [
    {
      key: "patch:0",
      path: "src/a.ts",
      kind: "update",
      patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
      additions: 1,
      deletions: 1,
      preview: false,
      status: "complete",
    },
  ],
} as const

const subagentToolBlock = {
  _tag: "ToolCall",
  id: "agent",
  name: "task",
  input: "{}",
  status: "complete",
  presentation: {
    family: "agent",
    action: "task",
    activeLabel: "Subagent working",
    completeLabel: "Subagent finished",
  },
  detail: "Inspect\nthe projection",
  files: [],
} as const

const renderedText = (changes: Partial<Model>) =>
  buildTranscript(model(changes))
    .styled.chunks.map((chunk) => chunk.text)
    .join("")

test("keeps Edited for a mixed group and labels each child row by its file kind", () => {
  const mixedBlock = {
    ...editToolBlock,
    id: "mixed",
    files: [
      {
        key: "mixed:0",
        path: "tmp-agent-test.txt",
        kind: "add",
        patch: "--- /dev/null\n+++ b/tmp-agent-test.txt\n@@ -0,0 +1 @@\n+hello",
        additions: 1,
        deletions: 0,
        preview: false,
        status: "complete",
      },
      {
        key: "mixed:1",
        path: "src/a.ts",
        kind: "update",
        patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
        additions: 1,
        deletions: 1,
        preview: false,
        status: "complete",
      },
    ],
  } as const
  const collapsed = renderedText({ blocks: [mixedBlock], expandedRowKeys: [] })
  expect(collapsed).toContain("Edited 2 files")
  const expanded = renderedText({ blocks: [mixedBlock], expandedRowKeys: ["tool:mixed"] })
  expect(expanded).toContain("Create tmp-agent-test.txt +1")
  expect(expanded).toContain("Edit src/a.ts +1 -1")
})

test("labels a new-file Diff block Created", () => {
  const created = renderedText({
    blocks: [
      {
        _tag: "Diff",
        path: "tmp-agent-test.txt",
        patch: "--- /dev/null\n+++ b/tmp-agent-test.txt\n@@ -0,0 +1 @@\n+hello",
      },
    ],
    expandedRowKeys: [],
  })
  expect(created).toContain("Created tmp-agent-test.txt")
})

test("connects and aligns the subagent response after two blank timeline rows", () => {
  const state = model({
    entries: [
      {
        role: "assistant",
        text: "Architectural overview\n\nThe projection stays pure.",
        turnId: "child:agent",
      },
    ],
    blocks: [{ ...subagentToolBlock, detail: "Inspect the projection" }, shell("child-a", "bun test", "passed")],
    items: [
      { _tag: "Block", index: 0, id: "tool:agent", turnId: "turn" },
      { _tag: "Block", index: 1, id: "tool:child-a", turnId: "child:agent", parentId: "agent" },
      { _tag: "Entry", index: 0, id: "assistant:child:agent:0", turnId: "child:agent", parentId: "agent" },
    ],
    expandedRowKeys: ["tool:agent"],
  })
  const lines = buildTranscript(state)
    .styled.chunks.map((chunk) => chunk.text)
    .join("")
    .split("\n")
  const childRow = lines.findIndex((line) => line.includes("bun test"))
  const responseRow = lines.findIndex((line) => line.includes("Architectural overview"))
  expect(childRow).toBeGreaterThan(-1)
  expect(lines[childRow]!.startsWith("  ├ ✓ $ bun test")).toBe(true)
  expect(responseRow).toBe(childRow + 3)
  expect(lines[childRow + 1]).toBe("  │")
  expect(lines[childRow + 2]).toBe("  │")
  expect(lines[responseRow]!.indexOf("Architectural overview")).toBe(lines[childRow]!.indexOf("$ bun test"))
  const lastResponseRow = lines.findIndex((line) => line.includes("stays pure"))
  expect(lastResponseRow).toBeGreaterThan(responseRow)
  for (const [offset, row] of lines.slice(childRow + 1, lastResponseRow).entries())
    expect([offset, row.startsWith("  │")]).toEqual([offset, true])
  expect(lines[lastResponseRow]!.startsWith("  ╰ ")).toBe(true)
  expect(lines.every((line) => !line.startsWith("│"))).toBe(true)
})

test("keeps wrapped response continuations inside the rail and curls the final row", () => {
  const state = model({
    width: 60,
    entries: [
      {
        role: "assistant",
        text: "1. Splitting the resident endpoint into separate host and client transports removes the restart complexity.",
        turnId: "child:agent",
      },
    ],
    blocks: [{ ...subagentToolBlock, detail: "Inspect the projection" }, shell("child-a", "bun test", "passed")],
    items: [
      { _tag: "Block", index: 0, id: "tool:agent", turnId: "turn" },
      { _tag: "Block", index: 1, id: "tool:child-a", turnId: "child:agent", parentId: "agent" },
      { _tag: "Entry", index: 0, id: "assistant:child:agent:0", turnId: "child:agent", parentId: "agent" },
    ],
    expandedRowKeys: ["tool:agent"],
  })
  const lines = buildTranscript(state)
    .styled.chunks.map((chunk) => chunk.text)
    .join("")
    .split("\n")
  const first = lines.findIndex((line) => line.includes("Splitting"))
  const continuation = lines.findIndex((line) => line.includes("complexity"))
  expect(first).toBeGreaterThan(-1)
  expect(continuation).toBeGreaterThan(first)
  const responseRows = lines.slice(first, continuation + 1)
  expect(responseRows.length).toBeGreaterThan(1)
  for (const row of responseRows.slice(0, -1)) expect(row.startsWith("  │   ")).toBe(true)
  expect(responseRows[responseRows.length - 1]!.startsWith("  ╰   ")).toBe(true)
  for (const row of responseRows) expect(row.length).toBeLessThanOrEqual(60)
})

test("expands a failed subagent to its prompt and stored error text", () => {
  const lines = nonEmptyLines(
    renderedText({
      blocks: [
        {
          ...subagentToolBlock,
          status: "failed",
          detail: "Inspect the projection",
          output: "AgentToolError: Model gpt-5.6-luna is not available",
        },
      ],
      expandedRowKeys: ["tool:agent"],
    }),
  )
  expect(lines.some((line) => line.includes("Inspect the projection"))).toBe(true)
  expect(lines.some((line) => line.includes("AgentToolError: Model gpt-5.6-luna is not available"))).toBe(true)
})

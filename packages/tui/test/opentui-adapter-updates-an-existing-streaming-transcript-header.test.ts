import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Data, Effect } from "effect"
import { Surface } from "../src/adapter"
import { initial, ready, update, type Model } from "../src/view-state"

class OpenTuiError extends Data.TaggedError("OpenTuiError")<{ readonly cause: unknown }> {}

const openTui = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new OpenTuiError({ cause }) })

const insertText = (model: Model, text: string) => update(model, { _tag: "Pasted", text })

const styledTextValue = (value: { readonly chunks: ReadonlyArray<{ readonly text: string }> } | string) =>
  typeof value === "string" ? value : value.chunks.map((chunk) => chunk.text).join("")

const streamingShell = (id: string, output?: string) => ({
  _tag: "ToolCall" as const,
  id,
  name: "bash",
  input: `{"command":"printf ${id}"}`,
  status: "running" as const,
  presentation: {
    family: "shell" as const,
    action: "shell",
    activeLabel: "Running",
    completeLabel: "Ran",
  },
  detail: `printf ${id}`,
  ...(output === undefined ? {} : { output }),
  files: [],
})

test("updates an existing streaming transcript header when it becomes expandable", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      let model: Model = {
        ...initial("/work", "high"),
        blocks: [streamingShell("first", "first-output"), streamingShell("streaming")],
        items: [
          { _tag: "Block", index: 0, id: "first", turnId: "turn-streaming" },
          { _tag: "Block", index: 1, id: "streaming", turnId: "turn-streaming" },
        ],
        expandedRowKeys: ["tool:first"],
      }
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        clickToggle: (unit) => {
          model = update(model, { _tag: "DetailToggled", id: unit })
          surface.update(model)
        },
        resize: () => undefined,
      })
      const records = () =>
        (
          surface as unknown as {
            readonly transcriptRecords: ReadonlyMap<
              string,
              {
                readonly renderable: {
                  readonly screenX: number
                  readonly screenY: number
                  readonly selectable: boolean
                }
              }
            >
          }
        ).transcriptRecords
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        const before = records().get("tool-child:streaming:header")!.renderable
        expect(before.selectable).toBe(true)

        model = { ...model, blocks: [model.blocks[0]!, streamingShell("streaming", "late-output")] }
        surface.update(model)
        yield* openTui(() => setup.flush())
        const after = records().get("tool-child:streaming:header")!.renderable
        expect(after).toBe(before)
        expect(after.selectable).toBe(false)
        yield* openTui(() => setup.mockMouse.click(after.screenX + 4, after.screenY))
        yield* openTui(() => setup.flush())
        expect(model.expandedRowKeys).toContain("tool-child:streaming")
        expect(setup.renderer.getSelection()).toBeNull()
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("renders a subagent tool tree and expands each child independently", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 32 }))
      const presentation = {
        agent: {
          family: "agent" as const,
          action: "oracle",
          activeLabel: "Oracle exploring",
          completeLabel: "Oracle has spoken",
        },
        explore: {
          family: "explore" as const,
          action: "read",
          activeLabel: "Exploring",
          completeLabel: "Explored",
          counter: "file" as const,
        },
        shell: {
          family: "shell" as const,
          action: "command",
          activeLabel: "Running",
          completeLabel: "Ran",
        },
      }
      let model: Model = {
        ...initial("/work", "high"),
        width: 80,
        height: 32,
        entries: [
          {
            role: "assistant",
            text: "## Review complete\n\n**No defects found.**",
            turnId: "child:oracle",
          },
        ],
        blocks: [
          {
            _tag: "ToolCall",
            id: "oracle-parent",
            name: "oracle",
            input: '{"prompt":"Review the code"}',
            status: "complete",
            presentation: presentation.agent,
            detail: "Review the code",
            childId: "child:oracle",
            files: [],
          },
          {
            _tag: "ToolCall",
            id: "child-read",
            name: "read",
            input: '{"path":"src/a.ts","offset":2,"limit":3}',
            output: "read child output",
            status: "complete",
            presentation: presentation.explore,
            detail: "src/a.ts L2-4",
            files: [],
          },
          {
            _tag: "ToolCall",
            id: "child-agent",
            name: "task",
            input: '{"prompt":"Explore packages"}',
            status: "complete",
            presentation: {
              family: "agent",
              action: "task",
              activeLabel: "Subagent working",
              completeLabel: "Subagent finished",
            },
            detail:
              "Read-only explore packages/config, extensions, and tools. Report concise public responsibilities with source-file evidence.",
            files: [],
          },
          {
            _tag: "ToolCall",
            id: "child-shell",
            name: "bash",
            input: '{"command":"bun test"}',
            output: "shell child output",
            status: "complete",
            presentation: presentation.shell,
            detail: "bun test",
            files: [],
          },
        ],
        items: [
          { _tag: "Block", index: 0, id: "tool:oracle-parent", turnId: "turn" },
          { _tag: "Block", index: 1, id: "tool:child-read", turnId: "child:oracle", parentId: "oracle-parent" },
          { _tag: "Block", index: 2, id: "tool:child-agent", turnId: "child:oracle", parentId: "oracle-parent" },
          { _tag: "Block", index: 3, id: "tool:child-shell", turnId: "child:oracle", parentId: "oracle-parent" },
          {
            _tag: "Entry",
            index: 0,
            id: "assistant:child:oracle:0",
            turnId: "child:oracle",
            parentId: "oracle-parent",
          },
        ],
        expandedRowKeys: ["tool:oracle-parent"],
      }
      const opened: Array<{ readonly path: string; readonly line?: number; readonly column?: number }> = []
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        openPath: (target) => opened.push(target),
        clickToggle: (unit) => {
          model = update(model, { _tag: "DetailToggled", id: unit })
          surface.update(model)
        },
        resize: () => undefined,
      })
      const records = () =>
        (
          surface as unknown as {
            readonly transcriptRecords: ReadonlyMap<
              string,
              {
                readonly renderable: {
                  readonly content: { readonly chunks: ReadonlyArray<{ readonly text: string }> }
                  readonly screenX: number
                  readonly screenY: number
                }
              }
            >
          }
        ).transcriptRecords
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        const collapsed = setup.captureCharFrame()
        expect(collapsed).toContain("Oracle has spoken ▾")
        expect(collapsed).toContain("Review the code")
        expect(collapsed).toContain("├ ✓ Read src/a.ts L2-4 ▸")
        expect(collapsed).toContain("├ ✓ Subagent finished Read-only explore")
        expect(collapsed).toContain("├ ✓ $ bun test ▸")
        expect(collapsed).toContain("Review complete")
        expect(collapsed).toContain("No defects found.")
        expect(collapsed).not.toContain("##")
        expect(collapsed).not.toContain("**")
        expect(collapsed).not.toContain("read child output")
        expect(collapsed).not.toContain("shell child output")
        const collapsedLines = collapsed.split("\n")
        const shellRow = collapsedLines.findIndex((line) => line.includes("$ bun test"))
        const responseRow = collapsedLines.findIndex((line) => line.includes("Review complete"))
        expect(responseRow).toBe(shellRow + 3)
        expect(collapsedLines[shellRow + 1]!.trim()).toBe("│")
        expect(collapsedLines[shellRow + 2]!.trim()).toBe("│")
        expect(collapsedLines[responseRow]!.indexOf("Review complete")).toBe(
          collapsedLines[shellRow]!.indexOf("$ bun test"),
        )

        const agent = records().get("tool:child-agent:header")!.renderable
        const agentLines = styledTextValue(agent.content).split("\n")
        expect(agentLines.length).toBeGreaterThan(1)
        expect(agentLines.slice(1).every((line) => line.startsWith("  │   "))).toBe(true)
        const markerLine = agentLines.at(-1)!
        yield* openTui(() =>
          setup.mockMouse.click(agent.screenX + markerLine.indexOf("▸"), agent.screenY + agentLines.length - 1),
        )
        yield* openTui(() => setup.flush())
        expect(model.expandedRowKeys).toContain("tool:child-agent")

        const read = records().get("tool:child-read:header")!.renderable
        yield* openTui(() => setup.mockMouse.click(read.screenX + 4, read.screenY))
        yield* openTui(() => setup.flush())
        expect(model.expandedRowKeys).toContain("tool:child-read")
        expect(setup.captureCharFrame()).toContain("read child output")
        expect(setup.captureCharFrame()).not.toContain("shell child output")

        yield* openTui(() => setup.mockMouse.click(read.screenX + 12, read.screenY))
        expect(opened).toEqual([{ path: "src/a.ts", line: 3, column: 1 }])
        expect(model.expandedRowKeys).toContain("tool:child-read")

        const shell = records().get("tool:child-shell:header")!.renderable
        yield* openTui(() => setup.mockMouse.click(shell.screenX + 4, shell.screenY))
        yield* openTui(() => setup.flush())
        expect(model.expandedRowKeys).toContain("tool:child-shell")
        expect(setup.captureCharFrame()).toContain("shell child output")

        const expandedRead = records().get("tool:child-read:header")!.renderable
        yield* openTui(() => setup.mockMouse.click(expandedRead.screenX + 4, expandedRead.screenY))
        yield* openTui(() => setup.flush())
        expect(model.expandedRowKeys).not.toContain("tool:child-read")
        expect(setup.captureCharFrame()).not.toContain("read child output")
        expect(setup.captureCharFrame()).toContain("shell child output")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("drags the composer top border through OpenTUI mouse routing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const pointers: Array<string> = []
      ;(setup.renderer as unknown as { realStdoutWrite?: undefined }).realStdoutWrite = undefined
      setup.renderer.setMousePointer = (style) => pointers.push(style)
      let model = initial("/work", "high")
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        composerResize: (height) => {
          model = update(model, { _tag: "ComposerHeightChanged", height })
          surface.update(model)
        },
        resize: () => undefined,
      })
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        expect(surface.inputBox.height).toBe(5)
        expect(model.input).toBe("")
        yield* openTui(() => setup.mockMouse.moveTo(20, surface.inputBox.y))
        expect(pointers.at(-1)).toBe("move")
        yield* openTui(() => setup.mockMouse.drag(20, surface.inputBox.y, 20, surface.inputBox.y - 4))
        yield* openTui(() => setup.renderOnce())
        expect(model.composerHeight).toBe(9)
        expect(surface.inputBox.height).toBe(9)
        yield* openTui(() => setup.mockMouse.moveTo(20, surface.inputBox.y + 1))
        expect(pointers.at(-1)).toBe("default")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps the welcome mark renderable stable while typing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30 }))
      let model: Model = { ...initial("/work", "high"), width: 100, height: 30 }
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        resize: () => undefined,
      })
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const transcriptChildren = () =>
          (surface as unknown as { readonly transcriptChildren: ReadonlyArray<{ readonly content: unknown }> })
            .transcriptChildren
        const before = transcriptChildren()[0]
        const beforeContent = before?.content
        expect(before).toBeDefined()
        for (const character of "hello world") {
          model = update(model, {
            _tag: "KeyPressed",
            key: {
              name: character,
              ctrl: false,
              alt: false,
              meta: false,
              shift: false,
              sequence: character,
              eventType: "press",
            },
          })
          surface.update(model)
        }
        yield* openTui(() => setup.renderOnce())
        expect(transcriptChildren()[0]).toBe(before)
        expect(transcriptChildren()[0]?.content).toBe(beforeContent)
        expect(setup.captureCharFrame()).toContain("Welcome to Rika")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("drags the sidebar left border to resize it through OpenTUI mouse routing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 120, height: 30 }))
      const pointers: Array<string> = []
      ;(setup.renderer as unknown as { realStdoutWrite?: undefined }).realStdoutWrite = undefined
      setup.renderer.setMousePointer = (style) => pointers.push(style)
      let model: Model = {
        ...initial("/work", "high"),
        width: 120,
        height: 30,
        changedFilesOpen: true,
        changedFiles: ready([
          { path: "src/a-really-long-file-name-that-truncates.ts", status: "M", added: 1, removed: 0 },
        ]),
      }
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        sidebarResize: (width) => {
          model = update(model, { _tag: "SidebarWidthChanged", width })
          surface.update(model)
        },
        resize: () => undefined,
      })
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        expect(surface.changedFilesBox.visible).toBe(true)
        const borderX = surface.changedFilesBox.x
        yield* openTui(() => setup.mockMouse.moveTo(borderX, 10))
        expect(pointers.at(-1)).toBe("move")
        const narrowFrame = setup.captureCharFrame()
        expect(narrowFrame).not.toContain("a-really-long-file-name-that-truncates.ts")
        yield* openTui(() => setup.mockMouse.drag(borderX, 10, borderX - 24, 10))
        yield* openTui(() => setup.renderOnce())
        expect(model.sidebarWidth).toBe(60)
        expect(surface.changedFilesBox.width).toBe(58)
        const frame = setup.captureCharFrame()
        expect(frame).toContain("Changed files (1)")
        expect(frame).toContain("a-really-long-file-name-that-truncates.ts")
        surface.changedFilesBox.focus()
        yield* openTui(() => setup.renderOnce())
        const focusBlue = setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .some((span) => span.text.includes("│") && span.fg.toInts().join(",") === "0,170,255,255")
        expect(focusBlue).toBe(false)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("routes bracketed multiline paste through the adapter as collapsed text", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      let model = initial("/work", "high")
      const surface = new Surface(setup.renderer, {
        key: () => undefined,
        paste: (text) => {
          model = insertText(model, text)
          surface.update(model)
        },
        resize: () => undefined,
      })
      try {
        const pasted = "first line\nsecond [literal] line\nthird line"
        surface.update(model)
        yield* openTui(() => setup.mockInput.pasteBracketedText(pasted))
        expect(model.input).toHaveLength(1)
        expect(model.pastedText[0]?.type === "text" ? model.pastedText[0].value : undefined).toBe(pasted)
        expect(model.pastedText[0]?.label).toBe("[Pasted text #1 +3 lines]")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

import { Renderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Data, Effect } from "effect"
import stringWidth from "string-width"
import { Surface } from "../src/adapter"
import { initial, loading, ready, replaceQueue, update, type Model, type ThreadItem } from "../src/view-state"

class OpenTuiError extends Data.TaggedError("OpenTuiError")<{ readonly cause: unknown }> {}

const openTui = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new OpenTuiError({ cause }) })

const styledTextValue = (value: { readonly chunks: ReadonlyArray<{ readonly text: string }> } | string) =>
  typeof value === "string" ? value : value.chunks.map((chunk) => chunk.text).join("")

const thread = (input: Partial<ThreadItem> & Pick<ThreadItem, "id" | "title">): ThreadItem => ({
  workspace: "/work",
  pinned: false,
  archived: false,
  status: "idle",
  unread: false,
  lastActivityAt: 0,
  ...input,
})

test("drives keyboard, palette, resize, frame capture, and teardown", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      let model: Model = initial("/work", "high")
      const surface = new Surface(setup.renderer, {
        key: (key) => {
          model = update(model, { _tag: "KeyPressed", key })
          if (key.name === "return" && !key.shift) model = update(model, { _tag: "Submitted" })
          surface.update(model)
        },
        resize: (width, height) => {
          model = update(model, { _tag: "Resized", width, height })
          surface.update(model)
        },
      })
      try {
        setup.resize(80, 24)
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const welcome = setup.captureCharFrame()
        expect(welcome).toContain("Welcome to Rika")
        expect(welcome).toContain("ctrl+o for commands")
        expect(welcome).toContain("? for shortcuts")
        expect(welcome).not.toContain("Threads")
        expect(welcome).not.toContain("Local durable coding agent")
        expect(welcome).not.toContain("▏")
        model = update(model, { _tag: "FilesReplaced", files: ["src/main.ts", "docs/SPEC.md"] })
        surface.update(model)
        yield* openTui(() => setup.mockInput.typeText("@main"))
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).toContain("src/main.ts")
        model = { ...model, input: "", cursor: 0 }
        surface.update(model)
        setup.mockInput.pressKey("s", { ctrl: true })
        yield* openTui(() => setup.renderOnce())
        const modeFrame = setup.captureCharFrame()
        expect(modeFrame).toContain("GPT-5.6 Sol")
        expect(modeFrame).toContain("Deep reasoning for hard tasks")
        model = update(model, {
          _tag: "KeyPressed",
          key: {
            name: "escape",
            ctrl: false,
            alt: false,
            meta: false,
            shift: false,
            sequence: "\u001b",
            eventType: "press",
          },
        })
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        expect(model.modePicker.open).toBe(false)
        yield* openTui(() => setup.mockInput.typeText("?"))
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).toContain("toggle this help")
        expect(model.input).toBe("?")
        yield* openTui(() => setup.mockInput.typeText("?"))
        yield* openTui(() => setup.mockInput.typeText("hello"))
        setup.mockInput.pressEnter()
        model = update(model, { _tag: "TurnStarted", turnId: "turn-hello", prompt: "?hello" })
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).toContain("┃ ?hello")
        model = update(model, { _tag: "AssistantStreamed", text: "stream" })
        model = update(model, { _tag: "AssistantStreamed", text: "ing" })
        model = update(model, { _tag: "ReasoningStreamed", text: "checking" })
        model = replaceQueue(model, [{ id: "next-task", prompt: "next task" }])
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const streamingFrame = setup.captureCharFrame()
        expect(streamingFrame).toContain("streaming")
        expect(streamingFrame).toContain("next task")
        setup.mockInput.pressKey("o", { ctrl: true })
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).toContain("Command Palette")
        setup.mockInput.pressKey("o", { ctrl: true })
        model = update(model, {
          _tag: "BlockAdded",
          block: {
            _tag: "ToolCall",
            id: "1",
            name: "read",
            input: "src/main.ts",
            status: "running",
            presentation: {
              family: "explore",
              action: "read",
              activeLabel: "Exploring",
              completeLabel: "Explored",
              counter: "file",
            },
            detail: "src/main.ts",
            files: [],
          },
        })
        model = update(model, { _tag: "BlockAdded", block: { _tag: "Diff", path: "src/main.ts", patch: "-old\n+new" } })
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const activityFrame = setup.captureCharFrame()
        expect(activityFrame).toMatch(/[⠀-⣿] Exploring 1 file ▸/u)
        expect(activityFrame).toContain("Edited src/main.ts +1 -1")
        model = update(model, {
          _tag: "BlockAdded",
          block: { _tag: "Workflow", name: "release", step: "verify", status: "running" },
        })
        model = update(model, {
          _tag: "BlockAdded",
          block: {
            _tag: "ImageAttachment",
            name: "screen.png",
            mediaType: "image/png",
            width: 800,
            height: 600,
            bytes: 1200,
          },
        })
        setup.resize(80, 40)
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const metadataFrame = setup.captureCharFrame()
        expect(metadataFrame).toContain("Workflow release")
        expect(metadataFrame).toContain("screen.png · image/png · 800×600 · 1200 bytes")
        setup.resize(50, 12)
        yield* openTui(() => setup.renderOnce())
        expect([model.width, model.height]).toEqual([50, 12])
        const retained = Renderable.renderablesByNumber.size
        for (let index = 0; index < 25; index += 1) surface.update(model)
        expect(Renderable.renderablesByNumber.size).toBe(retained)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps every overlay above the composer at 50x12", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 50, height: 12 }))
      let model: Model = { ...initial("/work", "high"), width: 50, height: 12 }
      model = update(model, { _tag: "FilesReplaced", files: ["src/main.ts"] })
      model = update(model, {
        _tag: "ThreadsReplaced",
        threads: [thread({ id: "thread-2", title: "Release notes", workspace: "/two" })],
      })
      const base = model
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      const capture = Effect.fn("capture")(function* (next: Model, title: string, content: string, composerRow = 7) {
        model = next
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        const rows = frame.split("\n")
        expect(frame).toContain(title)
        expect(frame).toContain(content)
        expect(rows[composerRow]?.startsWith("╭")).toBe(true)
        expect(rows[11]?.startsWith("╰")).toBe(true)
      })
      try {
        yield* capture(
          { ...base, paletteOpen: true, palette: { ...base.palette, open: true } },
          "Command Palette",
          "toggle fast mode",
        )
        yield* capture({ ...base, modePicker: { ...base.modePicker, open: true } }, "←→ turn · esc", "GPT-5.6")
        yield* capture({ ...base, shortcutsOpen: true }, "command palette", "Ctrl+O", 4)
        yield* capture({ ...base, filePicker: { ...base.filePicker, open: true } }, "@src", "@src")
        yield* capture(
          { ...base, threadSwitcher: { ...base.threadSwitcher, open: true, kind: "mention" } },
          "Mention Thread",
          "Release notes",
        )
        yield* capture(
          { ...base, threadSwitcher: { ...base.threadSwitcher, open: true } },
          "Switch Thread",
          "Release notes",
        )
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

for (const [width, height] of [
  [140, 40],
  [100, 24],
  [60, 16],
  [59, 14],
  [40, 12],
  [24, 8],
  [20, 8],
  [12, 6],
] as const) {
  test(`bounds responsive surfaces inside a ${width}x${height} terminal`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* openTui(() => createTestRenderer({ width, height }))
        const queued = replaceQueue(
          {
            ...initial("/work", "high"),
            width,
            height,
            input: "界🙂e\u0301".repeat(12),
            cursor: 60,
            changedFilesOpen: true,
            changedFiles: ready([{ path: "src/界🙂e\u0301.ts", status: "M", added: 2, removed: 1 }]),
            filePicker: {
              open: false,
              query: "",
              selected: 0,
              items: ready(["src/界🙂e\u0301.ts"]),
            },
            threadSidebar: { open: true, focused: true, selected: 0, scrollTop: 0 },
            threads: [thread({ id: "unicode-thread", title: "界🙂e\u0301 thread" })],
          },
          [{ id: "tiny-queue", prompt: "queued 界🙂e\u0301".repeat(10) }],
        )
        const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
        const bounded = (name: string, renderable: { x: number; y: number; width: number; height: number }) => {
          const bounds = { x: renderable.x, y: renderable.y, width: renderable.width, height: renderable.height }
          expect(renderable.x).toBeGreaterThanOrEqual(0)
          expect(renderable.y).toBeGreaterThanOrEqual(0)
          expect(renderable.x + renderable.width, `${name} horizontal ${JSON.stringify(bounds)}`).toBeLessThanOrEqual(
            width,
          )
          expect(renderable.y + renderable.height, `${name} vertical ${JSON.stringify(bounds)}`).toBeLessThanOrEqual(
            height,
          )
        }
        try {
          for (const model of [
            { ...queued, paletteOpen: true, palette: { ...queued.palette, open: true } },
            { ...queued, modePicker: { ...queued.modePicker, open: true } },
            { ...queued, filePicker: { ...queued.filePicker, open: true } },
            { ...queued, filePicker: { ...queued.filePicker, open: true, items: ready([]) } },
            { ...queued, filePicker: { ...queued.filePicker, open: true, items: loading } },
            { ...queued, threadSwitcher: { ...queued.threadSwitcher, open: true } },
          ]) {
            surface.update(model)
            yield* openTui(() => setup.renderOnce())
            bounded("composer", surface.inputBox)
            bounded("queue", surface.queueBox)
            bounded("overlay", surface.paletteBox)
            bounded("content", surface.contentColumn)
            if (model.modePicker.open || model.filePicker.open) {
              expect(surface.paletteBox.x).toBeGreaterThanOrEqual(surface.contentColumn.x)
              expect(surface.paletteBox.x + surface.paletteBox.width).toBeLessThanOrEqual(
                surface.contentColumn.x + surface.contentColumn.width,
              )
            }
            if (surface.sidebar.visible) bounded("thread sidebar", surface.sidebar)
            if (surface.changedFilesBox.visible) {
              bounded("file sidebar", surface.changedFilesBox)
              const state = surface as unknown as {
                readonly changedRows: ReadonlyArray<{ readonly chunks: ReadonlyArray<{ readonly text: string }> }>
              }
              const innerWidth = Math.max(1, surface.changedFilesBox.width - 6)
              expect(
                state.changedRows.every(
                  (row) => row.chunks.reduce((total, chunk) => total + stringWidth(chunk.text), 0) <= innerWidth,
                ),
              ).toBe(true)
            }
            if (surface.overlayEditor.visible) {
              bounded("overlay editor", surface.overlayEditor)
              expect(surface.overlayEditor.x).toBeGreaterThanOrEqual(surface.paletteBox.x)
              expect(surface.overlayEditor.x + surface.overlayEditor.width).toBeLessThanOrEqual(
                surface.paletteBox.x + surface.paletteBox.width,
              )
            }
            const overlayText = styledTextValue(surface.palette.content)
            const overlayInnerWidth = Math.max(1, surface.paletteBox.width - 4)
            expect(
              overlayText.split("\n").every((line) => stringWidth(line) <= overlayInnerWidth),
              `${width} columns with ${overlayInnerWidth} overlay cells:\n${overlayText}`,
            ).toBe(true)
          }
          surface.showToast("Selection 界👩‍💻e\u0301 copied to clipboard")
          yield* openTui(() => setup.renderOnce())
          bounded("toast", surface.toastBox)
          expect(stringWidth(styledTextValue(surface.toast.content))).toBeLessThanOrEqual(
            Math.max(1, surface.toastBox.width - 4),
          )
        } finally {
          surface.destroy()
          setup.renderer.destroy()
        }
      }),
    ))
}

test("joins the durable queue to the composer like Amp", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      let model = replaceQueue(
        { ...initial("/work", "medium"), busy: true, activity: { _tag: "Streaming", bytes: 40 } },
        [
          { id: "queued-1", prompt: "First queued prompt" },
          { id: "queued-2", prompt: "Selected queued prompt" },
        ],
      )
      model = { ...model, queueSelection: "queued-2" }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update({ ...model, queueSelection: undefined })
        yield* openTui(() => setup.renderOnce())
        expect(setup.captureCharFrame()).not.toContain("Enter to steer")
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        const rows = frame.split("\n")
        expect(frame).toContain("First queued prompt")
        expect(frame).toContain("Selected queued p…")
        expect(frame).not.toContain("queued 1/2")
        expect(frame).not.toContain("queued 2/2")
        expect(frame).toContain("Enter to steer")
        expect(frame).toContain("Backspace to dequeue")
        expect(frame).toContain("Ctrl+E to edit")
        expect(rows.findIndex((row) => row.includes("Enter to steer"))).toBe(
          rows.findIndex((row) => row.includes("Selected queued p…")),
        )
        expect(rows.find((row) => row.includes("Enter to steer"))).toMatch(/Ctrl\+E to edit  │ $/)
        expect(surface.queueBox.height).toBe(4)
        expect(surface.inputBox.y).toBe(surface.queueBox.y + surface.queueBox.height - 1)
        expect(rows[surface.queueBox.y]?.startsWith(" ╭")).toBe(true)
        expect(rows[surface.inputBox.y]?.startsWith("╭┴")).toBe(true)
        expect(rows[surface.inputBox.y]?.endsWith("╮")).toBe(true)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("renders an inline hint on the selected queued row as the queue window moves", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 60, height: 14 }))
      const items = Array.from({ length: 8 }, (_, index) => ({ id: `q${index}`, prompt: `prompt number ${index}` }))
      const base = replaceQueue({ ...initial("/work", "medium"), busy: true, width: 60, height: 14 }, items)
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update({ ...base, queueSelection: "q0" })
        yield* openTui(() => setup.renderOnce())
        const top = setup.captureCharFrame()
        const topRows = top.split("\n")
        expect(top).not.toContain("queued 1/8")
        expect(topRows.findIndex((row) => row.includes("Enter to steer"))).toBe(
          topRows.findIndex((row) => row.includes("prompt number 0")),
        )
        surface.update({ ...base, queueSelection: "q7" })
        yield* openTui(() => setup.renderOnce())
        const bottom = setup.captureCharFrame()
        const bottomRows = bottom.split("\n")
        expect(bottom).not.toContain("queued 8/8")
        expect(bottomRows.findIndex((row) => row.includes("Enter to steer"))).toBe(
          bottomRows.findIndex((row) => row.includes("prompt number 7")),
        )
        expect(bottom).not.toContain("prompt number 0")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("shows the editing hint inline on the queued row being edited", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      const model = {
        ...replaceQueue({ ...initial("/work", "medium"), busy: true, width: 80, height: 24 }, [
          { id: "a", prompt: "alpha" },
          { id: "b", prompt: "beta" },
        ]),
        queueSelection: "b",
        editingTurnId: "b",
        input: "beta edited",
        cursor: "beta edited".length,
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const frame = setup.captureCharFrame()
        const rows = frame.split("\n")
        expect(frame).toContain("Editing queued")
        expect(frame).not.toContain("2/2")
        expect(frame).toContain("Enter save")
        expect(frame).toContain("Esc cancel")
        expect(rows.findIndex((row) => row.includes("Editing queued"))).toBe(
          rows.findIndex((row) => row.includes("beta")),
        )
        expect(surface.queueBox.height).toBe(4)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

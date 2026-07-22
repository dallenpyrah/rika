import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Data, Effect } from "effect"
import { Surface } from "../src/adapter"
import { colors } from "../src/theme"
import { initial, ready, replaceQueue, update, type Model } from "../src/view-state"

class OpenTuiError extends Data.TaggedError("OpenTuiError")<{ readonly cause: unknown }> {}

const openTui = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => new OpenTuiError({ cause }) })

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

test("rebuilds the large changed-files sidebar per set change, not per streaming frame", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 120, height: 40 }))
      const paths = Array.from(
        { length: 10_000 },
        (_, index) => `src/feature-${Math.floor(index / 20)}/file-${index}.ts`,
      )
      const files = (revision: number) =>
        ready(paths.map((path) => ({ path, status: "M", added: revision, removed: 0 })))
      const base: Model = {
        ...initial("/work", "high"),
        width: 120,
        height: 40,
        changedFilesOpen: true,
        changedFiles: files(1),
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(base)
        yield* openTui(() => setup.flush())
        const state = surface as unknown as { readonly changedRows: ReadonlyArray<unknown> }
        const boundedWindow = () =>
          expect(surface.changedFilesBox.content.height).toBeLessThanOrEqual(
            surface.changedFilesBox.viewport.height + 1,
          )
        boundedWindow()
        let rebuilds = 0
        let previousRows = state.changedRows
        let model = base
        for (let tick = 0; tick < 4; tick += 1) {
          for (let frame = 0; frame < 5; frame += 1) {
            model = Object.assign({}, model, {
              entries: [{ role: "assistant", text: `streaming ${tick}:${frame}` }],
            })
            surface.update(model)
            if (state.changedRows !== previousRows) {
              rebuilds += 1
              previousRows = state.changedRows
            }
          }
          model = { ...model, changedFiles: files(tick + 2) }
          surface.update(model)
          if (state.changedRows !== previousRows) {
            rebuilds += 1
            previousRows = state.changedRows
          }
          boundedWindow()
        }
        expect(rebuilds).toBe(4)
        expect(surface.changedFilesBox.scrollHeight).toBe(state.changedRows.length)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("expands the queue box to fit a wrapped single-line queued prompt joined to the composer", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 40, height: 24 }))
      let model: Model = { ...initial("/work", "high"), width: 40, height: 24 }
      model = replaceQueue(model, [{ id: "q1", prompt: "x".repeat(120) }])
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        expect(surface.queueBox.visible).toBe(true)
        expect(surface.queueBox.height).toBeGreaterThanOrEqual(6)
        expect(surface.queueRightJoint.top).toBe(model.height - surface.inputBox.height)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("renders autonomous welcome animation frames while otherwise event-driven", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24, clock }))
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { clock })
      try {
        surface.update({ ...initial("/work", "high"), width: 80, height: 24 })
        yield* openTui(() => setup.renderOnce())
        const first = setup.captureCharFrame()
        clock.advance(100)
        yield* openTui(() => setup.renderOnce())
        const second = setup.captureCharFrame()
        expect(first).toContain("Welcome to Rika")
        expect(second).toContain("Welcome to Rika")
        expect(second).not.toBe(first)
        expect(setup.renderer.isRunning).toBe(false)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("ticks Amp status and running-tool spinners every 200ms without rebuilding transcript bodies", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30, clock }))
      const running = {
        _tag: "ToolCall" as const,
        id: "long-running",
        name: "bash",
        input: '{"command":"sleep 5"}',
        status: "running" as const,
        presentation: {
          family: "shell" as const,
          action: "command",
          activeLabel: "Running",
          completeLabel: "Ran",
        },
        detail: "sleep 5",
        output: "still running",
        files: [],
      }
      const model: Model = {
        ...initial("/work", "high"),
        width: 100,
        height: 30,
        busy: true,
        activity: { _tag: "Thinking", bytes: 20 },
        blocks: [running],
        items: [{ _tag: "Block", index: 0, id: "tool:long-running", turnId: "turn" }],
        expandedRowKeys: ["tool:long-running"],
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { clock })
      const records = () =>
        (
          surface as unknown as {
            readonly transcriptRecords: ReadonlyMap<
              string,
              { readonly renderable: { readonly content: { readonly chunks: ReadonlyArray<{ text: string }> } } }
            >
          }
        ).transcriptRecords
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        const body = records().get("tool:long-running:body")!.renderable
        const firstBodyContent = body.content
        expect(styledTextValue(surface.statusLabel.content)).toContain("∼ Thinking 5 tok")
        expect(styledTextValue(records().get("tool:long-running:header")!.renderable.content)).toContain("⠭")

        clock.advance(199)
        expect(styledTextValue(surface.statusLabel.content)).toContain("∼ Thinking 5 tok")
        expect(styledTextValue(records().get("tool:long-running:header")!.renderable.content)).toContain("⠭")
        clock.advance(1)
        expect(styledTextValue(surface.statusLabel.content)).toContain("≈ Thinking 5 tok")
        expect(styledTextValue(records().get("tool:long-running:header")!.renderable.content)).toMatch(/[⠀-⣿] sleep 5/u)
        expect(body.content).toBe(firstBodyContent)

        clock.advance(200)
        expect(styledTextValue(surface.statusLabel.content)).toContain("≋ Thinking 5 tok")
        clock.advance(200)
        expect(styledTextValue(surface.statusLabel.content)).toContain("≈ Thinking 5 tok")
        clock.advance(200)
        expect(styledTextValue(surface.statusLabel.content)).toContain("∼ Thinking 5 tok")
        clock.advance(200)
        expect(styledTextValue(surface.statusLabel.content)).toContain("∼ Thinking 5 tok")
        expect(body.content).toBe(firstBodyContent)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("does not animate a cancelled subagent again when a new turn starts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30, clock }))
      const parent = {
        _tag: "ToolCall" as const,
        id: "cancelled-parent",
        name: "task",
        input: "{}",
        status: "cancelled" as const,
        presentation: {
          family: "agent" as const,
          action: "task",
          activeLabel: "Subagent working",
          completeLabel: "Subagent finished",
        },
        detail: "Run the checks",
        files: [],
      }
      const cancelled: Model = {
        ...initial("/work", "high"),
        width: 100,
        height: 30,
        blocks: [parent],
        items: [{ _tag: "Block", index: 0, id: "tool:cancelled-parent", turnId: "old-turn" }],
      }
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { clock })
      const header = () =>
        styledTextValue(
          (
            surface as unknown as {
              readonly transcriptRecords: ReadonlyMap<
                string,
                { readonly renderable: { readonly content: { readonly chunks: ReadonlyArray<{ text: string }> } } }
              >
            }
          ).transcriptRecords.get("tool:cancelled-parent:header")!.renderable.content,
        )
      try {
        surface.update(cancelled)
        yield* openTui(() => setup.renderOnce())
        expect(header()).toContain("⊘ Subagent cancelled ▸")

        surface.update({
          ...cancelled,
          busy: true,
          activeTurnId: "new-turn",
          activity: { _tag: "Waiting" },
          entries: [{ role: "user", text: "continue", turnId: "new-turn" }],
          items: [...cancelled.items, { _tag: "Entry", index: 0, id: "turn:new-turn:user", turnId: "new-turn" }],
        })
        yield* openTui(() => setup.renderOnce())
        const before = header()
        clock.advance(600)
        const after = header()

        expect(after).toBe(before)
        expect(after).toContain("⊘ Subagent cancelled ▸")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("keeps the status spinner moving across a tool-result lull without feed events", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 100, height: 30, clock }))
      let model: Model = { ...initial("/work", "high"), width: 100, height: 30, busy: true }
      model = update(model, {
        _tag: "EventReplayed",
        event: {
          id: "tool-call",
          cursor: "1",
          turnId: "turn",
          block: streamingShell("tool-lull"),
        },
      })
      model = update(model, {
        _tag: "EventReplayed",
        event: {
          id: "tool-result",
          cursor: "2",
          turnId: "turn",
          block: { _tag: "ToolResult", id: "tool-lull", output: "done", failed: false },
        },
      })
      const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined }, { clock })
      try {
        surface.update(model)
        yield* openTui(() => setup.renderOnce())
        expect(styledTextValue(surface.statusLabel.content)).toContain("∼ Waiting")
        clock.advance(200)
        expect(styledTextValue(surface.statusLabel.content)).toContain("≈ Waiting")
        clock.advance(200)
        expect(styledTextValue(surface.statusLabel.content)).toContain("≋ Waiting")
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

test("toggles expandable transcript headers without selecting them and keeps bodies selectable", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const setup = yield* openTui(() => createTestRenderer({ width: 80, height: 24 }))
      let model: Model = {
        ...initial("/work", "high"),
        input: "draft remains editable",
        cursor: "draft remains editable".length,
        blocks: [
          {
            _tag: "ToolCall",
            id: "shell-selection",
            name: "bash",
            input: '{"command":"printf transcript-output"}',
            status: "complete",
            presentation: {
              family: "shell",
              action: "shell",
              activeLabel: "Running",
              completeLabel: "Ran",
            },
            detail: "printf transcript-output",
            output: "transcript-output",
            files: [],
          },
        ],
        items: [{ _tag: "Block", index: 0, id: "shell-selection", turnId: "turn-selection" }],
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
                  readonly content: {
                    readonly chunks: ReadonlyArray<{
                      readonly text: string
                      readonly fg?: { readonly equals: (color: unknown) => boolean }
                    }>
                  }
                }
              }
            >
          }
        ).transcriptRecords
      const commandIsBlue = () =>
        records()
          .get("tool:shell-selection:header")!
          .renderable.content.chunks.some(
            (chunk) => chunk.text.includes("printf transcript-output") && chunk.fg?.equals(colors.blue) === true,
          )
      try {
        surface.update(model)
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState()).toMatchObject({ visible: true, blinking: true })
        expect(commandIsBlue()).toBe(false)
        const header = records().get("tool:shell-selection:header")!.renderable
        yield* openTui(() => setup.mockMouse.click(header.screenX + 2, header.screenY))
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState()).toMatchObject({ visible: true, blinking: true })
        expect(model.expandedRowKeys).toContain("tool:shell-selection")
        expect(model.detailSelection).toBeUndefined()
        expect(commandIsBlue()).toBe(false)
        expect(setup.renderer.getSelection()).toBeNull()

        const body = records().get("tool:shell-selection:body")!.renderable
        yield* openTui(() => setup.mockMouse.drag(body.screenX, body.screenY, body.screenX + 20, body.screenY))
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState()).toMatchObject({ visible: true, blinking: true })
        expect(setup.renderer.getSelection()?.getSelectedText()).toContain("transcript-output")
        setup.renderer.clearSelection()

        const expandedHeader = records().get("tool:shell-selection:header")!.renderable
        yield* openTui(() => setup.mockMouse.click(expandedHeader.screenX + 2, expandedHeader.screenY))
        yield* openTui(() => setup.flush())
        expect(setup.renderer.getCursorState()).toMatchObject({ visible: true, blinking: true })
        expect(model.expandedRowKeys).not.toContain("tool:shell-selection")
        expect(commandIsBlue()).toBe(false)
        expect(setup.renderer.getSelection()).toBeNull()

        model = update(model, {
          _tag: "KeyPressed",
          key: {
            name: "tab",
            ctrl: false,
            alt: false,
            meta: false,
            shift: false,
            sequence: "",
            eventType: "press",
          },
        })
        surface.update(model)
        yield* openTui(() => setup.flush())
        expect(model.detailSelection).toBe("tool:shell-selection")
        expect(commandIsBlue()).toBe(true)
      } finally {
        surface.destroy()
        setup.renderer.destroy()
      }
    }),
  ))

import { expect, test } from "vitest"
import { Keys, ViewState } from "../src"

const key = (input: Partial<Keys.Key> & Pick<Keys.Key, "name">): Keys.Key => ({
  name: input.name,
  ctrl: input.ctrl ?? false,
  alt: input.alt ?? false,
  meta: input.meta ?? false,
  shift: input.shift ?? false,
  sequence: input.sequence ?? "",
  eventType: input.eventType ?? "press",
})

const readCall = (
  id: string,
  detail: string,
  status: "running" | "complete" = "running",
): Extract<ViewState.TranscriptBlock, { _tag: "ToolCall" }> => ({
  _tag: "ToolCall",
  id,
  name: "read",
  input: detail,
  status,
  presentation: {
    family: "explore",
    action: "read",
    activeLabel: "Exploring",
    completeLabel: "Explored",
    counter: "file",
  },
  detail,
  files: [],
})

const editFile = (id: string, path: string) => ({
  key: id,
  path,
  kind: "update" as const,
  patch: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`,
  additions: 1,
  deletions: 1,
  preview: false,
  status: "complete" as const,
})

const busyQueueModel = (model: ViewState.Model): ViewState.Model => ({
  ...model,
  busy: true,
  currentThreadId: "t",
})

test("executes every focused palette action", () => {
  let model = ViewState.initial("/work")
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
  for (const character of "change mode")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.modePicker.open).toBe(true)
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "down" }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.mode).toBe("high")

  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
  for (const character of "thread switch")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.threadSwitcher.open).toBe(true)
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })

  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
  for (const character of "fast")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.fastMode).toBe(true)

  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
  for (const character of "quit")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.pendingAction).toEqual({ _tag: "Quit" })
})

test("keeps overlays exclusive and types @ and ? into a non-empty composer", () => {
  let model = { ...ViewState.initial("/work"), input: "draft", cursor: 5 }
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
  expect(model).toMatchObject({ paletteOpen: false, palette: { open: false }, filePicker: { open: true } })
  expect(model.input).toBe("draft@")
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "/", sequence: "?", shift: true }) })
  expect(model).toMatchObject({ shortcutsOpen: false, filePicker: { open: true, query: "?" } })
  expect(model.input).toBe("draft@?")
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
  expect(model.filePicker.open).toBe(false)
  expect(model.input).toBe("draft@?")
  model = { ...model, input: "", cursor: 0 }
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "/", sequence: "?", shift: true }) })
  expect(model.shortcutsOpen).toBe(true)
  expect(model.input).toBe("?")
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
  expect(model.shortcutsOpen).toBe(false)
})

test("opens shortcuts only for the first question mark in an empty composer", () => {
  let sentence = { ...ViewState.initial("/work"), input: "how was your day", cursor: 16 }
  sentence = ViewState.update(sentence, {
    _tag: "KeyPressed",
    key: key({ name: "/", sequence: "?", shift: true }),
  })
  expect(sentence).toMatchObject({
    input: "how was your day?",
    cursor: 17,
    shortcutsOpen: false,
    shortcutsTrigger: undefined,
  })

  let model = ViewState.update(ViewState.initial("/work"), {
    _tag: "KeyPressed",
    key: key({ name: "/", sequence: "?", shift: true }),
  })
  expect(model).toMatchObject({ input: "?", cursor: 1, shortcutsOpen: true, shortcutsTrigger: 0 })

  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "a", sequence: "a" }) })
  expect(model).toMatchObject({ input: "?a", cursor: 2, shortcutsOpen: true, shortcutsTrigger: 0 })

  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "/", sequence: "?", shift: true }) })
  expect(model).toMatchObject({ input: "?a", cursor: 2, shortcutsOpen: false, shortcutsTrigger: undefined })

  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "/", sequence: "?", shift: true }) })
  expect(model).toMatchObject({ input: "?a?", cursor: 3, shortcutsOpen: false, shortcutsTrigger: undefined })

  model = ViewState.update(ViewState.initial("/work"), {
    _tag: "KeyPressed",
    key: key({ name: "/", sequence: "?", shift: true }),
  })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
  expect(model).toMatchObject({ input: "", cursor: 0, shortcutsOpen: false, shortcutsTrigger: undefined })
})

test("does not open shortcuts when question mark is typed in a dialog", () => {
  let model = ViewState.update(ViewState.initial("/work"), {
    _tag: "KeyPressed",
    key: key({ name: "o", ctrl: true }),
  })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "/", sequence: "?", shift: true }) })
  expect(model).toMatchObject({ shortcutsOpen: false, palette: { open: true, query: "?" }, input: "" })

  model = {
    ...ViewState.initial("/work"),
    blocks: [
      {
        _tag: "Permission",
        id: "permission",
        kind: "tool-approval",
        status: "pending",
        title: "Run command",
        detail: "bun test",
      },
    ],
  } as ViewState.Model
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "/", sequence: "?", shift: true }) })
  expect(model).toMatchObject({ shortcutsOpen: false, input: "" })
})

test("keeps an empty palette open with a valid selection and no action", () => {
  let model = ViewState.update(ViewState.initial("/work"), {
    _tag: "KeyPressed",
    key: key({ name: "o", ctrl: true }),
  })
  for (const character of "no such command")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "down" }) })
  expect(model.palette.selected).toBe(0)
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model).toMatchObject({ paletteOpen: true, palette: { open: true, selected: 0 } })
  expect(model.pendingAction).toBeUndefined()
})

test("switches mutually exclusively between the workspace file tree and changed files", () => {
  let model = ViewState.initial("/work")
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "t", alt: true }) })
  expect(model).toMatchObject({ workspaceFilesOpen: true, changedFilesOpen: false })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "s", alt: true }) })
  expect(model).toMatchObject({ workspaceFilesOpen: false, changedFilesOpen: true })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "t", alt: true }) })
  expect(model).toMatchObject({ workspaceFilesOpen: true, changedFilesOpen: false })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "t", alt: true }) })
  expect(model).toMatchObject({ workspaceFilesOpen: false, changedFilesOpen: false })
})

test("toggles every transcript detail as one reducer action", () => {
  let model = {
    ...ViewState.initial("/work"),
    blocks: [
      { _tag: "Reasoning", text: "why" },
      readCall("read", "src/a.ts", "complete"),
      { _tag: "Diff", path: "src/a.ts", patch: "+a" },
    ],
  } as ViewState.Model
  model = ViewState.update(model, { _tag: "AllDetailsToggled" })
  expect(model.expandedRowKeys).toEqual(["block:Reasoning:0", "tool:read", "block:Diff:2"])
  model = ViewState.update(model, { _tag: "AllDetailsToggled" })
  expect(model.expandedRowKeys).toEqual([])
})

test("keeps an unchanged changed-files snapshot stable", () => {
  const files = [{ path: "src/a.ts", status: "M", added: 1, removed: 2 }]
  const model = ViewState.update(ViewState.initial("/work"), { _tag: "ChangedFilesReplaced", files })

  expect(ViewState.update(model, { _tag: "ChangedFilesReplaced", files: [...files] })).toBe(model)
})

test("selects permission decisions and executes the pending choice from keys", () => {
  let model = ViewState.update(ViewState.initial("/work"), {
    _tag: "BlockAdded",
    block: { _tag: "Permission", id: "p", kind: "tool-approval", title: "Write", detail: "a.ts", status: "pending" },
  })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "right" }) })
  expect(model.permissionSelection).toBe(1)
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.pendingAction).toEqual({
    _tag: "DecidePermission",
    id: "p",
    kind: "tool-approval",
    decision: "always",
  })
  expect(model.blocks[0]).toMatchObject({ status: "approved" })
})

test("cancels only the matching permission and clears its stale action", () => {
  let model = ViewState.update(ViewState.initial("/work"), {
    _tag: "BlockAdded",
    block: { _tag: "Permission", id: "old", kind: "permission", title: "Old", detail: "old", status: "pending" },
  })
  model = ViewState.update(model, {
    _tag: "BlockAdded",
    block: { _tag: "Permission", id: "new", kind: "permission", title: "New", detail: "new", status: "pending" },
  })
  model = ViewState.update(model, { _tag: "PermissionDecisionSelected", id: "old" })
  model = ViewState.update(model, { _tag: "PermissionCancelled", id: "old" })

  expect(model.blocks).toMatchObject([
    { id: "old", status: "denied" },
    { id: "new", status: "pending" },
  ])
  expect(model.pendingAction).toBeUndefined()
  expect(model.permissionSelection).toBe(0)
})

test("moves up into queued turns and down or Escape back to the composer", () => {
  let model = ViewState.replaceQueue({ ...ViewState.initial("/work"), busy: true }, [
    { id: "one", prompt: "one" },
    { id: "two", prompt: "two" },
  ])
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  expect(model.queueSelection).toBe("two")
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  expect(model.queueSelection).toBe("one")
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "down" }) })
  expect(model.queueSelection).toBe("two")
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "down" }) })
  expect(model.queueSelection).toBeUndefined()
  expect(model.pendingAction).toBeUndefined()
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  expect(model.queueSelection).toBe("two")
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
  expect(model.queueSelection).toBeUndefined()
  expect(model.pendingAction).toBeUndefined()
})

test("steers and dequeues only while a queued turn is selected", () => {
  let model = ViewState.replaceQueue({ ...ViewState.initial("/work"), busy: true }, [
    { id: "one", prompt: "one" },
    { id: "two", prompt: "two" },
  ])
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.pendingAction).toEqual({ _tag: "SteerQueued", id: "two", prompt: "two" })
  model = { ...model, pendingAction: undefined }
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
  expect(model.pendingAction).toEqual({ _tag: "Dequeue", id: "two" })
})

test("leaves the queue unchanged when Backspace is pressed from the composer", () => {
  const model = ViewState.update(
    ViewState.replaceQueue({ ...ViewState.initial("/work"), busy: true }, [
      { id: "first", prompt: "first" },
      { id: "second", prompt: "second" },
    ]),
    { _tag: "KeyPressed", key: key({ name: "backspace" }) },
  )
  expect(model.queueSelection).toBeUndefined()
  expect(model.pendingAction).toBeUndefined()
})

test("keeps queue navigation inactive on reset and Added", () => {
  let model = ViewState.resetQueue(busyQueueModel(ViewState.initial("/work")), "t", 1, [
    { id: "a", prompt: "a" },
    { id: "b", prompt: "b" },
  ])
  expect(model.queueSelection).toBeUndefined()
  const added = ViewState.applyQueueDelta(model, "t", 2, { _tag: "Added", item: { id: "c", prompt: "c" } })
  expect(added.resync).toBe(false)
  expect(added.model.queueSelection).toBeUndefined()
})

test("keeps a still-valid selection across reset and Updated", () => {
  let model = ViewState.resetQueue(busyQueueModel(ViewState.initial("/work")), "t", 1, [
    { id: "a", prompt: "a" },
    { id: "b", prompt: "b" },
  ])
  model = { ...model, queueSelection: "a" }
  model = ViewState.resetQueue(model, "t", 2, [
    { id: "a", prompt: "a" },
    { id: "b", prompt: "b" },
  ])
  expect(model.queueSelection).toBe("a")
  const updated = ViewState.applyQueueDelta(model, "t", 3, { _tag: "Updated", item: { id: "a", prompt: "a3" } })
  expect(updated.model.queueSelection).toBe("a")
  expect(updated.model.queue[0]).toEqual({ id: "a", prompt: "a3" })
})

test("reselects the neighbor at the same index when the selected queued turn is removed", () => {
  let model = ViewState.resetQueue(busyQueueModel(ViewState.initial("/work")), "t", 1, [
    { id: "a", prompt: "a" },
    { id: "b", prompt: "b" },
    { id: "c", prompt: "c" },
  ])
  model = { ...model, queueSelection: "b" }
  const removed = ViewState.applyQueueDelta(model, "t", 2, { _tag: "Removed", turnId: "b" })
  expect(removed.model.queue.map((item) => item.id)).toEqual(["a", "c"])
  expect(removed.model.queueSelection).toBe("c")
})

test("reconciles a mismatched durable queued count by requesting a resync", () => {
  const model = ViewState.resetQueue(busyQueueModel(ViewState.initial("/work")), "t", 1, [{ id: "a", prompt: "a" }])
  const applied = ViewState.applyQueueDelta(model, "t", 2, { _tag: "Added", item: { id: "b", prompt: "b" } }, 5)
  expect(applied.resync).toBe(true)
})

test("edits a queued turn: Ctrl+E loads it, Enter saves EditQueued, Escape restores", () => {
  let model = ViewState.resetQueue(busyQueueModel(ViewState.initial("/work")), "t", 1, [
    { id: "a", prompt: "alpha" },
    { id: "b", prompt: "beta" },
  ])
  expect(model.queueSelection).toBeUndefined()
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  expect(model.queueSelection).toBe("b")
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "e", ctrl: true }) })
  expect(model.editingTurnId).toBe("b")
  expect(model.input).toBe("beta")
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "!", sequence: "!" }) })
  expect(model.input).toBe("beta!")
  const saved = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(saved.pendingAction).toEqual({ _tag: "EditQueued", id: "b", prompt: "beta!" })
  expect(saved.editingTurnId).toBeUndefined()
  expect(saved.input).toBe("")
  const cancelled = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
  expect(cancelled.editingTurnId).toBeUndefined()
  expect(cancelled.queueSelection).toBeUndefined()
  expect(cancelled.input).toBe("")
  expect(cancelled.pendingAction).toBeUndefined()
})

test("Enter on a selected queued row without edit mode still steers", () => {
  let model = ViewState.resetQueue(busyQueueModel(ViewState.initial("/work")), "t", 1, [{ id: "a", prompt: "alpha" }])
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.pendingAction).toEqual({ _tag: "SteerQueued", id: "a", prompt: "alpha" })
  expect(model.editingTurnId).toBeUndefined()
})

test("does not allow submit while editing a queued turn", () => {
  expect(ViewState.canSubmit({ ...ViewState.initial("/work"), editingTurnId: "b", input: "edited" })).toBe(false)
  expect(ViewState.canSubmit({ ...ViewState.initial("/work"), input: "normal" })).toBe(true)
})

test("exits edit mode and restores the composer when the edited queued turn is removed", () => {
  let model = ViewState.resetQueue(busyQueueModel(ViewState.initial("/work")), "t", 1, [
    { id: "a", prompt: "alpha" },
    { id: "b", prompt: "beta" },
  ])
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "e", ctrl: true }) })
  expect(model.editingTurnId).toBe("b")
  expect(model.input).toBe("beta")
  const removed = ViewState.applyQueueDelta(model, "t", 2, { _tag: "Removed", turnId: "b" }).model
  expect(removed.editingTurnId).toBeUndefined()
  expect(removed.editReturn).toBeUndefined()
  expect(removed.input).toBe("")
})

test("blocks image attachment while editing a queued turn", () => {
  let model = ViewState.resetQueue(busyQueueModel(ViewState.initial("/work")), "t", 1, [{ id: "a", prompt: "alpha" }])
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "e", ctrl: true }) })
  expect(model.editingTurnId).toBe("a")
  const after = ViewState.update(model, { _tag: "ImageInserted", path: "/tmp/x.png" })
  expect(after.input).toBe(model.input)
  expect(after.pastedText).toEqual([])
})

test("ignores queue dequeue and edit re-entry keys while editing with a cleared composer", () => {
  let model = ViewState.resetQueue(busyQueueModel(ViewState.initial("/work")), "t", 1, [{ id: "a", prompt: "alpha" }])
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "e", ctrl: true }) })
  model = { ...model, input: "", cursor: 0 }
  const backspaced = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
  expect(backspaced.pendingAction).toBeUndefined()
  expect(backspaced.editingTurnId).toBe("a")
  const reentry = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "e", ctrl: true }) })
  expect(reentry.input).toBe("")
})

test("navigates transcript detail units with Tab and toggles the selected unit", () => {
  let model = {
    ...ViewState.initial("/work"),
    blocks: [
      { _tag: "Reasoning", text: "why" },
      readCall("1", "a", "complete"),
      { _tag: "Diff", path: "a", patch: "+a" },
    ],
  } as ViewState.Model
  model = ViewState.update({ ...model, detailSelection: "block:Diff:2" }, { _tag: "DetailToggled", id: "block:Diff:2" })
  expect(model).toMatchObject({
    detailSelection: "block:Diff:2",
    expandedRowKeys: ["block:Diff:2"],
  })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "tab", shift: true }) })
  expect(model.detailSelection).toBe("tool:1")
  model = ViewState.update(model, { _tag: "DetailToggled", id: "tool:1" })
  expect(model).toMatchObject({
    detailSelection: "tool:1",
    expandedRowKeys: ["block:Diff:2", "tool:1"],
  })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "tab" }) })
  expect(model.detailSelection).toBe("block:Diff:2")
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "tab" }) })
  expect(model.detailSelection).toBe("block:Reasoning:0")
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.expandedRowKeys).toEqual(["block:Diff:2", "tool:1", "block:Reasoning:0"])
})

test("keeps an expanded streamed tool group open as new children arrive", () => {
  let model = ViewState.update(ViewState.initial("/work"), { _tag: "BlockAdded", block: readCall("1", "a") })
  model = ViewState.update(model, { _tag: "DetailToggled", id: "tool:1" })
  for (let index = 2; index <= 5; index += 1)
    model = ViewState.update(model, {
      _tag: "BlockAdded",
      block: readCall(String(index), String.fromCharCode(96 + index)),
    })

  expect(model.expandedRowKeys).toContain("tool:1")
  const collapsed = ViewState.update(model, { _tag: "DetailToggled", id: "tool:1" })
  expect(collapsed.expandedRowKeys).not.toContain("tool:1")
})

test("click toggles do not move the Tab detail selection", () => {
  const base = { ...ViewState.initial("/work"), blocks: [readCall("1", "a", "complete")] }
  const clicked = ViewState.update(base, { _tag: "DetailToggled", id: "tool:1" })
  expect(clicked).toMatchObject({ detailSelection: undefined, expandedRowKeys: ["tool:1"] })

  const tabbed = ViewState.update(clicked, { _tag: "KeyPressed", key: key({ name: "tab" }) })
  expect(tabbed.detailSelection).toBe("tool:1")
})

test("toggles an expanded edit group's file rows independently", () => {
  const call: Extract<ViewState.TranscriptBlock, { _tag: "ToolCall" }> = {
    _tag: "ToolCall",
    id: "patch",
    name: "edit",
    input: "{}",
    status: "complete",
    presentation: { family: "edit", action: "edit", activeLabel: "Editing", completeLabel: "Edited" },
    detail: "",
    files: [editFile("patch:0", "src/a.ts"), editFile("patch:1", "src/b.ts")],
  }
  const parent = "tool:patch"
  const child = "file:patch:0"
  const model = ViewState.update(
    { ...ViewState.initial("/work"), blocks: [call], expandedRowKeys: [parent] },
    { _tag: "DetailToggled", id: child },
  )

  expect(model).toMatchObject({ detailSelection: undefined, expandedRowKeys: [parent, child] })
})

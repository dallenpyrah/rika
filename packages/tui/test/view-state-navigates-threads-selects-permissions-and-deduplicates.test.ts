import { expect, test } from "vitest"
import { it } from "@effect/vitest"
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

const thread = (
  input: Partial<ViewState.ThreadItem> & Pick<ViewState.ThreadItem, "id" | "title">,
): ViewState.ThreadItem => ({
  workspace: "/work",
  pinned: false,
  archived: false,
  status: "idle",
  unread: false,
  lastActivityAt: 0,
  ...input,
})

test("navigates threads, selects permissions, and deduplicates replay", () => {
  let model = ViewState.update(ViewState.initial("/work"), {
    _tag: "ThreadsReplaced",
    threads: [thread({ id: "a", title: "First" }), thread({ id: "b", title: "Second", unread: true })],
  })
  model = ViewState.update(model, { _tag: "ThreadSidebarSelectionMoved", offset: 1 })
  model = ViewState.update(model, { _tag: "ThreadSidebarSelectionConfirmed" })
  expect(model.pendingAction).toEqual({ _tag: "SelectThread", id: "b" })
  model = {
    ...model,
    blocks: [{ _tag: "Permission", id: "p", kind: "permission", title: "P", detail: "d", status: "pending" }],
  }
  model = ViewState.update(model, { _tag: "PermissionSelectionMoved", offset: -1 })
  model = ViewState.update(model, { _tag: "PermissionDecisionSelected", id: "p" })
  expect(model.pendingAction).toEqual({ _tag: "DecidePermission", id: "p", kind: "permission", decision: "deny" })
  const event = {
    id: "stable",
    cursor: "42",
    block: { _tag: "ChildAgent", id: "review", name: "review", summary: "checking", status: "running", activity: [] },
  } as const
  model = ViewState.update(model, { _tag: "EventReplayed", event })
  const replayed = ViewState.update(model, { _tag: "EventReplayed", event })
  expect(replayed).toBe(model)
  expect(model).toMatchObject({ eventCursor: "42", seenEventIds: ["stable"] })
})

test("opens, filters, navigates, closes, and confirms the all-workspace thread switcher", () => {
  let model = ViewState.update(ViewState.initial("/work"), {
    _tag: "ThreadsReplaced",
    threads: [
      thread({ id: "a", title: "First", workspace: "/one" }),
      thread({ id: "b", title: "Second task", workspace: "/two", unread: true, archived: true }),
    ],
  })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "t", ctrl: true }) })
  expect(model.threadSwitcher.open).toBe(true)
  model = ViewState.update(model, { _tag: "ThreadPreviewScrolled", offset: 5 })
  expect(model.threadSwitcher.previewScroll).toBe(5)
  for (const character of "second")
    model = ViewState.update(model, {
      _tag: "KeyPressed",
      key: key({ name: character, sequence: character }),
    })
  expect(model.threadSwitcher.previewScroll).toBe(0)
  expect(ViewState.filteredThreads(model).map((item) => item.id)).toEqual(["b"])
  expect(ViewState.selectedThreadMetadata(model)).toMatchObject({ id: "b", workspace: "/two", archived: true })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.pendingAction).toEqual({ _tag: "SelectThread", id: "b" })
  expect(model.threadSwitcher.open).toBe(false)
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "w", alt: true }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
  expect(model.threadSwitcher.open).toBe(false)
})

test("clears stale previews for missing filters and removed or archived thread summaries", () => {
  let model = ViewState.update(ViewState.initial("/work"), {
    _tag: "ThreadsReplaced",
    threads: [thread({ id: "a", title: "Alpha" }), thread({ id: "b", title: "Beta" })],
  })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "t", ctrl: true }) })
  model = ViewState.update(model, {
    _tag: "ThreadPreviewLoaded",
    threadId: "a",
    turns: [{ prompt: "stale preview", events: [] }],
  })
  for (const character of "missing")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
  expect(model.threadPreview._tag).toBe("Idle")

  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "t", ctrl: true }) })
  model = ViewState.update(model, {
    _tag: "ThreadPreviewLoaded",
    threadId: "a",
    turns: [{ prompt: "removed preview", events: [] }],
  })
  model = ViewState.update(model, {
    _tag: "ThreadsReplaced",
    threads: [thread({ id: "b", title: "Beta" })],
  })
  expect(model.threadPreview._tag).toBe("Idle")
  expect(ViewState.selectedThreadMetadata(model)?.id).toBe("b")
  expect(model.threadSwitcher.previewScroll).toBe(0)
})

test("switches file completion to thread completion with @@ and inserts a typed thread mention", () => {
  let model = ViewState.update(ViewState.initial("/work"), {
    _tag: "ThreadsReplaced",
    threads: [thread({ id: "thread-2", title: "Release notes", workspace: "/two" })],
  })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
  expect(model.threadSwitcher).toMatchObject({ open: true, kind: "mention" })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "r", sequence: "r" }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.input).toBe("@thread-2 ")
})

test("removes a complete Unicode query character and keeps file completion open", () => {
  let model = ViewState.update(ViewState.initial("/work"), {
    _tag: "FilesReplaced",
    files: ["src/😀.ts"],
  })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "😀", sequence: "😀" }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
  expect(model.input).toBe("@")
  expect(model.filePicker).toMatchObject({ open: true, query: "", selected: 0 })
})

test("selects from refreshed file and thread results without retaining stale indexes", () => {
  let files = ViewState.update(ViewState.initial("/work"), {
    _tag: "FilesReplaced",
    files: ["a.ts", "b.ts", "c.ts"],
  })
  files = ViewState.update(files, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
  files = ViewState.update(files, { _tag: "KeyPressed", key: key({ name: "t", sequence: "t" }) })
  files = ViewState.update(files, { _tag: "KeyPressed", key: key({ name: "down" }) })
  files = ViewState.update(files, { _tag: "KeyPressed", key: key({ name: "down" }) })
  files = ViewState.update(files, { _tag: "FilesReplaced", files: ["only.ts"] })
  files = ViewState.update(files, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(files.input).toBe("@only.ts ")

  let threads = ViewState.update(ViewState.initial("/work"), {
    _tag: "ThreadsReplaced",
    threads: [thread({ id: "a", title: "A" }), thread({ id: "b", title: "B" }), thread({ id: "c", title: "C" })],
  })
  threads = ViewState.update(threads, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
  threads = ViewState.update(threads, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
  threads = ViewState.update(threads, { _tag: "KeyPressed", key: key({ name: "down" }) })
  threads = ViewState.update(threads, { _tag: "KeyPressed", key: key({ name: "down" }) })
  threads = ViewState.update(threads, {
    _tag: "ThreadsReplaced",
    threads: [thread({ id: "only", title: "Only" })],
  })
  threads = ViewState.update(threads, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(threads.input).toBe("@only ")
})

test("opens, focuses, navigates, and closes the fixed thread sidebar with ctrl+backslash", () => {
  let model = ViewState.update(ViewState.initial("/work"), {
    _tag: "ThreadsReplaced",
    threads: [thread({ id: "a", title: "First" }), thread({ id: "b", title: "Second" })],
  })
  model = ViewState.update(model, { _tag: "ThreadActivated", threadId: "b", title: "Second" })
  const toggle = { _tag: "KeyPressed", key: key({ name: "\\", ctrl: true, sequence: "\u001c" }) } as const
  model = ViewState.update(model, toggle)
  expect(model.threadSidebar).toMatchObject({ open: true, focused: false, selected: 1 })
  model = ViewState.update(model, toggle)
  expect(model.threadSidebar.focused).toBe(true)
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.pendingAction).toEqual({ _tag: "SelectThread", id: "a" })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
  expect(model.threadSidebar).toMatchObject({ open: true, focused: false })
  model = ViewState.update(model, toggle)
  model = ViewState.update(model, toggle)
  expect(model.threadSidebar.open).toBe(false)
})

test("keeps the thread sidebar selection visible when stale threads disappear", () => {
  let model = ViewState.update(ViewState.initial("/work"), {
    _tag: "ThreadsReplaced",
    threads: Array.from({ length: 40 }, (_, index) => thread({ id: String(index), title: `Thread ${index}` })),
  })
  model = {
    ...model,
    height: 8,
    threadSidebar: { open: true, focused: true, selected: 39, scrollTop: 32 },
  }
  model = ViewState.update(model, {
    _tag: "ThreadsReplaced",
    threads: [thread({ id: "fresh", title: "Fresh" })],
  })
  expect(model.threadSidebar).toMatchObject({ selected: 0, scrollTop: 0 })
})

test("bounds the thread sidebar on tiny terminals to preserve the main column", () => {
  const model = {
    ...ViewState.initial("/work"),
    width: 20,
    threadSidebar: { ...ViewState.initial("/work").threadSidebar, open: true },
  }
  expect(ViewState.boundedThreadSidebarWidth(model.width)).toBe(8)
  expect(ViewState.contentColumnWidth(model)).toBe(12)
})

test("covers reducer boundaries and every busy shortcut", () => {
  let model = ViewState.initial("/work")
  expect(ViewState.update(model, { _tag: "ThreadSidebarSelectionConfirmed" })).toBe(model)
  model = ViewState.update(model, { _tag: "AllDetailsToggled" })
  model = ViewState.update(model, { _tag: "ThreadsReplaced", threads: [] })
  model = ViewState.update(model, { _tag: "ThreadSidebarSelectionMoved", offset: 9 })
  model = ViewState.update(model, { _tag: "ScrollMoved", offset: -3 })
  model = ViewState.update(model, { _tag: "ReasoningToggled", index: 0 })
  model = ViewState.update(model, { _tag: "PaletteActionConsumed" })
  model = { ...model, busy: true, input: "go", cursor: 2 }
  expect(ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "c", ctrl: true }) }).pendingAction).toEqual({
    _tag: "Cancel",
  })
  expect(
    ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "s", ctrl: true }) }).pendingAction,
  ).toMatchObject({ _tag: "Steer" })
  expect(
    ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return", ctrl: true }) }).pendingAction,
  ).toMatchObject({ _tag: "InterruptAndSend" })
})

test("covers palette navigation, actions, mode wrapping, history boundaries, and explicit permission", () => {
  let model = ViewState.initial("/work", "low")
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "m", ctrl: true }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  expect(model.modePicker.selected).toBe(3)
  expect(model.mode).toBe("low")
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "x", sequence: "x" }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "escape" }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "o", ctrl: true }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "down" }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "up" }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "backspace" }) })
  for (const c of "mode") model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: c, sequence: c }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.modePicker.open).toBe(true)
  model = {
    ...model,
    blocks: [{ _tag: "Permission", id: "p", kind: "permission", title: "P", detail: "d", status: "pending" }],
  }
  model = ViewState.update(model, { _tag: "PermissionDecisionSelected", id: "p", decision: "allow" })
  expect(model.pendingAction).toMatchObject({ decision: "allow" })
  model = {
    ...model,
    blocks: [
      { _tag: "Permission", id: "p", kind: "permission", title: "P", detail: "d", status: "pending" },
      { _tag: "Notification", title: "queued", detail: "x" },
    ],
  }
  model = ViewState.update(model, { _tag: "PermissionDecisionSelected", id: "p", decision: "deny" })
  expect(model.blocks[0]).toMatchObject({ status: "denied" })
  const empty = ViewState.initial("/work")
  expect(ViewState.update(empty, { _tag: "KeyPressed", key: key({ name: "up" }) })).toBe(empty)
  expect(ViewState.inputRows({ ...empty, input: "\n".repeat(12) })).toBe(8)
})

test("replaces queue state without changing transcript blocks and covers remaining input navigation branches", () => {
  const base = {
    ...ViewState.initial("/work"),
    blocks: [{ _tag: "Notification", title: "N", detail: "d" }],
    history: ["alpha", "beta"],
  } as ViewState.Model
  const replaced = ViewState.replaceQueue(base, [
    { id: "new", prompt: "new" },
    { id: "next", prompt: "next" },
  ])
  expect(replaced.blocks).toEqual(base.blocks)
  expect(replaced.queue).toEqual([
    { id: "new", prompt: "new" },
    { id: "next", prompt: "next" },
  ])
  let model = ViewState.update(base, { _tag: "KeyPressed", key: key({ name: "down" }) })
  expect(model.input).toBe("")
  model = { ...model, input: "zzz", cursor: 3, historySearch: "alpha" }
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "r", ctrl: true }) })
  expect(model.input).toBe("zzz")
  model = { ...model, input: "", cursor: 0, historySearch: "alpha" }
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "r", ctrl: true }) })
  expect(model.input).toBe("alpha")
  expect(ViewState.isNarrow(ViewState.initial("/work"))).toBe(false)
  expect(ViewState.inputRows(ViewState.initial("/work"))).toBe(1)
})

test("blocks Enter submission while overlays or pending permissions are active", () => {
  const base = { ...ViewState.initial("/work"), input: "look at ", cursor: 8 }
  expect(ViewState.canSubmit(base)).toBe(true)
  expect(ViewState.canSubmit({ ...base, filePicker: { ...base.filePicker, open: true } })).toBe(false)
  expect(ViewState.canSubmit({ ...base, modePicker: { open: true, selected: 0 } })).toBe(false)
  expect(ViewState.canSubmit({ ...base, palette: { open: true, query: "", selected: 0 } })).toBe(false)
  expect(ViewState.canSubmit({ ...base, threadSwitcher: { ...base.threadSwitcher, open: true } })).toBe(false)
  expect(ViewState.canSubmit({ ...base, shortcutsOpen: true })).toBe(false)
  expect(ViewState.canSubmit({ ...base, input: "multi\\", cursor: 6 })).toBe(false)
  const withPermission = ViewState.update(base, {
    _tag: "BlockAdded",
    block: { _tag: "Permission", id: "p1", kind: "permission", title: "Run shell", detail: "ls", status: "pending" },
  })
  expect(ViewState.canSubmit(withPermission)).toBe(false)
})

test("selecting a file mention inserts it without clearing the composer", () => {
  let model = ViewState.update(ViewState.initial("/work"), {
    _tag: "FilesReplaced",
    files: ["src/main.ts"],
  })
  model = { ...model, input: "explain ", cursor: 8 }
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
  expect(ViewState.canSubmit(model)).toBe(false)
  for (const character of "main")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
  expect(model.input).toBe("explain @main")
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.input).toBe("explain @src/main.ts ")
  expect(model.filePicker.open).toBe(false)
  expect(ViewState.canSubmit(model)).toBe(true)
  expect(model.entries).toHaveLength(0)
})

test("quotes a selected file mention containing spaces", () => {
  let model = ViewState.update(ViewState.initial("/work"), {
    _tag: "FilesReplaced",
    files: ["docs/read me.md"],
  })
  model = { ...model, input: "read ", cursor: 5 }
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "@", sequence: "@" }) })
  for (const character of "read")
    model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: character, sequence: character }) })
  model = ViewState.update(model, { _tag: "KeyPressed", key: key({ name: "return" }) })
  expect(model.input).toBe('read @"docs/read me.md" ')
})

test("normalizes OpenTUI modifiers and printable keys", () => {
  expect(Keys.fromOpenTui({ name: "x", meta: true }).alt).toBe(true)
  expect(Keys.fromOpenTui({ name: "x", super: true }).meta).toBe(true)
  expect(Keys.fromOpenTui({ name: "x" })).toMatchObject({ sequence: "", eventType: "press" })
  expect(Keys.isPrintable(key({ name: "x", sequence: "x" }))).toBe(true)
  expect(Keys.isPrintable(key({ name: "x", sequence: "x", ctrl: true }))).toBe(false)
  expect(Keys.isPrintable(key({ name: "x", sequence: "x", alt: true }))).toBe(false)
  expect(Keys.isPrintable(key({ name: "x", sequence: "x", meta: true }))).toBe(false)
  expect(Keys.isPrintable(key({ name: "x", sequence: "" }))).toBe(false)
  expect(Keys.isPrintable(key({ name: "x", sequence: "\u001f" }))).toBe(false)
  expect(Keys.isPrintable(key({ name: "x", sequence: "\u007f" }))).toBe(false)
})

it("transitions changed files idle to loading to ready and keeps ready on refresh", () => {
  const base = ViewState.initial("/work")
  expect(base.changedFiles).toEqual({ _tag: "Idle" })
  const loading = ViewState.update(base, { _tag: "ChangedFilesRequested" })
  expect(loading.changedFiles).toEqual({ _tag: "Loading" })
  const ready = ViewState.update(loading, {
    _tag: "ChangedFilesReplaced",
    files: [{ path: "a.ts", status: "M", added: 1, removed: 0 }],
  })
  expect(ready.changedFiles._tag).toBe("Ready")
  const requestedAgain = ViewState.update(ready, { _tag: "ChangedFilesRequested" })
  expect(requestedAgain.changedFiles._tag).toBe("Ready")
  const refreshed = ViewState.update(requestedAgain, {
    _tag: "ChangedFilesReplaced",
    files: [{ path: "b.ts", status: "A", added: 2, removed: 0 }],
  })
  expect(ViewState.readyOr(refreshed.changedFiles, []).map((file) => file.path)).toEqual(["b.ts"])
})

it("transitions workspace files and keeps a stale thread preview while the next one loads", () => {
  const base = ViewState.initial("/work")
  expect(base.filePicker.items).toEqual({ _tag: "Idle" })
  const loading = ViewState.update(base, { _tag: "FilesRequested" })
  expect(loading.filePicker.items).toEqual({ _tag: "Loading" })
  const ready = ViewState.update(loading, { _tag: "FilesReplaced", files: ["src/main.ts"] })
  expect(ViewState.readyOr(ready.filePicker.items, [])).toEqual(["src/main.ts"])
  expect(ViewState.update(ready, { _tag: "FilesRequested" }).filePicker.items._tag).toBe("Ready")
  const firstPreviewLoading = ViewState.update(base, { _tag: "ThreadPreviewRequested" })
  expect(firstPreviewLoading.threadPreview).toEqual({ _tag: "Loading" })
  const previous = ViewState.update(firstPreviewLoading, {
    _tag: "ThreadPreviewLoaded",
    threadId: "thread-0",
    turns: [{ prompt: "previous", events: [] }],
  })
  const previewLoading = ViewState.update(previous, { _tag: "ThreadPreviewRequested" })
  expect(previewLoading.threadPreview).toEqual({
    _tag: "Loading",
    previous: { threadId: "thread-0", turns: [{ prompt: "previous", events: [] }] },
  })
  const previewReady = ViewState.update(previewLoading, {
    _tag: "ThreadPreviewLoaded",
    threadId: "thread-1",
    turns: [{ prompt: "hi", events: [] }],
  })
  expect(previewReady.threadPreview._tag).toBe("Ready")
  const opening = ViewState.update(base, { _tag: "ThreadOpenRequested" })
  expect(opening.threadLoading).toBe(true)
  expect(ViewState.update(opening, { _tag: "ThreadOpenCompleted" }).threadLoading).toBe(false)
})

it("clamps the sidebar width on change and terminal resize", () => {
  const base = { ...ViewState.initial("/work"), width: 120, height: 40 }
  expect(ViewState.update(base, { _tag: "SidebarWidthChanged", width: 200 }).sidebarWidth).toBe(80)
  expect(ViewState.update(base, { _tag: "SidebarWidthChanged", width: 10 }).sidebarWidth).toBe(24)
  const widened = ViewState.update(base, { _tag: "SidebarWidthChanged", width: 60 })
  expect(widened.sidebarWidth).toBe(60)
  const shrunk = ViewState.update(widened, { _tag: "Resized", width: 70, height: 40 })
  expect(shrunk.sidebarWidth).toBe(30)
})

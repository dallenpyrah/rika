import { isPrintable, type Key } from "../keys"
import { filter, type PaletteAction } from "../palette"
import { expandPastedText, fileMention, lastCharacterLength, questionKey } from "./composer"
import { internal as InternalComposer } from "./composer"
import { idle, readyOr, type Model, type QueueItem, type ThreadItem, type TranscriptBlock } from "./model"

export const filteredFiles = (model: Model): ReadonlyArray<string> => {
  const items = readyOr(model.filePicker.items, [])
  const query = model.filePicker.query.toLowerCase()
  if (query.length === 0) {
    const segments = new Set<string>()
    for (const file of items) segments.add(file.split("/")[0]!)
    return [...segments].toSorted().slice(0, 50)
  }
  return items.filter((file) => file.toLowerCase().includes(query)).slice(0, 50)
}

export const filteredThreads = (model: Model): ReadonlyArray<ThreadItem> => {
  const query = model.threadSwitcher.query.toLowerCase()
  return (model.threads as ReadonlyArray<ThreadItem>).filter((thread) =>
    `${thread.title} ${thread.workspace ?? ""} ${thread.id}`.toLowerCase().includes(query),
  )
}

export const selectedThreadMetadata = (model: Model): ThreadItem | undefined =>
  filteredThreads(model)[model.threadSwitcher.selected]

export const canSubmit = (model: Model): boolean =>
  model.editingTurnId === undefined &&
  !model.threadSwitcher.open &&
  !model.threadSidebar.focused &&
  !model.paletteOpen &&
  !model.palette.open &&
  !model.modePicker.open &&
  !model.filePicker.open &&
  !model.shortcutsOpen &&
  !(model.cursor > 0 && model.input[model.cursor - 1] === "\\") &&
  model.blocks.every((block) => {
    const candidate = block as TranscriptBlock
    return candidate._tag !== "Permission" || candidate.status !== "pending"
  })

export type Update = (model: Model, message: import("./model").Message) => Model

const keyPressed = (model: Model, key: Key, update: Update): Model => {
  if (key.eventType === "release") return model
  if (model.editingTurnId !== undefined) {
    if (key.name === "escape") {
      const restore = model.editReturn ?? { input: "", attachments: [] }
      return {
        ...model,
        editingTurnId: undefined,
        editReturn: undefined,
        queueSelection: undefined,
        input: restore.input,
        cursor: restore.input.length,
        pastedText: [...restore.attachments],
      }
    }
    if (key.name === "return" && !key.shift && !(model.cursor > 0 && model.input[model.cursor - 1] === "\\"))
      return {
        ...model,
        pendingAction: {
          _tag: "EditQueued",
          id: model.editingTurnId,
          prompt: expandPastedText(model.input, model.pastedText),
        },
        editingTurnId: undefined,
        editReturn: undefined,
        input: "",
        cursor: 0,
        pastedText: [],
      }
  }
  if (key.ctrl && (key.name === "\\" || key.sequence === "\u001c")) {
    const currentIndex = Math.max(
      0,
      (model.threads as ReadonlyArray<ThreadItem>).findIndex((thread) => thread.id === model.currentThreadId),
    )
    return model.threadSidebar.open
      ? model.threadSidebar.focused
        ? { ...model, threadSidebar: { ...model.threadSidebar, open: false, focused: false } }
        : { ...model, threadSidebar: { ...model.threadSidebar, focused: true } }
      : {
          ...model,
          threadSidebar: {
            open: true,
            focused: false,
            selected: currentIndex,
            scrollTop: Math.max(0, currentIndex - model.height + 1),
          },
        }
  }
  if (model.threadSidebar.open && model.threadSidebar.focused) {
    if (key.name === "escape") return { ...model, threadSidebar: { ...model.threadSidebar, focused: false } }
    if (key.name === "up") return update(model, { _tag: "ThreadSidebarSelectionMoved", offset: -1 })
    if (key.name === "down") return update(model, { _tag: "ThreadSidebarSelectionMoved", offset: 1 })
    if (key.name === "return") return update(model, { _tag: "ThreadSidebarSelectionConfirmed" })
    return model
  }
  if (!key.ctrl && !key.alt && !key.meta && key.name === "pageup")
    return {
      ...model,
      scrollOffset: Math.max(0, model.scrollOffset - Math.max(1, model.height - 6)),
      scrollFollow: false,
    }
  if (!key.ctrl && !key.alt && !key.meta && key.name === "pagedown")
    return {
      ...model,
      scrollOffset: model.scrollOffset + Math.max(1, model.height - 6),
      scrollFollow: false,
    }
  if (!key.ctrl && !key.alt && !key.meta && key.name === "end") return { ...model, scrollOffset: 0, scrollFollow: true }
  if ((key.ctrl && key.name === "t") || (key.alt && key.name === "w")) {
    const open = !model.threadSwitcher.open
    const selected = Math.max(
      0,
      filteredThreads({ ...model, threadSwitcher: { ...model.threadSwitcher, query: "" } }).findIndex(
        (thread) => thread.id === model.currentThreadId,
      ),
    )
    return {
      ...model,
      threadSwitcher: { open, query: "", selected, kind: "switch", previewScroll: 0 },
      paletteOpen: false,
      palette: { open: false, query: "", selected: 0 },
      modePicker: { ...model.modePicker, open: false },
      filePicker: { ...model.filePicker, open: false },
      shortcutsOpen: false,
      ...(open ? {} : { threadPreview: idle }),
    }
  }
  if (model.threadSwitcher.open) {
    const threads = filteredThreads(model)
    if (key.name === "escape")
      return {
        ...model,
        threadSwitcher: { open: false, query: "", selected: 0, kind: "switch", previewScroll: 0 },
        threadPreview: idle,
      }
    if (key.name === "return") {
      const thread = threads[model.threadSwitcher.selected]
      return thread === undefined
        ? model
        : model.threadSwitcher.kind === "mention"
          ? InternalComposer.insert(
              InternalComposer.erase(
                {
                  ...model,
                  threadSwitcher: {
                    open: false,
                    query: "",
                    selected: 0,
                    kind: "switch",
                    previewScroll: 0,
                  },
                  threadPreview: idle,
                },
                Math.min(2 + model.threadSwitcher.query.length, model.cursor),
              ),
              `@${thread.id} `,
            )
          : {
              ...model,
              threadSwitcher: {
                open: false,
                query: "",
                selected: 0,
                kind: "switch",
                previewScroll: 0,
              },
              threadPreview: idle,
              pendingAction: { _tag: "SelectThread", id: thread.id },
            }
    }
    if (key.name === "backspace") {
      if (model.threadSwitcher.kind === "mention" && model.threadSwitcher.query.length === 0)
        return InternalComposer.erase(
          {
            ...model,
            threadSwitcher: {
              open: false,
              query: "",
              selected: 0,
              kind: "switch",
              previewScroll: 0,
            },
            filePicker: { ...model.filePicker, open: true, query: "", selected: 0 },
          },
          1,
        )
      const next = {
        ...model,
        threadSwitcher: {
          ...model.threadSwitcher,
          query: model.threadSwitcher.query.slice(0, -lastCharacterLength(model.threadSwitcher.query)),
          selected: 0,
          previewScroll: 0,
        },
      }
      const restored =
        model.threadSwitcher.kind === "mention"
          ? InternalComposer.erase(next, lastCharacterLength(model.threadSwitcher.query))
          : next
      return filteredThreads(restored).length === 0 ? { ...restored, threadPreview: idle } : restored
    }
    const selected =
      key.name === "up"
        ? (model.threadSwitcher.selected + Math.max(1, threads.length) - 1) % Math.max(1, threads.length)
        : key.name === "down"
          ? (model.threadSwitcher.selected + 1) % Math.max(1, threads.length)
          : model.threadSwitcher.selected
    if (!isPrintable(key))
      return {
        ...model,
        threadSwitcher: {
          ...model.threadSwitcher,
          selected,
          previewScroll: selected === model.threadSwitcher.selected ? model.threadSwitcher.previewScroll : 0,
        },
      }
    const next = {
      ...model,
      threadSwitcher: {
        ...model.threadSwitcher,
        query: model.threadSwitcher.query + key.sequence,
        selected: 0,
        previewScroll: 0,
      },
    }
    const filtered = model.threadSwitcher.kind === "mention" ? InternalComposer.insert(next, key.sequence) : next
    return filteredThreads(filtered).length === 0 ? { ...filtered, threadPreview: idle } : filtered
  }
  if (key.ctrl && key.name === "o") {
    const open = !model.palette.open
    return {
      ...model,
      paletteOpen: open,
      palette: { open, query: "", selected: 0 },
      modePicker: { ...model.modePicker, open: false },
      filePicker: { ...model.filePicker, open: false },
      shortcutsOpen: false,
    }
  }
  if (!model.filePicker.open && !key.ctrl && !key.alt && !key.meta && key.sequence === "@")
    return InternalComposer.insert(
      {
        ...model,
        paletteOpen: false,
        palette: { open: false, query: "", selected: 0 },
        modePicker: { ...model.modePicker, open: false },
        filePicker: { ...model.filePicker, open: true, query: "", selected: 0 },
        shortcutsOpen: false,
      },
      "@",
    )
  if (key.ctrl && (key.name === "s" || key.name === "m") && !model.busy) {
    if (model.modePicker.open)
      return { ...model, modePicker: { open: true, selected: (model.modePicker.selected + 1) % 4 } }
    return {
      ...model,
      paletteOpen: false,
      palette: { open: false, query: "", selected: 0 },
      modePicker: { open: true, selected: ["low", "medium", "high", "ultra"].indexOf(model.mode) },
      filePicker: { ...model.filePicker, open: false },
      shortcutsOpen: false,
    }
  }
  if (key.ctrl && key.name === "c" && model.busy)
    return { ...model, activity: { _tag: "Waiting" }, pendingAction: { _tag: "Cancel" } }
  if (key.ctrl && key.name === "s" && model.busy && model.input.length > 0)
    return { ...model, pendingAction: { _tag: "Steer", prompt: model.input }, input: "", cursor: 0 }
  if (key.ctrl && key.name === "return" && model.busy && model.input.length > 0)
    return { ...model, pendingAction: { _tag: "InterruptAndSend", prompt: model.input }, input: "", cursor: 0 }
  if (key.alt && key.name === "t") {
    return update(model, { _tag: "WorkspaceFilesToggled" })
  }
  if (key.alt && key.name === "s") return update(model, { _tag: "SidebarViewToggled" })
  if (
    key.name === "escape" &&
    (model.palette.open || model.modePicker.open || model.filePicker.open || model.shortcutsOpen)
  )
    return {
      ...model,
      paletteOpen: false,
      palette: { open: false, query: "", selected: 0 },
      modePicker: { ...model.modePicker, open: false },
      filePicker: { ...model.filePicker, open: false, query: "", selected: 0 },
      shortcutsOpen: false,
      shortcutsTrigger: undefined,
    }
  if (model.shortcutsOpen) {
    if (questionKey(key)) return { ...model, shortcutsOpen: false, shortcutsTrigger: undefined }
    if (isPrintable(key)) return InternalComposer.insertWhileShortcutsOpen(model, key.sequence)
    const next = update({ ...model, shortcutsOpen: false, shortcutsTrigger: undefined }, { _tag: "KeyPressed", key })
    return InternalComposer.continueShortcutsAfterEdit(model, next)
  }
  if (model.modePicker.open) {
    if (key.name === "escape") return { ...model, modePicker: { ...model.modePicker, open: false } }
    const selected =
      key.name === "left" || key.name === "up"
        ? (model.modePicker.selected + 3) % 4
        : key.name === "right" || key.name === "down"
          ? (model.modePicker.selected + 1) % 4
          : model.modePicker.selected
    if (key.name === "return")
      return {
        ...model,
        mode: (["low", "medium", "high", "ultra"] as const)[selected]!,
        modePicker: { open: false, selected },
      }
    return { ...model, modePicker: { open: true, selected } }
  }
  if (model.palette.open) {
    const results = filter(model.palette.query)
    const selected =
      key.name === "up"
        ? Math.max(0, model.palette.selected - 1)
        : key.name === "down"
          ? Math.max(0, Math.min(results.length - 1, model.palette.selected + 1))
          : model.palette.selected
    if (key.name === "return") {
      const action = results[selected]?.action as PaletteAction | undefined
      if (action === undefined) return { ...model, palette: { ...model.palette, selected: 0 } }
      if (action._tag === "OpenModePicker")
        return model.busy
          ? {
              ...model,
              paletteOpen: false,
              palette: { open: false, query: "", selected: 0 },
            }
          : {
              ...model,
              paletteOpen: false,
              palette: { open: false, query: "", selected: 0 },
              modePicker: { open: true, selected: ["low", "medium", "high", "ultra"].indexOf(model.mode) },
            }
      if (action._tag === "SwitchThread")
        return {
          ...model,
          paletteOpen: false,
          palette: { open: false, query: "", selected: 0 },
          threadSwitcher: { open: true, query: "", selected: 0, kind: "switch", previewScroll: 0 },
        }
      if (action._tag === "ToggleFastMode")
        return {
          ...model,
          paletteOpen: false,
          palette: { open: false, query: "", selected: 0 },
          fastMode: !model.fastMode,
        }
      return {
        ...model,
        paletteOpen: false,
        palette: { open: false, query: "", selected: 0 },
        pendingAction: action,
      }
    }
    if (key.name === "backspace")
      return { ...model, palette: { ...model.palette, query: model.palette.query.slice(0, -1), selected: 0 } }
    return isPrintable(key)
      ? { ...model, palette: { ...model.palette, query: model.palette.query + key.sequence, selected: 0 } }
      : { ...model, palette: { ...model.palette, selected } }
  }
  if (model.filePicker.open) {
    const mentionLength = Math.min(1 + model.filePicker.query.length, model.cursor)
    if (isPrintable(key) && key.sequence === "@" && model.filePicker.query === "")
      return InternalComposer.insert(
        {
          ...model,
          filePicker: { ...model.filePicker, open: false },
          threadSwitcher: { open: true, query: "", selected: 0, kind: "mention", previewScroll: 0 },
        },
        "@",
      )
    const files = filteredFiles(model)
    const selected =
      key.name === "up"
        ? (model.filePicker.selected + Math.max(1, files.length) - 1) % Math.max(1, files.length)
        : key.name === "down"
          ? (model.filePicker.selected + 1) % Math.max(1, files.length)
          : model.filePicker.selected
    if (key.name === "return") {
      const file = files[selected]
      return file === undefined
        ? { ...model, filePicker: { ...model.filePicker, open: false } }
        : InternalComposer.insert(
            InternalComposer.erase(
              { ...model, filePicker: { ...model.filePicker, open: false, query: "", selected: 0 } },
              mentionLength,
            ),
            fileMention(file),
          )
    }
    if (key.name === "backspace") {
      if (model.filePicker.query.length > 0)
        return InternalComposer.erase(
          {
            ...model,
            filePicker: {
              ...model.filePicker,
              query: model.filePicker.query.slice(0, -lastCharacterLength(model.filePicker.query)),
              selected: 0,
            },
          },
          lastCharacterLength(model.filePicker.query),
        )
      return InternalComposer.erase({ ...model, filePicker: { ...model.filePicker, open: false, selected: 0 } }, 1)
    }
    return isPrintable(key)
      ? InternalComposer.insert(
          {
            ...model,
            filePicker: { ...model.filePicker, query: model.filePicker.query + key.sequence, selected: 0 },
          },
          key.sequence,
        )
      : { ...model, filePicker: { ...model.filePicker, selected } }
  }
  const permission = model.blocks.findLast((block) => {
    const candidate = block as TranscriptBlock
    return candidate._tag === "Permission" && candidate.status === "pending"
  }) as Extract<TranscriptBlock, { _tag: "Permission" }> | undefined
  if (permission !== undefined) {
    if (key.name === "left" || key.name === "up") return update(model, { _tag: "PermissionSelectionMoved", offset: -1 })
    if (key.name === "right" || key.name === "down" || key.name === "tab")
      return update(model, { _tag: "PermissionSelectionMoved", offset: 1 })
    if (key.name === "return") return update(model, { _tag: "PermissionDecisionSelected", id: permission.id })
    if (questionKey(key)) return model
  }
  if (questionKey(key) && model.input.length === 0) {
    const trigger = model.cursor
    const next = InternalComposer.insert(model, "?")
    return {
      ...next,
      shortcutsOpen: true,
      shortcutsTrigger: trigger,
      paletteOpen: false,
      palette: { open: false, query: "", selected: 0 },
      modePicker: { ...model.modePicker, open: false },
      filePicker: { ...model.filePicker, open: false },
    }
  }
  if ((key.name === "tab" || key.name === "backtab") && !key.ctrl && !key.alt && !key.meta)
    return update(model, { _tag: "DetailMoved", offset: key.name === "backtab" || key.shift ? -1 : 1 })
  if (
    key.name === "return" &&
    !key.ctrl &&
    !key.alt &&
    !key.meta &&
    !key.shift &&
    model.input.length === 0 &&
    model.detailSelection !== undefined
  )
    return update(model, { _tag: "DetailToggled" })
  const queued = model.queue as ReadonlyArray<QueueItem>
  if (model.busy && model.input.length === 0 && queued.length > 0 && model.editingTurnId === undefined) {
    const current = queued.findIndex((item) => item.id === model.queueSelection)
    if (current < 0) {
      if (key.name === "up")
        return {
          ...model,
          queueSelection: queued.at(-1)!.id,
        }
    } else {
      if (key.name === "escape") return { ...model, queueSelection: undefined }
      if (key.name === "up") {
        const index = Math.max(0, current - 1)
        return {
          ...model,
          queueSelection: queued[index]!.id,
        }
      }
      if (key.name === "down") {
        if (current === queued.length - 1) return { ...model, queueSelection: undefined }
        return {
          ...model,
          queueSelection: queued[current + 1]!.id,
        }
      }
      const selected = queued[current]!
      if (key.ctrl && key.name === "e")
        return InternalComposer.insert(
          {
            ...model,
            editingTurnId: selected.id,
            editReturn: { input: model.input, attachments: model.pastedText },
            input: "",
            cursor: 0,
            pastedText: [],
          },
          selected.prompt,
        )
      if (key.name === "return")
        return {
          ...model,
          pendingAction: {
            _tag: "SteerQueued",
            id: selected.id,
            prompt: selected.prompt,
          },
        }
      if (key.name === "backspace") return { ...model, pendingAction: { _tag: "Dequeue", id: selected.id } }
    }
  }
  if ((key.name === "return" && key.shift) || key.name === "linefeed" || (key.ctrl && key.name === "j"))
    return InternalComposer.insert(model, "\n")
  if (key.name === "return" && model.cursor > 0 && model.input[model.cursor - 1] === "\\") {
    const withoutSlash = {
      ...model,
      input: model.input.slice(0, model.cursor - 1) + model.input.slice(model.cursor),
      cursor: model.cursor - 1,
    }
    return InternalComposer.insert(withoutSlash, "\n")
  }
  if (key.name === "up" || key.name === "down") {
    if (model.history.length === 0) return model
    const lineStart = model.input.lastIndexOf("\n", Math.max(0, model.cursor - 1)) + 1
    const lineEnd = model.input.indexOf("\n", model.cursor)
    if (key.name === "up" && lineStart > 0) return model
    if (key.name === "down" && lineEnd >= 0) return model
    const current = model.historyIndex ?? model.history.length
    const index = key.name === "up" ? Math.max(0, current - 1) : Math.min(model.history.length, current + 1)
    const savedDraft =
      model.historyIndex === undefined ? { input: model.input, attachments: model.pastedText } : model.historyDraft
    const draft = index === model.history.length ? savedDraft : model.historyComposers[index]
    const input = draft?.input ?? (index === model.history.length ? "" : model.history[index]!)
    return {
      ...model,
      historyIndex: index === model.history.length ? undefined : index,
      historyDraft: index === model.history.length ? undefined : savedDraft,
      input,
      pastedText: draft?.attachments ?? [],
      cursor: input.length,
    }
  }
  if (key.ctrl && key.name === "r") {
    const query = model.input || model.historySearch
    const input = model.history.toReversed().find((prompt) => prompt.includes(query)) ?? model.input
    return { ...model, input, cursor: input.length, historySearch: query }
  }
  if (((key.alt && key.name === "backspace") || (key.ctrl && key.name === "w")) && model.cursor > 0) {
    const before = model.input.slice(0, model.cursor)
    const trimmed = before.replace(/[ \t]+$/, "")
    const boundary = Math.max(trimmed.lastIndexOf(" "), trimmed.lastIndexOf("\n"), trimmed.lastIndexOf("\t"))
    const target = trimmed.length === 0 ? 0 : boundary + 1
    return { ...model, input: model.input.slice(0, target) + model.input.slice(model.cursor), cursor: target }
  }
  if (((key.meta && key.name === "backspace") || (key.ctrl && key.name === "u")) && model.cursor > 0) {
    const lineStart = model.input.lastIndexOf("\n", model.cursor - 1) + 1
    return {
      ...model,
      input: model.input.slice(0, lineStart) + model.input.slice(model.cursor),
      cursor: lineStart,
    }
  }
  if (key.name === "backspace" && model.cursor > 0) {
    return {
      ...model,
      input: model.input.slice(0, model.cursor - 1) + model.input.slice(model.cursor),
      cursor: model.cursor - 1,
    }
  }
  if (key.name === "left") return { ...model, cursor: Math.max(0, model.cursor - 1) }
  if (key.name === "right") return { ...model, cursor: Math.min(model.input.length, model.cursor + 1) }
  return isPrintable(key) ? InternalComposer.insert(model, key.sequence) : model
}

export const internal = { keyPressed }

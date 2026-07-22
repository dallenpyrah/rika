import { Function } from "effect"
import { expandableRowIds, rows as transcriptUnits, unitId as transcriptUnitId } from "../transcript-presenter"
import { classifyPrompt, expandPastedText } from "./composer"
import { internal as Composer } from "./composer"
import { composerHeightLimit } from "./layout"
import { internal as Layout } from "./layout"
import { filteredFiles, filteredThreads, selectedThreadMetadata } from "./navigation"
import { internal as Navigation } from "./navigation"
import {
  idle,
  loading,
  ready,
  streamActivity,
  type Message,
  type Model,
  type ThreadItem,
  type TranscriptBlock,
  type TranscriptItem,
} from "./model"
import { internal as Transcript } from "./transcript"

export const update: {
  (model: Model, message: Message): Model
  (message: Message): (model: Model) => Model
} = Function.dual(2, (model: Model, message: Message): Model => {
  switch (message._tag) {
    case "Pasted": {
      const next = Composer.insertPaste(model, message.text)
      return model.shortcutsOpen ? Composer.continueShortcutsAfterEdit(model, next) : next
    }
    case "ImageInserted":
      return Composer.insertImage(model, message.path)
    case "ImageRemoved":
      return Composer.removeImage(model, message.path)
    case "PastedTextExpanded":
      return Composer.expandPastedTextAttachment(model, message.token)
    case "ThreadsReplaced": {
      const selectedId = (model.threads as ReadonlyArray<ThreadItem>)[model.threadSidebar.selected]?.id
      const browserSelectedId = selectedThreadMetadata(model)?.id
      const selected = Math.max(
        0,
        selectedId === undefined ? 0 : message.threads.findIndex((thread) => thread.id === selectedId),
      )
      const boundedSelected = Math.min(selected, Math.max(0, message.threads.length - 1))
      const maximumScrollTop = Math.max(0, message.threads.length - model.height)
      const boundedScrollTop = Math.min(model.threadSidebar.scrollTop, maximumScrollTop)
      const replacedThreads = {
        ...model,
        threads: [...message.threads],
        threadSidebar: {
          ...model.threadSidebar,
          selected: boundedSelected,
          scrollTop: Math.min(boundedScrollTop, boundedSelected),
        },
      }
      const browserThreads = filteredThreads(replacedThreads)
      const browserSelected = Math.max(
        0,
        browserSelectedId === undefined ? 0 : browserThreads.findIndex((thread) => thread.id === browserSelectedId),
      )
      const browserThread = browserThreads[browserSelected]
      const previewThreadId =
        model.threadPreview._tag === "Ready"
          ? model.threadPreview.value.threadId
          : model.threadPreview._tag === "Loading"
            ? model.threadPreview.previous?.threadId
            : undefined
      return {
        ...replacedThreads,
        threadSwitcher: {
          ...replacedThreads.threadSwitcher,
          selected: Math.min(browserSelected, Math.max(0, browserThreads.length - 1)),
          ...(browserThread?.id === previewThreadId ? {} : { previewScroll: 0 }),
        },
        ...(model.threadSwitcher.open && browserThread?.id !== previewThreadId ? { threadPreview: idle } : {}),
      }
    }
    case "ThreadActivated":
      return {
        ...model,
        currentThreadId: message.threadId,
        currentThreadTitle: message.title,
      }
    case "ThreadTitleChanged":
      return {
        ...model,
        currentThreadTitle: model.currentThreadId === message.threadId ? message.title : model.currentThreadTitle,
        threads: Transcript.renameThread(model.threads as ReadonlyArray<ThreadItem>, message.threadId, message.title),
      }
    case "FilesRequested":
      return model.filePicker.items._tag === "Ready"
        ? model
        : { ...model, filePicker: { ...model.filePicker, items: loading } }
    case "FilesReplaced": {
      const replacedFiles = { ...model, filePicker: { ...model.filePicker, items: ready([...message.files]) } }
      return {
        ...replacedFiles,
        filePicker: {
          ...replacedFiles.filePicker,
          selected: Math.min(replacedFiles.filePicker.selected, Math.max(0, filteredFiles(replacedFiles).length - 1)),
        },
      }
    }
    case "BranchDetected":
      return { ...model, branch: message.branch }
    case "WorkspaceFilesToggled":
      return { ...model, workspaceFilesOpen: !model.workspaceFilesOpen, changedFilesOpen: false }
    case "ThreadSidebarSelectionMoved": {
      const selected = Math.max(0, Math.min(model.threads.length - 1, model.threadSidebar.selected + message.offset))
      const scrollTop =
        selected < model.threadSidebar.scrollTop
          ? selected
          : selected >= model.threadSidebar.scrollTop + model.height
            ? selected - model.height + 1
            : model.threadSidebar.scrollTop
      return { ...model, threadSidebar: { ...model.threadSidebar, selected, scrollTop } }
    }
    case "ThreadSidebarSelectionConfirmed": {
      const index = message.index ?? model.threadSidebar.selected
      const thread = (model.threads as ReadonlyArray<ThreadItem>)[index]
      return thread === undefined
        ? model
        : {
            ...model,
            threadSidebar: { ...model.threadSidebar, selected: index },
            pendingAction: { _tag: "SelectThread", id: thread.id },
          }
    }
    case "ThreadPreviewScrolled":
      return {
        ...model,
        threadSwitcher: {
          ...model.threadSwitcher,
          previewScroll: Math.max(0, model.threadSwitcher.previewScroll + message.offset),
        },
      }
    case "PermissionSelectionMoved":
      return { ...model, permissionSelection: (model.permissionSelection + message.offset + 3) % 3 }
    case "PermissionDecisionSelected": {
      const decisions = ["allow", "always", "deny"] as const
      const decision = message.decision ?? decisions[model.permissionSelection]!
      const permission = (model.blocks as ReadonlyArray<TranscriptBlock>).find(
        (block): block is Extract<TranscriptBlock, { _tag: "Permission" }> =>
          block._tag === "Permission" && block.id === message.id,
      )
      if (permission?.kind === undefined || permission.status !== "pending") return model
      return {
        ...model,
        blocks: model.blocks.map((block) =>
          (block as TranscriptBlock)._tag === "Permission" &&
          (block as Extract<TranscriptBlock, { _tag: "Permission" }>).id === message.id
            ? {
                ...(block as Extract<TranscriptBlock, { _tag: "Permission" }>),
                status: decision === "deny" ? ("denied" as const) : ("approved" as const),
              }
            : block,
        ),
        permissionSelection: 0,
        pendingAction: { _tag: "DecidePermission", id: message.id, kind: permission.kind, decision },
      }
    }
    case "PermissionCancelled": {
      const pendingAction = model.pendingAction as { readonly _tag?: string; readonly id?: string } | undefined
      return {
        ...model,
        blocks: model.blocks.map((block) =>
          (block as TranscriptBlock)._tag === "Permission" &&
          (block as Extract<TranscriptBlock, { _tag: "Permission" }>).id === message.id
            ? { ...(block as Extract<TranscriptBlock, { _tag: "Permission" }>), status: "denied" as const }
            : block,
        ),
        permissionSelection: 0,
        pendingAction:
          pendingAction?._tag === "DecidePermission" && pendingAction.id === message.id
            ? undefined
            : model.pendingAction,
      }
    }
    case "EventReplayed":
      if (model.seenEventIds.includes(message.event.id)) return model
      {
        const incoming = message.event.block
        const blocks = [...model.blocks] as Array<TranscriptBlock>
        let items = [...model.items] as Array<TranscriptItem>
        const lastItem = items.at(-1)
        const last = lastItem?._tag === "Block" ? blocks[lastItem.index] : undefined
        if (
          incoming._tag === "Reasoning" &&
          last?._tag === "Reasoning" &&
          lastItem?._tag === "Block" &&
          lastItem.turnId === message.event.turnId
        )
          blocks[lastItem.index] = { ...last, text: last.text + incoming.text }
        else if (incoming._tag === "ToolResult") {
          const index = blocks.findIndex((candidate) => candidate._tag === "ToolCall" && candidate.id === incoming.id)
          if (index >= 0) {
            const requested = blocks[index] as Extract<TranscriptBlock, { _tag: "ToolCall" }>
            blocks[index] = {
              ...requested,
              output: incoming.output,
              status: incoming.failed ? "failed" : "complete",
            }
          } else {
            items.push({
              _tag: "Block",
              index: blocks.length,
              id: message.event.id,
              ...(message.event.turnId === undefined ? {} : { turnId: message.event.turnId }),
            })
            blocks.push(incoming)
          }
        } else if (incoming._tag === "ToolCall") {
          const index = blocks.findIndex((candidate) => candidate._tag === "ToolCall" && candidate.id === incoming.id)
          if (index >= 0) blocks[index] = { ...(blocks[index] as typeof incoming), ...incoming }
          else {
            items.push({
              _tag: "Block",
              index: blocks.length,
              id: message.event.id,
              ...(message.event.turnId === undefined ? {} : { turnId: message.event.turnId }),
            })
            blocks.push(incoming)
          }
        } else if (incoming._tag === "Permission") {
          const index = blocks.findIndex((candidate) => candidate._tag === "Permission" && candidate.id === incoming.id)
          if (index >= 0) blocks[index] = { ...(blocks[index] as typeof incoming), ...incoming }
          else {
            items.push({
              _tag: "Block",
              index: blocks.length,
              id: message.event.id,
              ...(message.event.turnId === undefined ? {} : { turnId: message.event.turnId }),
            })
            blocks.push(incoming)
          }
        } else {
          items.push({
            _tag: "Block",
            index: blocks.length,
            id: message.event.id,
            ...(message.event.turnId === undefined ? {} : { turnId: message.event.turnId }),
          })
          blocks.push(incoming)
        }
        return {
          ...model,
          blocks,
          items,
          seenEventIds: [...model.seenEventIds, message.event.id],
          eventCursor: message.event.cursor,
          ...(model.busy
            ? {
                activity:
                  incoming._tag === "ToolCall"
                    ? { _tag: "RunningTools" as const }
                    : incoming._tag === "ToolResult" || incoming._tag === "Permission"
                      ? { _tag: "Waiting" as const }
                      : incoming._tag === "Reasoning"
                        ? streamActivity(model.activity, "Thinking", incoming.text, undefined)
                        : (model.activity ?? { _tag: "Waiting" as const }),
              }
            : {}),
        }
      }
    case "Resized":
      return {
        ...model,
        width: message.width,
        height: message.height,
        composerHeight: Math.min(model.composerHeight, composerHeightLimit(message.height)),
        sidebarWidth: Layout.clampSidebarWidth(model.sidebarWidth, message.width),
      }
    case "ComposerHeightChanged":
      return {
        ...model,
        composerHeight: Math.max(
          Math.min(5, model.height),
          Math.min(message.height, composerHeightLimit(model.height)),
        ),
      }
    case "SidebarWidthChanged":
      return { ...model, sidebarWidth: Layout.clampSidebarWidth(message.width, model.width) }
    case "ScrollMoved":
      return { ...model, scrollOffset: Math.max(0, message.offset), scrollFollow: false }
    case "ScrollFollowed":
      return { ...model, scrollOffset: 0, scrollFollow: true }
    case "Submitted":
      if (model.input.length === 0) return model
      const submission = classifyPrompt(model.input)
      const submittedPrompt = expandPastedText(model.input, model.pastedText)
      return submission._tag === "Shell" && submission.command.length === 0
        ? model
        : {
            ...model,
            input: "",
            cursor: 0,
            pastedText: [],
            history: [...model.history.filter((prompt) => prompt !== submittedPrompt), submittedPrompt],
            historyComposers: [
              ...model.historyComposers.filter(
                (draft) => expandPastedText(draft.input, draft.attachments) !== submittedPrompt,
              ),
              { input: model.input, attachments: model.pastedText },
            ],
            historyDraft: undefined,
            historyIndex: undefined,
            historySearch: "",
            busy: true,
            activity: { _tag: "Sending" },
          }
    case "TurnStarted":
      if (model.entries.some((entry) => entry.role === "user" && entry.turnId === message.turnId))
        return { ...model, activeTurnId: message.turnId, busy: true, activity: { _tag: "Waiting" } }
      return {
        ...model,
        entries: [...model.entries, { role: "user", text: message.prompt, turnId: message.turnId }],
        items: [
          ...model.items,
          { _tag: "Entry", index: model.entries.length, id: `turn:${message.turnId}:user`, turnId: message.turnId },
        ],
        activeTurnId: message.turnId,
        busy: true,
        activity: { _tag: "Waiting" },
      }
    case "BlockAdded":
      return {
        ...model,
        blocks: [...model.blocks, message.block],
        items: [...model.items, { _tag: "Block", index: model.blocks.length }],
        ...(model.busy
          ? {
              activity:
                message.block._tag === "ToolCall"
                  ? ({ _tag: "RunningTools" } as const)
                  : message.block._tag === "ToolResult" || message.block._tag === "Permission"
                    ? ({ _tag: "Waiting" } as const)
                    : (model.activity ?? ({ _tag: "Waiting" } as const)),
            }
          : {}),
      }
    case "ReasoningStreamed": {
      const blocks = [...model.blocks] as Array<TranscriptBlock>
      const lastItem = model.items.at(-1) as TranscriptItem | undefined
      const last = lastItem?._tag === "Block" ? blocks[lastItem.index] : undefined
      if (last?._tag === "Reasoning" && lastItem?._tag === "Block")
        blocks[lastItem.index] = { ...last, text: last.text + message.text }
      else {
        blocks.push({ _tag: "Reasoning", text: message.text })
        return {
          ...model,
          blocks,
          items: [...model.items, { _tag: "Block", index: model.blocks.length }],
          ...(model.busy ? { activity: streamActivity(model.activity, "Thinking", message.text, undefined) } : {}),
        }
      }
      return {
        ...model,
        blocks,
        ...(model.busy ? { activity: streamActivity(model.activity, "Thinking", message.text, undefined) } : {}),
      }
    }
    case "ReasoningToggled": {
      const unit = transcriptUnits(model).find(
        (candidate) => candidate.kind === "reasoning" && candidate.block === message.index,
      )
      if (unit === undefined) return model
      const id = transcriptUnitId(model, unit)
      const expanded = new Set(model.expandedRowKeys)
      if (expanded.has(id)) expanded.delete(id)
      else expanded.add(id)
      return { ...model, expandedRowKeys: [...expanded] }
    }
    case "PaletteActionConsumed":
      return { ...model, pendingAction: undefined }
    case "AssistantStreamed": {
      const entries = [...model.entries]
      const lastItem = (model.items as ReadonlyArray<TranscriptItem>).findLast(
        (item) => message.turnId === undefined || item.turnId === message.turnId,
      ) as TranscriptItem | undefined
      const index =
        lastItem?._tag === "Entry" &&
        entries[lastItem.index]?.role === "assistant" &&
        (message.turnId !== undefined || model.activity?._tag === "Streaming")
          ? lastItem.index
          : -1
      if (index >= 0) entries[index] = { ...entries[index]!, text: entries[index]!.text + message.text }
      else
        entries.push({
          role: "assistant",
          text: message.text,
          ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
        })
      return {
        ...model,
        entries,
        items:
          index >= 0
            ? model.items
            : [
                ...model.items,
                {
                  _tag: "Entry",
                  index: entries.length - 1,
                  ...(message.id === undefined ? {} : { id: message.id }),
                  ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
                } as const,
              ],
        busy: true,
        activity: streamActivity(model.activity, "Streaming", message.text, undefined),
      }
    }
    case "AssistantCompleted": {
      const entries = [...model.entries]
      const lastItem = (model.items as ReadonlyArray<TranscriptItem>).findLast(
        (item) => message.turnId === undefined || item.turnId === message.turnId,
      ) as TranscriptItem | undefined
      const index =
        lastItem?._tag === "Entry" &&
        entries[lastItem.index]?.role === "assistant" &&
        (message.turnId !== undefined || model.activity?._tag === "Streaming")
          ? lastItem.index
          : -1
      if (index >= 0) entries[index] = { ...entries[index]!, text: message.text }
      else
        entries.push({
          role: "assistant",
          text: message.text,
          ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
        })
      return {
        ...model,
        entries,
        items:
          index >= 0
            ? model.items
            : [
                ...model.items,
                {
                  _tag: "Entry",
                  index: entries.length - 1,
                  ...(message.id === undefined ? {} : { id: message.id }),
                  turnId: message.turnId,
                },
              ],
        busy: model.busy,
        activity: model.busy && model.activeTurnId !== undefined ? { _tag: "Waiting" } : undefined,
      }
    }
    case "ExecutionCompleted":
      return message.turnId !== undefined && model.activeTurnId !== message.turnId
        ? model
        : { ...model, busy: false, activity: undefined, activeTurnId: undefined }
    case "ExecutionFailed":
      if (message.turnId !== undefined && model.activeTurnId !== message.turnId) return model
      return {
        ...model,
        blocks: [
          ...model.blocks,
          {
            _tag: "Error",
            title: "Execution failed",
            detail: message.message,
            recovery: "Edit your prompt and press Enter to try again.",
          },
        ],
        items: [...model.items, { _tag: "Block", index: model.blocks.length }],
        busy: false,
        activity: undefined,
        activeTurnId: undefined,
      }
    case "ExecutionCancelled":
      if (message.turnId !== undefined && model.activeTurnId !== message.turnId) return model
      if (!model.busy) return model
      {
        const turnId = message.turnId ?? model.activeTurnId
        const hasMarkerUnit = model.blocks.some((candidate) => {
          const block = candidate as TranscriptBlock
          if (block._tag === "ChildAgent") return block.status === "running" || block.status === "cancelled"
          return (
            block._tag === "ToolCall" &&
            (block.status === "running" || block.status === "cancelled") &&
            block.presentation.family === "agent"
          )
        })
        const entries = hasMarkerUnit
          ? model.entries
          : [
              ...model.entries,
              { role: "notice" as const, text: "cancelled", ...(turnId === undefined ? {} : { turnId }) },
            ]
        const items = hasMarkerUnit
          ? model.items
          : [
              ...model.items,
              {
                _tag: "Entry" as const,
                index: model.entries.length,
                ...(turnId === undefined ? {} : { id: `execution:${turnId}:cancelled`, turnId }),
              },
            ]
        return {
          ...model,
          entries,
          items,
          blocks: model.blocks.map((candidate) => {
            const block = candidate as TranscriptBlock
            return (block._tag === "ToolCall" || block._tag === "ChildAgent") && block.status === "running"
              ? { ...block, status: "cancelled" as const }
              : candidate
          }),
          busy: false,
          activity: undefined,
          activeTurnId: undefined,
        }
      }
    case "UsageReported":
      return message.costUsd === undefined ? model : { ...model, costUsd: (model.costUsd ?? 0) + message.costUsd }
    case "DetailMoved": {
      const ids = expandableRowIds(model)
      const count = ids.length
      if (count === 0) return model
      const current = ids.indexOf(model.detailSelection ?? "")
      const nextIndex =
        current < 0 ? (message.offset < 0 ? count - 1 : 0) : (((current + message.offset) % count) + count) % count
      return { ...model, detailSelection: ids[nextIndex]! }
    }
    case "DetailToggled": {
      const id = message.id ?? model.detailSelection
      if (id === undefined) return model
      if (!expandableRowIds(model).includes(id)) return model
      const expanded = new Set(model.expandedRowKeys)
      if (expanded.has(id)) expanded.delete(id)
      else expanded.add(id)
      return {
        ...model,
        detailSelection: message.id === undefined ? id : model.detailSelection,
        expandedRowKeys: [...expanded],
      }
    }
    case "AllDetailsToggled": {
      const roots = expandableRowIds({ ...model, expandedRowKeys: [] })
      if (roots.length === 0) return model
      const all = expandableRowIds({ ...model, expandedRowKeys: roots })
      const expanded = new Set(model.expandedRowKeys)
      return { ...model, expandedRowKeys: all.every((id) => expanded.has(id)) ? [] : [...all] }
    }
    case "FastModeToggled":
      return { ...model, fastMode: !model.fastMode }
    case "SidebarViewToggled":
      return { ...model, changedFilesOpen: !model.changedFilesOpen, workspaceFilesOpen: false }
    case "ChangedFilesRequested":
      return model.changedFiles._tag === "Ready" ? model : { ...model, changedFiles: loading }
    case "ChangedFilesReplaced": {
      if (model.changedFiles._tag === "Ready" && Transcript.sameChangedFiles(model.changedFiles.value, message.files))
        return model
      return { ...model, changedFiles: ready([...message.files]) }
    }
    case "ThreadPreviewRequested": {
      const previous =
        model.threadPreview._tag === "Ready"
          ? model.threadPreview.value
          : model.threadPreview._tag === "Loading"
            ? model.threadPreview.previous
            : undefined
      return {
        ...model,
        threadPreview: { _tag: "Loading", ...(previous === undefined ? {} : { previous }) },
        threadSwitcher: { ...model.threadSwitcher, previewScroll: 0 },
      }
    }
    case "ThreadOpenRequested":
      return { ...model, threadLoading: true }
    case "ThreadOpenCompleted":
      return { ...model, threadLoading: false }
    case "ThreadPreviewLoaded":
      return {
        ...model,
        threadPreview: ready({
          threadId: message.threadId,
          turns: message.turns.map((turn) => ({ prompt: turn.prompt, events: [...turn.events] })),
        }),
      }
    case "ComposerReplaced":
      return {
        ...model,
        input: message.text,
        cursor: message.text.length,
        pastedText: [],
        shortcutsOpen: false,
        shortcutsTrigger: undefined,
      }
    case "KeyPressed":
      return Navigation.keyPressed(model, message.key, update)
  }
})

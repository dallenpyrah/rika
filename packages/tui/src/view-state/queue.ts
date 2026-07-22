import { Function } from "effect"
import type { Model, QueueChange, QueueItem } from "./model"

export const replaceQueue: {
  (model: Model, queue: ReadonlyArray<QueueItem>): Model
  (queue: ReadonlyArray<QueueItem>): (model: Model) => Model
} = Function.dual(2, (model: Model, queue: ReadonlyArray<QueueItem>): Model => {
  const selected = queue.some((item) => item.id === model.queueSelection) ? model.queueSelection : undefined
  return {
    ...model,
    queue: [...queue],
    queueSelection: selected,
  }
})

const validQueueSelection = (current: string | undefined, queue: ReadonlyArray<QueueItem>): string | undefined =>
  current !== undefined && queue.some((item) => item.id === current) ? current : undefined

const exitEditWhenRemoved = (model: Model, queue: ReadonlyArray<QueueItem>): Partial<Model> => {
  if (model.editingTurnId === undefined || queue.some((item) => item.id === model.editingTurnId)) return {}
  const restore = model.editReturn ?? { input: "", attachments: [] }
  return {
    editingTurnId: undefined,
    editReturn: undefined,
    input: restore.input,
    cursor: restore.input.length,
    pastedText: [...restore.attachments],
  }
}

export const resetQueue: {
  (model: Model, threadId: string, revision: number, queue: ReadonlyArray<QueueItem>): Model
  (threadId: string, revision: number, queue: ReadonlyArray<QueueItem>): (model: Model) => Model
} = Function.dual(
  4,
  (model: Model, threadId: string, revision: number, queue: ReadonlyArray<QueueItem>): Model => ({
    ...model,
    queue: [...queue],
    queueThreadId: threadId,
    queueRevision: revision,
    queueSelection: validQueueSelection(model.queueSelection, queue),
    ...exitEditWhenRemoved(model, queue),
  }),
)

export const applyQueueDelta: {
  (
    model: Model,
    threadId: string,
    revision: number,
    change: QueueChange,
    queuedCount?: number,
  ): {
    readonly model: Model
    readonly resync: boolean
  }
  (
    threadId: string,
    revision: number,
    change: QueueChange,
    queuedCount?: number,
  ): (model: Model) => {
    readonly model: Model
    readonly resync: boolean
  }
} = Function.dual(
  (args) => typeof args[0] !== "string",
  (
    model: Model,
    threadId: string,
    revision: number,
    change: QueueChange,
    queuedCount?: number,
  ): { readonly model: Model; readonly resync: boolean } => {
    if (model.currentThreadId !== undefined && model.currentThreadId !== threadId) return { model, resync: false }
    if (model.queueThreadId !== threadId || model.queueRevision === undefined) return { model, resync: true }
    if (revision <= model.queueRevision) return { model, resync: false }
    if (revision !== model.queueRevision + 1) return { model, resync: true }
    const queue = [...model.queue]
    let selection = model.queueSelection
    if (change._tag === "Added") {
      if (queue.some((item) => item.id === change.item.id)) return { model, resync: true }
      queue.push(change.item)
    } else if (change._tag === "Updated") {
      const index = queue.findIndex((item) => item.id === change.item.id)
      if (index < 0) return { model, resync: true }
      queue[index] = change.item
    } else {
      const index = queue.findIndex((item) => item.id === change.turnId)
      if (index < 0) return { model, resync: true }
      queue.splice(index, 1)
      if (model.queueSelection === change.turnId) selection = queue[Math.min(index, queue.length - 1)]?.id
    }
    return {
      model: {
        ...model,
        queue,
        queueRevision: revision,
        queueSelection: validQueueSelection(selection, queue),
        ...exitEditWhenRemoved(model, queue),
      },
      resync: queuedCount !== undefined && queuedCount !== queue.length,
    }
  },
)

export const replaceTurnPrompt: {
  (model: Model, turnId: string, prompt: string): Model
  (turnId: string, prompt: string): (model: Model) => Model
} = Function.dual(3, (model: Model, turnId: string, prompt: string): Model => {
  const index = model.entries.findIndex((entry) => entry.role === "user" && entry.turnId === turnId)
  if (index < 0) return model
  const entries = [...model.entries]
  entries[index] = { ...entries[index]!, text: prompt }
  return { ...model, entries }
})

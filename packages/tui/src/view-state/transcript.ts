import type { ChangedFile, ThreadItem } from "./model"

const renameThread = (
  threads: ReadonlyArray<ThreadItem>,
  threadId: string,
  title: string,
): ReadonlyArray<ThreadItem> => {
  const next: Array<ThreadItem> = []
  for (const thread of threads) next.push(thread.id === threadId ? { ...thread, title } : thread)
  return next
}

const sameChangedFiles = (left: ReadonlyArray<ChangedFile>, right: ReadonlyArray<ChangedFile>): boolean =>
  left.length === right.length &&
  left.every((file, index) => {
    const candidate = right[index]
    return (
      candidate !== undefined &&
      file.path === candidate.path &&
      file.status === candidate.status &&
      file.added === candidate.added &&
      file.removed === candidate.removed
    )
  })

export const internal = { renameThread, sameChangedFiles }

import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import { Console, Effect, Schema } from "effect"
import { Input, OperationUnavailable } from "../operation-contract"
import type { InteractiveEvent, QueueItem } from "../operation-contract"
import { operationError } from "./options"
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)

const queueItem = (turn: Turn.Turn): QueueItem => {
  const attachments = turn.promptParts
    ?.filter((part) => part.type === "image")
    .flatMap((part) => (part.filename === undefined ? [] : [part.filename]))
  return attachments === undefined || attachments.length === 0
    ? { id: turn.id, prompt: turn.prompt }
    : { id: turn.id, prompt: turn.prompt, attachments }
}

const queueMutationEvent = (queue: TurnRepository.QueueItemChange): InteractiveEvent => {
  const change =
    queue.change._tag === "Removed"
      ? ({ _tag: "Removed", turnId: queue.change.turnId } as const)
      : ({ _tag: queue.change._tag, item: queueItem(queue.change.turn) } as const)
  return {
    _tag: "QueueUpdated",
    selectionEpoch: 0,
    threadId: queue.threadId,
    revision: queue.revision,
    queuedCount: queue.queuedCount,
    change,
  }
}

const unavailable = (input: Input, message = `${input._tag} is specified but not implemented yet`) =>
  OperationUnavailable.make({ operation: input._tag, message })

const writeThread = (thread: Thread.Thread) => Console.log(encodeJson(thread))

const requireThread = Effect.fn("Operation.requireThread")(function* (
  repository: ThreadRepository.Interface,
  id: string,
) {
  const thread = yield* repository.get(Thread.ThreadId.make(id))
  if (thread === undefined) return yield* operationError(`Thread ${id} does not exist`)
  return thread
})

const markdownExport = (thread: Thread.Thread, turns: ReadonlyArray<Turn.Turn>) =>
  [
    `# ${thread.title}`,
    "",
    `- Thread: ${thread.id}`,
    `- Workspace: ${thread.workspace}`,
    `- Labels: ${thread.labels.join(", ") || "None"}`,
    "",
    ...turns.flatMap((turn, index) => [`## Turn ${index + 1}`, "", `Status: ${turn.status}`, "", turn.prompt, ""]),
  ].join("\n")

export const internal = { markdownExport, queueItem, queueMutationEvent, requireThread, unavailable, writeThread }

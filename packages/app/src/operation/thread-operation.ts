import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as ThreadSummaryRepository from "@rika/persistence/thread-summary-repository"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Clock, Console, Context, Effect, Schema, Semaphore } from "effect"
import { Input, OperationUnavailable } from "../operation-contract"
import type { ProductLayerOptions } from "./options"
import { operationError } from "./options"
import { internal as threadFormat } from "./thread-format"
const { markdownExport, requireThread, unavailable, writeThread } = threadFormat
import * as ThreadActivity from "../thread-activity"

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)

interface ThreadOperationDependencies<E> {
  readonly options: Pick<ProductLayerOptions<never, never, never>, "defaultWorkspace" | "makeThreadId" | "makeTurnId">
  readonly pendingTurnCapacity: number
  readonly turnMutationAdmission: Semaphore.Semaphore
  readonly acquiredBackend: ExecutionBackend.Interface
  readonly dependencyContext: Context.Context<
    ThreadRepository.Service | ThreadSummaryRepository.Service | TurnRepository.Service
  >
  readonly notifyThreadSummaries: Effect.Effect<void, E, ThreadSummaryRepository.Service>
}

export const makeThreadOperation = <E>(dependencies: ThreadOperationDependencies<E>) => {
  const {
    options,
    pendingTurnCapacity,
    turnMutationAdmission,
    acquiredBackend,
    dependencyContext,
    notifyThreadSummaries,
  } = dependencies
  return (input: Extract<Input, { readonly _tag: "Thread" }>): Effect.Effect<void, OperationUnavailable> =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const repository = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        const now = yield* Clock.currentTimeMillis
        switch (input.action) {
          case "new": {
            const id = yield* options.makeThreadId
            const thread = yield* repository.create({
              id,
              workspace: input.clientWorkspace ?? options.defaultWorkspace,
              title: "New thread",
              now,
            })
            yield* notifyThreadSummaries
            yield* writeThread(thread)
            return
          }
          case "list": {
            const threads = yield* repository.list({
              ...(input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            })
            yield* Console.log(encodeJson(threads))
            return
          }
          case "search": {
            const candidates = yield* repository.list({
              ...(input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived }),
              limit: 100,
            })
            const terms = input.query.map((term) => term.toLowerCase())
            const matches = candidates
              .filter((thread) => {
                const fields = [thread.id, thread.title, thread.workspace, ...thread.labels].map((field) =>
                  field.toLowerCase(),
                )
                return terms.every((term) => fields.some((field) => field.includes(term)))
              })
              .slice(0, Math.min(Math.max(input.limit ?? 50, 1), 100))
            yield* Console.log(encodeJson(matches))
            return
          }
          case "last":
          case "top": {
            const thread = (yield* repository.list({ limit: 1 }))[0]
            if (thread === undefined) return yield* operationError("No threads exist")
            yield* writeThread(thread)
            return
          }
          case "continue": {
            yield* Effect.gen(function* () {
              const backend = yield* ExecutionBackend.Service
              let selected: Thread.Thread | ReadonlyArray<Thread.Thread>
              if ("last" in input) {
                const thread = (yield* repository.list({ limit: 1 }))[0]
                if (thread === undefined) return yield* operationError("No threads exist")
                selected = thread
              } else {
                selected = yield* Effect.forEach(input.threadIds, (id) => requireThread(repository, id))
              }
              const selectedThreads = Array.isArray(selected) ? selected : [selected]
              const continued = yield* Effect.forEach(selectedThreads, (thread) =>
                Effect.gen(function* () {
                  const threadTurns = yield* turns.list(thread.id)
                  const history = yield* Effect.forEach(threadTurns, (turn) =>
                    backend
                      .replay(turn.id)
                      .pipe(Effect.map((result) => ({ turn, status: result.status, events: result.events }))),
                  )
                  return { ...thread, turns: history }
                }),
              )
              yield* Console.log(encodeJson(Array.isArray(selected) ? continued : continued[0]))
            }).pipe(Effect.provide(Context.make(ExecutionBackend.Service, acquiredBackend)), Effect.scoped)
            return
          }
          case "rename":
            yield* repository
              .rename(Thread.ThreadId.make(input.threadId), input.title, now)
              .pipe(Effect.flatMap(writeThread))
            yield* notifyThreadSummaries
            return
          case "label":
            yield* repository
              .label(Thread.ThreadId.make(input.threadId), input.labels, now)
              .pipe(Effect.flatMap(writeThread))
            yield* notifyThreadSummaries
            return
          case "pin":
            yield* repository
              .setPinned(Thread.ThreadId.make(input.threadId), true, now)
              .pipe(Effect.flatMap(writeThread))
            yield* notifyThreadSummaries
            return
          case "archive":
            yield* repository
              .setArchived(Thread.ThreadId.make(input.threadId), true, now)
              .pipe(Effect.flatMap(writeThread))
            yield* notifyThreadSummaries
            return
          case "unarchive":
            yield* repository
              .setArchived(Thread.ThreadId.make(input.threadId), false, now)
              .pipe(Effect.flatMap(writeThread))
            yield* notifyThreadSummaries
            return
          case "delete":
            yield* repository.remove(Thread.ThreadId.make(input.threadId))
            yield* notifyThreadSummaries
            return
          case "export": {
            const thread = yield* requireThread(repository, input.threadId)
            const threadTurns = yield* turns.list(thread.id)
            yield* Console.log(
              input.format === "json"
                ? encodeJson({ thread, turns: threadTurns })
                : markdownExport(thread, threadTurns),
            )
            return
          }
          case "usage": {
            const thread = yield* requireThread(repository, input.threadId)
            const threadTurns = yield* turns.list(thread.id)
            const statusNames: ReadonlyArray<Turn.Status> = [
              "accepted",
              "queued",
              "running",
              "waiting",
              "completed",
              "failed",
              "cancelled",
            ]
            const statuses = Object.fromEntries(
              statusNames.map((status) => [status, threadTurns.filter((turn) => turn.status === status).length]),
            )
            yield* Console.log(encodeJson({ threadId: thread.id, turns: threadTurns.length, statuses }))
            return
          }
          case "fork": {
            return yield* turnMutationAdmission.withPermits(1)(
              Effect.gen(function* () {
                const source = yield* requireThread(repository, input.threadId)
                const sourceTurns = yield* turns.list(source.id)
                const boundary =
                  input.atTurn === undefined
                    ? sourceTurns.length - 1
                    : sourceTurns.findIndex((turn) => turn.id === input.atTurn)
                if (boundary < 0 && input.atTurn !== undefined)
                  return yield* operationError(`Turn ${input.atTurn} does not exist in thread ${input.threadId}`)
                const copiedSourceTurns = sourceTurns.slice(0, boundary + 1)
                const forkId = yield* options.makeThreadId
                const queuedCopies = copiedSourceTurns.filter((turn) => turn.status === "queued").length
                if (queuedCopies > pendingTurnCapacity)
                  return yield* TurnRepository.QueueFull.make({
                    threadId: forkId,
                    capacity: pendingTurnCapacity,
                    count: queuedCopies,
                  })
                let forkCreated = false
                return yield* Effect.gen(function* () {
                  const fork = yield* repository.create({
                    id: forkId,
                    workspace: source.workspace,
                    title: source.title,
                    now,
                  })
                  forkCreated = true
                  yield* repository.setArchived(fork.id, true, now)
                  if (source.labels.length > 0) yield* repository.label(fork.id, source.labels, now)
                  const summaries = yield* ThreadSummaryRepository.Service
                  for (const sourceTurn of copiedSourceTurns) {
                    const copied = yield* turns.copy(
                      {
                        ...sourceTurn,
                        id: yield* options.makeTurnId,
                        threadId: fork.id,
                      },
                      pendingTurnCapacity,
                    )
                    const execution = yield* acquiredBackend.inspect(sourceTurn.id)
                    if (execution === undefined)
                      yield* summaries.ensureTurn(copied.id, copied.threadId, copied.updatedAt)
                    else {
                      const replayed = yield* acquiredBackend.replay(sourceTurn.id)
                      yield* summaries.replaceTurn(
                        ThreadActivity.projectionInput(
                          fork.id,
                          { ...replayed, turnId: copied.id },
                          yield* Clock.currentTimeMillis,
                        ),
                      )
                    }
                  }
                  const published = yield* repository.setArchived(fork.id, false, now)
                  yield* notifyThreadSummaries
                  yield* writeThread(published)
                }).pipe(
                  Effect.onError(() =>
                    forkCreated
                      ? repository.remove(forkId).pipe(
                          Effect.catch((error) =>
                            Effect.logError("thread.fork.cleanup.failed").pipe(
                              Effect.annotateLogs({
                                "rika.thread.id": String(forkId),
                                "rika.failure.kind": String(error),
                              }),
                            ),
                          ),
                        )
                      : Effect.void,
                  ),
                )
              }),
            )
          }
        }
      })
      yield* program.pipe(
        Effect.provide(dependencyContext),
        Effect.mapError((error) => unavailable(input, String(error))),
      )
    }) as Effect.Effect<void, OperationUnavailable>
}

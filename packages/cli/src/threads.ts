import { IdGenerator } from "@rika/core"
import { ThreadClient, ThreadDirectory } from "@rika/rivet-host"
import { Event, Ids } from "@rika/schema"
import { ThreadProjection } from "@rika/persistence"
import { Context, Effect, Layer, Schema } from "effect"
import * as Args from "./args"
import * as Output from "./output"

export class ThreadsError extends Schema.TaggedErrorClass<ThreadsError>()("ThreadsError", {
  message: Schema.String,
  action: Args.ThreadAction,
}) {}

export type RunError = ThreadClient.RunError | ThreadDirectory.ThreadDirectoryError | ThreadsError

export interface Interface {
  readonly executeCommand: (command: Args.ThreadCommand) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Threads") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const output = yield* Output.Service
    const threadClient = yield* ThreadClient.Service
    const directory = yield* ThreadDirectory.Service
    const idGenerator = yield* IdGenerator.Service

    return Service.of({
      executeCommand: Effect.fn("Cli.Threads.executeCommand")(function* (command: Args.ThreadCommand) {
        switch (command.action) {
          case "list": {
            const summaries = yield* listSummaries(directory, command)
            yield* output.stdout(formatJson(summaries))
            return 0
          }
          case "search": {
            const summaries = yield* listSummaries(directory, command)
            const query = command.query?.toLowerCase() ?? ""
            const results = summaries.filter((summary) => summaryMatches(summary, query))
            yield* output.stdout(formatJson(limit(results, command.limit)))
            return 0
          }
          case "archive": {
            const snapshot = yield* threadClient.archiveThread({ thread_id: yield* requireThreadId(command) })
            yield* output.stdout(formatJson(snapshot))
            return 0
          }
          case "unarchive": {
            const snapshot = yield* threadClient.unarchiveThread({ thread_id: yield* requireThreadId(command) })
            yield* output.stdout(formatJson(snapshot))
            return 0
          }
          case "visibility": {
            const snapshot = yield* threadClient.setVisibility({
              thread_id: yield* requireThreadId(command),
              visibility: yield* requireVisibility(command),
            })
            yield* output.stdout(formatJson(snapshot))
            return 0
          }
          case "compact": {
            const event = yield* threadClient.compactThread({ thread_id: yield* requireThreadId(command) })
            yield* output.stdout(formatJson(event))
            return 0
          }
          case "fork": {
            const sourceThreadId = yield* requireThreadId(command)
            const forkThreadId = Ids.ThreadId.make(yield* idGenerator.next("thread"))
            const snapshot = yield* threadClient.forkThread({
              thread_id: sourceThreadId,
              fork_thread_id: forkThreadId,
              import_identity: { _tag: "VerifiedUserIdentity", user_id: localUserId },
              ...(command.at_turn === undefined ? {} : { at_turn: command.at_turn }),
            })
            yield* output.stdout(formatJson(snapshot))
            return 0
          }
          case "share": {
            const events = yield* threadClient.getEvents({
              thread_id: yield* requireThreadId(command),
              after_sequence: 0,
            })
            yield* output.stdout(formatJson({ events }))
            return 0
          }
          case "reference": {
            const events = yield* threadClient.getEvents({
              thread_id: yield* requireThreadId(command),
              after_sequence: 0,
            })
            yield* output.stdout(formatJson(referenceFromEvents(events, command.query)))
            return 0
          }
          case "delete":
          case "rebuild-projection":
          case "import":
            return yield* unsupported(command)
        }
      }),
    })
  }),
)

export const executeCommand = Effect.fn("Cli.Threads.executeCommand.call")(function* (command: Args.ThreadCommand) {
  const service = yield* Service
  return yield* service.executeCommand(command)
})

export const formatError = (error: RunError) => {
  if (error instanceof ThreadsError) return error.message
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const localUserId = Ids.UserId.make("local")

const listSummaries = (directory: ThreadDirectory.Interface, command: Args.ThreadCommand) =>
  directory.listThreads().pipe(
    Effect.map((summaries) =>
      limit(
        summaries.filter((summary) => command.include_archived === true || !summary.archived),
        command.limit,
      ),
    ),
  )

const requireThreadId = (command: Args.ThreadCommand) =>
  command.thread_id === undefined
    ? Effect.fail(new ThreadsError({ message: `Thread id is required for ${command.action}`, action: command.action }))
    : Effect.succeed(command.thread_id)

const requireVisibility = (command: Args.ThreadCommand) =>
  command.visibility === undefined
    ? Effect.fail(new ThreadsError({ message: "Thread visibility is required", action: command.action }))
    : Effect.succeed(command.visibility)

const unsupported = (command: Args.ThreadCommand) =>
  Effect.fail(
    new ThreadsError({
      message: `Thread action ${command.action} is not available in local actor-native mode`,
      action: command.action,
    }),
  )

const summaryMatches = (summary: ThreadProjection.ThreadSummary, query: string) => {
  if (query.length === 0) return true
  return [summary.thread_id, summary.title_text, summary.latest_message_text]
    .filter((value): value is string => value !== undefined)
    .some((value) => value.toLowerCase().includes(query))
}

const referenceFromEvents = (events: ReadonlyArray<Event.Event>, query: string | undefined) => ({
  query: query ?? null,
  events,
})

const limit = <A>(values: ReadonlyArray<A>, count: number | undefined) =>
  count === undefined ? values : values.slice(0, count)

const formatJson = (value: unknown) => JSON.stringify(value)

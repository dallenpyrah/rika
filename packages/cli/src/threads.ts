import { ThreadService, TournamentService } from "@rika/agent"
import { OrbStore } from "@rika/persistence"
import { Client } from "@rika/sdk"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as Args from "./args"
import * as Input from "./input"
import * as Output from "./output"
import * as Tournament from "./tournament"

export class ThreadsError extends Schema.TaggedErrorClass<ThreadsError>()("ThreadsError", {
  message: Schema.String,
  action: Args.ThreadAction,
}) {}

export type RunError =
  | ThreadService.Error
  | TournamentService.RunError
  | OrbStore.OrbStoreError
  | Client.SdkError
  | Input.InputError
  | ThreadsError

export interface Interface {
  readonly executeCommand: (command: Args.ThreadCommand) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Threads") {}

export class RemoteClient extends Context.Service<RemoteClient, Client.Interface>()("@rika/cli/Threads/RemoteClient") {}

export const remoteClientLayer = (client: Client.Interface) => Layer.succeed(RemoteClient, RemoteClient.of(client))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const output = yield* Output.Service
    const input = yield* Input.Service
    const threads = yield* ThreadService.Service
    const tournament = yield* Effect.serviceOption(TournamentService.Service)
    const orbs = yield* OrbStore.Service
    const remoteClient = yield* Effect.serviceOption(RemoteClient)

    return Service.of({
      executeCommand: Effect.fn("Cli.Threads.executeCommand")(function* (command: Args.ThreadCommand) {
        switch (command.action) {
          case "list": {
            const summaries = yield* threads.list(listInput(command))
            const enriched = yield* Effect.forEach(summaries, (summary) => withOrbStatus(orbs, summary))
            yield* output.stdout(formatJson(enriched))
            return 0
          }
          case "search": {
            const results = yield* threads.search(searchInput(command))
            yield* output.stdout(formatJson(results))
            return 0
          }
          case "archive": {
            const summary = yield* threads.archive({ thread_id: yield* requireThreadId(command) })
            yield* output.stdout(formatJson(summary))
            return 0
          }
          case "unarchive": {
            const summary = yield* threads.unarchive({ thread_id: yield* requireThreadId(command) })
            yield* output.stdout(formatJson(summary))
            return 0
          }
          case "visibility": {
            const visibility = yield* requireVisibility(command)
            const summary = yield* threads.setVisibility({
              thread_id: yield* requireThreadId(command),
              visibility,
            })
            yield* output.stdout(formatJson(summary))
            return 0
          }
          case "compact": {
            const remote = Option.getOrUndefined(remoteClient)
            if (remote === undefined) {
              return yield* new ThreadsError({
                message: "Thread compaction requires the shared backend client",
                action: command.action,
              })
            }
            const event = yield* remote.compactThread(yield* requireThreadId(command))
            yield* output.stdout(formatJson(event))
            return 0
          }
          case "fork": {
            const summary = yield* threads.fork({
              thread_id: yield* requireThreadId(command),
              ...(command.at_turn === undefined ? {} : { at_turn: command.at_turn }),
            })
            yield* output.stdout(formatJson(summary.thread_id))
            return 0
          }
          case "tournament": {
            const tournamentRunner = Option.getOrUndefined(tournament)
            if (tournamentRunner === undefined) {
              return yield* new ThreadsError({
                message: "Thread tournament requires the local tournament runner",
                action: command.action,
              })
            }
            const message = yield* tournamentMessage(input, command)
            const result = yield* tournamentRunner.run({
              thread_id: yield* requireThreadId(command),
              message,
              branch_count: command.branch_count ?? 3,
              ...(command.modes === undefined ? {} : { modes: command.modes }),
              ...(command.rubric === undefined ? {} : { rubric: command.rubric }),
            })
            yield* output.stdout(Tournament.formatResult(result))
            return 0
          }
          case "share": {
            const exported = yield* threads.share({ thread_id: yield* requireThreadId(command) })
            yield* output.stdout(formatJson(exported))
            return 0
          }
          case "reference": {
            const reference = yield* threads.reference({
              thread_id: yield* requireThreadId(command),
              ...(command.query === undefined ? {} : { query: command.query }),
            })
            yield* output.stdout(formatJson(reference))
            return 0
          }
          case "delete": {
            yield* threads.deleteThread({ thread_id: yield* requireThreadId(command) })
            return 0
          }
        }
        return yield* new ThreadsError({
          message: "Unsupported thread action",
          action: command.action,
        })
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

const requireThreadId = (command: Args.ThreadCommand) =>
  command.thread_id === undefined
    ? Effect.fail(new ThreadsError({ message: `Thread id is required for ${command.action}`, action: command.action }))
    : Effect.succeed(command.thread_id)

const requireVisibility = (command: Args.ThreadCommand) =>
  command.visibility === undefined
    ? Effect.fail(new ThreadsError({ message: "Thread visibility is required", action: command.action }))
    : Effect.succeed(command.visibility)

const listInput = (command: Args.ThreadCommand): ThreadService.ListInput => ({
  ...(command.include_archived === undefined ? {} : { include_archived: command.include_archived }),
  ...(command.limit === undefined ? {} : { limit: command.limit }),
})

const searchInput = (command: Args.ThreadCommand): ThreadService.SearchInput => ({
  ...(command.query === undefined ? {} : { query: command.query }),
  ...(command.include_archived === undefined ? {} : { include_archived: command.include_archived }),
  ...(command.limit === undefined ? {} : { limit: command.limit }),
})

const tournamentMessage = (input: Input.Interface, command: Args.ThreadCommand) =>
  command.message === undefined
    ? Effect.fail(new ThreadsError({ message: "Tournament message is required", action: command.action }))
    : command.message === "-"
      ? input.readAll.pipe(Effect.map((value) => value.trimEnd()))
      : Effect.succeed(command.message)

const withOrbStatus = (orbs: OrbStore.Interface, summary: ThreadService.ThreadSummary) =>
  orbs
    .getByThread(summary.thread_id)
    .pipe(Effect.map((orb) => (orb === undefined ? summary : { ...summary, orb_status: orb.status })))

const formatJson = (value: unknown) => JSON.stringify(value)

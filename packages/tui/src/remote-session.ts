import { Config } from "@rika/core"
import { Client } from "@rika/sdk"
import { Ids, Remote } from "@rika/schema"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import * as Renderer from "./renderer"
import * as Session from "./session"
import * as Terminal from "./terminal"
import * as ViewState from "./view-state"

export type RunInput = Session.RunInput
export const RunInput = Session.RunInput

export class RemoteSessionError extends Schema.TaggedErrorClass<RemoteSessionError>()("RemoteSessionError", {
  message: Schema.String,
  operation: Schema.String,
}) {}

export type RunError = RemoteSessionError | Client.SdkError | Terminal.TerminalError

export interface Interface {
  readonly run: (input: RunInput) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/tui/RemoteSession") {}

interface Dependencies {
  readonly client: Client.Interface
  readonly terminal: Terminal.Interface
}

export const layerFromClient = (client: Client.Interface) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const terminal = yield* Terminal.Service
      return make(client, terminal)
    }),
  )

export const make = (client: Client.Interface, terminal: Terminal.Interface): Interface => {
  const dependencies: Dependencies = { client, terminal }
  return Service.of({
    run: Effect.fn("Tui.RemoteSession.run")(function* (input: RunInput) {
      return yield* runSession(dependencies, input)
    }),
  })
}

export const run = Effect.fn("Tui.RemoteSession.run.call")(function* (input: RunInput) {
  const session = yield* Service
  return yield* session.run(input)
})

const runSession = (dependencies: Dependencies, input: RunInput): Effect.Effect<number, RunError> =>
  Effect.gen(function* () {
    const workspacePath = input.workspace_root ?? process.cwd()
    let mode = input.mode ?? "smart"
    const loaded = yield* loadThreadState(dependencies, input.thread_id, workspacePath, mode)
    let threadId = loaded.thread_id
    let state = ViewState.withNotice(
      loaded.state,
      "Connected to shared Rika backend. Type /help for the command palette.",
    )
    yield* render(dependencies, state)

    while (true) {
      const line = yield* dependencies.terminal.readLine({ prompt: "› " })
      if (line === undefined) return 0
      const trimmed = line.trim()
      if (trimmed.length === 0) continue

      if (trimmed.startsWith("/")) {
        const command = yield* handleCommand(dependencies, state, threadId, workspacePath, mode, trimmed)
        state = command.state
        threadId = command.thread_id
        mode = command.mode
        yield* render(dependencies, state)
        if (command.exit) return 0
        continue
      }

      yield* dependencies.client
        .startTurn({
          thread_id: threadId,
          workspace_id: Ids.WorkspaceId.make(workspacePath),
          content: line,
          mode,
        })
        .pipe(
          Stream.runForEach((event) => {
            state = ViewState.applyEvent(state, event)
            return render(dependencies, state)
          }),
        )
    }
  })

interface LoadedThread {
  readonly thread_id: Ids.ThreadId
  readonly state: ViewState.ViewState
}

interface CommandResult {
  readonly state: ViewState.ViewState
  readonly thread_id: Ids.ThreadId
  readonly mode: Config.Mode
  readonly exit: boolean
}

const loadThreadState = (
  dependencies: Dependencies,
  threadId: Ids.ThreadId | undefined,
  workspacePath: string,
  mode: Config.Mode,
): Effect.Effect<LoadedThread, RunError> =>
  Effect.gen(function* () {
    if (threadId !== undefined) {
      const record = yield* dependencies.client
        .openThread(threadId)
        .pipe(
          Effect.catchTag("SdkError", () =>
            dependencies.client
              .createThread({ thread_id: threadId, workspace_id: Ids.WorkspaceId.make(workspacePath) })
              .pipe(Effect.map((summary): Remote.ThreadRecord => ({ summary, events: [] }))),
          ),
        )
      return {
        thread_id: threadId,
        state: ViewState.initial({ thread_id: threadId, workspace_path: workspacePath, mode, events: record.events }),
      }
    }

    const summary = yield* dependencies.client.createThread({ workspace_id: Ids.WorkspaceId.make(workspacePath) })
    return {
      thread_id: summary.thread_id,
      state: ViewState.initial({ thread_id: summary.thread_id, workspace_path: workspacePath, mode, events: [] }),
    }
  })

const handleCommand = (
  dependencies: Dependencies,
  state: ViewState.ViewState,
  threadId: Ids.ThreadId,
  workspacePath: string,
  mode: Config.Mode,
  command: string,
): Effect.Effect<CommandResult, RunError> =>
  Effect.gen(function* () {
    const [name, argument] = splitCommand(command)
    if (name === "/exit" || name === "/quit")
      return { state: ViewState.withNotice(state, "Goodbye."), thread_id: threadId, mode, exit: true }
    if (name === "/help" || name === "/palette")
      return { state: ViewState.withPalette(state), thread_id: threadId, mode, exit: false }
    if (name === "/mode") return modeCommand(state, threadId, mode, argument)
    if (name === "/skills" || name === "/skill") {
      return {
        state: ViewState.withNotice(state, "Skills are loaded by the shared backend during agent turns."),
        thread_id: threadId,
        mode,
        exit: false,
      }
    }
    if (name === "/review") {
      return {
        state: ViewState.withNotice(
          state,
          "Use `rika review` for review runs; interactive review will be backend-routed next.",
        ),
        thread_id: threadId,
        mode,
        exit: false,
      }
    }
    if (name === "/threads") {
      const summaries = yield* dependencies.client.listThreads({ workspace_id: Ids.WorkspaceId.make(workspacePath) })
      return { state: ViewState.withNotice(state, formatSummaries(summaries)), thread_id: threadId, mode, exit: false }
    }
    if (name === "/search") {
      if (argument === undefined || argument.length === 0) {
        return { state: ViewState.withNotice(state, "Usage: /search <query>"), thread_id: threadId, mode, exit: false }
      }
      const results = yield* dependencies.client.searchThreads({
        query: argument,
        workspace_id: Ids.WorkspaceId.make(workspacePath),
      })
      return {
        state: ViewState.withNotice(state, formatSearchResults(results)),
        thread_id: threadId,
        mode,
        exit: false,
      }
    }
    if (name === "/new") {
      const summary = yield* dependencies.client.createThread({ workspace_id: Ids.WorkspaceId.make(workspacePath) })
      const next = ViewState.withThread(state, {
        thread_id: summary.thread_id,
        events: [],
        notice: `Started new thread ${summary.thread_id}`,
      })
      return { state: next, thread_id: summary.thread_id, mode, exit: false }
    }
    if (name === "/thread") {
      if (argument === undefined || argument.length === 0) {
        return {
          state: ViewState.withNotice(state, "Usage: /thread <thread-id>"),
          thread_id: threadId,
          mode,
          exit: false,
        }
      }
      const nextThreadId = Ids.ThreadId.make(argument)
      const record = yield* dependencies.client.openThread(nextThreadId)
      const next = ViewState.withThread(state, {
        thread_id: nextThreadId,
        events: record.events,
        notice: `Resumed thread ${nextThreadId}`,
      })
      return { state: next, thread_id: nextThreadId, mode, exit: false }
    }
    if (name === "/archive" || name === "/unarchive") {
      const target = argument === undefined || argument.length === 0 ? threadId : Ids.ThreadId.make(argument)
      const summary =
        name === "/archive"
          ? yield* dependencies.client.archiveThread(target)
          : yield* dependencies.client.unarchiveThread(target)
      const record = target === threadId ? yield* dependencies.client.openThread(target) : undefined
      const nextState =
        record === undefined
          ? state
          : ViewState.withThread(state, {
              thread_id: target,
              events: record.events,
              notice: `${name.slice(1)}d ${target}`,
            })
      return {
        state: ViewState.withNotice(nextState, `${summary.archived ? "Archived" : "Unarchived"} ${target}`),
        thread_id: threadId,
        mode,
        exit: false,
      }
    }
    if (name === "/share") {
      const target = argument === undefined || argument.length === 0 ? threadId : Ids.ThreadId.make(argument)
      const exported = yield* dependencies.client.shareThread(target)
      return {
        state: ViewState.withNotice(state, `Thread export JSON:\n${JSON.stringify(exported, null, 2)}`),
        thread_id: threadId,
        mode,
        exit: false,
      }
    }
    if (name === "/reference") {
      if (argument === undefined || argument.length === 0) {
        return {
          state: ViewState.withNotice(state, "Usage: /reference <thread-id> [query]"),
          thread_id: threadId,
          mode,
          exit: false,
        }
      }
      const [target, query] = splitFirst(argument)
      const reference = yield* dependencies.client.referenceThread({
        thread_id: Ids.ThreadId.make(target),
        ...(query === undefined ? {} : { query }),
      })
      return { state: ViewState.withNotice(state, reference.rendered), thread_id: threadId, mode, exit: false }
    }
    return {
      state: ViewState.withNotice(state, `Unknown command ${name}. Type /help.`),
      thread_id: threadId,
      mode,
      exit: false,
    }
  })

const modeCommand = (
  state: ViewState.ViewState,
  threadId: Ids.ThreadId,
  mode: Config.Mode,
  argument: string | undefined,
): CommandResult => {
  const nextMode = argument === undefined || argument.length === 0 ? nextModeAfter(mode) : parseMode(argument)
  if (nextMode === undefined) {
    return {
      state: ViewState.withNotice(state, "Usage: /mode rush|smart|deep"),
      thread_id: threadId,
      mode,
      exit: false,
    }
  }
  return {
    state: ViewState.withNotice(ViewState.withMode(state, nextMode), `Mode switched to ${nextMode}`),
    thread_id: threadId,
    mode: nextMode,
    exit: false,
  }
}

const parseMode = (value: string): Config.Mode | undefined => {
  const decoded = Schema.decodeUnknownOption(Config.Mode)(value)
  return Option.isSome(decoded) ? decoded.value : undefined
}

const nextModeAfter = (mode: Config.Mode): Config.Mode => {
  if (mode === "rush") return "smart"
  if (mode === "smart") return "deep"
  return "rush"
}

const render = (dependencies: Dependencies, state: ViewState.ViewState) =>
  dependencies.terminal.writeFrame(Renderer.render(state))

const splitCommand = (command: string): readonly [string, string | undefined] => {
  const [name, ...rest] = command.split(/\s+/)
  return [name ?? command, rest.length === 0 ? undefined : rest.join(" ")]
}

const splitFirst = (value: string): readonly [string, string | undefined] => {
  const [first, ...rest] = value.split(/\s+/)
  return [first ?? value, rest.length === 0 ? undefined : rest.join(" ")]
}

const formatSummaries = (summaries: ReadonlyArray<Remote.ThreadSummary>) => {
  if (summaries.length === 0) return "No active threads."
  return [`Active threads (${summaries.length})`, ...summaries.map(summaryLine)].join("\n")
}

const formatSearchResults = (results: ReadonlyArray<Remote.ThreadSearchResult>) => {
  if (results.length === 0) return "No matching threads."
  return [
    `Thread search results (${results.length})`,
    ...results.map((result) => `${summaryLine(result.summary)} · score ${result.score}`),
  ].join("\n")
}

const summaryLine = (summary: Remote.ThreadSummary) =>
  `${summary.thread_id}${summary.archived ? " [archived]" : ""}: ${summary.latest_message_text ?? "(no messages)"}`

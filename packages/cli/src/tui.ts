import { SkillRegistry, WorkspaceIdentity } from "@rika/agent"
import { Config, IdGenerator, Settings } from "@rika/core"
import { ThreadProjection } from "@rika/persistence"
import { ThreadActor, ThreadClient, ThreadDirectory } from "@rika/rivet-host"
import { Event, Ids, Message } from "@rika/schema"
import { Adapter, Backend, Controller, Keymap, Ticker, ViewState } from "@rika/tui"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname } from "node:path"
import * as Args from "./args"

export class TuiError extends Schema.TaggedErrorClass<TuiError>()("TuiError", {
  message: Schema.String,
  operation: Schema.String,
}) {}

export type RunError =
  | TuiError
  | Config.ConfigError
  | SkillRegistry.SkillRegistryError
  | ThreadClient.RunError
  | ThreadDirectory.ThreadDirectoryError

export interface Interface {
  readonly executeCommand: (command: Args.TuiCommand) => Effect.Effect<number, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Tui") {}

interface Dependencies {
  readonly configValues: Config.Values
  readonly idGenerator: IdGenerator.Interface
  readonly renderer: Adapter.Adapter
  readonly ticker: Ticker.Interface
  readonly threadClient: ThreadClient.Interface
  readonly threadDirectory: ThreadDirectory.Interface
  readonly skillRegistry: SkillRegistry.Interface
  readonly keymap?: Keymap.EffectiveKeymap
  readonly persistMode: (mode: Config.Mode) => Effect.Effect<void>
}

const localUserIdentity = { _tag: "VerifiedUserIdentity" as const, user_id: Ids.UserId.make("local") }

const isSettingsRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readUserSettings = async (path: string): Promise<Record<string, unknown>> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    return isSettingsRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const configValues = yield* config.get
    const idGenerator = yield* IdGenerator.Service
    const renderer = yield* Adapter.Service
    const ticker = yield* Ticker.Service
    const threadClient = yield* ThreadClient.Service
    const threadDirectory = yield* ThreadDirectory.Service
    const skillRegistry = yield* SkillRegistry.Service
    const settings = Option.getOrUndefined(yield* Effect.serviceOption(Settings.Service))
    const settingsSnapshot = settings === undefined ? undefined : yield* settings.snapshot
    const keymap =
      settingsSnapshot === undefined
        ? Keymap.defaultEffectiveKeymap
        : Keymap.effectiveKeymap({
            entries: settingsSnapshot.values.keymap,
            sources: settingsSnapshot.keymapSources,
          })
    const persistMode = (mode: Config.Mode) =>
      Effect.tryPromise({
        try: async () => {
          if (process.env.RIKA_MODE !== undefined && process.env.RIKA_MODE.length > 0) return
          const path = Settings.userSettingsPath(process.env.HOME ?? homedir())
          const current = await readUserSettings(path)
          current["mode.default"] = mode
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, `${JSON.stringify(current, null, 2)}\n`)
        },
        catch: (cause) => cause,
      }).pipe(Effect.ignore)

    const dependencies: Dependencies = {
      configValues,
      idGenerator,
      renderer,
      ticker,
      threadClient,
      threadDirectory,
      skillRegistry,
      keymap,
      persistMode,
    }

    return Service.of({
      executeCommand: Effect.fn("Cli.Tui.executeCommand")(function* (command: Args.TuiCommand) {
        const workspaceRoot = command.workspace_root ?? configValues.workspace_root
        const workspaceId = WorkspaceIdentity.resolveWorkspaceId({ workspace_root: workspaceRoot })
        return yield* Controller.run(
          {
            backend: makeBackend(dependencies),
            renderer,
            ticks: ticker.ticks,
            defaultMode: command.mode ?? configValues.default_mode,
            defaultWorkspace: workspaceRoot,
            keymap,
            persistMode,
          },
          {
            workspace_root: workspaceRoot,
            workspace_id: workspaceId,
            ...(command.thread_id === undefined ? {} : { thread_id: command.thread_id }),
            ...(command.mode === undefined ? {} : { mode: command.mode }),
          },
        )
      }),
    })
  }),
)

export const executeCommand = Effect.fn("Cli.Tui.executeCommand.call")(function* (command: Args.TuiCommand) {
  const service = yield* Service
  return yield* service.executeCommand(command)
})

const makeBackend = (dependencies: Dependencies): Backend.SessionBackend<RunError> => ({
  loadInitial: ({ thread_id, workspace_path, workspace_id, mode }) =>
    Effect.gen(function* () {
      const threadId = thread_id ?? Ids.ThreadId.make(yield* dependencies.idGenerator.next("thread"))
      const snapshot = yield* dependencies.threadClient.ensureThread({ thread_id: threadId, workspace_id })
      const events = yield* dependencies.threadClient.getEvents({ thread_id: threadId, after_sequence: 0 })
      return {
        thread_id: threadId,
        state: ViewState.beginConnecting(
          ViewState.initial({
            thread_id: threadId,
            workspace_path,
            mode,
            events,
          }),
        ),
        last_sequence: events.at(-1)?.sequence ?? snapshot.last_sequence,
      }
    }),
  streamTurn: (input) =>
    Stream.unwrap(
      dependencies.threadClient.ensureThread({ thread_id: input.thread_id, workspace_id: input.workspace_id }).pipe(
        Effect.flatMap((snapshot) =>
          dependencies.threadClient.startTurn(turnPayload(input)).pipe(
            Effect.as(
              dependencies.threadClient.subscribeEvents({
                thread_id: input.thread_id,
                after_sequence: snapshot.last_sequence,
              }),
            ),
          ),
        ),
      ),
    ),
  submitTurn: (input) => dependencies.threadClient.startTurn(turnPayload(input)).pipe(Effect.asVoid),
  subscribeThreadEvents: (input) => dependencies.threadClient.subscribeEvents(input),
  cancelTurn: (input) => dependencies.threadClient.interruptTurn(input).pipe(Effect.asVoid),
  runCommand: (context, command) => handleCommand(dependencies, context, command),
  listThreads: ({ workspace_id }) =>
    dependencies.threadDirectory
      .listThreads()
      .pipe(
        Effect.map((summaries) =>
          summaries.filter((summary) => summary.workspace_id === workspace_id).map(threadOptionFromSummary),
        ),
      ),
  loadThreadPreview: ({ thread_id, workspace_path, mode }) =>
    dependencies.threadClient.getEvents({ thread_id, after_sequence: 0 }).pipe(
      Effect.map((events) => ({
        thread_id,
        state: ViewState.initial({
          thread_id,
          workspace_path,
          mode,
          events,
        }),
      })),
    ),
})

const turnPayload = (input: Backend.TurnRequest): ThreadActor.StartTurnPayload => ({
  thread_id: input.thread_id,
  workspace_id: input.workspace_id,
  content: input.content,
  ...(input.content_parts === undefined ? {} : { content_parts: input.content_parts }),
  mode: input.mode,
  ...(input.fast_mode === undefined ? {} : { fast_mode: input.fast_mode }),
  ...(input.tool_access === undefined ? {} : { tool_access: input.tool_access }),
})

const threadOptionFromSummary = (summary: ThreadProjection.ThreadSummary): Backend.ThreadOption =>
  Backend.threadOption({
    thread_id: summary.thread_id,
    ...(summary.title_text === undefined ? {} : { title_text: summary.title_text }),
    ...(summary.latest_message_text === undefined ? {} : { latest_message_text: summary.latest_message_text }),
    updated_at: summary.updated_at,
    archived: summary.archived,
    diff: summary.diff,
  })

const handleCommand = (
  dependencies: Dependencies,
  context: Backend.CommandContext,
  command: string,
): Effect.Effect<Backend.CommandResult, RunError> =>
  Effect.gen(function* () {
    const { state, thread_id: threadId, workspace_id: workspaceId } = context
    const [name, argument] = Backend.splitCommand(command)
    if (name === "/exit" || name === "/quit") {
      return Backend.commandResult(context, { state: ViewState.withNotice(state, "Goodbye."), exit: true })
    }
    if (name === "/help" || name === "/palette") {
      return Backend.commandResult(context, { state: ViewState.withPalette(state) })
    }
    if (name === "/mode") return modeCommand(context, argument)
    if (name === "/fast") return fastCommand(context)
    if (name === "/relaunch") {
      return Backend.commandResult(context, {
        state: ViewState.withNotice(state, "Relaunch requested. Start Rika again after this session exits."),
        exit: true,
      })
    }
    if (name === "/welcome") {
      if (ViewState.modeLocked(state)) {
        return Backend.commandResult(context, {
          state: ViewState.withNotice(state, "Welcome is only available before a thread is active."),
        })
      }
      return Backend.commandResult(context, {
        state: ViewState.initial({ thread_id: threadId, workspace_path: context.workspace_path, mode: context.mode }),
      })
    }
    if (name === "/credits") {
      return Backend.commandResult(context, {
        state: ViewState.withNotice(state, "Rika is local actor-native software."),
      })
    }
    if (name === "/version") return Backend.commandResult(context, { state: ViewState.withNotice(state, "Rika 0.0.0") })
    if (name === "/doctor") {
      return Backend.commandResult(context, { state: ViewState.withNotice(state, "Run `rika doctor` from the shell.") })
    }
    if (name === "/review") {
      return Backend.commandResult(context, { state: ViewState.withNotice(state, "Run `rika review` from the shell.") })
    }
    if (name === "/ast-grep") {
      return Backend.commandResult(context, { state: ViewState.withNotice(state, "ast-grep outline status: ready") })
    }
    if (name === "/mcp") {
      return Backend.commandResult(context, { state: ViewState.withNotice(state, "Run `rika mcp` from the shell.") })
    }
    if (name === "/skills") {
      const skills = yield* dependencies.skillRegistry.list()
      return Backend.commandResult(context, { state: ViewState.withNotice(state, formatSkills(skills)) })
    }
    if (name === "/skill") {
      if (argument === undefined || argument.length === 0) {
        return Backend.commandResult(context, { state: ViewState.withNotice(state, "Usage: /skill <name>") })
      }
      const skill = yield* dependencies.skillRegistry.inspect(argument)
      return Backend.commandResult(context, { state: ViewState.withNotice(state, formatSkill(skill)) })
    }
    if (name === "/threads") {
      const summaries = yield* dependencies.threadDirectory.listThreads()
      return Backend.commandResult(context, {
        state: ViewState.withNotice(
          state,
          formatSummaries(summaries.filter((summary) => summary.workspace_id === workspaceId)),
        ),
      })
    }
    if (name === "/search") {
      if (argument === undefined || argument.length === 0) {
        return Backend.commandResult(context, { state: ViewState.withNotice(state, "Usage: /search <query>") })
      }
      const summaries = yield* dependencies.threadDirectory.listThreads()
      const results = summaries.filter(
        (summary) => summary.workspace_id === workspaceId && summaryMatches(summary, argument),
      )
      return Backend.commandResult(context, { state: ViewState.withNotice(state, formatSummaries(results)) })
    }
    if (name === "/compact") {
      const event = yield* dependencies.threadClient.compactThread({ thread_id: threadId })
      return Backend.commandResult(context, {
        state: ViewState.withNotice(ViewState.applyEvent(state, event), "Compacted thread context."),
        last_sequence: event.sequence,
      })
    }
    if (name === "/new") {
      const nextThreadId = Ids.ThreadId.make(yield* dependencies.idGenerator.next("thread"))
      const snapshot = yield* dependencies.threadClient.ensureThread({
        thread_id: nextThreadId,
        workspace_id: workspaceId,
      })
      const events = yield* dependencies.threadClient.getEvents({ thread_id: nextThreadId, after_sequence: 0 })
      const next = ViewState.withThread(state, {
        thread_id: nextThreadId,
        events,
        notice: `Started new thread ${nextThreadId}`,
      })
      return Backend.commandResult(context, {
        state: next,
        thread_id: nextThreadId,
        last_sequence: events.at(-1)?.sequence ?? snapshot.last_sequence,
      })
    }
    if (name === "/thread") return yield* threadCommand(dependencies, context, argument)
    if (name === "/fork") return yield* forkCommand(dependencies, context, argument)
    if (name === "/archive" || name === "/unarchive")
      return yield* archiveCommand(dependencies, context, name, argument)
    if (name === "/share") {
      const target = argument === undefined || argument.length === 0 ? threadId : Ids.ThreadId.make(argument)
      const events = yield* dependencies.threadClient.getEvents({ thread_id: target, after_sequence: 0 })
      return Backend.commandResult(context, {
        state: ViewState.withNotice(state, `Thread export JSON:\n${JSON.stringify({ events }, null, 2)}`),
      })
    }
    if (name === "/reference") {
      if (argument === undefined || argument.length === 0) {
        return Backend.commandResult(context, {
          state: ViewState.withNotice(state, "Usage: /reference <thread-id> [query]"),
        })
      }
      const [target, query] = Backend.splitFirst(argument)
      const events = yield* dependencies.threadClient.getEvents({
        thread_id: Ids.ThreadId.make(target),
        after_sequence: 0,
      })
      return Backend.commandResult(context, {
        state: ViewState.withNotice(state, formatReference(Ids.ThreadId.make(target), events, query)),
      })
    }
    return Backend.commandResult(context, {
      state: ViewState.withNotice(state, `Unknown command ${name}. Type /help.`),
    })
  })

const threadCommand = (
  dependencies: Dependencies,
  context: Backend.CommandContext,
  argument: string | undefined,
): Effect.Effect<Backend.CommandResult, RunError> =>
  Effect.gen(function* () {
    if (argument === undefined || argument.length === 0) {
      return Backend.commandResult(context, {
        state: ViewState.withNotice(context.state, "Usage: /thread <thread-id>"),
      })
    }
    const visibilityCommand = parseThreadVisibilityCommand(argument)
    if (visibilityCommand?.kind === "usage") {
      return Backend.commandResult(context, { state: ViewState.withNotice(context.state, threadVisibilityUsage) })
    }
    if (visibilityCommand?.kind === "set") {
      const snapshot = yield* dependencies.threadClient.setVisibility({
        thread_id: context.thread_id,
        visibility: visibilityCommand.visibility,
      })
      return Backend.commandResult(context, {
        state: ViewState.withNotice(context.state, `Thread visibility: ${snapshot.visibility}`),
      })
    }
    const nextThreadId = Ids.ThreadId.make(argument)
    const snapshot = yield* dependencies.threadClient.ensureThread({
      thread_id: nextThreadId,
      workspace_id: context.workspace_id,
    })
    const events = yield* dependencies.threadClient.getEvents({ thread_id: nextThreadId, after_sequence: 0 })
    const next = ViewState.beginConnecting(
      ViewState.withThread(context.state, {
        thread_id: nextThreadId,
        events,
      }),
    )
    return Backend.commandResult(context, {
      state: next,
      thread_id: nextThreadId,
      last_sequence: events.at(-1)?.sequence ?? snapshot.last_sequence,
    })
  })

const forkCommand = (
  dependencies: Dependencies,
  context: Backend.CommandContext,
  argument: string | undefined,
): Effect.Effect<Backend.CommandResult, RunError> =>
  Effect.gen(function* () {
    const sourceThreadId =
      argument === undefined || argument.length === 0 ? context.thread_id : Ids.ThreadId.make(argument)
    const forkThreadId = Ids.ThreadId.make(yield* dependencies.idGenerator.next("thread"))
    const snapshot = yield* dependencies.threadClient.forkThread({
      thread_id: sourceThreadId,
      fork_thread_id: forkThreadId,
      import_identity: localUserIdentity,
    })
    const events = yield* dependencies.threadClient.getEvents({ thread_id: forkThreadId, after_sequence: 0 })
    const next = ViewState.withNotice(
      ViewState.beginConnecting(
        ViewState.withThread(context.state, {
          thread_id: forkThreadId,
          events,
        }),
      ),
      `Forked thread ${sourceThreadId} into ${forkThreadId}`,
    )
    return Backend.commandResult(context, {
      state: next,
      thread_id: forkThreadId,
      last_sequence: events.at(-1)?.sequence ?? snapshot.last_sequence,
    })
  })

const archiveCommand = (
  dependencies: Dependencies,
  context: Backend.CommandContext,
  name: "/archive" | "/unarchive",
  argument: string | undefined,
): Effect.Effect<Backend.CommandResult, RunError> =>
  Effect.gen(function* () {
    const target = argument === undefined || argument.length === 0 ? context.thread_id : Ids.ThreadId.make(argument)
    const snapshot =
      name === "/archive"
        ? yield* dependencies.threadClient.archiveThread({ thread_id: target })
        : yield* dependencies.threadClient.unarchiveThread({ thread_id: target })
    const events =
      target === context.thread_id
        ? yield* dependencies.threadClient.getEvents({ thread_id: target, after_sequence: 0 })
        : []
    const nextState =
      target === context.thread_id
        ? ViewState.withThread(context.state, {
            thread_id: target,
            events,
            notice: `${name.slice(1)}d ${target}`,
          })
        : context.state
    return Backend.commandResult(context, {
      state: ViewState.withNotice(nextState, `${snapshot.archived ? "Archived" : "Unarchived"} ${target}`),
      ...(target === context.thread_id ? { last_sequence: events.at(-1)?.sequence ?? snapshot.last_sequence } : {}),
    })
  })

const fastCommand = (context: Backend.CommandContext): Backend.CommandResult => {
  if (!ViewState.isFastEligible(context.mode)) {
    return Backend.commandResult(context, {
      state: ViewState.withNotice(context.state, "Fast speed is only available in rush and deep modes."),
    })
  }
  const next = ViewState.toggleFastMode(context.state)
  return Backend.commandResult(context, {
    state: ViewState.withNotice(next, next.fast_mode ? "Fast speed on ↯ (priority processing)" : "Standard speed"),
  })
}

const modeCommand = (context: Backend.CommandContext, argument: string | undefined): Backend.CommandResult => {
  const nextMode = argument === undefined || argument.length === 0 ? nextModeAfter(context.mode) : parseMode(argument)
  if (nextMode === undefined) {
    return Backend.commandResult(context, {
      state: ViewState.withNotice(context.state, "Usage: /mode rush|smart|deep1|deep2|deep3"),
    })
  }
  if (ViewState.modeLocked(context.state)) {
    return Backend.commandResult(context, {
      state: ViewState.withNotice(context.state, "Mode is locked once a thread is active."),
    })
  }
  return Backend.commandResult(context, {
    state: ViewState.withMode(context.state, nextMode),
    mode: nextMode,
  })
}

const parseMode = (value: string): Config.Mode | undefined => {
  const decoded = Schema.decodeUnknownOption(Config.Mode)(value)
  return Option.isSome(decoded) ? decoded.value : undefined
}

const threadVisibilityUsage = "Usage: /thread visibility <private|workspace|unlisted>"

type ThreadVisibilityCommand =
  | { readonly kind: "set"; readonly visibility: Event.ThreadVisibility }
  | { readonly kind: "usage" }

const parseThreadVisibilityCommand = (argument: string): ThreadVisibilityCommand | undefined => {
  const [subcommand, value] = Backend.splitFirst(argument)
  if (subcommand !== "visibility") return undefined
  if (value === "private" || value === "workspace" || value === "unlisted") return { kind: "set", visibility: value }
  return { kind: "usage" }
}

const nextModeAfter = (mode: Config.Mode): Config.Mode => {
  if (mode === "rush") return "smart"
  if (mode === "smart") return "deep1"
  if (mode === "deep1") return "deep2"
  if (mode === "deep2") return "deep3"
  return "rush"
}

const formatSummaries = (summaries: ReadonlyArray<ThreadProjection.ThreadSummary>) => {
  if (summaries.length === 0) return "No active threads."
  return [`Active threads (${summaries.length})`, ...summaries.map(summaryLine)].join("\n")
}

const summaryMatches = (summary: ThreadProjection.ThreadSummary, query: string) => {
  const needle = query.toLowerCase()
  return [summary.thread_id, summary.title_text, summary.latest_message_text]
    .filter((value): value is string => value !== undefined)
    .some((value) => value.toLowerCase().includes(needle))
}

const summaryLine = (summary: ThreadProjection.ThreadSummary) =>
  `${summary.thread_id}${summary.archived ? " [archived]" : ""}: ${summary.latest_message_text ?? "(no messages)"}`

const formatSkills = (skills: ReadonlyArray<SkillRegistry.SkillSummary>) => {
  if (skills.length === 0) return "No skills found."
  return [`Skills (${skills.length})`, ...skills.map((skill) => `- ${skill.name}: ${skill.description}`)].join("\n")
}

const formatSkill = (skill: SkillRegistry.Skill) =>
  [
    `${skill.summary.name}: ${skill.summary.description}`,
    `Source: ${skill.summary.source}`,
    ...skill.resources.map((resource) => `- ${resource.relative_path}`),
  ].join("\n")

const formatReference = (threadId: Ids.ThreadId, events: ReadonlyArray<Event.Event>, query: string | undefined) => {
  const title = query === undefined ? `Thread reference ${threadId}` : `Thread reference ${threadId} (${query})`
  const text = events
    .filter((event) => event.type === "message.added")
    .map((event) => Message.displayText(event.data.message))
    .filter((value) => value.length > 0)
    .join("\n\n")
  return text.length === 0 ? `${title}\n(no messages)` : `${title}\n${text}`
}

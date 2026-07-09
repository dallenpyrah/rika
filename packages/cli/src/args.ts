import { Config } from "@rika/core"
import { Ids } from "@rika/schema"
import { NodeServices } from "@effect/platform-node"
import { Console as EffectConsole, Effect, Option, Ref, Schema } from "effect"
import { Argument, CliError, Command, Flag } from "effect/unstable/cli"

export interface ExecuteCommand extends Schema.Schema.Type<typeof ExecuteCommand> {}
export const ExecuteCommand = Schema.Struct({
  type: Schema.Literal("execute"),
  prompt: Schema.String,
  stream_json: Schema.Boolean,
  stream_json_input: Schema.Boolean,
  mode: Schema.optional(Config.Mode),
  workspace_root: Schema.optional(Schema.String),
  thread_id: Schema.optional(Ids.ThreadId),
  ephemeral: Schema.Boolean,
}).annotate({ identifier: "Rika.Cli.Args.ExecuteCommand" })

export const ThreadAction = Schema.Literals([
  "list",
  "search",
  "archive",
  "unarchive",
  "compact",
  "fork",
  "visibility",
  "share",
  "reference",
  "delete",
  "rebuild-projection",
  "import",
]).annotate({ identifier: "Rika.Cli.Args.ThreadAction" })
export type ThreadAction = typeof ThreadAction.Type

export interface ThreadCommand extends Schema.Schema.Type<typeof ThreadCommand> {}
export const ThreadCommand = Schema.Struct({
  type: Schema.Literal("threads"),
  action: ThreadAction,
  thread_id: Schema.optional(Ids.ThreadId),
  query: Schema.optional(Schema.String),
  at_turn: Schema.optional(Ids.TurnId),
  visibility: Schema.optional(Schema.Literals(["private", "workspace", "unlisted"])),
  include_archived: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Int),
  semantic: Schema.optional(Schema.Boolean),
  source_data_dir: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Cli.Args.ThreadCommand" })

export const SkillAction = Schema.Literals(["list", "inspect", "add", "remove"]).annotate({
  identifier: "Rika.Cli.Args.SkillAction",
})
export type SkillAction = typeof SkillAction.Type

export interface SkillCommand extends Schema.Schema.Type<typeof SkillCommand> {}
export const SkillCommand = Schema.Struct({
  type: Schema.Literal("skills"),
  action: SkillAction,
  name: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  user: Schema.optional(Schema.Boolean),
  force: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Rika.Cli.Args.SkillCommand" })

export const McpAction = Schema.Literals(["list", "approve", "add", "remove", "doctor"]).annotate({
  identifier: "Rika.Cli.Args.McpAction",
})
export type McpAction = typeof McpAction.Type

export interface McpCommand extends Schema.Schema.Type<typeof McpCommand> {}
export const McpCommand = Schema.Struct({
  type: Schema.Literal("mcp"),
  action: McpAction,
  server_name: Schema.optional(Schema.String),
  global: Schema.optional(Schema.Boolean),
  url: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "Rika.Cli.Args.McpCommand" })

export const ConfigAction = Schema.Literals(["list", "edit"]).annotate({
  identifier: "Rika.Cli.Args.ConfigAction",
})
export type ConfigAction = typeof ConfigAction.Type

export interface ConfigCommand extends Schema.Schema.Type<typeof ConfigCommand> {}
export const ConfigCommand = Schema.Struct({
  type: Schema.Literal("config"),
  action: ConfigAction,
  workspace: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Rika.Cli.Args.ConfigCommand" })

export interface VersionCommand extends Schema.Schema.Type<typeof VersionCommand> {}
export const VersionCommand = Schema.Struct({
  type: Schema.Literal("version"),
}).annotate({ identifier: "Rika.Cli.Args.VersionCommand" })

export interface HelpCommand extends Schema.Schema.Type<typeof HelpCommand> {}
export const HelpCommand = Schema.Struct({
  type: Schema.Literal("help"),
  topic: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Cli.Args.HelpCommand" })

export interface TuiCommand extends Schema.Schema.Type<typeof TuiCommand> {}
export const TuiCommand = Schema.Struct({
  type: Schema.Literal("tui"),
  mode: Schema.optional(Config.Mode),
  workspace_root: Schema.optional(Schema.String),
  thread_id: Schema.optional(Ids.ThreadId),
  ephemeral: Schema.Boolean,
}).annotate({ identifier: "Rika.Cli.Args.TuiCommand" })

export interface InvalidExecuteAliasCommand extends Schema.Schema.Type<typeof InvalidExecuteAliasCommand> {}
export const InvalidExecuteAliasCommand = Schema.Struct({
  type: Schema.Literal("invalid_execute_alias"),
}).annotate({ identifier: "Rika.Cli.Args.InvalidExecuteAliasCommand" })

export interface ReviewCommand extends Schema.Schema.Type<typeof ReviewCommand> {}
export const ReviewCommand = Schema.Struct({
  type: Schema.Literal("review"),
  workspace_root: Schema.optional(Schema.String),
  staged: Schema.Boolean,
  base_ref: Schema.optional(Schema.String),
  paths: Schema.Array(Schema.String),
  ephemeral: Schema.Boolean,
}).annotate({ identifier: "Rika.Cli.Args.ReviewCommand" })

export const ExtensionAction = Schema.Literals([
  "create-skill",
  "create-plugin",
  "enable-plugin",
  "disable-plugin",
  "rollback-plugin",
]).annotate({ identifier: "Rika.Cli.Args.ExtensionAction" })
export type ExtensionAction = typeof ExtensionAction.Type

export interface ExtensionCommand extends Schema.Schema.Type<typeof ExtensionCommand> {}
export const ExtensionCommand = Schema.Struct({
  type: Schema.Literal("extensions"),
  action: ExtensionAction,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  verification_command: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  thread_id: Schema.optional(Ids.ThreadId),
}).annotate({ identifier: "Rika.Cli.Args.ExtensionCommand" })

export const MemoryAction = Schema.Literals(["index", "status"]).annotate({
  identifier: "Rika.Cli.Args.MemoryAction",
})
export type MemoryAction = typeof MemoryAction.Type

export interface MemoryCommand extends Schema.Schema.Type<typeof MemoryCommand> {}
export const MemoryCommand = Schema.Struct({
  type: Schema.Literal("memory"),
  action: MemoryAction,
  workspace_root: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Cli.Args.MemoryCommand" })

export interface DoctorCommand extends Schema.Schema.Type<typeof DoctorCommand> {}
export const DoctorCommand = Schema.Struct({
  type: Schema.Literal("doctor"),
}).annotate({ identifier: "Rika.Cli.Args.DoctorCommand" })

export type ParsedCommand =
  | ExecuteCommand
  | ThreadCommand
  | SkillCommand
  | McpCommand
  | ConfigCommand
  | VersionCommand
  | HelpCommand
  | TuiCommand
  | InvalidExecuteAliasCommand
  | ReviewCommand
  | ExtensionCommand
  | MemoryCommand
  | DoctorCommand

export class ArgsError extends Schema.TaggedErrorClass<ArgsError>()("ArgsError", {
  message: Schema.String,
  exit_code: Schema.Int,
  usage: Schema.optional(Schema.String),
}) {}

export const invalidExecuteAliasErrorText = "Error: error: unknown option '-e'\n\u001b[=0u\u001b[<u\u001b[?25h"

export const usage = [
  "Usage:",
  "  rika [options]",
  "  rika <command> [options]",
  "  rika run [options] [prompt]",
  "  rika --execute [options] [prompt]",
  "  rika threads list [--include-archived] [--limit <n>]",
  "  rika threads search [--semantic] [--include-archived] [--limit <n>] <query>",
  "  rika threads archive <thread-id>",
  "  rika threads unarchive <thread-id>",
  "  rika threads visibility <thread-id> <private|workspace|unlisted>",
  "  rika threads fork <thread-id> [--at-turn <turn-id>]",
  "  rika threads share <thread-id>",
  "  rika threads reference <thread-id> [query]",
  "  rika threads delete <thread-id>",
  "  rika threads rebuild-projection",
  "  rika threads import <source-data-dir>",
  "  rika skills list|inspect|add|remove",
  "  rika mcp list|add|remove|doctor|approve",
  "  rika config list|edit",
  "  rika review [--staged] [--base <ref>] [--workspace <path>] [--ephemeral] [paths...]",
  "  rika extensions <create-skill|create-plugin|enable-plugin|disable-plugin|rollback-plugin> ...",
  "  rika memory index [--workspace <path>]",
  "  rika memory status",
  "  rika doctor",
  "  rika version",
  "",
  "Options:",
  "  -V, --version          Print the version number and exit",
  "  -v                     Alias for --version",
  "  -x, --execute           Run one non-interactive turn",
  "  -m, --mode <rush|smart|deep1|deep2|deep3> Select agent mode",
  "  --workspace <path>      Workspace root for the turn",
  "  --thread <id>           Reuse a durable thread id",
  "  --ephemeral             Use in-memory persistence for this run",
  "  --stream-json           Stream schema JSON events to stdout",
  "  --stream-json-input     Read JSON Lines user messages from stdin; requires --stream-json",
  "  -h, --help              Show this help",
].join("\n")

const modeChoices = ["rush", "smart", "deep1", "deep2", "deep3"] as const
const visibilityChoices = ["private", "workspace", "unlisted"] as const

interface TurnInput {
  readonly execute?: boolean
  readonly mode: Option.Option<Config.Mode>
  readonly workspace: Option.Option<string>
  readonly thread: Option.Option<string>
  readonly ephemeral: boolean
  readonly streamJson?: boolean
  readonly streamJsonInput?: boolean
  readonly prompt?: ReadonlyArray<string>
}

const turnFlags = {
  mode: Flag.choice("mode", modeChoices).pipe(Flag.withAlias("m"), Flag.optional),
  workspace: Flag.string("workspace").pipe(Flag.optional),
  thread: Flag.string("thread").pipe(Flag.optional),
  ephemeral: Flag.boolean("ephemeral"),
}

const executeFlags = {
  ...turnFlags,
  streamJson: Flag.boolean("stream-json"),
  streamJsonInput: Flag.boolean("stream-json-input"),
  prompt: Argument.string("prompt").pipe(Argument.variadic()),
}

const rootFlags = {
  ...executeFlags,
  execute: Flag.boolean("execute").pipe(Flag.withAlias("x")),
}

export const parse = Effect.fn("Cli.Args.parse")(function* (argv: ReadonlyArray<string>) {
  if (argv.length === 1 && argv[0] === "-e") return { type: "invalid_execute_alias" as const }
  if (isHelp(argv))
    return { type: "help" as const, ...(helpTopic(argv) === undefined ? {} : { topic: helpTopic(argv) }) }
  if (isVersion(argv)) return { type: "version" as const }

  const parsed = yield* Ref.make<ParsedCommand | undefined>(undefined)
  const run = Command.runWith(commandParser(parsed), { version: "0.0.0" })(argv).pipe(
    Effect.provideService(EffectConsole.Console, silentConsole),
    Effect.provide(NodeServices.layer),
  )

  yield* run.pipe(Effect.mapError((error) => (error instanceof ArgsError ? error : argsErrorFromCliError(error))))
  const command = yield* Ref.get(parsed)
  if (command === undefined) return yield* argsError("No command parsed")
  return command
})

const commandParser = (parsed: Ref.Ref<ParsedCommand | undefined>) =>
  Command.make("rika", rootFlags, (input) =>
    rootCommand(input as TurnInput).pipe(Effect.flatMap((command) => Ref.set(parsed, command))),
  ).pipe(
    Command.withDescription("Local Rika agent CLI"),
    Command.withSubcommands([
      runCommand(parsed),
      threadsCommand(parsed),
      skillsCommand(parsed),
      mcpCommand(parsed),
      configCommand(parsed),
      reviewCommand(parsed),
      extensionsCommand(parsed),
      memoryCommand(parsed),
      doctorCommand(parsed),
      versionCommand(parsed),
    ]),
  )

const runCommand = (parsed: Ref.Ref<ParsedCommand | undefined>) =>
  Command.make("run", executeFlags, (input) =>
    validateExecuteInput(input as TurnInput).pipe(
      Effect.map(toExecuteCommand),
      Effect.flatMap((command) => Ref.set(parsed, command)),
    ),
  ).pipe(Command.withDescription("Run one non-interactive turn"))

const threadsCommand = (parsed: Ref.Ref<ParsedCommand | undefined>) => {
  const listConfig = {
    includeArchived: Flag.boolean("include-archived"),
    limit: Flag.integer("limit").pipe(Flag.optional),
  }
  const list = (input: {
    readonly includeArchived: boolean
    readonly limit: Option.Option<number>
  }): ThreadCommand => ({
    type: "threads",
    action: "list",
    ...(input.includeArchived ? { include_archived: true } : {}),
    ...optionField("limit", input.limit),
  })
  return Command.make("threads", listConfig, (input) => Ref.set(parsed, list(input))).pipe(
    Command.withDescription("Manage local actor threads"),
    Command.withSubcommands([
      Command.make("list", listConfig, (input) => Ref.set(parsed, list(input))),
      Command.make(
        "search",
        {
          semantic: Flag.boolean("semantic"),
          includeArchived: Flag.boolean("include-archived"),
          limit: Flag.integer("limit").pipe(Flag.optional),
          query: Argument.string("query").pipe(Argument.variadic()),
        },
        (input) =>
          input.query.length === 0
            ? argsError("rika threads search requires a query")
            : Ref.set(parsed, {
                type: "threads",
                action: "search",
                query: input.query.join(" "),
                ...(input.semantic ? { semantic: true } : {}),
                ...(input.includeArchived ? { include_archived: true } : {}),
                ...optionField("limit", input.limit),
              }),
      ).pipe(Command.withAlias("find")),
      threadIdCommand(parsed, "archive"),
      threadIdCommand(parsed, "unarchive"),
      threadIdCommand(parsed, "compact"),
      threadIdCommand(parsed, "share"),
      threadIdCommand(parsed, "delete"),
      Command.make(
        "fork",
        {
          thread: Argument.string("thread-id"),
          atTurn: Flag.string("at-turn").pipe(Flag.optional),
        },
        (input) =>
          Ref.set(parsed, {
            type: "threads",
            action: "fork",
            thread_id: Ids.ThreadId.make(input.thread),
            ...optionField("at_turn", Option.map(input.atTurn, Ids.TurnId.make)),
          }),
      ),
      Command.make(
        "visibility",
        {
          thread: Argument.string("thread-id"),
          visibility: Argument.choice("visibility", visibilityChoices),
        },
        (input) =>
          Ref.set(parsed, {
            type: "threads",
            action: "visibility",
            thread_id: Ids.ThreadId.make(input.thread),
            visibility: input.visibility,
          }),
      ),
      Command.make(
        "reference",
        {
          thread: Argument.string("thread-id"),
          query: Argument.string("query").pipe(Argument.variadic()),
        },
        (input) =>
          Ref.set(parsed, {
            type: "threads",
            action: "reference",
            thread_id: Ids.ThreadId.make(input.thread),
            ...(input.query.length === 0 ? {} : { query: input.query.join(" ") }),
          }),
      ),
      Command.make("rebuild-projection", {}, () => Ref.set(parsed, { type: "threads", action: "rebuild-projection" })),
      Command.make("import", { source: Argument.string("source-data-dir") }, (input) =>
        Ref.set(parsed, { type: "threads", action: "import", source_data_dir: input.source }),
      ),
    ]),
  )
}

const threadIdCommand = (parsed: Ref.Ref<ParsedCommand | undefined>, action: ThreadAction) =>
  Command.make(action, { thread: Argument.string("thread-id") }, (input) =>
    Ref.set(parsed, { type: "threads", action, thread_id: Ids.ThreadId.make(input.thread) }),
  )

const skillsCommand = (parsed: Ref.Ref<ParsedCommand | undefined>) =>
  Command.make("skills").pipe(
    Command.withSubcommands([
      Command.make("list", {}, () => Ref.set(parsed, { type: "skills", action: "list" })),
      Command.make("inspect", { name: Argument.string("name") }, (input) =>
        Ref.set(parsed, { type: "skills", action: "inspect", name: input.name }),
      ),
      Command.make(
        "add",
        {
          source: Argument.string("source"),
          user: Flag.boolean("user"),
          force: Flag.boolean("force"),
        },
        (input) =>
          Ref.set(parsed, {
            type: "skills",
            action: "add",
            source: input.source,
            user: input.user,
            force: input.force,
          }),
      ),
      Command.make(
        "remove",
        {
          name: Argument.string("name"),
          user: Flag.boolean("user"),
        },
        (input) => Ref.set(parsed, { type: "skills", action: "remove", name: input.name, user: input.user }),
      ),
    ]),
  )

const mcpCommand = (parsed: Ref.Ref<ParsedCommand | undefined>) =>
  Command.make("mcp").pipe(
    Command.withSubcommands([
      Command.make("list", {}, () => Ref.set(parsed, { type: "mcp", action: "list" })),
      Command.make("doctor", {}, () => Ref.set(parsed, { type: "mcp", action: "doctor" })),
      Command.make("approve", { server: Argument.string("server-name") }, (input) =>
        Ref.set(parsed, { type: "mcp", action: "approve", server_name: input.server }),
      ),
      Command.make(
        "add",
        {
          server: Argument.string("server-name"),
          global: Flag.boolean("global"),
          url: Flag.string("url").pipe(Flag.optional),
          command: Argument.string("command").pipe(Argument.variadic()),
        },
        (input) => mcpAddCommand(input).pipe(Effect.flatMap((command) => Ref.set(parsed, command))),
      ),
      Command.make(
        "remove",
        {
          server: Argument.string("server-name"),
          global: Flag.boolean("global"),
        },
        (input) =>
          Ref.set(parsed, {
            type: "mcp",
            action: "remove",
            server_name: input.server,
            ...(input.global ? { global: true } : {}),
          }),
      ),
    ]),
  )

const configCommand = (parsed: Ref.Ref<ParsedCommand | undefined>) =>
  Command.make("config").pipe(
    Command.withSubcommands([
      Command.make("list", {}, () => Ref.set(parsed, { type: "config", action: "list" })),
      Command.make("edit", { workspace: Flag.boolean("workspace") }, (input) =>
        Ref.set(parsed, { type: "config", action: "edit", ...(input.workspace ? { workspace: true } : {}) }),
      ),
    ]),
  )

const reviewCommand = (parsed: Ref.Ref<ParsedCommand | undefined>) =>
  Command.make(
    "review",
    {
      staged: Flag.boolean("staged"),
      base: Flag.string("base").pipe(Flag.optional),
      workspace: Flag.string("workspace").pipe(Flag.optional),
      ephemeral: Flag.boolean("ephemeral"),
      paths: Argument.string("paths").pipe(Argument.variadic()),
    },
    (input) =>
      Ref.set(parsed, {
        type: "review",
        staged: input.staged,
        paths: input.paths,
        ephemeral: input.ephemeral,
        ...optionField("base_ref", input.base),
        ...optionField("workspace_root", input.workspace),
      }),
  )

interface ExtensionInput {
  readonly name: string
  readonly description: Option.Option<string>
  readonly instructions: Option.Option<string>
  readonly verification: Option.Option<string>
  readonly reason: Option.Option<string>
  readonly thread: Option.Option<string>
}

const extensionsCommand = (parsed: Ref.Ref<ParsedCommand | undefined>) => {
  const config = {
    name: Argument.string("name"),
    description: Flag.string("description").pipe(Flag.optional),
    instructions: Flag.string("instructions").pipe(Flag.optional),
    verification: Flag.string("verification").pipe(Flag.optional),
    reason: Flag.string("reason").pipe(Flag.optional),
    thread: Flag.string("thread").pipe(Flag.optional),
  }
  const commandFor = (action: ExtensionAction, input: ExtensionInput): ExtensionCommand => ({
    type: "extensions",
    action,
    name: input.name,
    ...optionField("description", input.description),
    ...optionField("instructions", input.instructions),
    ...optionField("verification_command", input.verification),
    ...optionField("reason", input.reason),
    ...optionField("thread_id", Option.map(input.thread, Ids.ThreadId.make)),
  })
  return Command.make("extensions").pipe(
    Command.withSubcommands([
      Command.make("create-skill", config, (input) => Ref.set(parsed, commandFor("create-skill", input))),
      Command.make("create-plugin", config, (input) => Ref.set(parsed, commandFor("create-plugin", input))),
      Command.make("enable-plugin", config, (input) => Ref.set(parsed, commandFor("enable-plugin", input))),
      Command.make("disable-plugin", config, (input) => Ref.set(parsed, commandFor("disable-plugin", input))),
      Command.make("rollback-plugin", config, (input) => Ref.set(parsed, commandFor("rollback-plugin", input))),
    ]),
  )
}

const memoryCommand = (parsed: Ref.Ref<ParsedCommand | undefined>) =>
  Command.make("memory").pipe(
    Command.withSubcommands([
      Command.make("status", {}, () => Ref.set(parsed, { type: "memory", action: "status" })),
      Command.make("index", { workspace: Flag.string("workspace").pipe(Flag.optional) }, (input) =>
        Ref.set(parsed, { type: "memory", action: "index", ...optionField("workspace_root", input.workspace) }),
      ),
    ]),
  )

const doctorCommand = (parsed: Ref.Ref<ParsedCommand | undefined>) =>
  Command.make("doctor", {}, () => Ref.set(parsed, { type: "doctor" }))

const versionCommand = (parsed: Ref.Ref<ParsedCommand | undefined>) =>
  Command.make("version", {}, () => Ref.set(parsed, { type: "version" }))

const rootCommand = (input: TurnInput): Effect.Effect<ParsedCommand, ArgsError> => {
  if (input.execute === true) return validateExecuteInput(input).pipe(Effect.map(toExecuteCommand))
  if (input.streamJson === true || input.streamJsonInput === true) {
    return argsError("--stream-json requires --execute or run")
  }
  if ((input.prompt ?? []).length > 0) return argsError("Expected run or --execute for prompt input")
  return Effect.succeed(toTuiCommand(input))
}

const validateExecuteInput = (input: TurnInput): Effect.Effect<TurnInput, ArgsError> => {
  const streamJsonInput = input.streamJsonInput === true
  const streamJson = input.streamJson === true
  return streamJsonInput && !streamJson
    ? argsError("--stream-json-input requires --stream-json")
    : Effect.succeed(input)
}

const toExecuteCommand = (input: TurnInput): ExecuteCommand => ({
  type: "execute",
  prompt: (input.prompt ?? []).join(" ").trim(),
  stream_json: input.streamJson ?? false,
  stream_json_input: input.streamJsonInput ?? false,
  ephemeral: input.ephemeral,
  ...optionField("mode", input.mode),
  ...optionField("workspace_root", input.workspace),
  ...optionField("thread_id", Option.map(input.thread, Ids.ThreadId.make)),
})

const toTuiCommand = (input: TurnInput): TuiCommand => ({
  type: "tui",
  ephemeral: input.ephemeral,
  ...optionField("mode", input.mode),
  ...optionField("workspace_root", input.workspace),
  ...optionField("thread_id", Option.map(input.thread, Ids.ThreadId.make)),
})

const mcpAddCommand = (input: {
  readonly server: string
  readonly global: boolean
  readonly url: Option.Option<string>
  readonly command: ReadonlyArray<string>
}): Effect.Effect<McpCommand, ArgsError> => {
  const url = Option.getOrUndefined(input.url)
  if (url !== undefined && input.command.length > 0) {
    return argsError("rika mcp add accepts either --url or command argv, not both")
  }
  if (url === undefined && input.command.length === 0) return argsError("rika mcp add requires --url or command argv")
  return Effect.succeed({
    type: "mcp",
    action: "add",
    server_name: input.server,
    ...(input.global ? { global: true } : {}),
    ...(url === undefined ? { command: input.command[0] ?? "", args: input.command.slice(1) } : { url }),
  })
}

const optionField = <Key extends string, Value>(
  key: Key,
  value: Option.Option<Value>,
): { readonly [K in Key]?: Value } =>
  Option.isSome(value) ? ({ [key]: value.value } as { readonly [K in Key]?: Value }) : {}

const isHelp = (argv: ReadonlyArray<string>) => argv.at(-1) === "--help" || argv.at(-1) === "-h"

const helpTopic = (argv: ReadonlyArray<string>) => {
  if (argv.length <= 1) return undefined
  return argv.filter((part) => part !== "--help" && part !== "-h").join("-")
}

const isVersion = (argv: ReadonlyArray<string>) =>
  argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "-V" || argv[0] === "version")

const argsError = (message: string): Effect.Effect<never, ArgsError> =>
  Effect.fail(new ArgsError({ message, exit_code: 2, usage }))

const argsErrorFromCliError = (error: CliError.CliError): ArgsError => {
  if (error._tag === "ShowHelp") {
    const message =
      error.errors.length === 0 ? "Expected a command" : error.errors.map((entry) => entry.message).join("\n")
    return new ArgsError({ message, exit_code: 2, usage })
  }
  return new ArgsError({ message: error.message, exit_code: 2, usage })
}

const silentConsole: EffectConsole.Console = {
  ...globalThis.console,
  log: () => {},
  error: () => {},
}

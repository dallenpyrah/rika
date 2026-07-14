import * as Operation from "@rika/app/operation"
import { Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { command as ConfigCommand } from "./commands/config"
import { command as DiagnosticsCommand } from "./commands/diagnostics"
import { command as ExtensionsCommand } from "./commands/extensions"
import { command as McpCommand } from "./commands/mcp"
import { command as SkillsCommand } from "./commands/skills"
import { dispatch } from "./commands/shared"
import { command as ThreadsCommand } from "./commands/threads"
import { command as ToolsCommand } from "./commands/tools"
import { command as WorkflowsCommand } from "./commands/workflows"

export const version = "0.0.0"

const mode = Flag.choice("mode", ["low", "medium", "high", "ultra"]).pipe(Flag.withAlias("m"), Flag.optional)
const workspace = Flag.directory("workspace").pipe(Flag.optional)
const thread = Flag.string("thread").pipe(Flag.optional)
const ephemeral = Flag.boolean("ephemeral")
const prompt = Argument.variadic(Argument.string("prompt"))
const streamFlags = {
  streamJson: Flag.boolean("stream-json"),
  streamJsonInput: Flag.boolean("stream-json-input"),
  streamJsonThinking: Flag.boolean("stream-json-thinking"),
}

const optionalValue = <A>(value: Option.Option<A>): A | undefined => Option.getOrUndefined(value)
type RunOperation = Extract<Operation.Input, { readonly _tag: "Run" }>

const runInput = (values: {
  readonly mode: Option.Option<"low" | "medium" | "high" | "ultra">
  readonly workspace: Option.Option<string>
  readonly thread: Option.Option<string>
  readonly ephemeral: boolean
  readonly streamJson: boolean
  readonly streamJsonInput: boolean
  readonly streamJsonThinking: boolean
  readonly prompt: ReadonlyArray<string>
}): RunOperation => {
  const selectedMode = optionalValue(values.mode)
  const selectedWorkspace = optionalValue(values.workspace)
  const selectedThread = optionalValue(values.thread)
  return {
    _tag: "Run",
    prompt: values.prompt,
    ...(selectedMode === undefined ? {} : { mode: selectedMode }),
    ...(selectedWorkspace === undefined ? {} : { workspace: selectedWorkspace }),
    ...(selectedThread === undefined ? {} : { threadId: selectedThread }),
    ephemeral: values.ephemeral,
    streamJson: values.streamJson,
    streamJsonInput: values.streamJsonInput,
    streamJsonThinking: values.streamJsonThinking,
  }
}

const validateRunInput = (input: RunOperation) => {
  if (input.streamJsonInput && !input.streamJson) {
    return Effect.fail(new Operation.InvalidInput({ message: "--stream-json-input requires --stream-json" }))
  }
  if (input.streamJsonThinking && !input.streamJson) {
    return Effect.fail(new Operation.InvalidInput({ message: "--stream-json-thinking requires --stream-json" }))
  }
  return Effect.succeed(input)
}

export const parseJsonLines = (input: string): ReadonlyArray<string> =>
  input
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        throw new Operation.InvalidInput({ message: `Invalid JSON on stdin line ${index + 1}` })
      }
      if (typeof value === "string") return value
      if (typeof value === "object" && value !== null && "prompt" in value && typeof value.prompt === "string")
        return value.prompt
      throw new Operation.InvalidInput({ message: `JSON on stdin line ${index + 1} must be a string or prompt object` })
    })

export const readStreamInput = (input: RunOperation, stdin: AsyncIterable<unknown> = process.stdin) => {
  if (!input.streamJsonInput || input.prompt.length > 0) return Effect.succeed(input)
  return Effect.tryPromise({
    try: async () => {
      let text = ""
      for await (const chunk of stdin) text += String(chunk)
      return text
    },
    catch: (cause) => new Operation.InvalidInput({ message: `Unable to read JSON input: ${String(cause)}` }),
  }).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => ({ ...input, prompt: [...input.prompt, ...parseJsonLines(text)] }),
        catch: (cause) =>
          cause instanceof Operation.InvalidInput
            ? cause
            : new Operation.InvalidInput({ message: `Unable to parse JSON input: ${String(cause)}` }),
      }),
    ),
  )
}

const runCommand = Command.make(
  "run",
  {
    mode,
    workspace,
    thread,
    ephemeral,
    ...streamFlags,
    prompt,
  },
  (values) => validateRunInput(runInput(values)).pipe(Effect.flatMap(readStreamInput), Effect.flatMap(dispatch)),
).pipe(Command.withDescription("Run Rika non-interactively"))

const reviewCommand = Command.make(
  "review",
  {
    staged: Flag.boolean("staged"),
    base: Flag.string("base").pipe(Flag.optional),
    workspace,
    ephemeral,
    json: Flag.boolean("json"),
    paths: Argument.variadic(Argument.string("path")),
  },
  (values) => {
    const selectedBase = optionalValue(values.base)
    const selectedWorkspace = optionalValue(values.workspace)
    return dispatch({
      _tag: "Review",
      staged: values.staged,
      ...(selectedBase === undefined ? {} : { base: selectedBase }),
      ...(selectedWorkspace === undefined ? {} : { workspace: selectedWorkspace }),
      ephemeral: values.ephemeral,
      json: values.json,
      paths: values.paths,
    })
  },
)

const versionCommand = Command.make("version", {}, () => Console.log(version))

export const command = Command.make(
  "rika",
  {
    execute: Flag.boolean("execute").pipe(Flag.withAlias("x")),
    mode,
    workspace,
    thread,
    ephemeral,
    ...streamFlags,
    prompt,
  },
  (values) => {
    if (values.execute)
      return validateRunInput(runInput(values)).pipe(Effect.flatMap(readStreamInput), Effect.flatMap(dispatch))
    if (values.streamJson || values.streamJsonInput || values.streamJsonThinking) {
      return Effect.fail(new Operation.InvalidInput({ message: "stream flags require --execute or the run command" }))
    }
    const selectedMode = optionalValue(values.mode)
    const selectedWorkspace = optionalValue(values.workspace)
    const selectedThread = optionalValue(values.thread)
    return dispatch({
      _tag: "Interactive",
      prompt: values.prompt,
      ...(selectedMode === undefined ? {} : { mode: selectedMode }),
      ...(selectedWorkspace === undefined ? {} : { workspace: selectedWorkspace }),
      ...(selectedThread === undefined ? {} : { threadId: selectedThread }),
      ephemeral: values.ephemeral,
    })
  },
).pipe(
  Command.withDescription("Local durable coding agent"),
  Command.withSubcommands([
    runCommand,
    ThreadsCommand,
    Command.make("last", {}, () => dispatch({ _tag: "Thread", action: "last" })),
    Command.make("top", {}, () => dispatch({ _tag: "Thread", action: "top" })),
    ConfigCommand,
    DiagnosticsCommand,
    ToolsCommand,
    SkillsCommand,
    McpCommand,
    ExtensionsCommand,
    WorkflowsCommand,
    reviewCommand,
    Command.make("doctor", {}, () => dispatch({ _tag: "Doctor" })),
    Command.make("update", {}, () => dispatch({ _tag: "Update" })),
    versionCommand,
  ]),
)

export const run = Effect.fn("RikaCli.run")(function* (argv: ReadonlyArray<string>) {
  return yield* Command.runWith(command, { version })(argv)
})

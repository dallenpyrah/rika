import { WorkspaceIdentity } from "@rika/agent"
import { Config, Diagnostics, IdGenerator } from "@rika/core"
import { ThreadClient } from "@rika/rivet-host"
import { Codec, Event, Ids, Message } from "@rika/schema"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { basename } from "node:path"
import * as Args from "./args"
import * as Input from "./input"
import * as Output from "./output"

export class ExecuteError extends Schema.TaggedErrorClass<ExecuteError>()("ExecuteError", {
  message: Schema.String,
  exit_code: Schema.Int,
}) {}

const StreamJsonInputMessage = Schema.Struct({
  type: Schema.Literal("user"),
  message: Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Array(Message.TextPart),
  }),
}).annotate({ identifier: "Rika.Cli.Execute.StreamJsonInputMessage" })

interface StreamJsonInputMessage extends Schema.Schema.Type<typeof StreamJsonInputMessage> {}

export interface Interface {
  readonly execute: (argv: ReadonlyArray<string>) => Effect.Effect<number>
  readonly executeCommand: (command: Args.ExecuteCommand) => Effect.Effect<number, RunError>
}

export type RunError = ThreadClient.RunError | Input.InputError | ExecuteError

export class Service extends Context.Service<Service, Interface>()("@rika/cli/Execute") {}

interface Dependencies {
  readonly output: Output.Interface
  readonly inputService: Input.Interface
  readonly configValues: Config.Values
  readonly idGenerator: IdGenerator.Interface
  readonly diagnostics: Diagnostics.Interface
  readonly threadClient: ThreadClient.Interface
}

const makeService = (dependencies: Dependencies): Interface => {
  const executeCommand: Interface["executeCommand"] = Effect.fn("Cli.Execute.executeCommand")(function* (
    command: Args.ExecuteCommand,
  ) {
    const threadId = command.thread_id ?? Ids.ThreadId.make(yield* dependencies.idGenerator.next("thread"))
    const workspaceRoot = command.workspace_root ?? dependencies.configValues.workspace_root
    const workspaceId = WorkspaceIdentity.resolveWorkspaceId({ workspace_root: workspaceRoot })
    const isTty = yield* dependencies.inputService.isTty
    const stdin = !command.stream_json_input && !isTty ? yield* dependencies.inputService.readAll : ""

    return yield* Diagnostics.event(
      "cli.execute",
      (fields) =>
        Effect.gen(function* () {
          fields.thread_id = threadId
          let toolCount = 0
          let turnCount = 0
          let failed = false
          const observe = (event: Event.Event) =>
            observeEvent(event, {
              incrementToolCount: () => {
                toolCount += 1
              },
              incrementTurnCount: () => {
                turnCount += 1
              },
              markFailed: () => {
                failed = true
              },
              output: dependencies.output,
            })

          if (command.stream_json_input) {
            yield* dependencies.inputService.lines.pipe(
              Stream.map((line) => line.trim()),
              Stream.filter((line) => line.length > 0),
              Stream.mapEffect(parseStreamJsonInputLine),
              Stream.runForEach((message) =>
                runThreadTurn(dependencies.threadClient, {
                  thread_id: threadId,
                  workspace_id: workspaceId,
                  content: Message.displayText({ content: message.message.content }),
                  content_parts: message.message.content,
                  ...(command.mode === undefined ? {} : { mode: command.mode }),
                  observe,
                }),
              ),
            )
          } else {
            const content = promptFromSources(stdin, command.prompt)
            if (content.length === 0) {
              return yield* new ExecuteError({ message: "Prompt is required for --execute", exit_code: 2 })
            }
            yield* runThreadTurn(dependencies.threadClient, {
              thread_id: threadId,
              workspace_id: workspaceId,
              content,
              ...(command.mode === undefined ? {} : { mode: command.mode }),
              observe,
            })
          }

          fields.tool_count = toolCount
          fields.turn_count = turnCount
          fields.exit_code = failed ? 1 : 0
          return failed ? 1 : 0
        }),
      {
        mode: command.mode ?? dependencies.configValues.default_mode,
        workspace_root: basename(workspaceRoot),
        ephemeral: command.ephemeral,
      },
    ).pipe(Effect.provideService(Diagnostics.Service, dependencies.diagnostics))
  })

  return Service.of({
    execute: Effect.fn("Cli.Execute.execute")(function* (argv: ReadonlyArray<string>) {
      return yield* Args.parse(argv).pipe(
        Effect.flatMap((command) =>
          command.type === "execute"
            ? executeCommand(command)
            : Effect.fail(new ExecuteError({ message: "Expected run or --execute", exit_code: 2 })),
        ),
        Effect.matchEffect({
          onFailure: (error: Args.ArgsError | RunError) =>
            dependencies.output.stderr(formatError(error)).pipe(Effect.as(exitCode(error))),
          onSuccess: (code) => Effect.succeed(code),
        }),
      )
    }),
    executeCommand,
  })
}

const commonDependencies = Effect.gen(function* () {
  const output = yield* Output.Service
  const inputService = yield* Input.Service
  const config = yield* Config.Service
  const configValues = yield* config.get
  const idGenerator = yield* IdGenerator.Service
  const diagnostics = yield* Diagnostics.Service
  const threadClient = yield* ThreadClient.Service
  return { output, inputService, configValues, idGenerator, diagnostics, threadClient }
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return makeService(yield* commonDependencies)
  }),
)

export const execute = Effect.fn("Cli.Execute.execute.call")(function* (argv: ReadonlyArray<string>) {
  const service = yield* Service
  return yield* service.execute(argv)
})

export const executeCommand = Effect.fn("Cli.Execute.executeCommand.call")(function* (command: Args.ExecuteCommand) {
  const service = yield* Service
  return yield* service.executeCommand(command)
})

export const encodeEvent = (event: Event.Event) => JSON.stringify(Codec.encode(Event.Event)(event))

interface RunThreadTurnInput {
  readonly thread_id: Ids.ThreadId
  readonly workspace_id: Ids.WorkspaceId
  readonly content: string
  readonly content_parts?: ReadonlyArray<Message.ContentPart>
  readonly mode?: Config.Mode
  readonly observe: (event: Event.Event) => Effect.Effect<void>
}

const runThreadTurn = (
  threadClient: ThreadClient.Interface,
  input: RunThreadTurnInput,
): Effect.Effect<void, ThreadClient.RunError | ExecuteError> =>
  Effect.gen(function* () {
    const snapshot = yield* threadClient.ensureThread({ thread_id: input.thread_id, workspace_id: input.workspace_id })
    yield* threadClient.startTurn({
      thread_id: input.thread_id,
      workspace_id: input.workspace_id,
      content: input.content,
      ...(input.content_parts === undefined ? {} : { content_parts: input.content_parts }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    })

    let terminal = false
    yield* threadClient.subscribeEvents({ thread_id: input.thread_id, after_sequence: snapshot.last_sequence }).pipe(
      Stream.takeUntil((event) => event.type === "turn.completed" || event.type === "turn.failed"),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.type === "turn.completed" || event.type === "turn.failed") terminal = true
          yield* input.observe(event)
        }),
      ),
    )
    if (!terminal)
      return yield* new ExecuteError({ message: "Thread event stream ended before turn completed", exit_code: 1 })
  })

const promptFromSources = (stdin: string, prompt: string) => {
  const stdinPrompt = stdin.trimEnd()
  const argPrompt = prompt.trim()
  if (stdinPrompt.length > 0 && argPrompt.length > 0) return `${stdinPrompt}\n\n${argPrompt}`
  return stdinPrompt.length > 0 ? stdinPrompt : argPrompt
}

const parseStreamJsonInputLine = (line: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(StreamJsonInputMessage)(JSON.parse(line)),
    catch: (cause) =>
      new ExecuteError({
        message: `Invalid --stream-json-input line: ${cause instanceof Error ? cause.message : String(cause)}`,
        exit_code: 2,
      }),
  })

interface EventObserver {
  readonly incrementToolCount: () => void
  readonly incrementTurnCount: () => void
  readonly markFailed: () => void
  readonly output: Output.Interface
}

const observeEvent = (event: Event.Event, observer: EventObserver) =>
  Effect.gen(function* () {
    if (event.type === "tool.call.completed") observer.incrementToolCount()
    if (event.type === "turn.completed") observer.incrementTurnCount()
    if (event.type === "turn.failed") observer.markFailed()
    yield* observer.output.stdout(encodeEvent(event))
  })

export const formatError = (error: Args.ArgsError | RunError) => {
  if (error instanceof Args.ArgsError && error.usage !== undefined) return `${error.message}\n${error.usage}`
  if (error instanceof Args.ArgsError || error instanceof ExecuteError) return error.message
  if (error instanceof Error) return `Rika failed: ${error.message}`
  return `Rika failed: ${String(error)}`
}

const exitCode = (error: Args.ArgsError | RunError) => {
  if (error instanceof Args.ArgsError || error instanceof ExecuteError) return error.exit_code
  return 1
}

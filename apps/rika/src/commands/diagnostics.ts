import { Console, Effect, Path } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import * as Logging from "../logging"

const dataRoot = Effect.fn("DiagnosticsCommand.dataRoot")(function* () {
  const path = yield* Path.Path
  const home = process.env.HOME ?? process.cwd()
  const root = path.join(home, ".rika")
  return yield* Logging.resolveDataRoot(
    process.env.RIKA_DATABASE ?? path.join(root, "rika.db"),
    process.env.RIKA_RELAY_DATABASE ?? path.join(root, "relay.db"),
  )
})

const pathCommand = Command.make("path", {}, () =>
  dataRoot().pipe(Effect.flatMap(Logging.directory), Effect.flatMap(Console.log)),
)

const statusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const value = yield* dataRoot().pipe(Effect.flatMap(Logging.status))
    yield* Console.log(value.directory)
    yield* Console.log(`${value.files} log file${value.files === 1 ? "" : "s"}, ${value.bytes} bytes`)
  }),
)

const exportCommand = Command.make("export", { destination: Argument.string("directory") }, ({ destination }) =>
  dataRoot().pipe(
    Effect.flatMap((root) => Logging.exportLogs(root, destination)),
    Effect.flatMap((output) => Console.log(`Exported Rika logs to ${output}`)),
  ),
)

export const command = Command.make("diagnostics").pipe(
  Command.withDescription("Inspect and export local Rika logs"),
  Command.withSubcommands([pathCommand, statusCommand, exportCommand]),
)

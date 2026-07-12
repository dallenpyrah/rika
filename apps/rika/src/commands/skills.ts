import { Argument, Command } from "effect/unstable/cli"
import { dispatch } from "./shared"

const nameArgument = Argument.string("name")

export const command = Command.make("skills").pipe(
  Command.withDescription("Manage local agent skills"),
  Command.withSubcommands([
    Command.make("list", {}, () => dispatch({ _tag: "Skill", action: "list" })),
    Command.make("inspect", { name: nameArgument }, ({ name }) => dispatch({ _tag: "Skill", action: "inspect", name })),
    Command.make("add", { source: Argument.string("source") }, ({ source }) =>
      dispatch({ _tag: "Skill", action: "add", source }),
    ),
    Command.make("remove", { name: nameArgument }, ({ name }) => dispatch({ _tag: "Skill", action: "remove", name })),
  ]),
)

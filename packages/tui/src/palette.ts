import { Config } from "@rika/core"
import { isFastEligible } from "./view-state"

export interface Command {
  readonly id: string
  readonly category: string
  readonly action: string
  readonly hint: string
  readonly command: string
  readonly key?: string
}

export interface Visibility {
  readonly threadActive?: boolean
  readonly orbBackedThread?: boolean
}

const leadingCommands: ReadonlyArray<Command> = [
  { id: "thread-switch", category: "thread", action: "switch", hint: "switch threads", command: "/switch-thread" },
  {
    id: "orb-toggle",
    category: "orb",
    action: "toggle",
    hint: "toggle orb-backed thread creation",
    command: "/orb toggle",
    key: "Ctrl+X R",
  },
  {
    id: "project-select",
    category: "project",
    action: "select",
    hint: "choose the project for the next orb-backed thread",
    command: "/project select",
  },
  {
    id: "project-create",
    category: "project",
    action: "create",
    hint: "create a project for orb-backed threads",
    command: "/project create",
  },
  {
    id: "amp-relaunch",
    category: "amp",
    action: "relaunch (quit & reopen)",
    hint: "restart the interactive session",
    command: "/relaunch",
  },
  { id: "amp-help", category: "amp", action: "help", hint: "show help", command: "/help" },
  { id: "amp-welcome", category: "amp", action: "show welcome", hint: "show the welcome surface", command: "/welcome" },
  { id: "amp-credits", category: "amp", action: "end credits", hint: "show credits", command: "/credits" },
  { id: "amp-version", category: "amp", action: "show version", hint: "show version", command: "/version" },
  { id: "amp-doctor", category: "amp", action: "doctor", hint: "check local Rika setup", command: "/doctor" },
  { id: "amp-quit", category: "amp", action: "quit", hint: "leave Rika", command: "/exit", key: "Ctrl+C Ctrl+C" },
  {
    id: "ast-grep-outline-status",
    category: "ast-grep",
    action: "ast-grep outline status",
    hint: "show ast-grep outline status",
    command: "/ast-grep outline status",
  },
]

const trailingCommands: ReadonlyArray<Command> = [
  {
    id: "mcp-authenticate",
    category: "mcp",
    action: "authenticate",
    hint: "authenticate MCP servers",
    command: "/mcp authenticate",
  },
  { id: "mcp-info", category: "mcp", action: "info", hint: "show MCP information", command: "/mcp info" },
  { id: "mode-rush", category: "mode", action: "use rush", hint: "switch to rush mode", command: "/mode rush" },
  { id: "mode-smart", category: "mode", action: "use smart", hint: "switch to smart mode", command: "/mode smart" },
  { id: "mode-deep1", category: "mode", action: "use deep1", hint: "switch to deep1 mode", command: "/mode deep1" },
  { id: "mode-deep2", category: "mode", action: "use deep2", hint: "switch to deep2 mode", command: "/mode deep2" },
  { id: "mode-deep3", category: "mode", action: "use deep3", hint: "switch to deep3 mode", command: "/mode deep3" },
]

export const commands: ReadonlyArray<Command> = [...leadingCommands, ...trailingCommands]

const orbLifecycleCommands: ReadonlyArray<Command> = [
  {
    id: "orb-pause",
    category: "orb",
    action: "pause",
    hint: "pause the active orb-backed thread",
    command: "/orb pause",
  },
  {
    id: "orb-resume",
    category: "orb",
    action: "resume",
    hint: "resume the active orb-backed thread",
    command: "/orb resume",
  },
  {
    id: "orb-kill",
    category: "orb",
    action: "kill",
    hint: "kill the active orb-backed thread",
    command: "/orb kill",
  },
]

const threadLifecycleCommands: ReadonlyArray<Command> = [
  {
    id: "thread-compact",
    category: "thread",
    action: "compact context",
    hint: "summarize earlier context for this thread",
    command: "/compact",
  },
  {
    id: "thread-fork",
    category: "thread",
    action: "fork",
    hint: "copy this conversation into a new thread",
    command: "/fork",
  },
  {
    id: "thread-tournament",
    category: "thread",
    action: "tournament",
    hint: "compare read-only branch answers",
    command: "/tournament",
  },
  {
    id: "thread-visibility",
    category: "thread",
    action: "set visibility",
    hint: "set this thread visible to workspace members",
    command: "/thread visibility workspace",
  },
]

const speedCommand = (fastMode: boolean): Command => ({
  id: "speed-fast",
  category: "speed",
  action: fastMode ? "use standard speed" : "use fast (2.5x cost)",
  hint: "priority processing for rush & deep",
  command: "/fast",
  key: "Opt+R",
})

export const commandsFor = (
  mode: Config.Mode,
  fastMode: boolean,
  visibility: Visibility = {},
): ReadonlyArray<Command> => {
  const available = [
    ...leadingCommands,
    ...(visibility.threadActive === true ? threadLifecycleCommands : []),
    ...(visibility.orbBackedThread === true ? orbLifecycleCommands : []),
    ...trailingCommands,
  ]
  return isFastEligible(mode) ? [...available, speedCommand(fastMode)] : available
}

const normalize = (query: string) => query.trim().toLowerCase().replace(/^\//, "")

export const filter = (
  query: string,
  mode: Config.Mode,
  fastMode: boolean,
  visibility: Visibility = {},
): ReadonlyArray<Command> => {
  const available = commandsFor(mode, fastMode, visibility)
  const needle = normalize(query)
  if (needle.length === 0) return available
  return available.filter(
    (command) =>
      command.id.includes(needle) ||
      command.category.toLowerCase().includes(needle) ||
      command.action.toLowerCase().includes(needle) ||
      command.hint.toLowerCase().includes(needle) ||
      command.command.toLowerCase().replace(/^\//, "").includes(needle),
  )
}

export const at = (
  query: string,
  index: number,
  mode: Config.Mode,
  fastMode: boolean,
  visibility: Visibility = {},
): Command | undefined => {
  const results = filter(query, mode, fastMode, visibility)
  if (results.length === 0) return undefined
  const clamped = Math.min(Math.max(index, 0), results.length - 1)
  return results[clamped]
}

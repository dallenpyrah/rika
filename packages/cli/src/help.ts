import { homedir } from "node:os"
import { Effect } from "effect"
import * as Args from "./args"
import * as Output from "./output"

export const terminalResetText = "\u001b[=0u\u001b[<u\u001b[?25h"

export const rootHelpStdoutText = (homeDir = homedir()) => `Rika CLI

Usage:
  rika [options]
  rika <command> [options]
  rika run [options] [prompt]
  rika --execute [options] [prompt]

Commands:
  interactive   Launch the local TUI when no command is supplied
  run           Run one non-interactive agent turn
  threads      Manage local Rivet actor threads
  skills       Manage skills from GitHub or local sources
  mcp          Manage MCP server configuration
  config       Inspect or edit Rika settings
  review       Run local code review
  extensions   Create and manage local trusted extensions
  memory       Inspect or index local thread memory
  doctor       Print local diagnostics as JSON
  version      Print the version number and exit

Global options:
  -V, --version          Print the version number and exit
  -v                     Alias for --version
  -x, --execute          Run one non-interactive turn
  -m, --mode <mode>      Select agent mode: rush, smart, deep1, deep2, deep3
  --workspace <path>     Workspace root for the turn
  --thread <id>          Reuse a durable thread id
  --ephemeral            Use in-memory SQLite persistence for this process
  --stream-json          Stream schema JSON events to stdout
  --stream-json-input    Read JSON Lines user messages from stdin; requires --stream-json
  -h, --help             Show help

Environment variables:
  RIKA_API_KEY              Model provider API key
  RIKA_BASE_URL             Model provider base URL; defaults to http://127.0.0.1:8317/v1
  RIKA_DATA_DIR             Local data directory; defaults to ~/.rika
  RIKA_DATABASE_URL         Optional SQLite database path or file URL
  RIKA_MODE                 Default mode when no flag overrides it
  RIKA_RIVET_ENDPOINT       Optional localhost Rivet endpoint override
  RIKA_TELEMETRY            Enable or disable local telemetry export
  RIKA_TELEMETRY_ENDPOINT   Local OTLP base URL
  RIKA_SETTINGS_FILE        Settings file path; default ${homeDir}/.config/rika/settings.json

Examples:
  rika
  rika doctor
  rika run --mode smart "summarize this repository"
  rika --execute --stream-json "list risky files"
  rika threads list --limit 20
  rika threads search --semantic "recent auth work"

`

export const runHelpStdoutText = `Usage: rika run [options] [prompt]

Run one non-interactive agent turn through the local Effect runtime and Rivet actor host.

Options:
  -m, --mode <mode>      Select agent mode: rush, smart, deep1, deep2, deep3
  --workspace <path>     Workspace root for the turn
  --thread <id>          Reuse a durable thread id
  --ephemeral            Use in-memory SQLite persistence for this process
  --stream-json          Stream schema JSON events to stdout
  --stream-json-input    Read JSON Lines user messages from stdin; requires --stream-json

Examples:
  rika run "summarize this repository"
  rika run --workspace /repo --mode deep2 "fix the failing test"

`

export const threadsHelpStdoutText = `Usage: rika threads [command]

Manage local Rivet actor threads.

Commands:
  list                 List threads
  search               Search thread summaries
  archive              Archive a thread
  unarchive            Unarchive a thread
  compact              Compact a thread
  fork                 Fork a thread conversation
  visibility           Set thread visibility
  share                Export thread events as JSON
  reference            Print a thread reference payload
  delete               Reserved; not available in local actor-native mode yet
  rebuild-projection   Reserved; not available in local actor-native mode yet
  import               Reserved; not available in local actor-native mode yet

Examples:
  rika threads list --include-archived --limit 50
  rika threads search --semantic "sqlite migration"
  rika threads archive thread_123
  rika threads fork thread_123 --at-turn turn_456
  rika threads visibility thread_123 private

`

export const threadsSearchHelpStdoutText = `Usage: rika threads search [options] <query>

Search local thread summaries. The current local actor-native implementation searches summary text and thread ids.

Options:
  --semantic           Request semantic search when available
  --include-archived   Include archived threads
  --limit <number>     Maximum number of summaries to return

Examples:
  rika threads search "auth race"
  rika threads search --include-archived --limit 10 "migration"

`

export const threadsForkHelpStdoutText = `Usage: rika threads fork <thread-id> [--at-turn <turn-id>]

Fork a thread conversation into a new local thread without forking the working tree.

`

export const threadsVisibilityHelpStdoutText = `Usage: rika threads visibility <thread-id> <private|workspace|unlisted>

Set thread visibility metadata for local thread records.

`

export const skillsHelpStdoutText = `Usage: rika skills <command>

Commands:
  list                  List available skills
  inspect <name>        Inspect one skill
  add <source>          Install skills from a GitHub or local source
  remove <name>         Remove an installed skill

Examples:
  rika skills list
  rika skills inspect debugger
  rika skills add owner/repo/path/to/skill
  rika skills add https://github.com/owner/repo --user

`

export const mcpHelpStdoutText = `Usage: rika mcp <command>

Manage MCP server configuration under rika.mcpServers.

Commands:
  list                  List configured MCP servers
  add <name>            Add an MCP server configuration
  remove <name>         Remove an MCP server configuration
  doctor                Check MCP server status
  approve <name>        Approve a workspace command MCP server

Examples:
  rika mcp list
  rika mcp add context7 -- npx -y @upstash/context7-mcp
  rika mcp add docs --url https://example.com/mcp
  rika mcp approve context7

`

export const configHelpStdoutText = `Usage: rika config <command>

Commands:
  list                  Print effective configuration with sources
  edit                  Open the user settings file in $EDITOR
  edit --workspace      Open the workspace settings file in $EDITOR

`

export const reviewHelpStdoutText = `Usage: rika review [options] [paths...]

Run local code review through the review service.

Options:
  --staged              Review staged changes
  --base <ref>          Review changes against a base ref
  --workspace <path>    Workspace root
  --ephemeral           Use in-memory SQLite persistence for this process

`

export const extensionsHelpStdoutText = `Usage: rika extensions <command> <name> [options]

Commands:
  create-skill          Create a local skill skeleton
  create-plugin         Create a local plugin skeleton
  enable-plugin         Enable a verified local plugin
  disable-plugin        Disable a local plugin
  rollback-plugin       Roll back a local plugin enablement

Options:
  --description <text>      Description for generated artifacts
  --instructions <text>     Instructions for generated artifacts
  --verification <command>  Verification command for plugin enablement
  --reason <text>           Reason for disable or rollback
  --thread <id>             Related thread id

`

export const memoryHelpStdoutText = `Usage: rika memory <command>

Commands:
  status                Print local thread memory status
  index                 Index local thread memory for a workspace

Examples:
  rika memory status
  rika memory index --workspace /repo

`

export const doctorHelpStdoutText = `Usage: rika doctor

Print local diagnostics as JSON. Secret values are redacted.

`

export const versionHelpStdoutText = `Usage: rika version

Print the version number and exit.

`

export const executeCommand = Effect.fn("Cli.Help.executeCommand")(function* (command: Args.HelpCommand) {
  yield* Output.stdoutRaw(helpText(command.topic))
  yield* Output.stderrRaw(terminalResetText)
  return 0
})

const helpText = (topic: string | undefined) => {
  switch (topic) {
    case "run":
      return runHelpStdoutText
    case "threads":
      return threadsHelpStdoutText
    case "threads-search":
      return threadsSearchHelpStdoutText
    case "threads-fork":
      return threadsForkHelpStdoutText
    case "threads-visibility":
      return threadsVisibilityHelpStdoutText
    case "skills":
    case "skill":
      return skillsHelpStdoutText
    case "mcp":
      return mcpHelpStdoutText
    case "config":
      return configHelpStdoutText
    case "review":
      return reviewHelpStdoutText
    case "extensions":
      return extensionsHelpStdoutText
    case "memory":
      return memoryHelpStdoutText
    case "doctor":
      return doctorHelpStdoutText
    case "version":
      return versionHelpStdoutText
    default:
      return rootHelpStdoutText()
  }
}

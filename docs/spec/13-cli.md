# Effect CLI and Automation

## Command Architecture

Every argument-bearing command or script uses `effect/unstable/cli` `Command`, `Flag`, and `Argument`. Leaf command modules export command values. The root CLI module exports the command tree and a `run(argv)` helper built with `Command.runWith`. The app entrypoint alone defines `main` with `Command.run` and interprets it with Bun runtime and platform layers.

Business behavior lives behind Effect services. Flags and arguments are Schema-validated. Standard output, standard error, terminal access, and filesystem behavior use Effect platform services.

Help, version, completions, and parse errors require only platform services. They must not initialize SQL, Relay, models, MCP, plugins, or OpenTUI.

The dispatcher classifies the parsed operation before reading the resident-service token or constructing infrastructure. Help, version, completions, and parse failures remain entirely local and lazy. Every operation that can read or write product state starts or attaches to the Resident Rika Service, so no probe-then-open race can create a second product SQLite owner.

The first stateful command for a Profile/data root attempts the resident listener bind. The winner starts the service and attaches its own client; bind losers attach to the winner after an authenticated, versioned handshake. Concurrent starters therefore wait through `starting` and converge on one service rather than rejecting the second process. TUI processes own terminal input, OpenTUI rendering, local view state, and protocol connection only. Noninteractive clients own CLI formatting and stdout/stderr only. Neither owns runtime or database fibers.

Every client sends its own current Workspace when an operation accepts a Workspace and no explicit `--workspace` was supplied. The resident service never substitutes the starter's current directory for a later client.

## Required Surfaces

- Default interactive TUI.
- `run` and `-x` execute modes.
- Stream JSON and multi-message JSONL.
- Threads, config, keymap, tools, skills, MCP, review, doctor, version, and update.

## Stable Contract

Flags, help, exit codes, stdout, stderr, and JSON records are public CLI contracts. Tests invoke `run(argv)` without process spawning and package smoke tests exercise the built binary.

`config list` and `doctor` report the effective global/workspace model route and credential presence. They never print credential values; persisted configuration cannot contain model API keys.

## Flag Relationships

- Root stream flags require `--execute`.
- `--stream-json-input` requires `--stream-json`.
- `--stream-json-thinking` requires `--stream-json`.
- `threads continue` accepts either `--last` or exactly one thread id, never both. It opens the interactive TUI with that Thread selected and its durable history replayed. Noninteractive transcript inspection uses `threads export --format json`.
- `mcp add` accepts exactly one remote `--url` or one local command with arguments.
- Expected validation failures write one concise stderr message and exit with code 2.

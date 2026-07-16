# CLI and automation

Commands use `effect/unstable/cli`. Leaf modules export commands, the root exports a testable command tree, and the process entrypoint alone runs the Effect. Help, version, completion, and parse failures do not initialize persistence, Relay, models, MCP, plugins, or OpenTUI.

The default command opens the TUI. Noninteractive execution supports plain final output and streaming JSON. Stateful commands go through the resident service. Flags, output, errors, and exit codes are public command contracts.

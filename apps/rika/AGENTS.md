# Rika CLI

Thin Effect CLI shell and process composition root. Leaf command modules export command values. `src/command.ts` exports the root command and testable `run(argv)`. `src/main.ts` alone interprets the process program.

Do not initialize SQL, Relay, models, MCP, plugins, or OpenTUI before command parsing selects an operation that needs them.

# Rika CLI

Thin Effect CLI shell and process composition root. Leaf command modules export command values. `src/command.ts` exports the root command and testable `run(argv)`. `src/main.ts` alone interprets the process program.

Do not initialize SQL, Relay, models, MCP, plugins, or OpenTUI before command parsing selects an operation that needs them.

Use `*.test.ts` for Unit tests of one owned behavior or interface, even when they need real process or OpenTUI adapters. Use `*.journey.test.ts` under the root `test/journey/` only for packaged product paths through real processes.

For user-visible interactive behavior, add or update a `*.scene.test.ts` test using `test/scene.ts`. Keep the real TUI, controller, resident transport, Relay, SQLite, and tools in a Scene; script only the language model. Provider models and network calls are forbidden in Scenes. Use reducer or renderer tests as narrower support, not as a substitute for a Scene.

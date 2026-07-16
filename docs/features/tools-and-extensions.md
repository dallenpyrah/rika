# Tools and extensions

Every tool has Schema input, typed output and errors, permission metadata, cancellation and timeout behavior, bounded output, idempotency rules, and a test layer. Included families cover file discovery and search, file and media reads, edits and patches, shell processes, Git inspection, web research, Thread retrieval, and specialist agents.

The resident resolves each Execution to its persisted Workspace. File edits fail on stale anchors rather than guessing. Process pipes are drained while retained output stays bounded. Built-in tools default to allow; configuration may ask or deny. Only explicit permission and tool-approval events create actionable cards.

Skills load lazily. MCP servers use Baton adapters while Rika owns configuration, trust, credentials, filtering, diagnostics, and OAuth lifecycle. Trusted local plugins may add tools, commands, policies, agents, modes, and bounded TUI actions. Active executions pin extension identity and schema so reload affects future work only.

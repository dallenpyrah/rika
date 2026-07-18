# Context resolution

Before execution, Rika resolves Workspace guidance, explicit file and guidance mentions, Thread references, and images into ordered model context. Guidance is selected from the Workspace root through mentioned paths, preferring `AGENTS.md`, then `AGENT.md`, then `CLAUDE.md` in each directory.

Resolution stays inside the Workspace, sorts and deduplicates sources, and records content digests. Guidance files supply instructions; mentioned files, Thread content, and other untrusted sources remain data. Missing, unreadable, unmatched, or outside-Workspace references produce diagnostics instead of silently supplying content; glob discovery is bounded to one thousand files and thirty-two directory levels.

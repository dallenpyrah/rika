# Context, Skills, and Compaction

## Resolved Context

Rika deterministically resolves parent and subtree guidance, global guidance, file mentions, thread references, images, skills, and memory before model execution. Untrusted content remains data rather than policy.

## Guidance

Supported files include `AGENTS.md` with `AGENT.md` and `CLAUDE.md` fallbacks. Referenced files and globs are resolved with explicit precedence, bounded depth and cardinality inside the Workspace, and recorded for diagnosis. Typed `@file:`, `@guidance:`, `@thread:`, and `@image:` mentions add files, reference globs, local thread transcripts, and image files to execution context without granting policy authority to their contents.

The TUI may materialize an untyped `@` file completion as Workspace-relative prompt text. This completion changes only composer text: submission and execution continue through the same durable prompt-parts and Resolved Context resolution boundaries.

Rika owns this resolution behavior. Baton receives already-resolved instruction and skill sources; the published Baton skills package does not define all Rika fallback, reference, and glob semantics.

## Skills

Skill listings are compact startup context. Skill bodies and resources load lazily through Baton skill activation. Skill-bundled MCP tools remain hidden until activation.

## Compaction

Compaction is automatic near the configured context threshold, preserves a recent suffix, bounds tool output first, emits a validated structured summary, and records checkpoints needed for replay. Baton owns the compaction decision and summary. Relay execution events are the sole durable checkpoint authority; restart reconstructs the latest valid checkpoint from replay and its digest prevents duplicate persistence. Rika projects token utilization, available capacity, threshold state, and the Relay checkpoint cursor for CLI and TUI presentation but does not persist a second durable authority. Manual compaction may exist only as a diagnostic operation.

Semantic thread memory may be specified separately from code search. The excluded semantic-search feature is a model-visible code-search tool and code embedding index, not an automatic ban on future thread-memory implementations.

# ADR 0009: Reduced Tool Surface

Status: Accepted

## Context

Rika v1 added semantic search and ast-grep outline, but v2 should reduce specialized local infrastructure and focus on the core coding-agent surface.

## Decision

Rika v2 does not implement a model-visible semantic code-search tool, code embedding index, semantic-search command/card, or ast-grep outline tool/activity.

## Consequences

File discovery, content search, read, shell, and normal structural commands remain available. No semantic index, embedding store, outline binary, tests, configuration, or UI activity is carried forward.

Lexical thread/content search and a future separately specified semantic thread-memory implementation remain allowed. Development-only ast-grep linting is allowed only if it is absent from the product tool registry, runtime dependencies, packaged assets, CLI, and TUI activity.

## Rejected Alternatives

- Keep them disabled by default: rejected because dormant code and dependencies still increase maintenance.
- Preserve only ast-grep outline: rejected because ordinary search and file reads cover the required personal feature surface.

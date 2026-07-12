# ADR 0001: Local-Only Product

Status: Accepted

## Context

Rika is built for one owner working in local repositories. Hosted and multi-client surfaces caused v1 architecture to expand beyond the personal CLI requirement.

## Decision

Rika v2 ships one local CLI/TUI and no web, IDE, remote control, remote runner, orb, hosted sharing, account, pricing, or enterprise surface.

## Consequences

SQLite and local filesystem state are sufficient. Product authorization is local Workspace and tool policy rather than account or tenant policy.

## Rejected Alternatives

- Preserve broader v1 surfaces: rejected because they reintroduce infrastructure unrelated to the owner workflow.
- Build a local daemon for future clients: rejected until a second real client exists.

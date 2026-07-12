# ADR 0008: Greenfield V2

Status: Accepted

## Context

Rika v1 has no compatibility obligation that outweighs the simplification of a clean execution and persistence model.

## Decision

Rika v2 does not read v1 databases, actor logs, configuration aliases, or legacy modes. V1 remains available as `rika-old` reference material.

## Consequences

Schemas and commands use only current vocabulary. No migration or fallback paths are added unless a new durable v2 release later requires them.

## Rejected Alternatives

- Import v1 threads: rejected because it would preserve actor/event assumptions in the new authority model.
- Decode legacy mode names: rejected because no v2 data can contain them at launch.

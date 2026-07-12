# ADR 0005: Effect SQL SQLite

Status: Accepted

## Context

Rika needs local product metadata and migration support without operating an external database.

## Decision

Rika-owned state uses Effect SQL with Bun SQLite. Relay execution state uses Relay's published embedded SQLite composition.

## Consequences

Raw clients remain at persistence composition boundaries. Rika does not expose or directly use Drizzle handles.

## Rejected Alternatives

- Postgres: rejected because it violates zero-infrastructure local operation.
- JSON files as canonical state: rejected because transactions, constraints, indexing, and migrations are required.
- Shared raw database handles across packages: rejected because it breaks service boundaries and tests.

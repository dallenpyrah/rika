# Domain and Authority

## Ownership

Relay owns canonical durable execution facts: executions, attempts, children, waits, joins, steering, cancellation, checkpoints, and replay cursors.

Baton owns non-durable agent-loop behavior: model turns, tool-call protocol, tool results, progress, permissions seams, compaction, and agent events.

Rika owns product semantics: Threads, modes, Workspace policy, product configuration, projections, artifacts, extensions, and terminal behavior.

## Invariants

- One Turn maps deterministically to one top-level Relay Execution.
- One Thread maps to one stable Relay Session identity used across its top-level Executions.
- A Child Run is always represented by a Relay child execution.
- Rika projections never become an alternative execution authority.
- Relay and Baton identifiers are translated at the `@rika/app` boundary and do not leak into TUI state.
- Product metadata may be rebuilt or reconciled without rewriting canonical execution history.

## Cross-Store Acceptance

Rika and Relay use separate SQLite files unless a future published Relay contract supports shared transactional composition.

- Rika generates deterministic Turn, Execution, Session, and operation-idempotency identities.
- Rika persists a Pending Turn before asking Relay to create its Execution.
- Relay creation is retryable under the deterministic identity.
- Rika records acceptance after Relay acknowledges it.
- Startup reconciliation queries Relay for pending and accepted mismatches.
- Projection updates and cursor advancement commit atomically in the Rika database.
- User-visible acceptance is shown only after the relevant durable transition.

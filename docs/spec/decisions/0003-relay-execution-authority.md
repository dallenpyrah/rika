# ADR 0003: Relay Execution Authority

Status: Accepted with Upstream Gates

## Context

Rika requires durable parent and child executions, waits, steering, cancellation, joins, and workflows. Splitting top-level and child work across independent authorities prevents coherent restart recovery.

## Decision

Relay is the sole durable execution authority for every Turn, Child Run, permission wait, and Workflow.

## Consequences

Rika projects Relay events but does not maintain a competing execution ledger. Parallel children and durable joins must be available through released Relay APIs before those features are marked implemented.

## Rejected Alternatives

- Baton for parents and Relay for children: rejected because parent recovery and child recovery would diverge.
- Product-local actor runtime: rejected because Rivet-style orchestration is the complexity v2 removes.
- Product-local durable workflow engine: rejected because it duplicates Relay's purpose.

# Steering, Queueing, Cancellation, and Transport

## Input Classes

- A normal message submitted while busy becomes a durable Pending Turn outside the active Execution.
- Steering input drains at Baton-safe boundaries before the next model turn.
- Interrupt-and-send durably requests cancellation, then promotes the requested Pending Turn to its own Execution after the active Execution reaches a terminal state.

## Durability

Accepted Pending Turns and steering input are durable before acceptance is shown. Replay observes the same steering set. Cancellation records a durable request and terminal outcome.

The Effect SQL TurnRepository is authoritative for Pending Turns. Every queue projection is emitted only after a repository operation and is keyed by durable Turn ID, including prompt and image attachment summaries. The terminal renders this projection in one joined panel above the composer rather than adding queue blocks or notices to the transcript. Selection follows Turn IDs across snapshots. While an Execution is active and the composer is empty, Up and Down select Pending Turns, Enter steers the selected Turn or the FIFO head when none is selected, and Backspace dequeues the selected Turn or FIFO head. Editing, steering, and dequeueing update durable state before publishing a replacement projection.

FIFO promotion is atomic and remains blocked while an Execution has an unresolved wait. An in-memory Effect Queue may serialize UI-edge callbacks, but it is never queue authority and restart or thread continuation always reconstructs the projection from TurnRepository.

Submission admission, queue promotion, and execution following have separate Effect semaphore ownership. Admission releases before model execution so later submissions can become durable Pending Turns. Only one queue drain may claim or start Turns, and only one follow operation may consume an execution stream at a time.

Every execution event crosses the application boundary with its durable Thread and Turn identity. Live callbacks, returned event batches, replay, and follow all enter one Turn-scoped projection. Canonical events are idempotent by Turn ID and Relay cursor, user entries are idempotent by Turn ID, and terminal events can clear busy state only for the active Turn. A late event from an earlier Turn updates that Turn's transcript region and never enters a later Turn. Ordinary Pending Turns always start later Relay executions; they are never reinterpreted as Baton steering input.

## Transport

In-process execution uses Effect Streams and services. Any process boundary uses WebSockets with Schema-framed messages.

The protocol must define connection initialization, cursor catch-up, live events, steering, follow-up input, permission answers, cancellation, heartbeat, typed errors, bounded buffering, and reconnect.

SSE is forbidden for Rika-owned live execution/control transport. Provider and MCP package transports remain governed by their public contracts.

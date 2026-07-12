# ADR 0007: WebSockets over SSE

Status: Accepted

## Context

Most Rika execution is in-process, but future process separation may require bidirectional live events, steering, permission answers, cancellation, and reconnect.

## Decision

Use Effect Streams in-process. If Rika introduces a process boundary for live execution and control, use a typed Effect WebSocket protocol. Do not use SSE for that Rika-owned transport. Provider and MCP transports remain governed by their published package contracts.

## Consequences

One bidirectional connection can carry event replay and user control messages. The protocol must define schemas, cursors, heartbeats, backpressure, reconnect, and typed errors.

Before implementation it must additionally define protocol negotiation, local authentication and origin checks, control-message idempotency, cursor acknowledgements, frame limits, ping timeouts, close codes, slow-consumer policy, duplicate control handling, and graceful shutdown.

## Rejected Alternatives

- SSE plus HTTP mutation endpoints: rejected because it splits one bidirectional interaction across unrelated mechanisms.
- WebSocket transport for the initial single process: rejected because no transport is simpler when no process boundary exists.

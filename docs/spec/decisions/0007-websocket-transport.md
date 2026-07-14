# ADR 0007: Resident Service WebSocket Transport

Status: Accepted

## Context

Rika requires concurrent CLI and TUI clients to converge on one resident execution owner while preserving bidirectional events, steering, permission answers, and cancellation while connected.

## Decision

Use Effect Streams inside the Resident Rika Service and a typed Effect WebSocket protocol over an OS-owned loopback listener between clients and that service. Do not use SSE. Provider and MCP transports remain governed by their published package contracts.

The shipped resident protocol v1 is connection-bound. The first client frame is a Schema-encoded handshake containing the protocol version, client kind and version, canonical Profile/data-root digest, and proof of the owner-only service token. The service accepts a compatible authenticated client or rejects the connection without exposing resident state.

After the handshake, Schema-framed request and response messages correlate an operation for the lifetime of that connection. Interactive operations can carry events and client actions over the same socket. Protocol decoding and operation failures are returned as typed errors when the connection is still usable.

Protocol v1 does not provide durable request idempotency keys, subscriptions, cursors, acknowledgements, bounded delivery windows, negotiated frame limits, reconnect replay, or slow-consumer handling. A disconnect or resident drain interrupts in-flight transport requests and interactive actions. The client reports the connection failure; it does not infer whether an interrupted mutation was accepted.

## Consequences

One bidirectional connection carries product requests, interactive events, and control messages. Durable Threads and Executions remain in SQLite after transport loss, but transport request state does not. Callers must reconnect, refresh durable state, and reissue only commands that are safe to repeat. The protocol makes no request-idempotency, replay, or backpressure guarantee. Browser origins are not supported; this is an owner-authenticated native local protocol. Listener ownership, lifecycle, and token storage are defined by ADR 0012 and specs 05 and 12.

## Rejected Alternatives

- SSE plus HTTP mutation endpoints: rejected because it splits one bidirectional interaction across unrelated mechanisms.
- Separate runtime per client: rejected because Relay SQLite and runtime notifications require one process owner.

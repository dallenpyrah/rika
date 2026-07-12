# ADR 0004: Baton Agent Loop

Status: Accepted

## Context

Baton already owns the Effect-native model/tool loop, permissions seams, steering, compaction, model registration, skills integration, and deterministic testing.

## Decision

Baton is the sole agent-loop authority. Rika defines product agents, tools, policies, context sources, and model routes using Baton contracts.

## Consequences

Rika does not implement another tool-call loop or provider registry. Relay composes Baton for durable execution.

## Rejected Alternatives

- Port the v1 agent loop: rejected because it duplicates Baton and weakens framework proof.
- Call providers directly: rejected because it bypasses Effect AI and Baton contracts.

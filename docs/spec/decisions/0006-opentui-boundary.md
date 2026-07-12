# ADR 0006: OpenTUI Boundary

Status: Accepted

## Context

Rika v1's OpenTUI implementation provides the desired visual and interaction baseline, but renderer APIs must not leak into product behavior.

## Decision

Rika retains OpenTUI behind one adapter module. Pure state and update logic remain renderer-independent.

## Consequences

The v1 styling can be ported while controller and domain tests remain deterministic. Native renderer failures are confined to one boundary.

## Rejected Alternatives

- Rewrite the TUI in Rust: rejected without evidence OpenTUI is the limiting factor.
- Let feature modules construct renderables: rejected because it couples behavior to the renderer.

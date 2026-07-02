# ADR 0001: Orb Contract and Rivet Deferral

## Status

Accepted

## Context

Rika's orbs run agents on remote sandbox machines. The local CLI, TUI, web app, and future hosted clients need one stable contract for creating threads, starting turns, and streaming thread events.

The RemoteControl adapter in `packages/server` already exposes the HTTP API and NDJSON event stream consumed by the typed SDK in `packages/sdk`. That contract preserves the existing local-web rule: `startTurn` submits work, while clients render from `subscribeThreadEvents`.

`packages/rivet-host` defines a parallel actor adapter around the same underlying thread model. Its current actor surface is action-oriented: `EnsureThread`, `AcceptTurn`, `ReplayThread`, and `GetSnapshot`. It does not expose a live event-stream action equivalent to `subscribeThreadEvents`.

## Decision

The orb contract is the RemoteControl HTTP+NDJSON API implemented by `packages/server` and consumed through `packages/sdk`.

An orb runs the full Rika backend inside the sandbox beside the repository checkout. Local clients connect to that backend through the existing SDK, using the same thread, turn, artifact, and NDJSON event-stream contracts as local development.

`packages/rivet-host` remains an unwired parallel adapter for now. Wiring Rivet is orthogonal to orb execution because both adapters sit above `AgentLoop` and the append-only event log. Remote execution needs a live stream contract today; the current Rivet actor contract does not provide one.

The revisit trigger is hosted control plane spike #66. Actor placement, scale, tenancy, and remote worker lifecycle are the point where Rivet can earn its wiring.

## Consequences

Orb work can proceed without designing a second client protocol. The CLI, TUI, web app, SDK, and orb mirror keep using RemoteControl request and stream schemas.

The sandbox backend owns its in-orb event log while it is alive. Local durability comes from mirroring RemoteControl event streams into the local event log, not from Rivet actor state.

Rivet remains available as a future hosted adapter, but it does not block the M1 orb path. If #66 chooses Rivet for hosted placement, that work must add or adapt a live stream action instead of bypassing `subscribeThreadEvents`.

The cost is that local-first orbs and hosted Rivet actors are not unified at the transport layer yet. That is intentional until hosted control plane requirements are concrete.

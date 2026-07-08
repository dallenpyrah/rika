# ADR 0001: Orb Contract and Rivet Deferral

## Status

Superseded by issue #104 actor-native migration

## Context

Rika's orbs run agents on remote sandbox machines. The local CLI, TUI, web app, and future hosted clients need one stable contract for creating threads, starting turns, and streaming thread events.

The RemoteControl adapter in `packages/server` originally exposed the HTTP API and NDJSON event stream consumed by the typed SDK in `packages/sdk`. That contract preserved the existing local-web rule: `startTurn` submits work, while clients render from `subscribeThreadEvents`.

Issue #104 changes the architectural direction. `packages/rivet-host` is no longer an unwired parallel adapter; its `ThreadActor` owns per-thread events in actor c.db, runs `StartTurn` through the agent loop inside the actor path, exposes `GetEvents` replay from actor storage, and broadcasts `threadEvent` for native live tails.

## Decision

This ADR documented the pre-Rivet orb contract and is no longer the target architecture.

During the migration, HTTP+NDJSON remains a compatibility surface for existing SDK clients and in-orb/local-development backends. It must not be treated as the canonical hosted thread authority.

The current target is actor-native: `ThreadActor` is the thread, actor c.db owns the append-only per-thread event log, the actor path owns active-turn serialization, and central persistence is a cross-thread index/read model.

## Consequences

Historical orb work can still use the RemoteControl-compatible request and stream schemas where needed. Hosted thread execution must route through the actor-native path instead of re-establishing RemoteControl as the source of truth.

The sandbox backend may still own an in-orb development event log while it is alive. Hosted durability for threads comes from actor c.db, with central projections rebuilt or synchronized from actor-owned events.

The remaining cost is that SDK-compatible HTTP streams are still a compatibility bridge. Native Rivet clients should use actor actions plus raw `threadEvent` connection broadcasts where available.

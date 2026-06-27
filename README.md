# Rika

Rika is a greenfield, Effect-native coding agent operating system inspired by Amp Code. It is planned as a Bun + Turbo monorepo with OpenCode-shaped Effect modules, Rivet actors from day one, Drizzle-backed durable threads, and a Pi-style extension system that can safely extend or modify the agent itself.

The implementation plan is tracked as stacked GitHub issues in this repository. The first implementation issue should create the Bun/Turbo/oxlint scaffold and turn the guidance in `AGENTS.md` into executable scripts.

## Product Direction

- Amp-like terminal coding agent UX: modes, durable threads, tools, subagents, skills, plugins, MCP, review, remote control, and SDK.
- Fully Effect-native internals: services, layers, typed errors, schemas, fibers, streams, and swappable test layers.
- Rivet actor runtime from the beginning: one durable actor boundary per active thread, local-first but remote-ready.
- Drizzle persistence where data must survive process restarts: append-only event log first, projections second.
- Built-in retrieval/editing tools: `fff`, hashline read/edit, semantic search, and ast-grep outline.

## Current State

This repository currently contains planning and agent guidance only. Do not treat it as an implementation scaffold until the first issue lands.

# Product Intent

## Problem

A single local developer needs a durable coding agent with a high-quality terminal interaction model, parallel agents, and restart-safe workflows without operating or depending on a Rika-hosted service.

## Requirements

- One local Bun CLI and OpenTUI application.
- Local Workspace access under explicit tool policy.
- Durable Threads, Turns, Child Runs, approvals, and workflows.
- Personal-use Amp feature parity as tracked in `docs/features/FEATURES.md`.
- Stable Rika modes independent of provider implementation.
- No mandatory network dependency except configured model, MCP, and research providers.

## Non-Goals

- Accounts, login, pricing, billing, teams, or enterprise administration.
- Web, IDE, hosted sharing, remote control, remote runners, or orbs.
- A public Rika server or SDK product.
- Compatibility with Rika v1 storage or legacy modes.

## Success

The packaged binary can complete, interrupt, resume, review, and verify local coding work, including parallel Child Runs and versioned workflows, after process termination.

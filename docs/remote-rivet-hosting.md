# Remote Rivet Hosting

Rika uses one `ThreadActor` contract for both local development and remote hosting. Deployment mode is a layer/configuration choice, not a different actor API.

## Current status

Rivet remains a parallel adapter while some SDK routes still use the RemoteControl HTTP+NDJSON API as their client contract. Orb file, file content, and changes routes are available through the native Rivet edge in orb mode. Hosted control-plane decisions now live in [orbs-hosted-control-plane.md](orbs-hosted-control-plane.md). See [ADR 0001](adr/0001-orb-contract-defer-rivet.md).

## Topology

```diagram
╭──────────────╮        ╭────────────────────╮        ╭────────────────╮
│ CLI / SDK /  │───────▶│ Native Edge / API  │───────▶│ ThreadActor    │
│ IDE adapter  │        │ adapters           │        │ @rika/rivet-   │
│              │        │                    │        │ host           │
╰──────────────╯        ╰─────────┬──────────╯        ╰───────┬────────╯
                                  │                           │
                                  ▼                           ▼
                         ╭─────────────────╮        ╭─────────────────╮
                         │ WorkspaceAccess │        │ Actor c.db log  │
                         │ @rika/agent     │        │ + projections   │
                         ╰─────────────────╯        ╰─────────────────╯
```

- `packages/rivet-host/src/thread-actor.ts` defines the actor contract.
- `packages/rivet-host/src/thread-live.ts` implements the server-side actor with an actor-local SQLite event log through `rawRivetkitContext.db`.
- `packages/rivet-host/src/thread-client.ts` calls the same actor contract through `@rivetkit/effect` clients.
- `packages/rivet-host/src/host-config.ts` resolves local vs remote Rivet configuration and converts it to official Rivet registry/client options.
- `LocalHost.threadClientLayer(...)` gives other packages the typed ThreadActor client without importing Rivet internals directly.
- `packages/rivet-host/src/native-edge.ts` exposes a narrow SDK-compatible HTTP adapter for health, thread creation, thread open, thread listing, thread search, visibility updates, submit-only turn start, orb read routes, and a long-lived HTTP event tail backed by actor `GetEvents` polling.
- `StartTurn` runs `AgentLoop.streamTurn` inside the actor path, hydrates the AgentLoop working log from actor c.db for existing threads, appends emitted events to actor c.db, and broadcasts `threadEvent` from that append path.

## Configuration

| Variable                                   | Meaning                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `RIKA_RIVET_HOST=local`                    | Default. Use a local Rivet endpoint.                                      |
| `RIKA_RIVET_HOST=remote`                   | Require an explicit remote endpoint.                                      |
| `RIKA_RIVET_ENDPOINT` / `RIVET_ENDPOINT`   | Rivet registry/client endpoint. Local default is `http://127.0.0.1:6420`. |
| `RIKA_RIVET_TOKEN` / `RIVET_TOKEN`         | Optional remote Rivet auth token.                                         |
| `RIKA_RIVET_NAMESPACE` / `RIVET_NAMESPACE` | Optional remote namespace.                                                |
| `RIKA_RIVET_NO_WELCOME=0`                  | Allows the Rivet welcome output for local debugging.                      |
| `RIVET_RUNNER_VERSION`                     | Optional deploy/build marker for remote runner selection.                 |

Local development starts the local actor host with:

```bash
bun run --cwd packages/rivet-host dev
```

Remote mode should set `RIKA_RIVET_HOST=remote` and the endpoint/token/namespace required by the target Rivet environment. The API server and actor host may run in the same process for local development, but hosted deployments should treat them as separate adapters. The actor owns per-thread events; relational stores remain for cross-cutting indexes and authorization data.

## Workspace access model

Remote requests do not authorize with a payload-level `user_id`. Hosted adapters resolve bearer or session credentials at the Remote Control boundary and pass a `VerifiedUserIdentity` into the actor contract. Omitting actor identity is a local-first allowance only.

- Remote-control adapters pass verified identity through shared schema request payloads for event attribution and turn-conflict display.
- Presence heartbeats use `user_id` in an in-memory map and never persist it as membership proof.
- `owner` members may perform future hosted `admin` actions; `owner` and `member` remain the durable membership roles.
- The first identified user to create an empty workspace is recorded as the `owner`.
- Hosted access control must use bearer/session credentials and durable membership data, not a self-asserted `user_id` field by itself.
- `NativeEdge` may bind with a generic bearer token on loopback for local development. Non-loopback serving requires a user-scoped bearer token so actor calls do not fall back to local-first identity. The exception is native orb mode, which is route-limited to `/v1/orb/*` and may use generated orb bearer tokens.

## Persistence and recovery

For the actor-native path, the actor-local SQLite log is the canonical durable source of truth for one thread:

- `ThreadActor` stores append-only thread facts in its embedded SQLite database.
- `GetEvents` replays the actor-local event log.
- Raw Rivet clients connect to the actor and subscribe to `threadEvent` for live tails.
- `ThreadProjection` remains the rebuildable cross-thread read model for listing and search candidates. User-scoped NativeEdge list/search refreshes candidate visibility from actor `GetEvents` before applying hosted access decisions.
- `WorkspaceStore` stores durable workspace memberships in `workspace_memberships`.
- Actor hot state is disposable and must be rebuilt from the actor-local event log by replay.

Hosted operators should:

1. Apply committed Drizzle migrations before serving traffic: `bun run db:migrate`.
2. Back up the actor runtime storage and relational database before each deployment.
3. Treat projection corruption as recoverable: rebuild projections from the mirrored relational event index, then let user-scoped NativeEdge reads re-check actor visibility before exposing candidates.
4. Treat membership corruption as security-sensitive: restore `workspace_memberships` from backup before enabling hosted access.
5. Roll actor workers by versioned deployment; actors can replay from their embedded event log after restart.

## Security boundaries

- Local workspace file access remains local to the process that owns the workspace root.
- Remote clients steer threads through the native edge and remaining compatibility API routes; they do not receive raw filesystem access by default.
- Raw Rivet imports stay in `@rika/rivet-host`.
- Raw Drizzle handles stay in `@rika/persistence`.
- Hosted user authorization stays in `WorkspaceAccess`; server and actor code only adapt request identity into that service.

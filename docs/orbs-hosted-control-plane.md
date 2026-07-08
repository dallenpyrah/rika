# Orbs Hosted Control Plane

The Hosted Control Plane is a remote implementation of the local orb control-plane services. It owns hosted authentication, orb lifecycle records, actor-backed thread routing, and multi-client fan-out while preserving the local `OrbManager` command shape and SDK compatibility where needed.

Spike proof: [`spike/orb-control-plane-http-seam-66`](https://github.com/dallenpyrah/rika/tree/spike/orb-control-plane-http-seam-66), commit [`3234e0a`](https://github.com/dallenpyrah/rika/commit/3234e0a). The branch is intentionally not merged. It proves an HTTP client layer can provide `OrbManager.Service` and pass provision, pause, resume, kill, schema decode, and typed failure mapping against a hosted stub.

## Decision

Hosted orbs use a small Hosted Control Plane as the authority for orb lifecycle, workspace access, and event fan-out. The local CLI keeps the same user-facing commands. `RIKA_CONTROL_PLANE_URL` switches the CLI/server runtime from local `OrbManager` and local `OrbStore` layers to remote client layers that implement the same Effect service interfaces.

## Problem

Local-first orbs already work because the user's machine owns the SQLite orb registry, talks to E2B, and mirrors in-orb events locally. Hosted clients need the same behavior when the user's laptop is offline.

What is true now:

- `OrbManager` creates and manages E2B sandboxes from a local process.
- `OrbStore` and `OrbMirror` persist local orb records and mirror in-orb event streams into local SQLite.
- `ThreadActor` exists and owns the actor-native thread path, with actor c.db event replay and raw Rivet `threadEvent` broadcasts.

What must remain true:

- `startTurn` stays submit-only.
- Clients render from `subscribeThreadEvents`.
- The append-only per-thread event log remains canonical inside the owning `ThreadActor` c.db.
- Workspace authorization uses `WorkspaceAccess`, not self-asserted `user_id`.
- Local-first CLI use keeps working without hosted credentials.

What should become true:

- A hosted service can provision, pause, resume, kill, and mirror orbs while clients use the same SDK and command shapes.
- Hosted web/TUI/SDK clients can subscribe to live events without keeping a local backend online.

Core tradeoff: this design centralizes orb control-plane state for hosted reliability while keeping the existing local service interfaces to avoid a second product/runtime model.

## Topology

```text
CLI / TUI / Web / SDK
        |
        | SDK-compatible HTTP bridge / native Rivet clients
        v
Hosted Control Plane
        |
        +-- WorkspaceAccess
        +-- HostedOrbManager -> E2B
        +-- HostedOrbStore   -> hosted DB
        +-- HostedOrbMirror  -> compatibility stream bridge
        |
        v
ThreadActor
        |
        v
actor c.db event log + hosted projections
```

The Hosted Control Plane is not a new client protocol. It is a deployment of existing ports behind remote adapters.

| Interface               | Local layer                    | Hosted layer                          | Hides                                                         |
| ----------------------- | ------------------------------ | ------------------------------------- | ------------------------------------------------------------- |
| `OrbManager.Service`    | E2B SDK adapter in `@rika/orb` | HTTP client to Hosted Control Plane   | Sandbox provider, endpoint token handling, lifecycle retries  |
| `OrbStore.Service`      | local SQLite                   | hosted DB repository                  | Orb rows, endpoint credentials, usage intervals               |
| `OrbMirror.Service`     | local process stream consumer  | hosted stream consumer                | In-orb event catch-up, idempotent local/hosted append         |
| `RemoteControl.Service` | local compatibility process    | legacy fallback only                  | Historical thread routes and typed errors                     |
| `ThreadActor`           | local actor-native server path | hosted turn router and fan-out entity | Actor event log, active turn serialization, hot subscriptions |

## Authentication

Hosted API access uses API tokens per user. Tokens are bearer credentials issued by the Hosted Control Plane and stored by the client in the same local secret boundary as the existing local backend token. The token identifies the caller. The request `user_id` remains attribution and presence data only.

Token rules:

- Tokens are scoped to a user and may carry workspace grants or refer to server-side grants.
- Tokens are stored hashed server-side.
- Tokens are never written to thread events, orb records, diagnostics, or project env.
- Every hosted request resolves the token to an authenticated principal before reading `user_id`.
- Machine callers, such as the hosted orb mirror, use separate machine tokens scoped only to the orb endpoint and thread stream they must mirror.

Authorization rules:

- Workspace and thread reads call `WorkspaceAccess` before returning data.
- Orb lifecycle mutations require workspace write access for the orb's project/workspace.
- Administrative project and membership mutations require owner access.
- `user_id` without a valid hosted token is rejected in hosted mode; local mode keeps the no-user local-first behavior.

## Hosted Persistence

The hosted DB owns central records that must outlive local clients:

- `orb_records`: the existing orb shape, with endpoint credentials behind the same narrow credential accessor.
- `orb_usage_intervals`: the existing usage interval model.
- `workspace_memberships`: existing durable membership rows.
- `thread_projections`: rebuildable thread summaries and access/search fields synchronized from actor-owned events.
- `projects`: hosted project profiles, env names, template ids, and secret references.

The hosted DB adapter stays behind persistence services. Raw Drizzle handles do not cross into server, actor, CLI, or SDK packages. Per-thread `thread_events` live in the owning `ThreadActor` c.db, not in the hosted relational database.

Hosted orb endpoint tokens follow the local rule: normal orb reads omit tokens; only the Hosted Control Plane's `OrbStore.endpointCredentials` equivalent can retrieve them for mirror/resume calls.

## Compatibility Event Mirror

The hosted mirror consumes each running compatibility orb backend's `subscribeThreadEvents` stream and submits validated events to the owning `ThreadActor`. Clients subscribe to the Hosted Control Plane or native actor connection, not directly to the sandbox, so the user's laptop does not need to remain online.

Mirror lifecycle:

1. `HostedOrbManager.provisionForThread` starts the sandbox and stores endpoint credentials.
2. `HostedOrbMirror.mirror(orb_id)` starts or resumes the stream from the latest actor-owned sequence.
3. Each event is validated against the orb's thread id before actor append.
4. Actor-appended events update projections and publish through ThreadActor fan-out.
5. Stream failure inspects sandbox lifecycle, marks the orb paused/killed when observable, and interrupts any active turn with a typed failure event.

The mirror is at-least-once. Actor-owned sequence checks make replay safe.

## Rivet Placement

Rivet is the hosted per-thread turn router, event-log owner, and live fan-out owner. The per-thread `ThreadActor` serializes active turns, replays state from actor c.db, and publishes live event frames to subscribers.

The current SDK-compatible HTTP event route is a compatibility polling tail over actor `GetEvents`. Native Rivet clients should use raw `threadEvent` broadcasts from connected actor handles until typed streaming actions exist.

Current actor actions:

- `EnsureThread`
- `StartTurn`
- `GetEvents`
- `ReplayThread`
- `GetSnapshot`
- `SetVisibility`

Typed streaming actions are not available in the installed Rivet Effect SDK. Do not reintroduce RemoteControl or hosted relational `thread_events` as the source of truth to compensate for that gap.

## Thread Visibility

Hosted sharing uses thread visibility levels:

- `private`: only the creator can read the thread.
- `workspace`: workspace members can read the thread.
- `unlisted`: anyone with the thread id and a valid hosted token can read the thread.

Schema sketch:

```sql
ALTER TABLE thread_projections
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
```

Allowed values are `private`, `workspace`, and `unlisted`. `ThreadProjection` derives the field from thread visibility events. `WorkspaceAccess.authorizeThread` enforces the matrix:

| Visibility  | Creator | Workspace member | Token holder with id | Local no-user |
| ----------- | ------- | ---------------- | -------------------- | ------------- |
| `private`   | allow   | deny             | deny                 | allow         |
| `workspace` | allow   | allow            | deny                 | allow         |
| `unlisted`  | allow   | allow            | allow                | allow         |

The no-user allowance is only for local-first mode.

Thread visibility enforcement is implemented for local compatibility paths and the actor-owned summary path. Storage for local compatibility lives in `packages/persistence/src/schema/event-log.ts`; actor-native visibility comes from actor-owned events in c.db; visibility events live in `packages/schema/src/event.ts`; `ThreadActor.SetVisibility` appends `thread.visibility.set` events in native paths; `ThreadService.setVisibility` appends the same event in local compatibility paths; `WorkspaceAccess` enforces the visibility matrix in `packages/agent/src/workspace-access.ts`; NativeEdge exposes the actor-backed HTTP route in `packages/rivet-host/src/native-edge.ts`; Remote Control exposes the legacy HTTP route in `packages/server/src/http-server.ts`; the SDK exposes `setThreadVisibility` in `packages/sdk/src/client.ts`; and the CLI exposes `rika threads visibility` plus `rika threads share` through `packages/cli/src/args.ts` and `packages/cli/src/threads.ts`.

The remaining open hosted work is the multi-tenant authentication path: hosted tokens must identify the principal before the existing `WorkspaceAccess` checks run. The local no-user allowance stays local-first only.

## Migration Path

Local-first remains the default.

```text
No RIKA_CONTROL_PLANE_URL
  -> local OrbManager
  -> local OrbStore
  -> local OrbMirror
  -> local SQLite

RIKA_CONTROL_PLANE_URL=https://...
  -> remote OrbManager client layer
  -> remote OrbStore client layer
  -> hosted mirror
  -> hosted DB
```

Client configuration:

| Variable                     | Meaning                                                       |
| ---------------------------- | ------------------------------------------------------------- |
| `RIKA_CONTROL_PLANE_URL`     | Enables hosted control-plane adapters.                        |
| `RIKA_CONTROL_PLANE_TOKEN`   | Bearer token for hosted API calls.                            |
| `RIKA_CONTROL_PLANE_USER_ID` | Optional local attribution default after token auth succeeds. |

Migration sequence:

1. Ship remote client layers for `OrbManager` and read-only `OrbStore` behind `RIKA_CONTROL_PLANE_URL`.
2. Add hosted API endpoints that delegate to the same service interfaces used locally.
3. Move `OrbMirror` into the hosted service and keep local mirror for local-only orbs.
4. Route hosted subscriptions through actor replay plus native `threadEvent` fan-out.
5. Wire hosted authentication into the existing thread visibility enforcement path.
6. Make project secrets hosted-secret references in hosted mode; local Project secrets remain local.

Rollback is setting `RIKA_CONTROL_PLANE_URL` off. Existing local commands keep using local SQLite and local E2B credentials.

## Failure Modes

| Failure                                         | Behavior                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| Hosted token invalid                            | Reject before workspace lookup; log auth failure without token value.                 |
| Hosted DB unavailable                           | Orb lifecycle calls fail typed; no sandbox mutation starts without durable row write. |
| E2B create succeeds but DB endpoint write fails | Kill sandbox before returning failure, same cleanup invariant as local provisioning.  |
| Mirror stream drops                             | Resume from latest actor-owned event sequence; duplicate frames are ignored.          |
| ThreadActor unavailable                         | API can reject new turns with 503; actor c.db remains canonical and replayable.       |
| Visibility projection corrupt                   | Rebuild projections from actor-owned events before serving hosted reads.              |

## Non-Goals

- No production hosted implementation in #66.
- No new public client protocol.
- No hosted billing model.
- No direct browser access to orb endpoint tokens.
- No replacement for local-first execution.

## Follow-Up Implementation Issue Drafts

### Hosted OrbManager HTTP adapter

Implement `HostedOrbManager` server endpoints and a CLI/runtime client layer selected by `RIKA_CONTROL_PLANE_URL`. The client layer must provide `OrbManager.Service`; the server layer must delegate to the existing local `OrbManager` implementation behind hosted authz. Acceptance: the #46 fake provisioning sequence passes through the remote client layer, and invalid tokens fail before any sandbox mutation.

### Hosted OrbStore and project persistence

Add hosted persistence adapters for orb records, endpoint credentials, usage intervals, projects, and project secret references. Acceptance: local code depends only on `OrbStore.Service` and `ProjectStore.Service`; hosted mode stores endpoint tokens behind the same credential accessor and normal reads omit token values.

### Hosted OrbMirror worker

Move continuous orb event mirroring into the Hosted Control Plane. Acceptance: a running compatibility orb can be mirrored into its owning `ThreadActor` while all clients are remote; stream reconnect resumes from the latest actor-owned sequence; duplicate frames are idempotent.

### ThreadActor native live tail

Route hosted subscriptions through `ThreadActor` replay plus native `threadEvent` broadcasts. Acceptance: replay after `after_sequence` and live events share one client stream; SDK-compatible HTTP polling tails are documented as compatibility bridges; presence frames remain ephemeral and are not appended to the event log.

### Hosted token service

Add user API token issue/revoke/list flows with hashed token storage and audit diagnostics. Acceptance: hosted API calls authenticate before workspace access; token values never appear in events, diagnostics, or normal API responses.

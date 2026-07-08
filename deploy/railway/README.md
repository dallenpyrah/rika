# Railway deploy recipe (issue #104)

Personal account workspace: `dallenpyrah` (not In Time Tec LLC).

## Environments

| Environment | Branch | Purpose |
| --- | --- | --- |
| staging | `main` | Persistent base environment |
| production | `release` | Production promote target |
| `rika-pr-<n>` | PR branches | Ephemeral; inherit from **staging**, not production |

## Services

| Service | Start | Pre-deploy | Health |
| --- | --- | --- | --- |
| `rika-postgres` | managed Postgres plugin | n/a | plugin health |
| `rika-rivet-engine` | `bun packages/rivet-host/src/main.ts` with `RIVET_RUN_ENGINE=1` | none | `/metadata` or engine health |
| `rika-actor-runner` | `bun packages/rivet-host/src/main.ts` | none | engine readiness probes |
| `rika-edge` | `bun packages/cli/src/main.ts server --host 0.0.0.0 --port $PORT` | `bun run db:migrate` | `/health` |
| `rika-web` (optional phase 6) | static `apps/web` dist via reverse proxy | `bun run --cwd apps/web build` | `/` |

All Rika processes use **bun** as the start command. Edge and long-lived streams set `idleTimeout: 0` in Bun.serve.

## Storage split

- **Actor c.db / Rivet engine storage**: per-thread event log (single-writer). Prefer Rivet engine filesystem volume or FoundationDB when multi-node; Postgres engine storage is experimental for multi-node.
- **`RIKA_DATABASE_URL` Postgres**: cross-cutting index only (`workspace_memberships`, `projects`, `orbs`, `artifacts`, `thread_projections`, `user_tokens`, …). Not the per-thread event source of truth.

## Environment variable families

- `RIKA_DATABASE_URL` — Postgres index DSN
- `RIKA_API_KEY` / provider keys — model access
- `E2B_API_KEY`, `RIKA_ORB_TEMPLATE` — orb provision
- Edge token / user tokens — `RIKA_SERVER_TOKEN` for single-tenant, `user_tokens` for multi-user
- `RIKA_RIVET_HOST` / `RIKA_RIVET_ENDPOINT` / `RIKA_RIVET_TOKEN` / `RIKA_RIVET_NAMESPACE`
- OTEL / Axiom exporters per service

## GitHub deploy triggers

Railway CLI `serviceCreate` does **not** wire GitHub auto-deploy. Create triggers via GraphQL:

```graphql
mutation {
  deploymentTriggerCreate(input: {
    projectId: "..."
    environmentId: "..."
    serviceId: "..."
    repository: "dallenpyrah/rika"
    branch: "main"
    provider: "github"
  }) { id }
}
```

Use `serviceInstanceDeploy` for the current config (not `deploymentRedeploy`). PR environments inherit from staging via `projectUpdate`.

## WebSocket resume

Railway public networking WebSockets have a documented duration limit (~15 minutes). Clients must reconnect and resume from `GetEvents(after_sequence)` rather than assuming indefinite sockets.

## Pre-deploy

`bun run db:migrate` applies **relational index** migrations only. It does not persist actor c.db or filesystem volume state.

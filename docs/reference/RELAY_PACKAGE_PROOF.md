# Relay Package Proof

## Package

- Registry package: `@relayfx/sdk@0.0.50`
- Effect family: `4.0.0-beta.93`
- Clean consumer: `/Users/dallen.pyrah/projects/Rika`

## Root Import

```bash
bun -e 'import("@relayfx/sdk")'
```

Observed result:

```text
ResolveMessage: Cannot find module '@effect/sql-mysql2/MysqlClient' from 'node_modules/@relayfx/sdk/dist/index.js'
```

## Cause

`node_modules/@relayfx/sdk/dist/index.js` statically imports `@effect/sql-mysql2/MysqlClient`, while `node_modules/@relayfx/sdk/package.json` does not declare `@effect/sql-mysql2`. The bundle dynamically imports `@effect/sql-sqlite-bun/SqliteClient`, which is also not declared by the SDK.

## Public Surface

The package exports root, `./ai`, and migration wildcard paths. SQLite migration assets are packaged, but a clean supported external SQLite composition path has not been proven.

## Rika Decision

- Do not add MySQL to Rika to mask the package defect.
- Do not import Relay internal packages.
- Runtime Phase 4 remains blocked.
- Require a released Relay version with dialect-isolated exports or complete dependency declarations and a documented external SQLite composition path.

## Upstream Correction Status

The Relay worktree contains an unreleased correction with:

- A curated `@relayfx/sdk/sqlite` entrypoint.
- Embedded SQLite migrations with source, import, record, id, and name parity checks.
- `RunnerRuntime.layerWithServices({ databaseLayer: SQLite.layer(...) })` composition.
- Portable SQL repository and runtime bundles without MySQL, Postgres, Drizzle, or `pg` runtime imports.
- A packed-tarball clean-consumer gate that imports root, `/ai`, and `/sqlite`, typechecks public composition, removes Postgres and Drizzle packages, applies migrations, starts `RunnerRuntime`, and reopens the SQLite database.

The upstream format, lint, typecheck, build, SDK tests, script tests, and clean-consumer gates pass locally. Rika's explicit local-link development mode now proves the public SQLite runtime through a product-owned adapter while final release verification remains blocked until the correction is published and pinned.

## Runtime Capability Proof

The linked public SDK completes a Baton scripted-model execution over SQLite, returns the same result for a duplicate deterministic Turn id, closes and reopens the runtime, and replays cursor-ordered events. Rika contains Relay identifiers and runtime composition inside `@rika/runtime`.

Cancellation is boundary-checked by current Relay contract. A waiting execution is durably cancelled; a queued or running execution records `cancellation_requested` and stops before the next agent turn. An in-flight model stream is not interrupted. Rika must not present mid-turn cancellation as immediate termination until Relay adds supported fiber interruption.

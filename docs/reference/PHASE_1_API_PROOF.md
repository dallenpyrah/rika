# Phase 1 Dependency and API Proof

Date: 2026-07-10. This proof uses the explicit local overlays at `/Users/dallen.pyrah/projects/batonfx` and `/Users/dallen.pyrah/projects/relay`. It is source and packed-artifact evidence, not evidence of a registry release.

## Package metadata and exports

The overlay manifests identify Node 22 and Bun 1.3 as their minimum runtimes, publish only `dist` and `README.md`, and externalize Effect as a declared dependency. Rika's committed manifest and lock retain exact registry catalog versions; `upstream:link` changes only installed links.

| Package              | Public exports inspected                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `@batonfx/core`      | `.`                                                                                                                           |
| `@batonfx/mcp`       | `.`, `./baton`                                                                                                                |
| `@batonfx/providers` | `.`, `./catalog`, `./openai`, `./anthropic`, `./openrouter`, `./openai-compat`, `./deterministic`, `./presets`, `./embedding` |
| `@batonfx/skills`    | `.`                                                                                                                           |
| `@batonfx/test`      | `.`                                                                                                                           |
| `@relayfx/sdk`       | `.`, `./ai`, `./sqlite`, `./migrations/*`                                                                                     |

`@relayfx/sdk@0.0.50` registry behavior remains recorded in `RELAY_PACKAGE_PROOF.md`; the local overlay reports version `0.0.0` and must not be represented as released.

## Installed Effect API inspection

The installed Effect 4 beta sources were inspected at their exported module paths. `BunRuntime.runMain` and `BunServices.layer` provide the process/runtime boundary; `Terminal` is an Effect service. SQLite composition uses `SqliteClient.layer`, `SqliteMigrator.fromRecord`, and `SqliteMigrator.layer`. Migration records are ordered by migration key and tracked in a dedicated table. `Stream` supplies scoped consumption, buffering, queues, and backpressure; Relay's `streamExecution({ after_cursor, limit })` is the durable cursor boundary. Relay's cluster execution entity and workflow services are exported by `@relayfx/sdk/sqlite`; Rika does not import Effect cluster/workflow internals directly.

## Relay capability matrix

| Capability           | Public operation                                                                                                      | Semantics / status                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Start and inspect    | `startExecution`, `getExecution`, `inspectExecution`, `listExecutions`                                                | Durable, deterministic execution identity                                         |
| Replay and live tail | `replayExecution`, `streamExecution`                                                                                  | Cursor-ordered replay with `after_cursor` and bounded `limit`                     |
| Cancellation         | `cancelExecution`                                                                                                     | Durable boundary request; no guaranteed interruption of an in-flight model stream |
| Input                | `steer`                                                                                                               | Durable steering or follow-up queue                                               |
| Waits and approval   | `listWaits`, `wake`, `listPendingApprovals`, `resolveToolApproval`, `resolvePermission`                               | Durable suspension and resolution                                                 |
| Tool placement       | `listPendingToolCalls`, `fulfillToolCall`, `claimToolWork`, `completeToolWork`, `releaseToolWork`, `listToolAttempts` | Durable external work, leases, attempts, and idempotent outcome acceptance        |
| Child runs           | `spawnChildRun`, `createChildFanOut`, `inspectChildFanOut`, `cancelChildFanOut`                                       | Durable bounded fan-out and aggregate join state in the overlay                   |
| Envelopes            | `send`, `submitInboundEnvelope`, claim/ack/release ready operations                                                   | Addressed durable delivery                                                        |
| Scheduling           | `createSchedule`, `cancelSchedule`, `listSchedules`                                                                   | Durable timers                                                                    |
| Workflows            | definition register/get/list plus `startWorkflowRun`, `inspectWorkflowRun`, `cancelWorkflowRun`                       | Versioned workflow definitions and runs in the overlay                            |

## Baton event coverage

| Baton event              | Relay durable representation       | Coverage                                                                               |
| ------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------- |
| `TurnStarted`            | execution event                    | durable                                                                                |
| `ModelPart`              | execution content event            | durable                                                                                |
| `ToolExecutionStarted`   | tool call/execution event          | durable                                                                                |
| `ToolProgress`           | no stable dedicated Relay contract | unsupported; presentation-only until upstream contract exists                          |
| `ToolExecutionCompleted` | tool outcome and execution event   | durable                                                                                |
| `ApprovalRequested`      | wait/pending approval              | durable                                                                                |
| `SteeringDrained`        | steering event metadata            | durable boundary fact                                                                  |
| `TurnCompleted`          | transcript/checkpoint event        | durable                                                                                |
| `StructuredOutput`       | no stable dedicated Relay event    | unsupported as a first-class durable value; content may be retained in terminal result |
| `Completed`              | terminal execution event           | durable                                                                                |
| `AgentSuspended`         | wait/tool state                    | durable                                                                                |
| Baton typed errors       | terminal failure event             | durable error projection                                                               |

## Migration ordering proof

Rika's product loader is a `SqliteMigrator.fromRecord` with keys `1_product_baseline`, `2_turns`, `3_queued_turn_status`, and `4_execution_extension_pins`, tracked by `rika_migrations`. Relay's packed SQLite export contains `0001_baseline.sql` through `0005_workflow_runtime.sql` and its public SQLite runtime applies them before service startup. The upstream Relay clean-consumer proof creates, migrates, starts, closes, and reopens its database. Rika integration tests and packaged smoke prove initial application and repeated startup against the product database.

Ordering is independently monotonic within each database; there is no cross-database transaction. Startup composes both migration layers before runtime services. Effect SQL migrator transactions and its migration table provide locking/duplicate suppression; failed migration effects do not record completion and are retried on startup. Packed Relay migration assets are verified from its tarball, while Rika migrations are bundled executable definitions.

## Clean packed external consumers

- Baton: `/Users/dallen.pyrah/projects/batonfx/scripts/package-smoke.ts` packed the workspace packages, installed their tarballs into a temporary project, imported every declared export, typechecked, and ran the consumer successfully on 2026-07-10.
- Relay: `/Users/dallen.pyrah/projects/relay/scripts/package-consumer.ts` packed `@relayfx/sdk`, installed it in a temporary external project, imported root/AI/SQLite exports, typechecked public composition, applied SQLite migrations, started the runtime, and reopened the database successfully on 2026-07-10.

Neither proof establishes npm registry availability.

## Unsupported capability ledger

| Capability                                          | Disposition                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| Immediate interruption of an in-flight model stream | Unsupported; cancellation is checked at durable boundaries            |
| First-class durable Baton `ToolProgress`            | Unsupported                                                           |
| First-class durable Baton `StructuredOutput`        | Unsupported                                                           |
| Atomic migration across Relay and Rika databases    | Unsupported by design; databases migrate independently before startup |
| Registry-released corrected Relay SQLite package    | Not proven; publication remains blocked work                          |
| Arbitrary generated workflow code                   | Excluded; only versioned typed workflow definitions are supported     |

## Result

Local-overlay API, migration, and clean packed-consumer proofs pass. The Phase 1 registry exit gate remains blocked until corrected Relay and corresponding Baton packages are actually published and Rika is switched back to and tested against those exact releases.

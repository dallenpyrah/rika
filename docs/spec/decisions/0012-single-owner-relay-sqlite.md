# ADR 0012: One Resident Rika Service per Profile Data Root

Status: Accepted

## Context

Relay's embedded SQLite topology is single-process. Each published `SQLite.layer`, `SQLite.childFanOutLayer`, and `SQLite.workflowLayer` construction opens an independent SQLite client with its own one-permit semaphore. Equal filenames do not share that semaphore or the in-process notification graph. Rika previously built one runner, fan-out host, and workflow host for every model mode, allowing independent writers in one process and producing intermittent `effect/sql/SqlError: Failed to execute statement` errors even when the canonical Execution completed.

## Decision

One Resident Rika Service owns each canonical Profile/data root. The root contains fixed `rika.db` and `relay.db` files; configurations that split or rename those files are rejected before listener probing or database open. The service owns product SQLite, one Relay embedded Runtime over one Relay SQLite client, route-driven `ExecutionBackend`, Operation and Turn admission/reconciliation, Relay hosts, and all runtime fibers. Clients own CLI parsing and formatting, TUI rendering and input, and the authenticated protocol connection.

The first stateful starter attempts an exclusive OS-owned loopback listener bind derived from canonical profile identity. The bind winner starts the service; concurrent losers connect and attach after the authenticated/versioned ADR 0007 handshake. The listener is acquired before either database opens and remains held until both databases close. PID directories, metadata, and database locks do not grant ownership. The OS releases the listener after `SIGKILL`, allowing a replacement to bind and reconcile durable state.

The service lifecycle is `starting -> ready -> grace -> draining -> stopped`. Final authenticated-client disconnect enters grace; a new client cancels grace. Grace expiry and cooperative signals drain. Draining rejects admission and cannot return to ready, closes client work, joins runtime fibers, closes Relay then product SQLite, and releases the listener last. Help, version, completion, and parse paths stay local and lazy. Every operation that can touch product SQLite starts or attaches to the service; there is no unsafe local fallback after an absent-service probe.

The published Relay package must expose composition that lets its runner, Child Run fan-out host, Workflow host, and Client share one SQLite client. Rika does not deep-import Relay internals or recreate that composition. Until that package contract is released and consumed, single-runtime completion remains blocked and release evidence must not claim the invariant is implemented.

## Consequences

Embedded Rika execution remains single-owner but supports many concurrent clients. A TUI and separate commands share one runtime and durable admission authority. A foreign or incompatible listener fails closed; Rika does not infer that state is safe to open from absent or stale PID metadata.

Turn routing must persist the selected mode and non-secret resolved route identity before Relay acceptance so queued promotion and restart reconciliation use the original route. Ambiguous storage failure after Relay acceptance does not manufacture a terminal product status; only canonical Relay terminal state may terminalize the Turn.

Verification counts service instances, listeners, SQLite owners, migrations, runtime hosts, backends, reconciliation fibers, and notification graphs rather than inferring ownership from successful prompts. Process tests cover concurrent convergence, authenticated attachment, lifecycle transitions, graceful shutdown, `SIGKILL`, replacement, incompatible and foreign listeners, and every acceptance-to-projection kill point.

## Rejected alternatives

- **WAL, busy timeout, or retries across independent clients:** rejected because they reduce lock frequency without creating one serialization or notification domain.
- **One Relay runtime per model mode:** rejected because mode is execution data and multiplying infrastructure by routing choice creates avoidable writers and recovery hosts.
- **Reject the second execution-capable process:** rejected because independent TUI and command clients are a product requirement and rejection does not provide a usable interface.
- **PID-directory or database-lock ownership:** rejected because user-space metadata can become stale and a database lock does not establish the authenticated service and runtime owner. The listener bind is released by the OS on process death.
- **Multi-process Relay SQLite:** rejected because Relay's SQLite notifications and worker ownership are process-local; true multi-process operation requires a server database and Relay's supported multi-node topology.

## Related docs

- `docs/spec/04-modes-and-model-routing.md`
- `docs/spec/05-threads-and-executions.md`
- `docs/spec/12-persistence.md`
- `docs/spec/15-testing.md`
- `docs/spec/decisions/0002-published-framework-dependencies.md`
- `docs/spec/decisions/0003-relay-execution-authority.md`
- `docs/spec/decisions/0005-effect-sql-sqlite.md`

# Durable execution

Each Thread groups Turns in one Workspace. A Turn maps deterministically to one top-level Relay Execution and the Thread uses one stable Relay Session. Relay is the execution record; Rika stores product metadata and disposable projections.

Input accepted while work is active becomes a durable Pending Turn. A Thread Host wakes from durable inbox messages and asks the SQL-backed promoter to claim the next Turn. Steering alone enters the active Execution. Cancellation, permission waits, children, joins, and workflow state remain Relay facts.

Execution following backfills from Relay pages, resumes from the newest cursor, and stops only at a canonical terminal event or an actionable permission request. Projection is idempotent by Turn and cursor. A transport failure never invents terminal state.

Child Runs use isolated durable Sessions, bounded fan-out, explicit join policy, deterministic identities, and pinned instructions, tools, permissions, output schema, route, and compaction policy. Children cannot spawn grandchildren. Built-in workflows are versioned Rika data compiled to Relay operations; model-authored executable workflow code is not supported.

# Non-Functional Requirements

## Correctness

- Durable side effects use stable idempotency keys.
- Cursor replay is monotonic and duplicate-safe.
- Failed dependencies produce typed failures rather than silent fallback.
- Configuration and persisted values are Schema-decoded at boundaries.

## Local Operation

- SQLite is the only required database.
- No daemon, Docker, Postgres, Rivet engine, or hosted Rika service is required.
- The packaged artifact restores the terminal immediately and exactly once on success, failure, defect, signal, interruption, renderer initialization failure, and cleanup-step failure, before awaiting slower client cleanup.

## Performance

- Input remains responsive during streaming and tool execution.
- Render work is frame-bounded and does not block durable event consumption.
- Tool output and model context are bounded.
- Parallel work has explicit concurrency limits.

## Maintainability

- Baton and Relay are external dependencies used only through public exports.
- Every behavior-bearing service has a test or memory layer.
- Public behavior is specified before implementation.
- Feature completion requires real-flow evidence.

# Pending Turn queue

Input admitted while a Thread has active work is persisted immediately as a Pending Turn. Each Thread has a bounded FIFO queue; admission beyond its capacity fails with a typed queue-full result and does not displace accepted work.

The Thread Host wakes from durable inbox messages and asks Rika's SQL-backed promoter to claim the next Pending Turn. Promotion is revisioned and safe to retry after interruption. A claimed Turn emits `TurnStarted` only after preparation succeeds and it enters `running`; users may edit, remove, or steer queued text into the active Execution before that point.

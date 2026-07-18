# Child Runs

A Child Run is a durable child Execution with narrowed instructions and capabilities. Each child has a deterministic identity, isolated durable Session, pinned profile, route, tools, permissions, output contract, and compaction policy; its events remain associated with the parent Turn.

Fan-out is bounded by an explicit concurrency limit and joins with `all`, `first-success`, `quorum`, or `best-effort`. Child failure is preserved in the join result, and cancellation is durable. Delegation is available only below depth two, so a child at the depth limit cannot create another Child Run.

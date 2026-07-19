# Durable Execution mapping

Every Turn maps deterministically to one top-level Relay Execution, and every Thread maps to one stable Relay Session. Relay owns execution events, waits, children, cancellation, replay, and terminal state; Rika stores the product records and disposable read projections that refer to them.

The Turn's resolved route is pinned before execution starts, so restart and replay do not adopt newer model settings. Context is resolved when execution starts and may be recomputed if an accepted Turn is recovered before Relay has created its Execution. Failure to prepare or start is recorded as a failed Turn rather than creating a second Execution.

Rika treats the Baton, Relay, and Effect versions pinned in the root package catalog as one runtime compatibility unit. They are installed and upgraded together so durable values never cross between different Effect runtime identities.

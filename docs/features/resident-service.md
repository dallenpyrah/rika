# Resident service and persistence

One Resident Rika Service owns each canonical Profile and data root. It binds an authenticated loopback listener before opening `rika.db` and `relay.db`, then owns product SQLite, one Relay runtime graph, route registration, admission, reconciliation, and runtime fibers. Stateful clients attach to it and never open a fallback database.

The local typed WebSocket contract carries bidirectional requests, events, actions, heartbeats, transcript pages, keyed patches, acknowledgements, and resync. Queues and frames are bounded. A logical client may reconnect and restore reads, but it never automatically resends a mutation whose outcome is unknown.

The lifecycle is `starting -> ready -> grace -> draining -> stopped`; a new authenticated client may cancel grace. The listener remains owned until Relay and product SQLite close. `SIGKILL` relies on OS listener release and durable reconciliation.

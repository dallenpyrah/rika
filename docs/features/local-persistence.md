# Local persistence

The Profile's canonical data root contains `rika.db` for Rika product state and `relay.db` for Relay execution state. The Resident Rika Service is their only runtime owner; stateful clients never open either database directly or fall back to a private copy.

Rika writes Threads, Turns, Pending Turns, projection checkpoints, semantic transcript units, summary activity, and read state through Effect SQL transactions. Relay remains authoritative for execution even when `rika.db` has stale disposable read state. Database open or migration failure prevents the resident from becoming ready rather than serving partial state.

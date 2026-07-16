# Resident service

**Gain:** one SQLite owner, one runtime graph, concurrent local clients, and deterministic recovery.

**Cost:** authenticated lifecycle and reconnect logic are part of the local app.

**Rejected:** one runtime per client or mode, PID-file ownership, and retries across independent SQLite clients. None creates one serialization and notification domain.

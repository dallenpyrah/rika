# Resident process lifecycle

The resident moves through `starting`, `ready`, `grace`, `draining`, and `stopped`. An authenticated client may cancel the grace period; clients arriving during draining are rejected, and startup detects incompatible residents, foreign listeners, unsafe tokens, and failed ownership rather than opening another state owner.

The loopback listener stays owned until Relay and product SQLite close. Graceful shutdown bounds each client close and the server scope so signals can finish promptly. After an abrupt stop, the operating system releases the listener and the next resident relies on durable reconciliation rather than process memory.

# Launched build wins

When a client and the running resident carry different protocol versions or build identities, the build the user just launched supersedes the resident; every already-attached client yields, exits its interactive runtime with a restart signal, and the CLI parent respawns the runtime from the build on disk, which rehydrates the Thread from durable state.

Supersession is a property of the launch, not of incompatibility. Before this rule, every client that saw an incompatible resident tried to replace it, so an upgrade with two live sessions became a kill war that ended in failed clients. Version-namespaced side-by-side residents were rejected because one resident is the single execution and persistence owner for a Profile and data root; two versions cannot share `rika.db` and `relay.db`.

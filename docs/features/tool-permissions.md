# Tool permissions

Built-in coding tools carry default permission metadata, and specialist agents receive only the capabilities required by their role. In the current Workspace policy path, shell execution may run directly when configured `allow`; every other shell setting asks the user before starting the process.

Only an explicit permission wait creates an actionable approval. Refusing the shell prompt or lacking a pinned capability returns a tool failure without running the operation, and cancellation ends the wait rather than granting access.

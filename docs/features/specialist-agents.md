# Specialist agents

The main agent can delegate durable Child Runs through Task, Oracle, Librarian, and Review tools. Task can read, edit, and run processes; Oracle investigates Workspace code read-only; Librarian reads network sources; Review inspects files and Git status. Each returns a role-specific structured result.

Root and first-level agents may delegate, but second-level agents receive no delegation tools. Child Runs use pinned routes and capability snapshots; unavailable routes, missing snapshots, excessive nesting, cancellation, and failed children return explicit delegation results rather than widening access.

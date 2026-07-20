# Specialist agents

The main agent can delegate durable Child Runs through Task, Oracle, Librarian, and Review tools. Task can read, edit, and run processes; Oracle is a read-only, high-reasoning advisor for planning, review, code comprehension, and debugging; Librarian reads network sources; Review inspects files and does not run processes. The main agent consults Oracle frequently for complex or difficult tasks, tells the user before doing so, and remains responsible for its conclusions. Each returns a structured result containing role-specific output.

Root and delegation-enabled first-level agents may delegate, but second-level agents receive no delegation tools. Oracle and Review do not delegate. Child Runs use pinned routes and capability snapshots; unavailable routes, missing snapshots, excessive nesting, cancellation, and failed children return explicit delegation results rather than widening access.

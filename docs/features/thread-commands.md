# Thread commands

Local developers manage Threads with `rika threads`: create, continue, list, search, rename, label, pin, archive, unarchive, delete, inspect usage, fork, and export. `rika last` and `rika top` are shortcuts for selecting recent Thread views; list and search support bounded results and optional archived Threads.

Commands that act on one Thread require its id and fail when it is missing. Continue accepts either `--last` or exactly one id, fork may stop at `--at-turn`, and export writes either JSON or Markdown; these commands expose CLI operations only, while Thread storage and execution meaning remain owned by the Thread capability.

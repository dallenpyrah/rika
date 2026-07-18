# Thread retrieval tools

Agents use `find_thread` to search local Thread metadata and `read_thread` to retrieve a bounded transcript. Search accepts plain terms and Workspace, repository, reference, author, label, file, and date filters; archived Threads are excluded unless requested.

Result counts, Turn counts, and text are bounded and report truncation. Unknown Thread identifiers, invalid filters or limits, and unavailable retrieval return typed failures; these tools read local Thread state only.

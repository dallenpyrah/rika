# File discovery and reading

Agents use `find_files`, `grep`, and `read` to inspect the current Workspace. Discovery skips `.git` and `node_modules`, returns at most one thousand paths or matches, and reads bounded UTF-8 line ranges with a default of five hundred and a maximum of two thousand lines.

Paths cannot escape the Workspace. Invalid regular expressions, missing or unreadable files, invalid ranges, and platform failures return typed tool errors; large results are truncated to the tool's output bound.

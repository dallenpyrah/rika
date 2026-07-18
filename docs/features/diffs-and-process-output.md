# Diffs and process output

Single-file edits expand directly to their diff. Multi-file edit groups expose independently expandable file rows. Running patches open automatically, turn argument deltas into per-file diff lines, and replace the live preview with the final result on the same row.

Shell rows stream bounded process output and retain the command and completion state. Multi-command groups expose each command separately, failures show an exit code, and process waits name the original command while showing only newly received output.

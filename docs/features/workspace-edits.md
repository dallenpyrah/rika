# Workspace edits

Agents use `create_file`, `edit_file`, and `apply_patch` to change UTF-8 files inside the Workspace. Creation never overwrites an existing path; exact edits require one matching old-text anchor; patches validate every operation and context before writing.

Outside-Workspace paths, stale or ambiguous anchors, malformed patches, and conflicting file operations fail instead of guessing. Edit calls are mutations and are not safe to retry when their result is unknown.

# Workspace edits

The canonical model-visible local tools are `read`, `edit`, `write`, and `bash`. Agents use `edit` to change existing UTF-8 files and `write` to create new UTF-8 files inside the Workspace. `write` is create-only and never overwrites an existing path; `edit` requires one matching old-text anchor. There is no model-visible `apply_patch` tool.

Outside-Workspace paths and edit paths containing symbolic links fail, as do stale or ambiguous anchors and conflicting file operations. Workspace edits are allowed without confirmation. Edit and write calls are mutations and are not safe to retry when their result is unknown.

# Tool contracts

Model-visible tools use Schema inputs, typed success and failure results, declared timeouts, and bounded output. Calls run through Effect scopes so timeout or Execution cancellation interrupts work and releases owned resources.

The canonical model-visible local contract is limited to `read`, `edit`, `write`, and `bash`. `write` is create-only and must not overwrite an existing path; `edit` changes existing files using an exact anchor; `bash` runs bounded local commands. There is no model-visible `apply_patch` tool.

Each contract states whether repeating a call is safe. Read-only calls may be retried against current local state; writes and process calls are not assumed idempotent, and callers must not repeat a mutation whose outcome is unknown.

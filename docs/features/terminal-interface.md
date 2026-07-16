# Terminal interface

OpenTUI stays behind one adapter. Pure view state owns interaction semantics; a client controller owns resident events, paging, resync, and frame scheduling. The TUI consumes product messages rather than Relay, Baton, SQL, or provider types.

The transcript is bottom-anchored and mounts at most two hundred semantic entries. Keyed entries retain object identity; streaming changes patch the final entry. Follow intent, anchor-preserving prepend, loading states, sidebars, overlays, the composer, cursor lifecycle, terminal suspension, and shutdown remain explicit state.

Read and search calls form exploration groups. Shell and edits use family groups; unknown tools remain generic. A single-file edit expands directly to its diff. Multi-file edits and multi-command shell groups have independently expandable children. Process waits name the original command. Subagents reveal their delegated task. Every underlying call appears once.

Tool-call argument deltas update the final ToolCall row. A running patch expands automatically and streams per-file diff lines. The result replaces that preview on the same row, without a draft row or delayed duplicate.

Workspace-relative path targets may carry line and column. The adapter renders them as clickable text; the app rejects paths outside the Workspace and suspends the terminal while opening the configured editor.

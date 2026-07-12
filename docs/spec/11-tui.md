# TUI Interaction and Visual Contract

## Visual Baseline

Rika v2 preserves the approved Rika v1 terminal visual language: colors, spacing, borders, panel geometry, flat transcript, Markdown rendering, tool cards, syntax-aware diffs, mode presentation, palette, and responsive narrow layouts.

Sequential read and search calls share one exploration activity, while shell and edit calls use family-specific groups and unknown tools remain generic. Summaries distinguish running, finished, and failed work and pluralize family counts; expanded activity presents every underlying call exactly once. Presentation details carry workspace-relative path targets with optional line and column. The OpenTUI adapter renders targets as independently clickable native text and delegates opening to the application. The application rejects targets outside the Workspace, launches `VISUAL` or `EDITOR` using its supported location convention, and suspends and restores the terminal around the editor process.

An empty startup has no persistent Thread sidebar or header. Its mode-tinted Rika mark and the copy `Welcome to Rika`, `ctrl+o for commands`, and `? for shortcuts` are centered in the transcript's remaining flex space above a minimum-five-row composer. The composer inherits the terminal background, uses a rounded text-color border, and presents mode or working state in a top-right cutout and Workspace in a bottom-right cutout. The composer grows with wrapped input and its top border is a mouse resize target even when the prompt is empty: hovering requests the OSC 22 `ns-resize` pointer with OpenTUI's `move` pointer as a fallback, dragging upward grows it, dragging downward shrinks it no lower than five rows, and terminal resize clamps it while preserving at least four transcript rows. Shortcut help temporarily owns composer height and closing it restores the prompt height. The speed glyph appears beside the mode only when provider-backed fast speed is enabled; ordinary mode presentation never implies fast speed. Transcript text is selectable; terminal selections are copied with OSC 52. Bracketed text paste is decoded and stripped of ANSI control sequences. A paste containing a newline, carriage return, or more than 120 characters becomes a collapsed pasted-text attachment at the cursor; shorter single-line paste remains directly editable. Clicking a collapsed pasted-text label or repeating the same bracketed paste within 500 milliseconds expands its exact contents in place for editing. Submission expands pasted-text attachments into the displayed user history, the durable Turn prompt, and ordered text prompt parts so surrounding typed text and exact pasted content enter durable execution unchanged. Collapsed attachment tokens are composer-internal and never enter transcript history, persisted prompts, prompt parts, or model input. Both renderer listeners are removed during adapter teardown.

The baseline is Rika v1, not Amp branding or copied Amp strings.

## Architecture

- Pure view state and update functions own interaction semantics.
- One adapter module owns OpenTUI imports and renderer lifecycle.
- The TUI consumes product messages, not Relay, Baton, SQL, or provider types.
- Renderer failures restore the terminal and surface a typed process failure.
- Interactive execution publishes each durable Execution Event as it arrives. `model.output.completed` finalizes assistant content but does not clear working state; only `execution.completed`, `execution.failed`, or `execution.cancelled` makes the TUI terminal, and that state is monotonic against late model events.
- Startup lists Threads from the product repository and remains on the empty welcome view. It selects and replays durable execution history only when a Thread is intentionally opened, including an explicit `--thread` startup selection.
- When a Turn reaches a terminal state, the oldest Pending Turn is atomically promoted and executed until the durable queue is empty or an execution waits.

## Required Interaction

Prompt editing, multiline input, history, external editor, images, file/thread mentions, queueing, steering, interruption, mode dial, command palette, thread sidebar, prior-message navigation, expandable activity, child runs, workflows, cost, context, and notifications are covered by the feature ledger.

Typing `@` opens a visible Workspace file completion overlay. Subsequent text filters the candidates, arrow keys move the selection, Enter inserts the selected Workspace-relative mention into the composer, and Escape closes the overlay. The inserted mention remains ordinary prompt text and follows the existing ordered prompt-parts and Resolved Context pipeline at submission.

`Ctrl+S` opens the mode picker between Turns, selects the current mode initially, and cycles the visible selection when pressed again. Every row shows its stable mode and current Model Route label; the active route is explicitly marked. Enter applies the selected mode and Escape closes without changing it. `?` toggles a shortcuts overlay in the existing overlay region; Escape and `?` close it.

Image input is structured rather than textual context. Dropped bracketed paths, quoted paths, escaped paths, and `file://` URLs for supported local image files become ordered prompt parts. On macOS, Ctrl+V requests PNG extraction through an injectable host callback and inserts one semantic image attachment rendered as `[Image #N]`; bracketed text paste remains text. Text surrounding an attachment retains its order. Missing, empty, unreadable, or unsupported image materialization is a visible typed submission failure and leaves the draft intact. Submission reads image bytes once, persists their media type, filename, and base64 payload with the Turn, and replay sends the same image part to Baton through Relay. Image bytes are never decoded as UTF-8 context. Up and Down enter history only from the first and last multiline boundaries, preserve the complete unsent draft and attachments, and Down past the newest entry restores that draft. Editing recalled input exits history mode.

Shell prefixes are parsed only at the beginning of an input: `$` selects a recorded shell command and `$$` selects an incognito command. Both request allow, deny, or always permission before invoking the shell runtime. Recorded command output is stored in the product Thread and Turn repositories, while incognito commands create neither a Thread nor a Turn. Denial never starts a process. Recorded shell output submitted while a Turn is active enters the durable queue. Context usage, estimated cost, compaction checkpoints, and notifications are typed transcript blocks so replay and rendering do not depend on backend event types.

The thread sidebar is a projection of non-archived product repository records in repository order. Selecting a sidebar item replaces the transcript with that Thread's replay rather than synthesizing a one-item sidebar.

The changed-files sidebar occupies the full right edge above and beside the composer, reducing both transcript and composer width while open. It renders the complete Workspace-relative path hierarchy, shows every file's added-line count in green and removed-line count in red, and scrolls within its own bordered viewport. Clicking a file opens that Workspace file through configured `VISUAL` or `EDITOR`, falling back to the platform's default file application; paths outside the Workspace are rejected.

Transcript follow intent is pure view state while OpenTUI measured content, viewport, and scroll geometry are adapter state. User movement above the physical bottom detaches; reaching the bottom or pressing End reattaches. Detached content and resize preserve the visible anchor, while attached content and resize scroll to the measured bottom after layout. Programmatic movement never changes intent. Footer cutouts retain inner, gap, and trailing breathing room relative to the composer border, with a compact narrow fallback. Thinking, working, and streaming show an animated dither loader; waiting is subdued and static; idle and terminal states show none.

## Proof

Character-frame tests, image captures, pixel comparisons, controller tests, and packaged interactive smoke runs are required.

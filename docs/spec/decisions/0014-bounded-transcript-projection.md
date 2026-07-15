# ADR 0014: Bounded Transcript Projection

Status: Accepted

## Context

The TUI currently rebuilds every transcript child when any view state changes. Native OpenTUI work therefore grows with complete Thread history, and one long Turn can make the next key press visibly slow. Relay owns canonical execution events, but a bounded raw event page cannot independently reproduce Rika's semantic transcript because grouping and finalization depend on earlier events.

## Decision

Relay exposes chronological forward and backward execution-event pages through its released public SDK. Rika persists a disposable semantic transcript projection with stable entry keys, revisions, ordering keys, source cursor bounds, and per-Turn projection checkpoints. Applying an event and advancing its checkpoint is atomic and idempotent. Missing or outdated projections rebuild from Relay pages.

Product interfaces return keyset transcript pages. The first page contains the newest fifty entries. The resident protocol v2 carries Schema-tagged page, prepend, keyed patch, and resync frames with a projection revision. Delivery queues are bounded; overflow asks the client to resync instead of buffering complete history.

A client controller owns transcript protocol events, reducer dispatch, page requests, resync, and frame scheduling. The OpenTUI adapter reconciles a window of at most two hundred semantic entries by key and revision. Unchanged renderables retain identity. Streaming rich text updates one keyed tail renderable. Prepending older entries preserves the measured visible anchor.

OpenTUI source is a read-only research submodule. Rika continues to consume released packages and upgrades only after its bounded-render benchmark and native behavior suite pass.

OpenTUI 0.4.3's `MarkdownRenderable` streaming path was evaluated. Rika keeps its existing semantic `StyledText` renderer because it owns tool grouping, selection colors, and Amp-compatible transcript layout. The adapter applies the same incremental principle by retaining the keyed tail `TextRenderable` and changing only its content.

## Consequences

Durable history may be large while database reads, protocol memory, reducer work, and mounted native objects stay bounded. Relay remains execution authority and Rika owns the user-facing read model. Projection schema changes require a versioned rebuild path. Protocol v1 clients remain connection-bound and cannot use paged transcript delivery; protocol v2 compatibility is negotiated during handshake.

## Rejected Alternatives

- Keep rebuilding the full transcript and tune individual renderers: rejected because work still grows with history.
- Page raw Relay events directly into the TUI: rejected because pages do not contain enough prefix state to produce stable semantic entries.
- Copy or fork OpenTUI internals: rejected because the released adapter boundary is sufficient and keeps framework ownership upstream.

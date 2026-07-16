# Transcripts and thread views

Rika persists one disposable semantic transcript projection with stable keys, revisions, chronological keys, source cursor bounds, and per-Turn checkpoints. Applying an event and advancing its checkpoint is atomic. An absent projection rebuilds from bounded Relay pages; there is no alternate projection shape or old decoder.

The initial read starts with the newest fifty entries and continues backward to at least two hundred entries and the nearest Turn boundary. Later reads use keyset pages. Raw Relay pages do not cross the runtime or resident product interfaces.

Initial load, prepend, replay, live delivery, and Thread preview use the same semantic projection. Assistant phases, tools, and children stay in source order. Thread summaries combine metadata with projected status, unread state, activity, and edit totals and are repairable from Relay.

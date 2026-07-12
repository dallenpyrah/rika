# Effect SQL Product Persistence

## Scope

Rika uses Effect SQL SQLite for product-owned state such as Thread metadata, Workspace records, configuration projections, extension trust, artifacts, and TUI preferences.

Relay owns its execution persistence through its published embedded runtime contract.

Rika and Relay use separate SQLite files unless a future published Relay contract explicitly supports shared transactional composition. Startup applies Relay migrations first and Rika product migrations second under one process migration lock before runtime layers start.

The initial product schema stores canonical Workspace paths and Thread metadata. A Thread row contains its stable Relay Session identifier before any Turn begins. Thread and Session identifiers are allocated by the product service and passed into repositories so tests remain deterministic.

Thread metadata operations are create, get, list, search, rename, replace labels, pin, archive, unarchive, and delete. Listing is ordered by pinned state, most recent update, then identifier. Search matches title, workspace path, and labels. Repository list limits are clamped to one through one hundred.

## Rules

- Raw SQLite clients remain inside persistence composition.
- Repositories are Effect services with tagged errors and test layers.
- Rows are decoded to domain values through Effect Schema.
- Constraints enforce uniqueness and references.
- Migrations move forward and ship with the packaged binary.
- Transaction boundaries follow product invariants.
- Rika does not import raw Drizzle APIs.
- Clean startup, repeated startup, interrupted migration, and N-1 to N upgrade are tested against packaged migration assets.
- CLI help, version, completions, and parse errors do not open the product database.

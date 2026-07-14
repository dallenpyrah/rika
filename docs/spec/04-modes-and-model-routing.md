# Modes and model routing

## Contract

Rika settings contain named `gateways`, `models`, and `modes`. A Gateway has an explicit `openai` Responses or `anthropic` Messages protocol, an absolute HTTP or HTTPS `baseUrl`, and an explicit authentication mode. VibeProxy uses one Gateway of each protocol. Runtime behavior never depends on the Gateway name or endpoint. Authentication is either `none` or `bearer-env` with a required environment-variable name. Gateway URLs cannot contain user information or credential-like query parameter names, including exact or segmented `auth`, `signature`, and `sig` keys. Provider option objects cannot contain those or other credential-like keys at any depth. Legitimate model settings including `max_tokens`, `max_output_tokens`, `reasoning`, and `service_tier` remain valid. The configuration decode boundary rejects these secret-bearing shapes rather than sanitizing them because route pins preserve exact route semantics. The configuration boundary resolves each distinct named variable once into a redacted credential map, and each model registration receives only its Gateway's credential. Defaults name `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`; both VibeProxy Gateways may name `RIKA_MODEL_API_KEY`.

Each model alias owns ordered upstream candidate IDs, exact operational compaction, and request variants keyed by effort. Every effort variant has `normal` options and may have `fast` options. GPT aliases expose normal and fast variants; fast options explicitly include `service_tier: priority`. Claude aliases expose normal variants only, so a fast Claude route is rejected. Supported efforts are `low`, `medium`, `high`, `xhigh`, and `max`.

Each mode has a budget, measured in thousands of tokens, and complete `main` and `oracle` routes. For example, `budget: 64` admits 64,000 execution tokens. A route selects an alias, effort, and optional fast variant.

| Mode   | Main                    | Oracle                |
| ------ | ----------------------- | --------------------- |
| low    | `gpt-5.6-luna`, low     | `gpt-5.6-sol`, high   |
| medium | `gpt-5.6-terra`, medium | `gpt-5.6-sol`, high   |
| high   | `gpt-5.6-sol`, xhigh    | `claude-fable-5`, max |
| ultra  | `claude-fable-5`, max   | `gpt-5.6-sol`, max    |

Fable declares candidates `claude-fable-5` then `claude-opus-4-8`; Opus is also separately configurable. Baton 0.4.3 does not expose a candidate fallback policy constrained to availability failures before output, so Rika does not fake automatic fallback. Startup and doctor route resolution must report missing Gateways, aliases, and variants explicitly.

## Runtime invariants

- Registration keys are non-secret SHA-256 identities over protocol, normalized base URL, authentication mode and credential name, provider model ID, effort, fast selection, and canonical provider options. Registration deduplication uses Baton's exact `(Gateway name, provider model ID, registration key)` tuple.
- Every main and Oracle route is resolved and registered before execution.
- Every Relay execution start registers the agent from the Turn's immutable route pin and passes the exact returned revision to Relay.
- Root execution uses main. Oracle presets and Oracle fan-out members use Oracle. Librarian, Painter, Review, ReadThread, and Task remain on main.
- Deterministic TestModel configuration remains a fixed selection for every role.
- Automatic titling reuses the initiating Turn route.
- Old `providers`, model `provider`/`model`, and mode `model`/`oracleModel`/`reasoning` shapes are rejected.

The resident service resolves all routes and owns the one route-driven `ExecutionBackend`; clients never construct a backend or model layer. Before Relay acceptance, Turn admission persists an immutable route pin containing the mode, role, model alias, provider model ID, registration key, effort, fast selection, request-variant identity, provider options, compaction policy, token budget, and the non-secret Gateway identity needed to reproduce registration. The pin excludes credentials and mutable configuration values. Relay stores the exact agent revision returned when the backend registers that pinned definition.

Queued promotion, restart reconciliation, title generation, Child Run materialization, and Workflow continuation use the stored pin rather than current settings. A missing, malformed, or unregistrable pin fails admission before Relay start. Once Relay may have accepted an Execution, the pin cannot be changed or replaced; ambiguous product writes are reconciled by deterministic Turn and Execution identity and never by choosing the current route. Configuration reload affects only Turns not yet admitted.

A Review fan-out persists its parent Turn as a nonterminal route owner with the deterministic fan-out identity `review:<turn-id>`. The owner keeps its workspace-specific route registered across resident restart but is never started as a model execution. Startup registers every nonterminal executable Turn and route owner before Relay fan-out handlers resume. Reconciliation inspects the owner's fan-out and starts one resident-owned settlement watcher for each joining owner without waiting for the fan-out to finish. The foreground Review observes the same watcher for output, but request interruption does not interrupt settlement. The watcher leaves the owner nonterminal while the fan-out joins and settles it when the fan-out is terminal. If the fan-out disappears, including when the resident stopped after persisting the owner but before creating it, the watcher marks the owner failed instead of executing its routing prompt.

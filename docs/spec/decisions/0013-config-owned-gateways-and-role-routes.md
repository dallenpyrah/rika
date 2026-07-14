# ADR 0013: Config-owned gateways and role routes

## Status

Accepted

## Context

Provider names and endpoint presence previously selected runtime behavior, models did not own exact request variants, and `oracleModel` did not reach Oracle child execution. This made particular compatible services special, allowed old configuration to remain accidentally valid, and made mode routing incomplete.

Baton 0.4.3 registers exact model selections and measures the currently assembled prompt for proactive compaction, but exposes no candidate chain whose fallback is limited to availability failures before output. Relay 0.2.13 carries typed compaction policies on root definitions, child presets, and fan-out overrides, and assigns every direct and model-initiated child execution an isolated durable Session.

## Decision

Configuration owns named Gateways with an explicit `openai` Responses or `anthropic` Messages protocol and explicit `none` or `bearer-env` authentication. Bearer authentication names its environment variable. The application resolves distinct variables once into redacted values keyed by variable name and passes each registration only the credential named by its Gateway. Environment values remain the only secret boundary. Runtime dispatch uses the protocol discriminant only.

Models own ordered candidate IDs, provider-maximum input and output limits, retained recent tokens, and explicitly configured normal and optional fast variants keyed by effort. The public model contract does not expose Baton's `contextWindow` and `reserveTokens`: Rika derives them from `maxInputTokens` and `maxOutputTokens`, and derives the provider output option from the same output limit. Built-in model metadata lives in one catalog sourced from `models.dev`; custom Gateway aliases own their transport-specific overrides. Modes own complete main and Oracle routes. Named specialist routes independently select Librarian, Painter, Review, ReadThread, and Task models. Registration keys are content-addressed over protocol, normalized endpoint, authentication mode and credential name, model, variant, and canonical options; secret values never enter identity or logs. Root execution uses main, Oracle uses the mode's Oracle route, and each specialist uses its named route.

Rika does not impose cumulative execution-token budgets by mode or specialist. Each isolated root and child run is bounded only by the selected provider model's input and maximum per-response output limits. Legacy route pins may retain their old `tokenBudget` field for decoding, but runtime registration does not enforce it.

Each fan-out member uses a deterministic child-specific Relay agent definition materialized from its persisted override. This preserves the selected model, request variant, compaction policy, narrowed tools and permissions, output schema, and metadata without racing the shared root definition.

Review fan-out keeps a nonterminal synthetic parent Turn as its durable route owner. The Turn stores the deterministic `review:<turn-id>` fan-out identity, so resident startup can register its original workspace route before fan-out recovery without loading every completed Turn. Reconciliation inspects and settles the fan-out rather than starting the synthetic parent prompt as a model execution.

No legacy decoder, provider-name branch, endpoint inference, or old mode keys remain.

Fable declares `claude-fable-5` followed by `claude-opus-4-8`, and Opus is also a separately configured alias. Rika does not automatically fail over because the published Baton API cannot constrain candidate fallback to availability failures before output. Startup rejects unresolved routes and unavailable variants rather than silently changing models.

Root compaction follows main. Oracle child presets and fan-out overrides carry Oracle compaction, and Relay pins the resolved model and policy in each accepted child snapshot. Every root and native fan-out start uses the exact immutable revision returned by its registration call.

## Consequences

Any service implementing the configured OpenAI Responses or Anthropic Messages protocol behaves identically from configuration. Fast Claude routes are invalid. Candidate fallback remains an explicit upstream limitation rather than simulated behavior.

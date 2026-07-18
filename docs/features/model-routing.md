# Model routing

Rika maps model aliases to ordered provider candidates for the main agent, specialists, titles, and compaction summaries. A mode chooses a route; route aliases, provider mappings, request variants, limits, and specialist routes remain separate from mode selection.

Each accepted Turn pins the chosen models and non-secret provider settings. Missing aliases, unavailable variants, or routes that cannot be registered fail before execution starts; later configuration changes apply only to work not yet admitted.

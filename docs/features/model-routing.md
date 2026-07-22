# Model routing

Rika maps model aliases to ordered provider candidates for the main agent, specialists, titles, and compaction summaries. A mode chooses a route; route aliases, provider mappings, request variants, limits, and specialist routes remain separate from mode selection.

Each accepted Turn pins the chosen models and non-secret provider settings. Missing aliases, unavailable variants, or routes that cannot be registered fail before execution starts; later configuration changes apply only to work not yet admitted.

`modelAliases` may add aliases by naming a built-in `base`, provider, and ordered non-empty candidates. They inherit the base alias's limits and effort/fast variants exactly. `modelRoutes` changes only aliases for mode roles, agents, and compaction; each built-in route retains its effort and fast policy, and thread titles continue to use low main. Global and workspace values merge at alias and route-leaf granularity.

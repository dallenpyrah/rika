# Model routing

Rika maps model aliases to ordered provider candidates for the main and Oracle routes. A mode pins both routes: Task children use main, while Oracle, Librarian, Painter, Review, and ReadThread children use Oracle. Child tools never choose a model or reasoning effort.

Each accepted Turn pins the chosen models and non-secret provider settings. Missing aliases, unavailable variants, or routes that cannot be registered fail before execution starts; later configuration changes apply only to work not yet admitted.

`modelAliases` may add aliases by naming a built-in `base`, provider, and ordered non-empty candidates. They inherit the base alias's limits and effort/fast variants exactly. `modelRoutes.modes` changes only the main and Oracle aliases; each mode retains its built-in effort and fast policy. Title generation is fixed to Luna/low, and compaction summaries are fixed to Sol/xhigh.

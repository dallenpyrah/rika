# Workspace review

`rika review [path ...]` asks read-only review agents to inspect current Workspace changes. Callers may select staged changes with `--staged`, compare against a Git revision with `--base`, narrow the review to paths, or choose another `--workspace`.

Text is the default output; `--json` returns structured review findings for automation. An empty diff returns `No changes to review.` or `{"status":"no-changes","findings":[]}`, and invalid Git inputs, unavailable local tools, or failed review work produce command failures rather than a successful empty review.

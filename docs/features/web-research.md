# Web research

Agents use `web_search` to obtain ranked current-web excerpts and `read_web_page` to turn a public HTTP or HTTPS page into bounded Markdown. Searches require an objective; page reads may select material for an objective, request full content, or force a fresh fetch.

Credentials in URLs and non-HTTP protocols are rejected. Missing service credentials, network or HTTP errors, invalid responses, extraction failures, and unavailable requested full content return typed failures; returned source text is bounded.

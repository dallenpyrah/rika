# Live model suite

This opt-in suite reaches the configured local Vibe OpenAI-compatible proxy through Baton and Effect AI. It never imports a provider SDK or records credentials, request headers, raw transcripts, or model text as evidence.

Run it with:

```sh
RIKA_LIVE_MODEL_TEST=1 \
RIKA_VIBE_BASE_URL=http://127.0.0.1:PORT/v1 \
RIKA_VIBE_MODEL=MODEL \
RIKA_VIBE_API_KEY=SECRET \
bunx vitest run --config test/live/vitest.config.ts --no-file-parallelism
```

Without the opt-in flag or any required value, every case is skipped and names the missing configuration. The assertions retain only normalized evidence: completion presence, turn count, tool names, file outcome, named profile metadata, and the model registration's workflow capability marker. The workflow check intentionally reports unsupported until the configured registration advertises that capability.

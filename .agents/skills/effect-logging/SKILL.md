---
name: effect-logging
description: Use when adding or reviewing logging in any Rika package. Applies the Effect-native wide-events (canonical log line) pattern through the Diagnostics service so telemetry reaches motel with correlated traces and logs.
---

# Effect Logging (Wide Events)

Use when writing or reviewing any log in Rika. Emit **one context-rich wide event per operation**, not scattered lines. Rika already exports every `Effect.fn` span and every `Diagnostics.emit` to motel over OTLP; logs are auto-correlated to the enclosing span's `trace_id`/`span_id`. Your job is to make each operation emit a single, queryable event.

Read `AGENTS.md`, the package-local `AGENTS.md`, and `packages/core/src/telemetry.ts` before acting. View telemetry with `bunx @kitlangton/motel` (or the `motel-debug` skill for agents).

## Rules

1. **One wide event per operation.** An operation is a request-shaped unit: a CLI command, an agent-loop turn, a tool execution, an LLM call, an HTTP request, a thread mutation. Build up a context record through the operation and emit it **once at completion**. Do not sprinkle progress logs.

2. **Emit in a finally, always.** The event must be emitted on success and failure alike — never rely on falling through the happy path. Use the `Diagnostics.event` helper, which stamps `op`, `outcome`, `duration_ms`, and (on failure) `error`, and emits once in an `onExit` finalizer. Enrich the passed `fields` object as the operation learns more:

   ```ts
   const turn = Effect.fn("AgentLoop.turn")(function* (input: TurnInput) {
     return yield* Diagnostics.event(
       "agent.turn",
       (fields) =>
         Effect.gen(function* () {
           const result = yield* runTurn(input)
           fields.token_in = result.usage.input
           fields.token_out = result.usage.output
           fields.tool_count = result.toolCalls.length
           fields.stop_reason = result.stopReason
           return result
         }),
       { thread_id: input.threadId, mode: input.mode },
     )
   })
   ```

   For hand-rolled cases use `Effect.onExit`/`Effect.ensuring` directly, but prefer the helper for consistency.

3. **High cardinality.** Include the identifiers that let you query one specific occurrence: `thread_id`, `turn_id`, `tool_call_id`, `request_id`, `model`, `session_id`. `trace_id`/`span_id` are attached automatically by the telemetry layer — do not add them by hand.

4. **High dimensionality.** Aim for many fields (20+ where they exist): timing (`duration_ms`), operation (`op`, `path`, `method`), agent context (`mode`, `turn_index`, `tool_count`, `token_in`, `token_out`, `stop_reason`), decision context (`permission_mode`, `cache_hit`, `retry_count`), and `outcome`. More dimensions answer more questions without redeploying.

5. **Single logger.** Always go through `@rika/core` `Diagnostics.emit`. Never `console.log`/`console.error`, never `Effect.log*`, never a new logger. Diagnostics is the one sink; it writes the local NDJSON file and exports to motel.

6. **Two levels only.** `info` for completed wide events, `error` for failures needing attention. Do not reach for `debug`/`warn` to add detail — add a field to the wide event instead.

7. **Structured, never a bare string.** The `message` is a short stable label (`"agent.turn success"`); all real content goes in `data` as queryable fields. If tempted to interpolate values into the message, put them in `data` instead.

8. **Correlate across boundaries.** Thread the same identifiers (`thread_id`, `request_id`, `turn_id`) through sub-operations so a subagent turn, tool call, and LLM call for one user request all share keys and roll up under one trace.

9. **Redact secrets.** Never log API keys, tokens, or raw credentials. Prompt/response content is high-value but sensitive — gate full text behind explicit opt-in; log lengths, hashes, or truncations by default. Treat the motel store as sensitive dev data.

## Pitfalls

- **Scattered logs.** Six `emit` calls narrating one request is noise and cannot be queried as one row. Consolidate into the wide event.
- **Happy-path-only emission.** If the event is emitted after the work instead of in `onExit`/`ensuring`, failures and interruptions vanish exactly when you need them.
- **Designing only for known failures.** Capture context you did not anticipate needing (subscription tier, feature flags, mode, retry count) so unknown-unknowns are queryable after the fact.
- **Bypassing Diagnostics.** A `console.log` corrupts the TUI and never reaches motel.

## Verification

- `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run test`.
- With `bunx @kitlangton/motel` running, exercise the operation and confirm in motel that: the service `rika` appears, one wide event exists per operation with `outcome` and `duration_ms`, and each log is correlated to its span's trace.

## Completion Criteria

Done only when each touched operation emits exactly one wide event through `Diagnostics.emit`, emission happens in a finally (`onExit`/`ensuring`) covering success/error/interruption, events carry high-cardinality identifiers and rich dimensions, only `info`/`error` levels are used, no `console.*`/`Effect.log*` remain, and verification passes.

# Tool Failure Recovery Plan

## Implementation Status

Implemented on July 21, 2026:

- Local tool failures now carry a category, outcome certainty, recovery disposition, and one concrete next action. The actionable message survives Relay's current string-only failure persistence and reaches the next model turn with the original call ID.
- Timeout feedback includes the configured deadline. Unsafe timed-out or unclassified mutation failures report an unknown outcome and prohibit unchanged retry.
- Diagnostics retain execution ID, tool-call ID, tool name, deadline, duration, category, outcome, interruption state, and bounded retry facts without retaining raw causes.
- Web search retries one read-only transport failure after 200 ms inside the original tool deadline. Authentication, rate-limit, response, timeout, cancellation, and unsafe failures do not retry.
- Hidden-output tools display their failure guidance in the TUI. Historical string-only failures remain readable.
- Current OpenAI fragmented-stream tests execute each completed call ID exactly once and execute no malformed partial call. The historical duplicate-call suspicion did not reproduce on the current dependency set, so no Rika-side accumulator or deduper was added.

Blocked upstream:

- Released `@relayfx/sdk` 0.4.2 persists failed toolkit results as strings and discards declared structured failure values. Rika therefore cannot persist the full structured object while preserving failed status until Relay exposes a supported encoder. The current implementation intentionally preserves actionable text rather than using private APIs or JSON-in-error strings.

## Recommendation

Fix tool recovery as an interface problem, but do not treat every observed timeout as the same defect.

Rika should first make current-version failures attributable, then improve the model-visible text available through today's released Relay contract. Structured failures, separate model and TUI views, and automatic retries should follow only after the transport and retry-safety constraints are proven.

The work has three distinct owners:

- `@rika/tools` owns failures from an accepted local or web-research tool call, including outcome certainty and recovery guidance.
- `@rika/runtime` owns the mapping to released Baton and Relay tool-call protocols, durable call correlation, and provider/runtime integration.
- `@rika/transcript` and `@rika/tui` own the human projection. They must not become a second failure-classification owner.

Provider stream failures, malformed model tool calls, execution cancellation, child-scope violations, and model routing failures remain Baton, Relay, or `AgentToolError` concerns. Do not force them into the local `ToolError` contract.

## Goal

When a tool call fails, the agent should receive enough bounded, safe context to choose one of four outcomes without guessing:

1. correct the input and call again;
2. retry later or use an alternative because the dependency is transiently unavailable;
3. inspect known partial state before deciding what to do next; or
4. stop and report a blocker because retrying cannot help.

Users should see a concise explanation and suggested next action. Diagnostics should retain the category, deadline, duration, call correlation, and outcome certainty needed to investigate the failure without storing raw secrets or unbounded output.

The change must preserve these rules:

- unsafe calls whose outcome is unknown are never automatically repeated;
- cancellation remains cancellation, not a timeout or operation failure;
- Relay remains the owner of durable execution and tool-call identity;
- non-zero shell exits remain normal process results with exit code, stdout, and stderr;
- historical string-only tool failures continue to project correctly;
- no Rika code imports private Baton or Relay internals.

## Evidence and Current Path

### Persisted runs

The local Relay database contains activity from July 13 through July 21, 2026:

- 551 executions: 436 completed, 82 failed, 20 waiting, 12 cancelled, and 1 queued.
- 10,113 tool calls: 8,749 completed, 1,327 failed, 29 running, and 8 requested.
- 10,076 tool results: 1,327 string error results and 424 results containing a typed `ToolError` payload.
- 835 results contain only `ToolError: Tool call timed out`: 660 `grep`, 153 legacy `find_files`, and 22 `read_web_page` calls across 125 executions.

The diagnostic logs disprove the initial theory that those calls failed immediately:

- 816 `tool.failed` records completed near the 10-second tool deadline.
- 22 completed near the 30-second web-tool deadline.
- 296 failed in under 100 ms for other reasons.
- 21 of the 30-second failures occurred on July 21; 794 of the 10-second failures occurred on July 19–20.

Relay `created_at` values cannot be used as wall-clock tool durations. Runtime diagnostics are the duration source of truth.

### Timeout-heavy runs also had abnormal model traces, but causality is unproven

The 125 executions containing generic timeouts averaged:

- 675 `model.toolcall.delta` events, versus 54 in executions without a generic timeout;
- 66 `model.reasoning.delta` events, versus 3 otherwise;
- 17 model usage reports, versus 3 otherwise.

One failed GPT-5.6 child requested approximately 99 distinct tools in about three seconds and then ended with an OpenAI response-stream decode failure. Other timeout-heavy executions completed after the model recovered.

This establishes correlation, not a provider accumulator defect. Tool-call delta events are fragments, and the database spans several Rika, Baton, Relay, and Effect versions. The current workspace uses:

- `@relayfx/sdk` 0.4.2;
- `@batonfx/core` 0.7.1;
- Effect 4.0.0-beta.98.

A restarted current-version reproduction must count completed provider call IDs, Relay `tool.call.requested` IDs, handler starts, and peak active handlers before any provider or concurrency change is approved.

### Execution failures are mostly outside the local tool contract

The 82 terminal execution failures include:

- 21 OpenAI stream error-schema decode failures;
- 19 invalid OpenAI stream-option requests;
- 7 unavailable model registrations;
- 7 structured report validation failures;
- 6 tool-call conflicts;
- 4 provider stream decode failures;
- 4 agent token-budget failures;
- 3 provider rate limits;
- 3 session projection mismatches;
- 8 other failures.

These need their own runtime/provider corrections and must not be disguised as local tool failures.

### The model-visible local failure contract loses recovery information

`packages/tools/src/tool-runtime.ts` currently classifies only:

```text
kind: operation | timeout
outcome: known | unknown
message: string
```

Every underlying filesystem, process, index, provider, schema, and network failure is otherwise reduced through `String(cause)`. The database shows materially different failures flattened into that path:

- missing files and directories;
- invalid or stale edit anchors;
- path casing and workspace-containment errors;
- missing FFF native installation;
- unavailable or unconfigured web providers;
- HTTP response-schema failures;
- rate limits and transport failures;
- real local and web-tool deadlines.

`packages/runtime/src/execution-backend.ts` obtains the Relay execution ID, tool-call ID, tool name, and measured duration. `apps/rika/src/logging.ts` drops the first three because they are not in the diagnostic annotation allowlist. Existing `tool.failed` records therefore cannot be joined reliably to Relay rows.

The released Relay toolkit bridge persists many failed Effect toolkit results as `output_json = null` plus a string `error`. `packages/transcript/src/index.ts` then intentionally projects the string or `ToolError.message` as the tool output. Rika cannot provide a structured model result and a separate concise TUI view until the released Relay bridge can durably preserve the encoded failure value while keeping failure semantics.

## External Guidance

The target follows the common parts of current provider and protocol guidance:

- [Anthropic tool-call handling](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/handle-tool-calls) requires the result to retain the original `tool_use_id`, mark execution errors with `is_error`, and use instructive text such as a retry delay or missing parameter instead of `failed`. Anthropic reports that Claude commonly corrects invalid calls two or three times when it receives specific feedback.
- [Anthropic's agent-tool design guidance](https://www.anthropic.com/engineering/writing-tools-for-agents) recommends high-signal, token-efficient results; actionable validation and truncation feedback; and evaluations that measure runtime, calls, tokens, and tool errors from realistic multi-call tasks.
- [MCP tool results](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) separate protocol errors from tool execution errors, preserve `isError`, support structured content and output schemas, and require clients to validate results before giving them to the model.
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling) requires every output to retain its `call_id`, recommends strict schemas, supports multiple calls, and requires reasoning items to remain in history for reasoning models.
- [ToolMaze](https://arxiv.org/abs/2606.05806) reports that explicit versus implicit and transient versus permanent failures produce different recovery behavior; implicit semantic failures are especially damaging.
- [ToolMisuseBench](https://arxiv.org/html/2604.01508v1) recommends deterministic fault injection, explicit call and retry budgets, structured fault context, and separate measures for recovery success, time to recovery, invalid calls, and budget exhaustion.

The practical rule is to divide recovery ownership:

- deterministic infrastructure code handles bounded retries only when it can prove they are safe;
- the model receives semantic failures that require changed input, another tool, or user escalation;
- the user sees the concise consequence and next action;
- diagnostics retain correlation and measurements rather than raw sensitive causes.

## Target Design

```diagram
┌────────────────────────────────────────────────────────────┐
│ @rika/tools                                                │
│ accepted call → adapter → classified ToolFailure           │
│ category, message, outcome, recovery, bounded evidence     │
└────────────────────────────┬───────────────────────────────┘
                             │ encoded failure
                             ▼
┌────────────────────────────────────────────────────────────┐
│ @rika/runtime + released Relay/Baton                       │
│ durable call ID, failure semantics, cancellation, history  │
└──────────────────┬──────────────────────────┬──────────────┘
                   │ model result             │ execution event
                   ▼                          ▼
┌─────────────────────────────┐  ┌───────────────────────────┐
│ Agent recovery loop         │  │ @rika/transcript / TUI    │
│ correct / retry / pivot /   │  │ message + next action     │
│ stop                        │  │ historical compatibility  │
└─────────────────────────────┘  └───────────────────────────┘
```

The final Rika-owned failure shape should be a discriminated schema with:

- `category`: stable semantic class, not an exception class name;
- `message`: one concise statement of what happened;
- `outcome`: `known | unknown`;
- `recovery`: `never | after_change | later`;
- optional `nextAction`: one specific action the model can take;
- optional category-specific evidence with strict size limits.

Initial categories should cover only failures proven at the accepted tool boundary:

- `invalid_input`;
- `not_found`;
- `conflict` for stale or ambiguous edits and changed state;
- `access_denied` for filesystem or external-service access denial;
- `dependency_unavailable` for missing local adapters or unavailable providers;
- `rate_limited`;
- `timeout`;
- `operation` as the bounded fallback while mappings are completed.

Evidence must be a category-specific union, not one object with many optional fields. Candidate evidence includes configured deadline and elapsed time, retry-after duration, safe resource identity, validation issues, or dependency name. Do not duplicate normal process `exitCode`, `stdout`, and `stderr` into failures. Do not persist request bodies, credentials, environment values, arbitrary HTTP bodies, or unbounded exception traces.

Automatic retry eligibility is derived from all of:

```text
recovery == later
AND tool policy idempotency == safe
AND outcome == known
AND remaining call budget can contain the attempt and delay
AND the adapter preserves interruption
```

The failure object must not claim that a retry will occur. It tells the model what kind of recovery is valid.

## Implementation Slices

### 1. Make current failures attributable and reproduce the suspicious traces

- **Result:** Every new local-tool failure can be joined to one Relay call, and the July provider/concurrency hypotheses are either reproduced or rejected on the current dependency set.
- **Changes:**
  - Add `rika.execution.id`, `rika.tool.call.id`, and `rika.tool.name` to the diagnostics allowlist.
  - Add bounded annotations for configured deadline, elapsed duration, current failure category, outcome certainty, and cancellation/interruption state.
  - Record dependency versions once per resident process so mixed-version evidence is visible.
  - Add current-version provider replay fixtures for one fragmented call, several intentional calls, and a malformed terminal after partial deltas.
  - Count completed provider `call_id` values, Relay requested call IDs, handler starts, and peak active handlers. Do not infer calls from delta counts.
- **Tests:**
  - Logging test proves the new annotations survive allowlisting and raw causes do not.
  - Provider/runtime integration test proves one handler start per completed call ID.
  - Malformed partial stream test proves no uncompleted call executes.
  - Concurrency test proves the configured root and child limits observed through released APIs.
- **Checks:** Run focused app logging and runtime Relay tests, then `bun run check` if the replay fixture changes shared provider composition.
- **Stop condition:** If the released provider cannot replay the captured event shape through a public API, preserve the trace as evidence and open the correction in the owning dependency. Do not add a Rika-side stream accumulator or call-ID deduper.

### 2. Improve recovery text through the current released transport

- **Result:** The model can recover from common current failures even while Relay still transports them as strings.
- **Changes:**
  - Replace generic `String(cause)` output at known adapter boundaries with concise, actionable messages.
  - Include the operation, consequence, outcome certainty, and one next action in stable text.
  - Keep typed internal causes so later structured encoding does not require reparsing strings.
  - Cover the observed high-frequency cases first:
    - timeout after the actual configured deadline;
    - file not found → search or correct the path;
    - stale/ambiguous edit → reread and retry with current unique text;
    - path outside workspace → use a path under the stated workspace root;
    - missing workspace index dependency → repair installation, do not retry the call;
    - unavailable provider → select a configured provider or report configuration;
    - rate limit → respect retry-after when present;
    - response-schema failure → retry later or use another provider, without exposing the raw body.
  - State explicitly that unchanged retry is unsafe when the outcome is unknown.
- **Tests:** Table-driven adapter tests assert exact recovery meaning, not exception formatting. Add a real Relay boundary test asserting the exact string the next scripted model receives.
- **Checks:** `bun test packages/tools/test/tool-runtime.test.ts packages/runtime/test/execution-backend-relay.test.ts` using the repository's supported focused-test syntax, followed by package typechecks.
- **Cleanup:** Remove duplicated ad hoc messages once their adapter mapping is covered.

### 3. Preserve structured failures through released Relay

- **Result:** Relay stores and replays the encoded Rika failure object while still marking the tool result as failed.
- **Changes:**
  - Specify an upstream Relay acceptance test: an Effect toolkit handler returns a declared failure schema; Relay persists the encoded failure; execution events expose it as a failed result; the next Baton model turn receives it with the original call ID.
  - Implement or consume the released Relay API that satisfies that test.
  - Upgrade Rika only after the public package release; do not import from `repos/*` or private package paths.
  - Keep string-only history readable during the transition.
- **Tests:** Run the acceptance test against real SQLite, restart the runtime, and prove replay returns the same structured failure and call ID.
- **Checks:** Focused runtime Relay integration test, `bun run typecheck`, and `bun run check`.
- **Stop condition:** Do not encode JSON into the error string and parse it in the transcript. If Relay cannot preserve structured failures, retain slice 2 and keep this slice blocked.

### 4. Introduce the stable Rika `ToolFailure` schema and projection

- **Result:** Model recovery data and human presentation derive from one Rika-owned failure value.
- **Changes:**
  - Replace `kind: operation | timeout` with the discriminated category and evidence schema.
  - Add the recovery disposition, outcome certainty, and optional next action.
  - Map each accepted tool adapter to the narrowest proven category.
  - Update `@rika/runtime` fallback mapping without swallowing cancellation or framework defects.
  - Preserve the structured failure in `@rika/transcript`; project old string errors through the existing fallback.
  - Render `message` and optional `nextAction` in the TUI. Keep bounded technical evidence available in expanded detail only when useful and safe.
- **Tests:**
  - Schema round-trip and size-bound tests.
  - One test for each category and recovery disposition.
  - Transcript tests for new structured results and historical string results.
  - An in-process TUI test proving concise failure and next-action presentation through the real product stack.
- **Checks:** Focused tools, runtime, transcript, and TUI tests; `bun run test-tui` for the user-visible case; then `bun run check`.
- **Cleanup:** Delete the old `kind` mapping after all constructors and stored-history compatibility paths are migrated.

### 5. Add only proven, adapter-local transient retries

- **Result:** A safe transient dependency failure can recover without spending another model turn, while permanent, semantic, cancelled, unsafe, and unknown-outcome failures do not retry.
- **Changes:**
  - Start with one measured web adapter failure such as a transport error, 429 with retry-after, or supported 5xx response.
  - Keep retries inside the original tool-call deadline and preserve Effect interruption.
  - Use finite exponential backoff with jitter only when retry-after is absent.
  - Emit attempt count and total elapsed time in diagnostics.
  - Do not add an in-memory execution-wide retry budget; Relay owns durable execution and such state would reset after process recovery.
  - Do not suppress identical model calls globally. Workspace state can make an identical read or edit valid later.
- **Tests:** Use `TestClock` to prove retry timing, cap, interruption, deadline exhaustion, and no retry for unsafe or unknown-outcome calls.
- **Checks:** Focused adapter tests and `bun run check`.
- **Stop condition:** If the adapter cannot distinguish transient failure and known-safe outcome, return the classified failure to the model instead of retrying.

### 6. Add deterministic failure-recovery evaluation

- **Result:** Changes to tools, prompts, models, and providers can be measured against real recovery behavior instead of anecdotal successful runs.
- **Changes:**
  - Build deterministic scripted-model scenarios for invalid input, missing resource, stale edit, timeout, rate limit, unavailable dependency, malformed output, cancellation, and unknown mutation outcome.
  - Inject faults at the real tool boundary and use real SQLite where durability or replay is under test.
  - Track task success, recovery success, time to recovery, repeated unchanged calls, total calls, deadline use, token use where available, and graceful-stop quality.
  - Include multi-call tasks and a large intentional batch so timeout recovery is tested under contention.
  - Keep provider network calls out of deterministic CI; retain a separate optional live journey for released-provider compatibility.
- **Tests:** The evaluation itself must fail when the scripted agent repeats an unsafe unknown-outcome call, retries a permanent failure unchanged, loses the call ID, or presents an empty generic error.
- **Checks:** `bun run test` owns deterministic evaluation discovery; run `bun run check` before completion.

## Rollout and Recovery

Ship slices 1 and 2 independently. They are backward compatible with string-only Relay history and immediately improve diagnosis and model recovery.

Do not ship slices 3 and 4 halfway. The structured schema should be enabled only after the released Relay transport passes the SQLite restart acceptance test. During migration:

- read both structured and historical string failures;
- write only the new structured shape once transport support is active;
- monitor unknown fallback-category rate, timeout rate by tool/deadline, retries by category, recovery success, repeated unchanged calls, and execution completion;
- stop rollout if structured failure encoding causes execution terminals, call IDs are lost, cancellation changes meaning, or unsafe calls repeat;
- roll back the writer while retaining the dual reader if presentation or provider compatibility regresses.

Retry rollout starts with one adapter and no more than two attempts inside the existing call deadline. Promote only if recovery improves without increasing p95 tool duration, timeout volume, or provider load materially. Remove temporary comparison metrics after two stable releases with no old writer in use.

## Open Questions

1. **Relay failure transport:** Which released Relay version or planned API will preserve declared Effect toolkit failures as structured failed results? This gates slices 3 and 4.
2. **Current provider replay:** Does the July call burst reproduce after a full resident restart on Relay 0.4.2, Baton 0.7.1, and Effect beta.98? The result decides whether work belongs upstream or the historical incident can close.
3. **Deadline policy:** Were the 10-second `grep` and legacy `find_files` calls slow because of workspace-index contention, large batches, or the old implementation? Slice 1 must correlate duration, active handlers, workspace, and dependency version before changing timeout values.
4. **Evaluation baseline:** Which current model route should be the fixed deterministic recovery baseline? This affects slice 6 only; all contract and adapter tests remain provider-neutral.

## Definition of Done

The work is complete when:

- a failed call is attributable by execution ID, call ID, tool, category, deadline, and duration;
- the model receives a specific consequence and valid next action for every supported category;
- unsafe unknown outcomes cannot be retried automatically;
- cancellation and provider/runtime failures retain their owning semantics;
- structured failures survive Relay SQLite persistence and restart without losing call identity;
- historical string failures still render;
- the TUI shows concise recovery guidance without exposing sensitive evidence;
- deterministic fault-injection tests prove correction, retry, pivot, stop, cancellation, and unknown-outcome paths;
- current-version provider replay has either disproved the historical accumulator concern or produced an upstream-owned failing test.

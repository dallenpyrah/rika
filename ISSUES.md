# Issues

## Relay workflow recovery drops undispatched fan-out members after SIGKILL

When SIGKILL lands after some fan-out members complete but before Relay durably commits, the recovered workflow re-dispatches the killed-window member (idempotency holds) but never dispatches members that had not yet spawned, and no poll sweeps them, so the run stays `running` forever. Reproduced at 250 ms poll intervals by `packages/runtime/test/workflow.test.ts` ("research-synthesis … survives SIGKILL"), which fails roughly half the time at full test parallelism because the kill must land inside the commit window. This matches real stuck threads seen in production use. The defect is in the vendored Relay runtime, so the fix belongs in the relay repository; the Rika test is correct and stays as the regression signal. Once relay is fixed, tighten the test's recovery guard to count distinct members instead of raw dispatch rows.

## Relay idle event-poll default delays recovery

`RELAY_EVENT_POLL_IDLE_INTERVAL_MILLIS` defaults to 30000 in `@relayfx/sdk`; after a missed wake, recovery can stall up to 30 s in production. Tests override it via `test/unit/setup-relay-polling.ts`; consider a faster product-side default when configuring Relay.

## OpenTUI never repaints cells vacated by a scrollbox shrink after wheel scrolling

Upstream `@opentui/core` (0.4.3) bug: after scrollbox content shrinks below a prior wheel-scroll extent, the vacated framebuffer cells are never erased or overwritten — the raw PTY stream after a collapse contains zero erase sequences and no background writes for those rows, so stale text stays on the real terminal. JS-side `OptimizedBuffer.clear` (both buffers), `setBackgroundColor`, and `forceFullRepaintRequested` do not reach the native renderer's own buffer; only init and a real dimension-changing resize reallocate it. Rika's scroll/model handling is already correct (collapse clamps `scrollTop`, opaque backgrounds set, post-layout restore in place). The repro is `apps/rika/test/transcript-collapse-rendering.scene.test.ts`, marked `test.fails`; when an OpenTUI upgrade erases or background-fills vacated cells after a shrink, that test starts passing and vitest will flag it — then flip `test.fails` back to `test` with no other Rika change. File the bug upstream at anomalyco/opentui with the PTY-stream evidence.

## Delete the dead view-state reducers and divergent page math

`EventReplayed`, `AssistantStreamed`, and `ReasoningStreamed` in `packages/tui/src/view-state.ts` have no product dispatcher (projection flows through `execution-events.ts`), and the pageup/pagedown/end reducer branch (`view-state.ts:1494`) is unreachable from the TUI (the adapter intercepts those keys) and uses a different page size than the adapter. Four test files still dispatch these tags (`opentui-adapter.test.ts`, `view-state.test.ts`, `opentui-session.test.ts`, `visual.capture.ts`), so deletion means migrating those tests to the real projection path, not just removing code. Do it as its own change with the tests rewritten against `execution-events` projections.

## Collapse `content.minHeight` onto the real transcript viewport height

Partly addressed. The scroll-position bottom is now computed in one place: `followTranscriptAfterLayout`, `atTranscriptBottom`, `atMountedTranscriptBottom`, and `clampTranscriptScrollTop` all route through `transcript-viewport.ts` (`maxScrollTop`/`atBottomWithin`/`clampScrollTop`) on OpenTUI's live `viewport.height`. The ScrollBar `onChange` no longer re-renders synchronously from inside itself — both branches defer through the single `reportTranscriptScroll`, so `model.scrollOffset` and live `scrollTop` no longer transiently diverge (regression: `opentui-adapter.test.ts` "defers the scrollbar detach report instead of reporting inside onChange").

What remains is the real divergence behind the "small follow-mode jumps": `content.minHeight` is set to `transcriptViewportRows` (`model.height - inputHeight - queueHeight`), which is ~1 row taller than the scroll box's actual `viewport.height` (layout chrome), so `scrollHeight >= transcriptViewportRows > viewport.height` and the top row is silently clipped (`scrollTop` sits at 1 even when "at bottom"). The scrollbar display is intentionally left on `transcriptViewportRows` to stay matched with `content.minHeight`; unifying the display and the fill onto the real viewport needs a post-layout `minHeight` pass (the true `viewport.height` is only known after Yoga lays out, so a pre-layout assignment on the first frame falls back and never corrects — it adds one corrective frame). That change alters layout timing and cannot be scene-verified while the scene model route is down, so it is deferred.

## Transcript blank-flash while streaming and wheel-scrolled is not reproduced at the adapter boundary

A screen recording shows the scrolled-up transcript history vanishing (only the tail renders, black above) while a turn streams, ending stuck blank. Driving the real OpenTUI test renderer through `Surface.update` with scripted streaming models plus real wheel events — plain entries, deep history past the 240-bundle row window, and streaming subagents, settled and mid-burst — never reproduces it: the detached reading position and mounted content are preserved every frame. So the adapter's follow/anchor/window/scroll math is not the cause. Remaining suspects are the async round-trip through the fenced `main.ts` scroll handlers and projection ordering, and the upstream OpenTUI shrink-culling bug (see the entry above about vacated cells). A faithful reproduction needs the real stack; scene verification is blocked while the scripted-model route is mid-restore (`transcript-navigation.scene.test.ts` fails with `Missing environment variable OPENAI_API_KEY for provider openai`).

## Two scene tests race streaming against input and cannot pass reliably

`transcript-navigation.scene.test.ts` "preserves a detached paging anchor across streaming resize" presses PageUp while output is still streaming, so where the anchor lands depends on how far the stream raced; it fails roughly one run in three on an unmodified tree. Gate the keypress on a stable post-stream marker instead of a delay.

## Scene tests contend when multiple real-subagent scenes share a vitest invocation

`subagent-presentation.scene.test.ts` "shows a failed subagent state before the parent turn finishes" passes in ~4 s isolated but times out (~32 s, 40 s cap) when the same vitest invocation also runs `child-runs.scene.test.ts`. Real-process resource contention, not a code defect. Fix the isolation (per-scene process budget, or raise the scene cap with evidence), never by capping workers or serializing suites.

## Journey suite fails at full parallelism

24/39 journey tests fail with spawn-level `ChildProcess.exitCode` errors when run with full file parallelism; they pass serially and in pairs. Cluster-port collision is disproven. Suspect spawn-storm resource limits (process/fd) with several packaged processes per journey; needs a dedicated bisect before removing the remaining serialization pressure.

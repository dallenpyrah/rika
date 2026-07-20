import { expect, test } from "vitest"
import { Effect } from "effect"
import { runTranscriptRenderStress } from "../../packages/tui/test/transcript-stress-driver"
import { printMetrics } from "./stress-support"

const updateBudgetMilliseconds = 8

test(
  "streams into two hundred expanded subagents with bounded mounts and flat per-update latency",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.promise(() =>
          runTranscriptRenderStress({ childCount: 200, toolsPerChild: 10, streamedUpdates: 400 }),
        )
        yield* printMetrics("transcript-render", { ...result, updateBudgetMilliseconds })
        expect(result.items).toBeGreaterThan(2000)
        expect(result.mountedAfterLoad).toBeLessThanOrEqual(result.mountedLimit)
        expect(result.mountedAfterBurst).toBeLessThanOrEqual(result.mountedLimit)
        expect(result.updateP95Milliseconds).toBeLessThan(updateBudgetMilliseconds)
      }),
    ),
  120_000,
)

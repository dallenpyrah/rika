import { expect, test } from "vitest"
import { Effect } from "effect"
import { interactivePty, run } from "./client-main-harness"

test(
  "exits cleanly when Ctrl+C quits the idle interactive TUI",
  () =>
    run(
      Effect.gen(function* () {
        const result = yield* interactivePty([{ after: "Welcome to Rika", write: "\u0003" }])
        expect(result.timedOut, result.output).toBe(false)
        expect(result.actionsCompleted).toBe(1)
        expect(result.exitCode, result.output).toBe(0)
        expect(result.output).toContain(".#*+:")
        expect(result.output).not.toContain("Rika interactive runtime exited with code")
        expect(result.clientLogs).not.toContain('"message":"process.failed"')
        expect(result.names.filter((name) => name.endsWith(".open.jsonl"))).toEqual([])
      }),
    ),
  45_000,
)

import { describe, expect, test } from "bun:test"
import { ReviewService } from "@rika/agent"
import { Common, Ids } from "@rika/schema"
import { Effect, Layer, Schema } from "effect"
import { Output, Review } from "../src/index"

const run: ReviewService.ReviewRun = {
  review_id: "review_cli",
  thread_id: Ids.ThreadId.make("thread_review_cli"),
  artifact_id: Ids.ArtifactId.make("artifact_review_cli"),
  status: "completed",
  range: { kind: "working-tree", paths: ["src/app.ts"] },
  changed_files: ["src/app.ts"],
  checks: [
    {
      name: "security",
      severity_default: "high",
      tools: ["read"],
      source_path: ".agents/checks/security.md",
      scope_path: "",
      applies_to: ["src/app.ts"],
    },
  ],
  findings: [
    {
      check_name: "security",
      severity: "high",
      path: "src/app.ts",
      range: { start_line: 1, end_line: 1 },
      title: "Avoid eval",
      evidence: "eval(input)",
    },
  ],
  started_at: Common.TimestampMillis.make(1000),
  completed_at: Common.TimestampMillis.make(2000),
}

const makeLayer = (output: Output.MemoryOutput) =>
  Review.layer.pipe(
    Layer.provideMerge(Output.memoryLayer(output)),
    Layer.provideMerge(
      ReviewService.fakeLayer(() =>
        Effect.succeed({
          run,
          artifact: {
            id: run.artifact_id,
            thread_id: run.thread_id,
            kind: "review",
            content: { review_id: run.review_id },
            created_at: run.completed_at,
          },
        }),
      ),
    ),
  )

describe("CLI review command", () => {
  test("prints review runs as machine-readable JSON", async () => {
    const output: Output.MemoryOutput = { stdout: [], stderr: [] }
    const exitCode = await Effect.runPromise(
      Review.executeCommand({ type: "review", staged: false, paths: [], ephemeral: false }).pipe(
        Effect.provide(makeLayer(output)),
      ),
    )

    expect(exitCode).toBe(0)
    expect(output.stderr).toEqual([])
    const parsed = Schema.decodeUnknownSync(ReviewService.ReviewRun)(JSON.parse(output.stdout[0] ?? "{}"))
    expect(parsed).toEqual(run)
  })
})

import { TestModel } from "@batonfx/test"
import { MediaView } from "@rika/tools"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { AiError } from "effect/unstable/ai"
import * as MediaAnalyzer from "../src/media-analyzer"

describe("MediaAnalyzer", () => {
  it.effect("analyzes attached bytes through the selected registered model", () =>
    Effect.gen(function* () {
      const fixture = yield* TestModel.make([TestModel.text("deterministic media description")])
      const result = yield* Effect.gen(function* () {
        const analyzer = yield* MediaView.MediaAnalyzer
        return yield* analyzer.analyze({
          path: "fixture.pdf",
          mimeType: "application/pdf",
          kind: "pdf",
          size: 5,
          bytes: new Uint8Array([37, 80, 68, 70, 45]),
        })
      }).pipe(Effect.provide(MediaAnalyzer.layer(fixture.selection)), Effect.provide(fixture.registryLayer))
      const requests = yield* fixture.requests
      const parts = requests[0]?.prompt.content[0]?.content
      assert.strictEqual(result, "deterministic media description")
      assert.strictEqual(requests.length, 1)
      assert.ok(Array.isArray(parts))
      assert.ok(parts?.some((part) => part.type === "file" && part.mediaType === "application/pdf"))
    }),
  )

  it.effect("maps selected model failures to MediaAnalysisError", () =>
    Effect.gen(function* () {
      const fixture = yield* TestModel.make([
        TestModel.failure(
          AiError.make({
            module: "test",
            method: "generateText",
            reason: new AiError.UnknownError({ description: "model unavailable" }),
          }),
        ),
      ])
      const failure = yield* Effect.gen(function* () {
        const analyzer = yield* MediaView.MediaAnalyzer
        return yield* Effect.flip(
          analyzer.analyze({
            path: "image.png",
            mimeType: "image/png",
            kind: "image",
            size: 1,
            bytes: new Uint8Array([1]),
          }),
        )
      }).pipe(Effect.provide(MediaAnalyzer.layer(fixture.selection)), Effect.provide(fixture.registryLayer))
      assert.strictEqual(failure._tag, "MediaAnalysisError")
      assert.match(failure.message, /model unavailable/)
      assert.match(failure.message, /image \(image\/png\)/)
    }),
  )
})

import { expect, test } from "vitest"
import { Scene } from "./scene"

const resizeBurst = (width: number, height: number) => [
  { width: 132, height: 40 },
  { width: 72, height: 18 },
  { width: 101, height: 27 },
  { width, height },
]

for (const [width, height] of [
  [120, 32],
  [60, 20],
  [59, 14],
  [40, 12],
  [24, 8],
  [12, 6],
] as const) {
  test(
    `reflows mounted Unicode content through a resize burst to ${width}x${height}`,
    () =>
      Scene.run({
        response: "FINAL 界界 🙂 e\u0301e\u0301 responsive transcript",
        actions: [
          Scene.action.resizeBurstAfter("Welcome to Rika", resizeBurst(width, height), "unicode layout\r"),
          Scene.action.writeAfter("FINAL", "\u0003", 200),
        ],
      }).then((result) => {
        expect(result.output).toContain("FINAL")
        expect(result.output).toContain("界")
        expect(result.output).toContain("🙂")
        expect(result.output.normalize("NFC")).toContain("é")
        expect(result.runningChecks).toEqual([true])
        expect([result.finalWidth, result.finalHeight]).toEqual([width, height])
        expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
      }),
    35_000,
  )
}

for (const [width, height] of [
  [80, 24],
  [40, 12],
  [24, 8],
] as const) {
  test(
    `keeps a wrapped Unicode queue and composer usable at ${width}x${height}`,
    () =>
      Scene.run({
        script: [Scene.model.text("FIRST_DONE", 1_500), Scene.model.text("QUEUE_DONE")],
        actions: [
          Scene.action.resizeBurstAfter("Welcome to Rika", resizeBurst(width, height), "first request\r"),
          Scene.action.writeAfter("first request", "queued 界🙂e\u0301 text\r", 100),
          Scene.action.writeAfter("QUEUE_DONE", "\u0003", 500),
        ],
      }).then((result) => {
        expect(result.output).toContain("FIRST_DONE")
        expect(result.output).toContain("QUEUE_DONE")
        expect(result.output).toContain("界")
        expect(result.runningChecks).toEqual([true])
        expect([result.finalWidth, result.finalHeight]).toEqual([width, height])
        expect(result.turns.map((turn) => turn.prompt)).toEqual(["first request", "queued 界🙂e\u0301 text"])
        expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
      }),
    35_000,
  )
}

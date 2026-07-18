import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "shows scripted Relay usage in the real TUI without duplicate inflation",
  () =>
    Scene.run({
      script: [
        Scene.model.text("Usage converted.", undefined, {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
        }),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Report deterministic usage.\r"),
        Scene.action.writeAfter("Usage converted.", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("$11.25")
      expect(result.output).not.toContain("$22.50")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "processes scripted child usage through the real TUI",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([Scene.model.toolCall("task", { prompt: "Measure child usage." }, "usage-child")]),
        Scene.model.text("Child usage complete.", undefined, { outputTokens: 1_000_000 }),
        Scene.model.object({ summary: "Child usage complete", files: [] }),
        Scene.model.text("Parent usage complete.", 1_000),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Delegate usage measurement.\r"),
        Scene.action.writeAfter("Parent usage complete.", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("Parent usage complete.")
      expect(result.diagnostics).toContain('"rika.event.type":"model.usage.reported"')
      expect(result.diagnostics).toContain("usage-child")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "shows zero rather than estimating cost when the scripted model omits usage",
  () =>
    Scene.run({
      script: [Scene.model.text("No usage report.")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Finish without usage.\r"),
        Scene.action.writeAfter("No usage report.", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("0.00")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

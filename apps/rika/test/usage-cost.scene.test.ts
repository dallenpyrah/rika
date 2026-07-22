import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "leaves token-only test-model usage unpriced in the real TUI",
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
      expect(result.output).toContain("0.00")
      expect(result.diagnostics).toContain('"rika.event.type":"model.usage.reported"')
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "replays parent and child token reports without inventing test-model pricing",
  () =>
    Scene.run({
      script: [
        Scene.model.turn(
          ["alpha", "beta", "gamma"].map((name) =>
            Scene.model.toolCall("task", { prompt: `Measure ${name}.` }, `usage-${name}`),
          ),
          undefined,
          { inputTokens: 500_000, outputTokens: 100_000 },
        ),
        ...["Alpha", "Beta", "Gamma"].map((name) =>
          Scene.model.text(`${name} usage complete.`, undefined, { inputTokens: 500_000, outputTokens: 500_000 }),
        ),
        Scene.model.text("Parent usage complete.", 1_000, { inputTokens: 500_000, outputTokens: 500_000 }),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Delegate three usage measurements.\r"),
        Scene.action.restartAfter("Parent usage complete.", "threads", "continue", "--last"),
        Scene.action.writeAfter("Parent usage complete.", "\u0003", 500),
      ],
    }).then((result) => {
      expect(result.output).toContain("Parent usage complete.")
      expect(result.diagnostics).toContain('"rika.event.type":"model.usage.reported"')
      expect(result.childExecutions).toHaveLength(3)
      expect(result.output).toContain("$0.00")
      expect(result.diagnostics.match(/resident\.connection\.accepted/g)?.length ?? 0).toBe(2)
      expect(result.diagnostics).toContain("usage-alpha")
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

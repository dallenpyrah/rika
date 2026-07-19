import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "does not price token-only Relay usage in the real TUI",
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
      expect(result.output).not.toContain("$11.25")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "keeps several child token reports at zero across durable replay",
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
        ...["Alpha", "Beta", "Gamma"].map((name) =>
          Scene.model.object({ summary: `${name} usage complete`, files: [] }),
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
      expect(result.output).not.toMatch(/\$[1-9][0-9]*\.[0-9]{2}/)
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

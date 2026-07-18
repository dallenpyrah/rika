import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "cancels every active parallel subagent without publishing late responses",
  () =>
    Scene.run({
      script: [
        Scene.model.turn(
          ["alpha", "beta", "gamma", "delta"].map((name) =>
            Scene.model.toolCall("task", { prompt: `Wait in ${name}.` }, `cancel-${name}`),
          ),
        ),
        ...["alpha", "beta", "gamma", "delta"].map((name) => Scene.model.text(`LATE_${name.toUpperCase()}`, 5_000)),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Start four slow checks.\r"),
        Scene.action.writeAfter("Subagent working", "\u0003", 100),
        Scene.action.writeAfter("cancelled", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output.match(/cancelled/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
      expect(result.output).not.toContain("LATE_ALPHA")
      expect(result.output).not.toContain("LATE_BETA")
      expect(result.output).not.toContain("LATE_GAMMA")
      expect(result.output).not.toContain("LATE_DELTA")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

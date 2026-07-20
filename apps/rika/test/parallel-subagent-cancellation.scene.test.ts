import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "requests cancellation after all parallel subagents are durably active",
  () =>
    Scene.run({
      script: [
        Scene.model.turn(
          ["alpha", "beta", "gamma", "delta"].map((name) =>
            Scene.model.toolCall("task", { prompt: `Wait in ${name}.` }, `cancel-${name}`),
          ),
        ),
        ...["alpha", "beta", "gamma", "delta"].map((name) => Scene.model.text(`LATE_${name.toUpperCase()}`, 20_000)),
        Scene.model.text("Parent must not publish this response."),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Start four slow checks.\r"),
        Scene.action.writeAfterChildExecutions("running", 4, "\u0003"),
        Scene.action.writeAfter("cancelled", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.childExecutions).toHaveLength(4)
      expect(result.output.match(/Subagent working/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
      expect(result.output).not.toContain("Parent must not publish this response.")
      for (const name of ["alpha", "beta", "gamma", "delta"])
        expect(result.childExecutions.some((execution) => execution.id.endsWith(`:cancel-${name}`))).toBe(true)
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  60_000,
)

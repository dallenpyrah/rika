import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "shows every parallel subagent as an expandable row with its completed response",
  () =>
    Scene.run({
      script: [
        Scene.model.turn(
          ["alpha", "beta", "gamma", "delta"].map((name) =>
            Scene.model.toolCall("task", { prompt: `Explore ${name}.` }, `call-${name}`),
          ),
        ),
        ...["Alpha", "Beta", "Gamma", "Delta"].map((name) =>
          Scene.model.text(`## ${name} complete\n\n**Verified.**`, 100),
        ),
        ...["Alpha", "Beta", "Gamma", "Delta"].map((name) =>
          Scene.model.object({ summary: `${name} complete`, files: [] }),
        ),
        Scene.model.text("All parallel work complete."),
      ],
      actions: [
        Scene.action.resizeAfter("Welcome to Rika", 100, 50, "Run four checks in parallel.\r"),
        Scene.action.writeAfter("work complete.", "\t", 100),
        Scene.action.writeAfter("finished ▸", "\r"),
        Scene.action.writeAfter("Explore alpha.", "\u0003", 1_000),
      ],
    }).then((result) => {
      expect(result.timedOut, result.output).toBe(false)
      expect(result.exitCode, result.output).toBe(0)
      expect(result.actionsCompleted).toBe(4)
      expect(result.output).toContain("Subagent finished")
      expect(result.output.match(/finished ▸/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
      expect(result.output).toContain("Explore alpha.")
      expect(result.childExecutions).toHaveLength(4)
      expect(result.childExecutions.every((execution) => execution.status === "completed")).toBe(true)
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  60_000,
)

test(
  "shows a failed subagent and lets the parent continue",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall("task", { prompt: "Return malformed structured output." }, "call-failed"),
        ]),
        Scene.model.object({ summary: "Malformed", files: "not-an-array" }),
        Scene.model.text("Parent continued after child failure."),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Run the failing child.\r"),
        Scene.action.writeAfter("Parent continued after child failure.", "\u0003", 1_000),
      ],
    }).then((result) => {
      expect(result.output).toContain("✕ Subagent failed")
      expect(result.output).toContain("Parent continued after child failure.")
      expect(result.childExecutions).toHaveLength(1)
      expect(result.childExecutions[0]?.status).toBe("failed")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  60_000,
)

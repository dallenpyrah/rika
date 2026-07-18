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
        Scene.action.writeAfter("Welcome to Rika", "Run four checks in parallel.\r"),
        Scene.action.writeAfter("work complete.", "\t", 100),
        Scene.action.writeAfter("finished ▸", "\r"),
        Scene.action.writeAfter("Alpha complete", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.timedOut, result.output).toBe(false)
      expect(result.exitCode, result.output).toBe(0)
      expect(result.actionsCompleted).toBe(4)
      expect(result.output).toContain("Subagent finished")
      expect(result.output.match(/finished ▸/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
      expect(result.output).toContain("Alpha complete")
      expect(result.output).toContain("Verified.")
      for (const name of ["alpha", "beta", "gamma", "delta"])
        expect(result.clientLogs).toContain(`:call-${name}:model:3:output-delta`)
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

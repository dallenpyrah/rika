import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "keeps a pending Turn in the queue until the active Turn reaches terminal state",
  () =>
    Scene.run({
      script: [Scene.model.text("FIRST_TURN_COMPLETE", 1_500), Scene.model.text("SECOND_TURN_COMPLETE")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "FIRST_ACTIVE_TURN\r"),
        Scene.action.writeAfter("FIRST_ACTIVE_TURN", "SECOND_PENDING_TURN\r", 100),
        Scene.action.writeAfter("FIRST_TURN_COMPLETE", ""),
        Scene.action.writeAfter("SECOND_TURN_COMPLETE", "\u0003", 500),
      ],
    }).then((result) => {
      const pending = result.output.indexOf("SECOND_PENDING_TURN")
      const firstCompleted = result.output.indexOf("FIRST_TURN_COMPLETE")
      const secondCompleted = result.output.indexOf("SECOND_TURN_COMPLETE")
      expect(pending).toBeGreaterThanOrEqual(0)
      expect(firstCompleted).toBeGreaterThan(pending)
      expect(secondCompleted).toBeGreaterThan(firstCompleted)
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  20_000,
)

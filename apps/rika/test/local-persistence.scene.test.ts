import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "reopens the latest durable transcript after the TUI and resident restart",
  () =>
    Scene.run({
      response: "Workspace checked.",
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Remember this durable turn.\r"),
        Scene.action.restartAfter("Workspace checked.", "threads", "continue", "--last"),
        Scene.action.writeAfter("Remember this durable turn.", "\u0003", 1_000),
      ],
    }).then((result) => {
      expect(result.output).toContain("Remember this durable turn.")
      expect(result.output).toContain("Workspace checked. $0.00")
      expect(result.persistedTurns).toEqual([expect.objectContaining({ prompt: "Remember this durable turn." })])
      expect(result.diagnostics).toContain('"message":"turn.finished"')
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

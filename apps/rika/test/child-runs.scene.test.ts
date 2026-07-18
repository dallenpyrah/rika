import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "shows a failed child run as failed",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([Scene.model.toolCall("task", { prompt: "Fail deterministically." }, "failed-child")]),
        Scene.model.failure("deterministic child failure"),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Delegate work that may fail.\r"),
        Scene.action.writeAfter("Subagent failed", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("Subagent failed")
      expect(result.output).not.toContain("Subagent finished")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  30_000,
)

test(
  "shows nested child runs and their completed responses",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([Scene.model.toolCall("task", { prompt: "Coordinate nested work." }, "depth-one")]),
        Scene.model.turn([Scene.model.toolCall("task", { prompt: "Complete the nested check." }, "depth-two")]),
        Scene.model.text("Depth two verified the boundary."),
        Scene.model.object({ summary: "Depth two complete", files: [] }),
        Scene.model.text("Depth one synthesized the nested result."),
        Scene.model.object({ summary: "Depth one complete", files: [] }),
        Scene.model.text("Parent received the nested result."),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Coordinate nested work.\r"),
        Scene.action.writeAfter("Parent received the nested result.", "\t", 100),
        Scene.action.writeAfterDelay("\r", 100),
        Scene.action.writeAfter("Depth one synthesized", "\t", 100),
        Scene.action.writeAfterDelay("\r", 100),
        Scene.action.writeAfter("Depth two verified", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output.match(/Subagent finished/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
      expect(result.output).toContain("Depth one synthesized the nested result.")
      expect(result.output).toContain("Depth two verified the boundary.")
      expect(result.output).toContain("Parent received the nested result.")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "preserves the specialist identity and response of an Oracle child run",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([Scene.model.toolCall("oracle", { prompt: "Review the boundary." }, "oracle-child")]),
        Scene.model.text("The boundary is sound."),
        Scene.model.object({ answer: "The boundary is sound.", evidence: [] }),
        Scene.model.text("Parent accepted the Oracle answer."),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Ask Oracle to review the boundary.\r"),
        Scene.action.writeAfter("Parent accepted the Oracle answer.", "\t", 100),
        Scene.action.writeAfterDelay("\r", 100),
        Scene.action.writeAfter("The boundary is sound.", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("Oracle has spoken")
      expect(result.output).toContain("The boundary is sound.")
      expect(result.output).toContain("Parent accepted the Oracle answer.")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  30_000,
)

test(
  "lets a child run use its narrowed workspace tools and shows the result",
  () =>
    Scene.run({
      script: [
        Scene.model.turn([
          Scene.model.toolCall("shell", { command: "printf child-workspace-marker > marker.txt" }, "write-marker"),
        ]),
        Scene.model.turn([Scene.model.toolCall("task", { prompt: "Read marker.txt." }, "workspace-child")]),
        Scene.model.turn([Scene.model.toolCall("read_file", { path: "marker.txt" }, "read-marker")]),
        Scene.model.text("Child read child-workspace-marker."),
        Scene.model.object({ summary: "Workspace marker read", files: [] }),
        Scene.model.text("Parent received the workspace result."),
      ],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "Create a marker and delegate reading it.\r"),
        Scene.action.writeAfter("Parent received the workspace result.", "\t", 100),
        Scene.action.writeAfterDelay("\r", 100),
        Scene.action.writeAfter("Child read child-workspace-marker.", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("Child read child-workspace-marker.")
      expect(result.output).toContain("Parent received the workspace result.")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  30_000,
)

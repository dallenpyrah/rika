import { expect, test } from "vitest"
import { Scene } from "./scene"

test("runs the real TUI and tools inside an isolated workspace", () =>
  Scene.run({
    script: [
      Scene.model.turn([Scene.model.toolCall("shell", { command: "pwd", args: [] }, "workspace-pwd")]),
      Scene.model.text("Workspace checked."),
    ],
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "Show the current workspace.\r"),
      Scene.action.writeAfter("Workspace checked.", "\u0003", 100),
    ],
  }).then((result) => {
    expect(result.output).toContain("rika-scene-")
    expect(result.output).not.toContain("Projects/rika/apps/rika")
  }))

test("rejects when the TUI exits before every scripted action runs", () =>
  expect(
    Scene.run({
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "\u0003"),
        Scene.action.writeAfter("This marker cannot appear", "\r"),
      ],
    }),
  ).rejects.toThrow(/completed 1 of 2 actions/))

import { expect, test } from "vitest"
import { Scene } from "./scene"

test(
  "quits the real TUI through its command surface after releasing interactive state",
  () =>
    Scene.run({
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "\u000f"),
        Scene.action.writeAfter("Command Palette", "quit\r"),
      ],
    }).then((result) => {
      expect(result.output).toContain("Command Palette")
      expect(result.output).toContain("rika")
      expect(result.clientLogs).toContain("tui.teardown.started")
      expect(result.clientLogs).toContain("tui.teardown.completed")
      expect(result.clientLogs.match(/tui\.teardown\.started/g)).toHaveLength(1)
      expect(result.clientLogs.match(/tui\.teardown\.completed/g)).toHaveLength(1)
    }),
  15_000,
)

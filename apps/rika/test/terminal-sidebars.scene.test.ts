import { expect, test } from "vitest"
import { Scene } from "./scene"

const escape = "\u001b"
const alt = (key: string) => `${escape}${key}`
const mouseScrollDown = (x: number, y: number, times: number) =>
  Array.from({ length: times }, () => `${escape}[<65;${x};${y}M`).join("")

test(
  "keeps workspace and changed-file sidebars exclusive, independently scrollable, draggable, and resize-safe",
  () =>
    Scene.run({
      workspace: Object.fromEntries(
        Array.from({ length: 50 }, (_, index) => [`file-${String(index).padStart(2, "0")}.ts`, `${index}\n`]),
      ),
      git: true,
      actions: [
        Scene.action.writeAfter("Welcome to Rika", alt("t")),
        Scene.action.writeAfter("Files (50)", alt("s")),
        Scene.action.filesAfter("Changed files (0)", {
          "file-00.ts": "changed\n",
          "file-01.ts": null,
          "fresh.ts": "fresh\n",
        }),
        Scene.action.writeAfter("fresh.ts", alt("t")),
        Scene.action.writeAfter("Files (50)", mouseScrollDown(90, 10, 30), 100),
        Scene.action.writeAfterDelay(`${escape}[<0;67;10M${escape}[<32;20;10M${escape}[<0;20;10m`, 250),
        Scene.action.resizeAfterDelay(50, 8, 250),
        Scene.action.resizeAfterDelay(120, 40, 250, alt("s")),
        Scene.action.writeAfter("Changed files (3)", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.output).toContain("Files (50)")
      expect(result.output).toContain("Changed files (0)")
      expect(result.output).toContain("fresh.ts")
      expect(result.actionsCompleted).toBe(9)
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "opens, focuses, bounds, navigates, and rapidly switches the thread sidebar with stale selections in flight",
  () =>
    Scene.run({
      actions: [
        Scene.action.writeAfter("Welcome to Rika", "\u000fnew\r"),
        Scene.action.writeAfter("Welcome to Rika", "\u000fnew\r"),
        Scene.action.writeAfter("Welcome to Rika", "\u001c"),
        Scene.action.writeAfter("New thread", "\u001c"),
        Scene.action.writeAfter("New thread", `${escape}[A\r${escape}[B\r`),
        Scene.action.resizeAfterDelay(40, 7, 500, `${escape}[A${escape}[B`),
        Scene.action.resizeAfterDelay(100, 30, 500, "\u001b\u001c\u001c\u0003"),
      ],
    }).then((result) => {
      expect(result.output.match(/New thread/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
      expect(result.actionsCompleted).toBe(7)
      expect(result.runningChecks).not.toContain(false)
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

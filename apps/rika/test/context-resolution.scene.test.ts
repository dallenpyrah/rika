import { expect, test } from "vitest"
import { Scene } from "./scene"

const completedScene = (
  prompt: string,
  options: {
    readonly files?: Readonly<Record<string, string>>
    readonly binaryFiles?: Readonly<Record<string, string>>
    readonly waitFor?: string
  } = {},
) =>
  Scene.run({
    files: [
      ...Object.entries(options.files ?? {}).map(([path, contents]) => ({
        path,
        bytes: new TextEncoder().encode(contents),
      })),
      ...Object.entries(options.binaryFiles ?? {}).map(([path, contents]) => ({
        path,
        bytes: Buffer.from(contents, "base64"),
      })),
    ],
    response: "CONTEXT_SCENE_COMPLETE",
    actions: [
      Scene.action.writeAfter("Welcome to Rika", `\u001b[200~${prompt}\u001b[201~\r`),
      ...(options.waitFor === undefined ? [] : [Scene.action.writeAfter(options.waitFor, "")]),
      Scene.action.writeAfter("CONTEXT_SCENE_COMPLETE", "\u0003", 1_000),
    ],
  })

test(
  "resolves scoped guidance and explicit file mentions through the real TUI",
  () =>
    completedScene("Inspect @file:pkg/src/main.ts", {
      files: {
        "AGENTS.md": "root guidance",
        "pkg/AGENT.md": "package guidance",
        "pkg/src/AGENTS.md": "source guidance",
        "pkg/src/main.ts": "export const value = 1",
      },
    }).then((result) => {
      expect(result.output).toContain("CONTEXT_SCENE_COMPLETE")
      expect(result.output).not.toContain("Context resolution")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "deduplicates repeated quoted mentions without a TUI diagnostic",
  () =>
    completedScene('Compare @file:"docs/read me.md" @file:"docs/read me.md"', {
      files: { "docs/read me.md": "reference data" },
    }).then((result) => {
      expect(result.output).toContain("CONTEXT_SCENE_COMPLETE")
      expect(result.output).not.toContain("Context resolution")
    }),
  45_000,
)

test(
  "shows a missing mentioned file diagnostic and still completes",
  () =>
    completedScene("Inspect @file:missing.ts", { waitFor: "Context resolution" }).then((result) => {
      expect(result.output).toContain("Context resolution")
      expect(result.output).toContain("Referenced file does not exist")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

test(
  "shows an unmatched guidance glob diagnostic and still completes",
  () =>
    completedScene("Inspect @guidance:missing/**/*.md", { waitFor: "Context resolution" }).then((result) => {
      expect(result.output).toContain("Context resolution")
      expect(result.output).toContain("Referenced path did not match a file")
    }),
  45_000,
)

test(
  "shows an outside-Workspace mention diagnostic without reading it",
  () =>
    completedScene("Inspect @file:../outside-secret.txt", { waitFor: "Context resolution" }).then((result) => {
      expect(result.output).toContain("Context resolution")
      expect(result.output).toContain("outside the Workspace")
      expect(result.output).not.toContain("outside secret contents")
    }),
  45_000,
)

test(
  "accepts typed image context with the scripted model and no provider",
  () =>
    completedScene("Describe @image:assets/pixel.png", {
      binaryFiles: { "assets/pixel.png": "iVBORw0KGgo=" },
    }).then((result) => {
      expect(result.output).toContain("CONTEXT_SCENE_COMPLETE")
      expect(result.output).not.toContain("Context resolution")
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  45_000,
)

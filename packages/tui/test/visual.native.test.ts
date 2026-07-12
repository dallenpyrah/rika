import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureVisuals, scenarios } from "./visual.capture"

const removedActivityLabels = [/rivet/i, /semantic[- ]search/i, /ast[- ]grep[- ]outline/i]

test("native character frames and deterministic screenshots match the frozen baseline", async () => {
  const actual = await mkdtemp(join(tmpdir(), "rika-visual-"))
  const approved = join(import.meta.dir, "fixtures", "visual")
  try {
    await captureVisuals(actual)
    const names = (await readdir(approved)).toSorted()
    expect((await readdir(actual)).toSorted()).toEqual(names)
    await Promise.all(
      names.map(async (name) =>
        expect(await readFile(join(actual, name))).toEqual(await readFile(join(approved, name))),
      ),
    )
    const frames = await Promise.all(
      names.filter((name) => name.endsWith(".frame.txt")).map((name) => readFile(join(actual, name), "utf8")),
    )
    for (const frame of frames)
      for (const removedActivity of removedActivityLabels) expect(frame).not.toMatch(removedActivity)
    expect(await readFile(join(actual, "tool.frame.txt"), "utf8")).toContain("⠿ Exploring 1 file ▸")
    const evidenceScenarios = [
      "markdown",
      "diff-complex",
      "tool-group-states",
      "queued-turn",
      "permission",
      "sidebar",
      "thread-switcher",
      "narrow-mode-overlay",
      "narrow-palette-overlay",
      "narrow-permission",
    ]
    for (const scenario of evidenceScenarios) {
      expect(names).toContain(`${scenario}.frame.txt`)
      expect(names).toContain(`${scenario}.styles.json`)
    }
    const styledMarkdown = await readFile(join(actual, "markdown.styles.json"), "utf8")
    expect(styledMarkdown).toContain('"attributes": 1')
    const colorScenarios = ["mode-picker", "permission", "diff-complex", "tool-group-states"]
    const colorStyles = await Promise.all(
      colorScenarios.map((scenario) => readFile(join(actual, `${scenario}.styles.json`), "utf8")),
    )
    for (const styles of colorStyles) {
      expect(new Set(styles.match(/"buffer": \{[^}]+\}/gs) ?? []).size).toBeGreaterThan(2)
    }
    expect(scenarios().map(([name]) => name)).not.toContain("semantic-search")
    expect(scenarios().map(([name]) => name)).not.toContain("ast-grep-outline")
  } finally {
    await rm(actual, { recursive: true, force: true })
  }
})

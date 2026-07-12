import { describe, expect, test } from "vitest"
import { renderMarkdown } from "../src/markdown-renderer"
import { renderDiff } from "../src/diff-renderer"
import { renderTool } from "../src/tool-renderer"

describe("transcript renderers", () => {
  test("renders terminal-safe Markdown structure", () => {
    expect(
      renderMarkdown(
        "# Heading\n\n- one\n  - two\n> quoted\n`code` and [docs](https://rika.dev)\n```ts\nconst x = 1\n```",
      ),
    ).toBe("Heading\n\n- one\n  - two\n    │ quoted\n    │ code and docs <https://rika.dev>\n    const x = 1")
  })

  test("parses hunk line numbers and clips source lines", () => {
    const rendered = renderDiff(
      "--- a/a.ts\n+++ b/a.ts\n@@ -10,2 +20,2 @@ name\n-old value that is long\n+new value that is long\n same",
      18,
    )
    expect(rendered).toContain("@@ -10,2 +20,2 @@…")
    expect(rendered).toContain("10    -old value …")
    expect(rendered).toContain("   20 +new value …")
    expect(rendered.split("\n").every((line) => line.length <= 18)).toBe(true)
  })

  test("labels status and bounds tool output", () => {
    const output = Array.from({ length: 15 }, (_, index) => `line ${index}`).join("\n")
    const rendered = renderTool({ name: "Shell", input: "run", output, status: "complete", expanded: true }, 20)
    expect(rendered).toContain("✓ Shell [succeeded] ▾")
    expect(rendered).toContain("… 3 lines omitted")
    expect(rendered).not.toContain("line 14")
  })
})

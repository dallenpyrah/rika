import { describe, expect, test } from "bun:test"
import { Config } from "@rika/core"
import { Effect, Layer } from "effect"
import { CheckRegistry } from "../src/index"

const workspaceRoot = "/repo"
const configLayer = Config.layerFromValues({
  workspace_root: workspaceRoot,
  data_dir: `${workspaceRoot}/.rika`,
  default_mode: "smart",
})

const files = new Map([
  [
    "/repo/.agents/checks/security.md",
    `---
name: security
description: Find security bugs
severity-default: high
tools: [Read, Grep]
---

Look for unsafe auth and secret handling.
`,
  ],
  [
    "/repo/packages/api/.agents/checks/security.md",
    `---
name: security
severity-default: critical
tools:
  - read
  - write
---

API-specific security invariants.
`,
  ],
  [
    "/repo/packages/api/.agents/checks/perf.md",
    `---
name: performance
severity-default: medium
---

Look for avoidable O(n^2) behavior.
`,
  ],
])

const fileSystem: CheckRegistry.FileSystemAdapter = {
  readDirectory: (path) =>
    Effect.succeed(
      [...files.keys()]
        .filter((file) => file.startsWith(`${path}/`))
        .filter((file) => file.slice(path.length + 1).split("/").length === 1)
        .map((file) => ({ name: file.split("/").at(-1) ?? file, path: file, type: "file" as const })),
    ),
  readFile: (path) => {
    const content = files.get(path)
    return content === undefined
      ? Effect.fail(new CheckRegistry.CheckRegistryError({ message: "not found", operation: "readFile", path }))
      : Effect.succeed(content)
  },
}

const layer = CheckRegistry.layerWithFileSystem(fileSystem).pipe(Layer.provideMerge(configLayer))

describe("CheckRegistry", () => {
  test("loads root checks with frontmatter defaults and read-only tool normalization", async () => {
    const checks = await Effect.runPromise(CheckRegistry.list().pipe(Effect.provide(layer)))

    expect(checks.map((check) => check.summary)).toEqual([
      {
        name: "security",
        description: "Find security bugs",
        severity_default: "high",
        tools: ["ffgrep", "read"],
        source_path: ".agents/checks/security.md",
        scope_path: "",
        applies_to: [],
      },
    ])
  })

  test("applies nearest scoped checks and keeps same-named parent checks for other paths", async () => {
    const checks = await Effect.runPromise(
      CheckRegistry.checksForFiles({ paths: ["packages/api/src/server.ts", "packages/web/src/app.ts"] }).pipe(
        Effect.provide(layer),
      ),
    )

    expect(checks.map((check) => check.summary)).toEqual([
      {
        name: "security",
        description: "Find security bugs",
        severity_default: "high",
        tools: ["ffgrep", "read"],
        source_path: ".agents/checks/security.md",
        scope_path: "",
        applies_to: ["packages/web/src/app.ts"],
      },
      {
        name: "performance",
        severity_default: "medium",
        tools: ["ast_grep_outline", "ffgrep", "read", "semantic_search"],
        source_path: "packages/api/.agents/checks/perf.md",
        scope_path: "packages/api",
        applies_to: ["packages/api/src/server.ts"],
      },
      {
        name: "security",
        severity_default: "critical",
        tools: ["read"],
        source_path: "packages/api/.agents/checks/security.md",
        scope_path: "packages/api",
        applies_to: ["packages/api/src/server.ts"],
      },
    ])
  })
})

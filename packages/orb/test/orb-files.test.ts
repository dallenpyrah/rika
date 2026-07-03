import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Exit } from "effect"
import { OrbFiles } from "../src/index"

describe("OrbFiles", () => {
  test("lists workspace entries without exposing internal runtime files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rika-orb-files-list-"))

    try {
      await mkdir(join(workspace, "src"), { recursive: true })
      await mkdir(join(workspace, ".rika"), { recursive: true })
      await writeFile(join(workspace, "README.md"), "hello\n")
      await writeFile(join(workspace, "src", "index.ts"), "export const value = 1\n")
      await writeFile(join(workspace, ".rika", "runtime.db"), "internal\n")
      await symlink(join(workspace, ".rika", "runtime.db"), join(workspace, "src", "runtime-link"))

      const root = await Effect.runPromise(
        OrbFiles.list({ workspace_root: workspace, path: "" }).pipe(Effect.provide(OrbFiles.layer)),
      )
      const src = await Effect.runPromise(
        OrbFiles.list({ workspace_root: workspace, path: "src" }).pipe(Effect.provide(OrbFiles.layer)),
      )

      expect(root).toEqual({
        path: "",
        entries: [
          { name: "src", path: "src", kind: "dir" },
          { name: "README.md", path: "README.md", kind: "file", size: 6 },
        ],
      })
      expect(src).toEqual({
        path: "src",
        entries: [{ name: "index.ts", path: "src/index.ts", kind: "file", size: 23 }],
      })
    } finally {
      await rm(workspace, { force: true, recursive: true })
    }
  })

  test("reads text, truncated text, and binary files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rika-orb-files-read-"))

    try {
      await writeFile(join(workspace, "README.md"), "hello\n")
      await writeFile(join(workspace, "large.txt"), `${"x".repeat(1_048_576)}tail`)
      await writeFile(join(workspace, "image.bin"), new Uint8Array([0, 1, 2, 3, 255]))

      const text = await Effect.runPromise(
        OrbFiles.read({ workspace_root: workspace, path: "README.md" }).pipe(Effect.provide(OrbFiles.layer)),
      )
      const large = await Effect.runPromise(
        OrbFiles.read({ workspace_root: workspace, path: "large.txt" }).pipe(Effect.provide(OrbFiles.layer)),
      )
      const binary = await Effect.runPromise(
        OrbFiles.read({ workspace_root: workspace, path: "image.bin" }).pipe(Effect.provide(OrbFiles.layer)),
      )

      expect(text).toEqual({ path: "README.md", kind: "text", content: "hello\n", truncated: false })
      expect(large).toEqual({
        path: "large.txt",
        kind: "text",
        content: "x".repeat(1_048_576),
        truncated: true,
      })
      expect(binary).toEqual({ path: "image.bin", kind: "binary", binary: true })
    } finally {
      await rm(workspace, { force: true, recursive: true })
    }
  })

  test("rejects traversal, absolute paths, and symlinks outside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rika-orb-files-contained-"))
    const outside = await mkdtemp(join(tmpdir(), "rika-orb-files-outside-"))

    try {
      await mkdir(join(workspace, ".rika"), { recursive: true })
      await writeFile(join(workspace, ".rika", "runtime.db"), "internal\n")
      await writeFile(join(outside, "secret.txt"), "secret\n")
      await symlink(join(outside, "secret.txt"), join(workspace, "secret-link.txt"))
      await symlink(join(workspace, ".rika", "runtime.db"), join(workspace, "runtime-link.txt"))

      const traversal = await Effect.runPromiseExit(
        OrbFiles.read({ workspace_root: workspace, path: "../secret.txt" }).pipe(Effect.provide(OrbFiles.layer)),
      )
      const absolute = await Effect.runPromiseExit(
        OrbFiles.read({ workspace_root: workspace, path: join(outside, "secret.txt") }).pipe(
          Effect.provide(OrbFiles.layer),
        ),
      )
      const link = await Effect.runPromiseExit(
        OrbFiles.read({ workspace_root: workspace, path: "secret-link.txt" }).pipe(Effect.provide(OrbFiles.layer)),
      )
      const internalLink = await Effect.runPromiseExit(
        OrbFiles.read({ workspace_root: workspace, path: "runtime-link.txt" }).pipe(Effect.provide(OrbFiles.layer)),
      )

      expect(errorKind(traversal)).toBe("invalid_path")
      expect(errorKind(absolute)).toBe("invalid_path")
      expect(errorKind(link)).toBe("invalid_path")
      expect(errorKind(internalLink)).toBe("invalid_path")
    } finally {
      await rm(workspace, { force: true, recursive: true })
      await rm(outside, { force: true, recursive: true })
    }
  })
})

const errorKind = (exit: Exit.Exit<unknown, OrbFiles.OrbFilesError>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected failure")
  const failure = Cause.findErrorOption(exit.cause)
  if (failure._tag === "None") throw new Error("expected typed failure")
  return failure.value.kind
}

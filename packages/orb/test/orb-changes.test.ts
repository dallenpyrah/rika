import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { OrbChanges } from "../src/index"

describe("OrbChanges", () => {
  test("collects tracked, untracked, and binary workspace changes from the base commit", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rika-orb-changes-"))

    try {
      await runGit(workspace, ["init", "-b", "main"])
      await runGit(workspace, ["config", "user.email", "rika@example.test"])
      await runGit(workspace, ["config", "user.name", "Rika Test"])
      await writeFile(join(workspace, "README.md"), "before\n")
      await runGit(workspace, ["add", "README.md"])
      await runGit(workspace, ["commit", "-m", "init"])
      const baseCommit = (await runGit(workspace, ["rev-parse", "HEAD"])).trim()

      await writeFile(join(workspace, "README.md"), "after\n")
      await writeFile(join(workspace, "new.txt"), "untracked\n")
      await writeFile(join(workspace, "image.bin"), new Uint8Array([0, 1, 2, 3, 255]))
      await mkdir(join(workspace, ".rika"), { recursive: true })
      await writeFile(join(workspace, ".rika", "runtime.db"), "internal\n")

      const changes = await Effect.runPromise(
        OrbChanges.changes({
          workspace_root: workspace,
          base_commit: baseCommit,
        }).pipe(Effect.provide(OrbChanges.layer)),
      )

      expect(changes.base_commit).toBe(baseCommit)
      expect(changes.head_commit).toBe(baseCommit)
      expect(changes.dirty).toBe(true)
      expect(changes.diff).toContain("diff --git a/README.md b/README.md")
      expect(changes.diff).toContain("+after")
      expect(changes.diff).toContain("diff --git a/new.txt b/new.txt")
      expect(changes.diff).toContain("+untracked")
      expect(changes.diff).toContain("diff --git a/image.bin b/image.bin")
      expect(changes.diff).toContain("GIT binary patch")
      expect(changes.diff).not.toContain(".rika")
    } finally {
      await rm(workspace, { force: true, recursive: true })
    }
  })

  test("ignores internal .rika files when deciding dirty state", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rika-orb-changes-clean-"))

    try {
      await runGit(workspace, ["init", "-b", "main"])
      await runGit(workspace, ["config", "user.email", "rika@example.test"])
      await runGit(workspace, ["config", "user.name", "Rika Test"])
      await writeFile(join(workspace, "README.md"), "before\n")
      await runGit(workspace, ["add", "README.md"])
      await runGit(workspace, ["commit", "-m", "init"])
      const baseCommit = (await runGit(workspace, ["rev-parse", "HEAD"])).trim()
      await mkdir(join(workspace, ".rika"), { recursive: true })
      await writeFile(join(workspace, ".rika", "runtime.db"), "internal\n")

      const changes = await Effect.runPromise(
        OrbChanges.changes({
          workspace_root: workspace,
          base_commit: baseCommit,
        }).pipe(Effect.provide(OrbChanges.layer)),
      )

      expect(changes.diff).toBe("")
      expect(changes.dirty).toBe(false)
    } finally {
      await rm(workspace, { force: true, recursive: true })
    }
  })
})

const runGit = async (cwd: string, args: ReadonlyArray<string>) => {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
  return stdout
}

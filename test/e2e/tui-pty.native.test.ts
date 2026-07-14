import { describe, expect, test } from "bun:test"
import { binary, run, sandbox } from "./process"

const helper = new URL("native-pty.py", import.meta.url).pathname

describe("packaged TUI in a native PTY", () => {
  test("starts idle without replaying durable history or invoking the configured test model", async () => {
    const context = await sandbox()
    try {
      expect((await run(context, ["run", "historical prompt"])).stdout).toContain("deterministic response")
      const env = { ...context.env, TERM: "xterm-256color", COLORTERM: "truecolor" }
      const process = Bun.spawn(["python3", helper, binary, context.workspace, JSON.stringify(env), "idle"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ])
      expect(exitCode, stderr).toBe(0)
      const result = JSON.parse(stdout) as { capture: string; submitted: boolean }
      const capture = Buffer.from(result.capture, "base64").toString("utf8")
      expect(result.submitted).toBe(false)
      expect(capture).toContain("Welcome to Rika")
      expect(capture).not.toContain("historical prompt")
      expect(capture).not.toContain("deterministic response")
      expect(capture).not.toContain("Execution failed")
    } finally {
      await context.dispose()
    }
  }, 20_000)

  test("collapses bracketed multiline paste, submits it, and restores terminal state after SIGINT", async () => {
    const context = await sandbox()
    try {
      const env = { ...context.env, TERM: "xterm-256color", COLORTERM: "truecolor" }
      const process = Bun.spawn(["python3", helper, binary, context.workspace, JSON.stringify(env)], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const timeout = setTimeout(() => process.kill("SIGKILL"), 20_000)
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ])
      clearTimeout(timeout)
      expect(exitCode, stderr).toBe(0)
      const result = JSON.parse(stdout) as {
        capture: string
        pasteCollapsed: boolean
        submitted: boolean
        exited: boolean
        termiosRestored: boolean
      }
      const capture = Buffer.from(result.capture, "base64").toString("utf8")
      expect(result.pasteCollapsed).toBe(true)
      expect(result.submitted).toBe(true)
      expect(capture).toContain("Welcome to Rika")
      expect(capture).toContain("[Pasted text #1 +2 lines]")
      expect(capture).toContain("deterministic response")
      expect(capture).not.toContain("ExecutionBackendError")
      expect(capture).not.toContain("Execution failed")
      expect(capture).not.toContain("requires Crypto")
      expect(result.exited).toBe(true)
      expect(result.termiosRestored).toBe(true)
      for (const sequence of ["\u001b[?1049h", "\u001b[?25l", "\u001b[?2004h", "\u001b[?1000h"])
        expect(capture).toContain(sequence)
    } finally {
      await context.dispose()
    }
  }, 25_000)
})

import { describe, expect, test } from "vitest"
import { Effect, Schema } from "effect"
import { runCommand, runTest, sandbox } from "./process"

const helper = new URL("tui-pty.py", import.meta.url).pathname
const ResultJson = Schema.fromJsonString(
  Schema.Struct({
    capture: Schema.String,
    exitCode: Schema.NullOr(Schema.Int),
    paletteVisible: Schema.Boolean,
    quitSelected: Schema.Boolean,
    suspended: Schema.Boolean,
    continued: Schema.Boolean,
    editorActive: Schema.Boolean,
    editorJobControl: Schema.Boolean,
    prematureEditorResume: Schema.Boolean,
    editedDraftVisible: Schema.Boolean,
    fallbackSignalUsed: Schema.Boolean,
    termiosRestored: Schema.Boolean,
  }),
)

describe("packaged terminal lifecycle", () => {
  const runPty = (context: Effect.Effect.Success<typeof sandbox>, mode: "editor" | "suspend") =>
    runCommand(
      context,
      "python3",
      [
        helper,
        context.binary,
        context.workspace,
        Schema.encodeSync(Schema.UnknownFromJsonString)({
          ...context.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        }),
        mode,
      ],
      { timeout: 20_000 },
    )

  test(
    "suspends outside alternate screen, resumes the same interactive view, and tears down normally",
    () =>
      runTest(
        Effect.acquireUseRelease(
          sandbox,
          (context) =>
            Effect.gen(function* () {
              const process = yield* runPty(context, "suspend")
              const result = Schema.decodeUnknownSync(ResultJson)(process.stdout)
              const capture = Buffer.from(result.capture, "base64").toString("utf8")

              expect(result.suspended, `${process.stderr}\n${capture}`).toBe(true)
              expect(result.continued).toBe(true)
              expect(result.paletteVisible).toBe(true)
              expect(result.quitSelected).toBe(true)
              expect(result.fallbackSignalUsed).toBe(false)
              expect(result.exitCode).toBe(0)
              expect(result.termiosRestored).toBe(true)
              expect(capture.match(/\u001b\[\?1049h/g)?.length).toBeGreaterThanOrEqual(2)
              expect(capture.match(/\u001b\[\?1049l/g)?.length).toBeGreaterThanOrEqual(2)
              expect(capture.slice(capture.lastIndexOf("\u001b[?1049h"))).toContain("suspension draft")
            }),
          (context) => context.dispose,
        ),
      ),
    25_000,
  )

  test(
    "gives an external editor the restored terminal and resumes with the edited composer",
    () =>
      runTest(
        Effect.acquireUseRelease(
          sandbox,
          (context) =>
            Effect.gen(function* () {
              const process = yield* runPty(context, "editor")
              const result = Schema.decodeUnknownSync(ResultJson)(process.stdout)
              const capture = Buffer.from(result.capture, "base64").toString("utf8")
              const editor = capture.indexOf("EDITOR_TERMINAL_ACTIVE")
              const editorDone = capture.indexOf("EDITOR_TERMINAL_DONE")
              const release = capture.lastIndexOf("\u001b[?1049l", editor)
              const resume = capture.indexOf("\u001b[?1049h", editor)

              expect(result.editorActive, `${process.stderr}\n${capture}`).toBe(true)
              expect(result.editorJobControl).toBe(true)
              expect(result.prematureEditorResume).toBe(false)
              expect(result.editedDraftVisible).toBe(true)
              expect(result.paletteVisible).toBe(true)
              expect(result.fallbackSignalUsed).toBe(false)
              expect(result.exitCode).toBe(0)
              expect(result.termiosRestored).toBe(true)
              expect(release).toBeGreaterThanOrEqual(0)
              expect(editorDone).toBeGreaterThan(editor)
              expect(resume).toBeGreaterThan(editorDone)
            }),
          (context) => context.dispose,
        ),
      ),
    25_000,
  )
})

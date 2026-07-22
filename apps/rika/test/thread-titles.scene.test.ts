import { expect, test } from "vitest"
import { Scene } from "./scene"

const longTitle = `### "${"Concurrent Sanitized Title ".repeat(5)}"\nignored`
const sanitizedTitle = [..."Concurrent Sanitized Title ".repeat(5).trim()].slice(0, 80).join("")

test("sets the prompt-derived terminal title before the first assistant response", () => {
  const prompt = "Update the terminal title immediately"
  const terminalTitle = `\u001b]0;${prompt} - rika - `
  const script = [Scene.model.text("ASSISTANT_RETURNED", 3_000), Scene.model.text("Delayed Generated Title")] as const
  return Scene.run({
    script,
    actions: [
      Scene.action.writeAfter("Welcome to Rika", `${prompt}\r`),
      Scene.action.checkRunningAfter(terminalTitle, ""),
      Scene.action.writeAfter("ASSISTANT_RETURNED", "\u0003", 500),
    ],
  }).then((result) => {
    expect(result.runningChecks).toEqual([true])
    expect(result.rawOutput.indexOf(terminalTitle)).toBeGreaterThanOrEqual(0)
    expect(result.rawOutput.indexOf(terminalTitle)).toBeLessThan(result.rawOutput.indexOf("ASSISTANT_RETURNED"))
  })
}, 40_000)

test("titles the first Turn of an explicitly created Thread in the real TUI", () => {
  const generatedTitle = "Focused Thread Titles"
  const script = [Scene.model.text("FIRST_TURN_DONE"), Scene.model.text(generatedTitle)] as const
  return Scene.run({
    script,
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "\u000f"),
      Scene.action.writeAfter("New thread", "\r"),
      Scene.action.writeAfterDelay("Build automatic thread titles.\r", 500),
      Scene.action.writeAfter("FIRST_TURN_DONE", "\u0014", 500),
      Scene.action.writeAfter(generatedTitle, "\u0003"),
    ],
  }).then((result) => {
    expect(result.output).toContain(generatedTitle)
    expect(result.rawOutput).toContain(`\u001b]0;${generatedTitle} - rika - `)
    expect(result.diagnostics).not.toContain("provider.request.started")
  })
}, 40_000)

test("applies an existing Thread title after selecting it", () => {
  const generatedTitle = "Existing Thread Title"
  const existingTitle = `\u001b]0;${generatedTitle} - rika - `
  const newThreadTitle = "\u001b]0;New thread - rika - "
  const script = [Scene.model.text("EXISTING_THREAD_READY"), Scene.model.text(generatedTitle)] as const
  return Scene.run({
    script,
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "Create the existing Thread.\r"),
      Scene.action.writeAfter(generatedTitle, "\u000f"),
      Scene.action.writeAfter("New thread", "\r"),
      Scene.action.writeAfter("Welcome to Rika", "\u0014\u001b[B\r", 100),
      Scene.action.writeAfter("Loading Thread", "\u0003", 300),
    ],
  }).then((result) => {
    expect(result.rawOutput.split(existingTitle)).toHaveLength(3)
    expect(result.rawOutput.lastIndexOf(existingTitle)).toBeGreaterThan(result.rawOutput.indexOf(newThreadTitle))
    expect(result.diagnostics).not.toContain("provider.request.started")
  })
}, 40_000)

test("keeps a delayed background title from replacing the selected terminal title", () => {
  const backgroundPrompt = "Investigate concurrent title delivery."
  const generatedTitle = "Concurrent Sanitized Title"
  const script = [Scene.model.text("SWITCH_READY"), Scene.model.text(generatedTitle, 700)] as const
  return Scene.run({
    script,
    actions: [
      Scene.action.writeAfter("Welcome to Rika", `${backgroundPrompt}\r`),
      Scene.action.writeAfter("SWITCH_READY", "\u000f"),
      Scene.action.writeAfter("New thread", "\r"),
      Scene.action.writeAfterDelay("\u0014", 1_000),
      Scene.action.writeAfter("Thread Preview", "\u001b\u0003", 500),
    ],
  }).then((result) => {
    const newThreadTitle = "\u001b]0;New thread - rika - "
    const backgroundTitle = `\u001b]0;${generatedTitle} - rika - `
    expect(result.rawOutput).toContain(newThreadTitle)
    expect(result.rawOutput).not.toContain(backgroundTitle)
    expect(result.diagnostics).not.toContain("provider.request.started")
  })
}, 40_000)

test("sanitizes and bounds a generated title", () => {
  const script = [Scene.model.text("LONG_TITLE_READY"), Scene.model.text(longTitle)] as const
  return Scene.run({
    script,
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "Bound the generated title.\r"),
      Scene.action.writeAfter("LONG_TITLE_READY", "\u0003", 500),
    ],
  }).then((result) => {
    expect(sanitizedTitle).toHaveLength(80)
    expect(result.output).toContain("Concurrent Sanitized Title")
    expect(result.output).not.toContain("ignored")
    expect(result.diagnostics).not.toContain("provider.request.started")
  })
}, 40_000)

test("keeps the first-prompt title when the scripted title response sanitizes to empty", () => {
  const script = [Scene.model.text("EMPTY_TITLE_READY"), Scene.model.text('### ""\nignored')] as const
  return Scene.run({
    script,
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "Keep This Temporary Title\r"),
      Scene.action.writeAfter("EMPTY_TITLE_READY", "\u0003", 500),
    ],
  }).then((result) => {
    expect(result.output).toContain("Keep This Temporary Title")
    expect(result.output).not.toContain("ignored")
    expect(result.diagnostics).not.toContain("provider.request.started")
  })
}, 40_000)

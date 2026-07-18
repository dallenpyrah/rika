import { expect, test } from "vitest"
import { Scene } from "./scene"

const bracketedPaste = (text: string) => `\u001b[200~${text}\u001b[201~`

test.each([
  ["short single line", "ordinary paste", "ordinary paste"],
  ["exactly 120 ASCII characters", "a".repeat(120), "a".repeat(32)],
  ["exactly 120 Unicode characters", "😀".repeat(120), "😀".repeat(16)],
  ["121 characters", "b".repeat(121), "[Pasted text #1]"],
  ["line feed", "alpha\nbeta", "[Pasted text #1 +2 lines]"],
  ["carriage return", "alpha\rbeta", "[Pasted text #1 +2 lines]"],
  ["CRLF", "alpha\r\nbeta", "[Pasted text #1 +2 lines]"],
])(
  "preserves a %s paste through the real TUI and durable turn",
  (_name, paste, display) =>
    Scene.run({
      script: [Scene.model.text("PASTE_CASE_COMPLETE")],
      actions: [
        Scene.action.writeAfter("Welcome to Rika", bracketedPaste(paste)),
        Scene.action.writeAfter(display, "\r"),
        Scene.action.writeAfter("PASTE_CASE_COMPLETE", "\u0003", 100),
      ],
    }).then((result) => {
      expect(result.persistedTurns).toEqual([
        { prompt: paste, prompt_parts_json: JSON.stringify([{ type: "text", text: paste }]) },
      ])
      expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
    }),
  40_000,
)

test("expands multiple pasted tokens at their exact surrounding positions", () => {
  const first = "first\n第一😀"
  const second = "second\r\nδεύτερο"
  const prompt = `before ${first} between ${second} after`
  return Scene.run({
    script: [Scene.model.text("ORDER_COMPLETE")],
    actions: [
      Scene.action.writeAfter("Welcome to Rika", "before "),
      Scene.action.writeAfter("before ", bracketedPaste(first)),
      Scene.action.writeAfter("[Pasted text #1 +2 lines]", " between "),
      Scene.action.writeAfter(" between ", bracketedPaste(second)),
      Scene.action.writeAfter("[Pasted text #2 +2 lines]", " after\r"),
      Scene.action.writeAfter("ORDER_COMPLETE", "\u0003", 100),
    ],
  }).then((result) => {
    expect(result.persistedTurns.map((turn) => turn.prompt)).toEqual([prompt])
    expect(result.persistedTurns.map((turn) => turn.prompt_parts_json)).toEqual([
      JSON.stringify([{ type: "text", text: prompt }]),
    ])
  })
}, 40_000)

test("deletes one token without deleting or aliasing later pasted text", () => {
  const deleted = "delete\nthis"
  const kept = "keep\nthis"
  const added = "add\nthis"
  const prompt = ` ${added}${kept}`
  return Scene.run({
    script: [Scene.model.text("DELETION_COMPLETE")],
    actions: [
      Scene.action.writeAfter("Welcome to Rika", bracketedPaste(deleted)),
      Scene.action.writeAfter("[Pasted text #1 +2 lines]", bracketedPaste(kept)),
      Scene.action.writeAfter("[Pasted text #2 +2 lines]", "\u001b[D\u007f"),
      Scene.action.writeAfter("[Pasted text #2 +2 lines]", " "),
      Scene.action.writeAfter("[Pasted text #2 +2 lines]", bracketedPaste(added)),
      Scene.action.writeAfter("[Pasted text #2 +2 lines]", "\r", 100),
      Scene.action.writeAfter("DELETION_COMPLETE", "\u0003", 100),
    ],
  }).then((result) => {
    expect(result.persistedTurns.map((turn) => turn.prompt)).toEqual([prompt])
    expect(result.persistedTurns.map((turn) => turn.prompt_parts_json)).toEqual([
      JSON.stringify([{ type: "text", text: prompt }]),
    ])
  })
}, 40_000)

test("opens a collapsed token for editing and persists only the edited expansion", () => {
  const original = "editable\ntext"
  const edited = "editable\ntex!"
  return Scene.run({
    script: [Scene.model.text("EDIT_COMPLETE")],
    actions: [
      Scene.action.writeAfter("Welcome to Rika", bracketedPaste(original)),
      Scene.action.writeAfter("[Pasted text #1 +2 lines]", bracketedPaste(original)),
      Scene.action.writeAfter("editable", "\u007f!\r"),
      Scene.action.writeAfter("EDIT_COMPLETE", "\u0003", 100),
    ],
  }).then((result) => {
    expect(result.persistedTurns.map((turn) => turn.prompt)).toEqual([edited])
    expect(result.persistedTurns.map((turn) => turn.prompt_parts_json)).toEqual([
      JSON.stringify([{ type: "text", text: edited }]),
    ])
  })
}, 40_000)

test("replays a submitted paste as a token and persists the exact expansion again", () => {
  const paste = "durable\r\n履歴😀"
  return Scene.run({
    script: [Scene.model.text("FIRST_COMPLETE"), Scene.model.text("Pasted text replay"), Scene.model.text("REPLAY_COMPLETE")],
    actions: [
      Scene.action.writeAfter("Welcome to Rika", bracketedPaste(paste)),
      Scene.action.writeAfter("[Pasted text #1 +2 lines]", "\r"),
      Scene.action.writeAfter("FIRST_COMPLETE", "\u001b[A"),
      Scene.action.writeAfter("[Pasted text #1 +2 lines]", "\r"),
      Scene.action.writeAfter("REPLAY_COMPLETE", "\u0003", 100),
    ],
  }).then((result) => {
    expect(result.persistedTurns.map((turn) => turn.prompt)).toEqual([paste, paste])
    expect(result.persistedTurns.map((turn) => turn.prompt_parts_json)).toEqual([
      JSON.stringify([{ type: "text", text: paste }]),
      JSON.stringify([{ type: "text", text: paste }]),
    ])
    expect(result.diagnostics).not.toContain('"rika.model.backend.kind":"provider"')
  })
}, 40_000)

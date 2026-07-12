import { expect, test } from "bun:test"
import { Effect } from "effect"
import { buildTestModelScript, parseTestModelScript } from "../src/main"

test("parses and builds multi-part delayed TestModel turns", async () => {
  const json = JSON.stringify([
    {
      parts: [
        { type: "reasoning", text: "inspect" },
        { type: "toolCall", name: "read_file", params: { path: "a.txt" }, id: "read-1" },
      ],
      delayMs: 25,
    },
    { parts: [{ type: "text", text: "done" }] },
  ])
  const parsed = await Effect.runPromise(parseTestModelScript(json))
  expect(parsed).toHaveLength(2)
  const built = await Effect.runPromise(buildTestModelScript(json))
  expect(built).toEqual([
    {
      _tag: "Turn",
      parts: [
        { _tag: "Reasoning", text: "inspect" },
        { _tag: "ToolCall", name: "read_file", params: { path: "a.txt" }, id: "read-1", providerExecuted: false },
      ],
      delay: 25,
    },
    { _tag: "Turn", parts: [{ _tag: "Text", text: "done" }] },
  ])
})

test("rejects malformed, empty, and unsafe scripts", async () => {
  await Promise.all(
    [
      "not json",
      "[]",
      '[{"parts":[]}]',
      '[{"parts":[{"type":"toolCall","name":4}]}]',
      '[{"parts":[{"type":"text","text":"x"}],"delayMs":-1}]',
    ].map((value) => expect(Effect.runPromise(parseTestModelScript(value))).rejects.toBeDefined()),
  )
})

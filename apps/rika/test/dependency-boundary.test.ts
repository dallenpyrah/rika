import { expect, it } from "vitest"

it("loads app and command entrypoints without Bun-only composition", async () => {
  const [app, command] = await Promise.all([import("@rika/app"), import("../src/command")])

  expect(app.Operation.Service).toBeDefined()
  expect(command.command).toBeDefined()
})

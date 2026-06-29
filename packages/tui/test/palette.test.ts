import { describe, expect, test } from "bun:test"
import { Keys, Palette } from "../src/index"

describe("palette.filter", () => {
  test("returns every command for an empty query", () => {
    expect(Palette.filter("")).toEqual(Palette.commands)
  })

  test("narrows by id, title, and hint, ignoring a leading slash", () => {
    expect(Palette.filter("/mode").map((command) => command.id)).toEqual(["mode"])
    expect(Palette.filter("archive").map((command) => command.id)).toEqual(["archive", "unarchive"])
    expect(Palette.filter("review").map((command) => command.id)).toContain("review")
    expect(Palette.filter("agent mode").map((command) => command.id)).toEqual(["mode"])
  })

  test("at clamps the selected index into range", () => {
    expect(Palette.at("/mode", 0)?.id).toBe("mode")
    expect(Palette.at("/mode", 99)?.id).toBe("mode")
    expect(Palette.at("definitely-not-a-command", 0)).toBeUndefined()
  })
})

describe("keys", () => {
  test("fromOpenTui treats meta or option as alt", () => {
    expect(Keys.fromOpenTui({ name: "t", option: true, sequence: "t" }).alt).toBe(true)
    expect(Keys.fromOpenTui({ name: "t", meta: true, sequence: "t" }).alt).toBe(true)
    expect(Keys.fromOpenTui({ name: "t", sequence: "t" }).alt).toBe(false)
  })

  test("isPrintable rejects control and alt combinations", () => {
    expect(Keys.isPrintable(Keys.make({ name: "a", sequence: "a" }))).toBe(true)
    expect(Keys.isPrintable(Keys.make({ name: "space", sequence: " " }))).toBe(true)
    expect(Keys.isPrintable(Keys.ctrl("a"))).toBe(false)
    expect(Keys.isPrintable(Keys.alt("a"))).toBe(false)
    expect(Keys.isPrintable(Keys.make({ name: "return", sequence: "\r" }))).toBe(false)
  })
})

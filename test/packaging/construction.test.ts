import { describe, expect, test } from "bun:test"
import { targets } from "../../scripts/package"

describe("release target construction", () => {
  test("constructs the four supported OpenTUI platform mappings", () => {
    expect(Object.keys(targets)).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"])
    for (const [name, target] of Object.entries(targets)) {
      expect(target.bun).toBe(`bun-${name}`)
      expect(target.opentui).toBe(`@opentui/core-${name}`)
    }
  })

  test("does not claim Windows archive support", () => {
    expect(Object.keys(targets).some((target) => target.startsWith("win32-"))).toBe(false)
  })
})

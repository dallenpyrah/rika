import { describe, expect, test } from "vitest"
import {
  advanceWindow,
  anchorOf,
  atBottom,
  atWindowBottom,
  atWindowTop,
  clampScrollTop,
  clampWindow,
  contentChanged,
  detach,
  follow,
  following,
  initialWindow,
  isAnchored,
  isFollowing,
  maxScrollTop,
  reanchor,
  resized,
  settle,
  toggled,
  windowStart,
  type ViewportAnchor,
} from "../src/transcript-viewport"

const anchor = (unitId: string, offset: number): ViewportAnchor => ({ unitId, offset })
const metrics = (scrollTop: number, scrollHeight: number, viewportHeight: number) => ({
  scrollTop,
  scrollHeight,
  viewportHeight,
})

describe("transcript viewport follow/anchor state", () => {
  test("starts following", () => {
    expect(isFollowing(following)).toBe(true)
    expect(isAnchored(following)).toBe(false)
    expect(anchorOf(following)).toBeUndefined()
  })

  test("wheel up detaches and holds the captured anchor", () => {
    const state = detach(anchor("unit-a", 4))
    expect(isAnchored(state)).toBe(true)
    expect(anchorOf(state)).toEqual({ unitId: "unit-a", offset: 4 })
  })

  test("follow re-pins", () => {
    const state = follow()
    expect(isFollowing(state)).toBe(true)
  })

  test("toggle anchors on the toggled row", () => {
    const state = toggled(anchor("tool-x", 0))
    expect(anchorOf(state)).toEqual({ unitId: "tool-x", offset: 0 })
  })

  test("content change keeps the anchor while detached", () => {
    const state = detach(anchor("unit-a", 2))
    expect(contentChanged(state)).toBe(state)
    expect(anchorOf(contentChanged(state))).toEqual({ unitId: "unit-a", offset: 2 })
  })

  test("content change keeps following while following", () => {
    expect(isFollowing(contentChanged(following))).toBe(true)
  })

  test("resize keeps the anchor", () => {
    const state = detach(anchor("unit-a", 7))
    expect(anchorOf(resized(state))).toEqual({ unitId: "unit-a", offset: 7 })
  })

  test("reanchor updates the anchor only while detached", () => {
    const detached = detach(anchor("unit-a", 1))
    expect(anchorOf(reanchor(detached, anchor("unit-b", 9)))).toEqual({ unitId: "unit-b", offset: 9 })
    expect(isFollowing(reanchor(following, anchor("unit-b", 9)))).toBe(true)
  })
})

describe("transcript viewport bottom detection", () => {
  test("max scroll top never goes negative", () => {
    expect(maxScrollTop(metrics(0, 10, 30))).toBe(0)
    expect(maxScrollTop(metrics(0, 100, 30))).toBe(70)
  })

  test("at bottom requires the exact maximum, no off-by-one fuzz", () => {
    expect(atBottom(metrics(70, 100, 30))).toBe(true)
    expect(atBottom(metrics(69, 100, 30))).toBe(false)
    expect(atBottom(metrics(71, 100, 30))).toBe(true)
  })

  test("settle re-follows only at the true bottom", () => {
    expect(isFollowing(settle(metrics(70, 100, 30), anchor("u", 0)))).toBe(true)
    const parked = settle(metrics(69, 100, 30), anchor("u", 3))
    expect(isAnchored(parked)).toBe(true)
    expect(anchorOf(parked)).toEqual({ unitId: "u", offset: 3 })
  })

  test("clamps scroll top to live geometry", () => {
    expect(clampScrollTop(200, metrics(0, 100, 30))).toBe(70)
    expect(clampScrollTop(-5, metrics(0, 100, 30))).toBe(0)
    expect(clampScrollTop(50, metrics(0, 100, 30))).toBe(50)
  })

  test("shrink clamps a stale offset down to the new maximum", () => {
    const parkedOffset = 90
    const afterShrink = metrics(parkedOffset, 60, 30)
    expect(clampScrollTop(parkedOffset, afterShrink)).toBe(30)
  })
})

describe("transcript viewport window", () => {
  const limit = 200

  test("initial window mounts everything", () => {
    expect(initialWindow(500)).toEqual({ end: 500 })
    expect(initialWindow(-3)).toEqual({ end: 0 })
  })

  test("window start floors at zero", () => {
    expect(windowStart({ end: 500 }, limit)).toBe(300)
    expect(windowStart({ end: 100 }, limit)).toBe(0)
  })

  test("retreat toward older content stops at the top", () => {
    const retreated = advanceWindow({ end: 500 }, -100, 500, limit)
    expect(retreated.end).toBe(400)
    const atTopWindow = advanceWindow({ end: 300 }, -1000, 500, limit)
    expect(atTopWindow.end).toBe(limit)
    expect(atWindowTop(atTopWindow, limit)).toBe(true)
  })

  test("advance toward newer content stops at the bottom", () => {
    const advanced = advanceWindow({ end: 300 }, 100, 500, limit)
    expect(advanced.end).toBe(400)
    const atBottomWindow = advanceWindow({ end: 400 }, 1000, 500, limit)
    expect(atBottomWindow.end).toBe(500)
    expect(atWindowBottom(atBottomWindow, 500)).toBe(true)
  })

  test("clampWindow snaps to the newest units while following", () => {
    expect(clampWindow({ end: 300 }, 500, limit, true)).toEqual({ end: 500 })
    expect(clampWindow({ end: 0 }, 500, limit, false)).toEqual({ end: 500 })
  })

  test("clampWindow keeps a detached window within bounds when content shrinks", () => {
    expect(clampWindow({ end: 500 }, 320, limit, false)).toEqual({ end: 320 })
    expect(clampWindow({ end: 500 }, 500, limit, false)).toEqual({ end: 500 })
  })
})

describe("transcript viewport data-last overloads agree with data-first", () => {
  const limit = 200
  const window = { end: 500 }
  const geometry = metrics(50, 100, 30)
  const held = anchor("unit-a", 4)

  test("scroll and anchor transitions", () => {
    expect(clampScrollTop(geometry)(200)).toBe(clampScrollTop(200, geometry))
    expect(reanchor(held)(detach(anchor("unit-b", 1)))).toEqual(reanchor(detach(anchor("unit-b", 1)), held))
    expect(settle(held)(geometry)).toEqual(settle(geometry, held))
  })

  test("window queries and transitions", () => {
    expect(windowStart(limit)(window)).toBe(windowStart(window, limit))
    expect(atWindowTop(limit)(window)).toBe(atWindowTop(window, limit))
    expect(atWindowBottom(500)(window)).toBe(atWindowBottom(window, 500))
    expect(advanceWindow(-100, 500, limit)(window)).toEqual(advanceWindow(window, -100, 500, limit))
    expect(clampWindow(320, limit, false)(window)).toEqual(clampWindow(window, 320, limit, false))
  })
})

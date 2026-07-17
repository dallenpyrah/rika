import { describe, expect, it } from "@effect/vitest"
import * as ResidentService from "@rika/app/resident-service"
import { Schema } from "effect"
import {
  makeServerMessageFrameDecoder,
  maxFrameBytes,
  outputFrames,
  parse,
  serverMessageFrames,
} from "../src/resident-wire"

const decode = Schema.decodeUnknownSync(ResidentService.ServerMessage)
const encoder = new TextEncoder()

const expectRoundTrip = (text: string) => {
  const frames = outputFrames("request", "stdout", text)
  expect(frames.length).toBeGreaterThan(1)
  expect(Math.max(...frames.map((frame) => encoder.encode(frame).byteLength))).toBeLessThanOrEqual(maxFrameBytes)
  expect(
    frames
      .map((frame) => decode(parse(frame)))
      .map((frame) => (frame._tag === "output" ? frame.text : ""))
      .join(""),
  ).toBe(text)
}

describe("resident output frames", () => {
  it("splits large ASCII output", () => {
    expectRoundTrip("x".repeat(maxFrameBytes * 2))
  })

  it("splits multibyte output without breaking surrogate pairs", () => {
    expectRoundTrip("🙂".repeat(maxFrameBytes))
  })

  it("accounts for JSON escaping and control characters", () => {
    expectRoundTrip('\\"\n\r\t\u0000'.repeat(maxFrameBytes / 4))
  })

  it("keeps a small frame whole", () => {
    const frames = outputFrames("request", "stderr", "small")
    expect(frames).toHaveLength(1)
    expect(encoder.encode(frames[0]!).byteLength).toBeLessThanOrEqual(maxFrameBytes)
  })
})

describe("resident server message frames", () => {
  it("splits and reassembles an oversized interactive event", () => {
    const message = Schema.decodeUnknownSync(ResidentService.ServerMessage)({
      _tag: "interactive-feed-event",
      connectionId: "connection",
      requestId: "request",
      sessionId: "session",
      feedGeneration: "generation",
      sequence: 1,
      event: {
        _tag: "ExecutionFailed",
        selectionEpoch: 1,
        message: "x".repeat(1_100_000),
      },
    })
    const frames = serverMessageFrames("message", message)
    const decodeFrame = makeServerMessageFrameDecoder()
    const decoded = frames.map(decodeFrame).filter((value) => value !== undefined)

    expect(frames.length).toBeGreaterThan(1)
    expect(Math.max(...frames.map((frame) => encoder.encode(frame).byteLength))).toBeLessThanOrEqual(maxFrameBytes)
    expect(decoded).toEqual([message])
  })
})

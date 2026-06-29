import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Adapter, ViewState } from "../src/index"

const threadId = Ids.ThreadId.make("thread_adapter_smoke")
const turnId = Ids.TurnId.make("turn_adapter_smoke")

/**
 * Headless render smoke test. Confirms the OpenTUI renderable tree built by the
 * adapter's `Surface` paints the expected copy for both the welcome surface and
 * an active transcript. Uses `@opentui/core/testing` so no real TTY is required.
 */
describe("adapter Surface (headless)", () => {
  test("renders the welcome surface and an active transcript", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 })
    try {
      const surface = new Adapter.Surface(setup.renderer)

      surface.update(ViewState.initial({ thread_id: threadId, workspace_path: "/workspace/rika", mode: "deep" }))
      await setup.renderOnce()
      const welcome = setup.captureCharFrame()
      expect(welcome).toContain("Welcome to Rika")
      expect(welcome).toContain("deep³")

      const active = ViewState.initial({
        thread_id: threadId,
        workspace_path: "/workspace/rika",
        mode: "smart",
        events: [messageAdded(1, "user", "write a haiku"), messageAdded(2, "assistant", "snow on the cedar")],
      })
      surface.update(active)
      await setup.renderOnce()
      const transcript = setup.captureCharFrame()
      expect(transcript).toContain("write a haiku")
      expect(transcript).toContain("snow on the cedar")
    } finally {
      setup.renderer.destroy()
    }
  })
})

const base = (sequence: number): Omit<Event.Event, "type" | "data"> => ({
  id: Ids.EventId.make(`event_adapter_smoke_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: Common.TimestampMillis.make(sequence),
})

const messageAdded = (sequence: number, role: Message.Role, content: string): Event.MessageAdded => ({
  ...base(sequence),
  type: "message.added",
  data: {
    message: {
      id: Ids.MessageId.make(`message_adapter_smoke_${sequence}`),
      thread_id: threadId,
      turn_id: turnId,
      role,
      content: [Message.text(content)],
      created_at: Common.TimestampMillis.make(sequence),
    },
  },
})

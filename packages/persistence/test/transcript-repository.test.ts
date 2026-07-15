import * as Thread from "../src/thread-schema"
import * as TranscriptRepository from "../src/transcript-repository"
import * as Turn from "../src/turn-schema"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"

const turn = (index: number): Turn.Turn => ({
  id: Turn.TurnId.make(`turn-${index}`),
  threadId: Thread.ThreadId.make("thread-a"),
  prompt: `prompt ${index}`,
  status: "completed",
  createdAt: index,
  updatedAt: index,
})

const event = (index: number): TranscriptRepository.TranscriptEvent => ({
  cursor: `cursor-${index}`,
  sequence: index,
  type: index === 2 ? "execution.completed" : "model.output.completed",
  createdAt: index,
  text: `output ${index}`,
})

it.layer(TranscriptRepository.memoryLayer)("transcript repository", (it) => {
  it.effect("keeps one revisioned transcript entry per turn", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      yield* repository.replace(turn(1), [event(0), event(1)])
      const appended = yield* repository.append(turn(1), event(2))
      const duplicate = yield* repository.append(turn(1), event(2))
      expect(appended.events.map((item) => item.cursor)).toEqual(["cursor-0", "cursor-1", "cursor-2"])
      expect(appended.revision).toBe(2)
      expect(duplicate.revision).toBe(2)
      expect(duplicate.checkpointCursor).toBe("cursor-2")
    }),
  )

  it.effect("pages the newest transcript entries in chronological order", () =>
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.Service
      for (let index = 0; index < 5; index += 1) yield* repository.replace(turn(index), [event(index)])
      const newest = yield* repository.page(Thread.ThreadId.make("thread-a"), { limit: 2 })
      const older = yield* repository.page(Thread.ThreadId.make("thread-a"), {
        before: newest.oldestCursor,
        limit: 2,
      })
      expect(newest.entries.map((entry) => entry.turn.id)).toEqual([
        Turn.TurnId.make("turn-3"),
        Turn.TurnId.make("turn-4"),
      ])
      expect(newest.hasOlder).toBe(true)
      expect(older.entries.map((entry) => entry.turn.id)).toEqual([
        Turn.TurnId.make("turn-1"),
        Turn.TurnId.make("turn-2"),
      ])
    }),
  )
})

import type { ResidentCommandContext } from "./resident-client-command"
import * as Thread from "@rika/persistence/thread"
import * as Turn from "@rika/persistence/turn"
import * as Transcript from "@rika/transcript"
import { ViewState } from "@rika/tui"
import { Clock, Effect, Fiber, Queue, Ref } from "effect"
import * as InteractiveController from "../../src/interactive-controller"

const handleResidentCommand = (command: string, context: ResidentCommandContext) => {
  const { connection, path, fs, dataRoot, emit, kill, hostPid, clock, workspace } = context
  if (command === "ping") return connection.ping.pipe(Effect.andThen(emit({ type: "pong" })))
  if (command === "stall")
    return Effect.sync(() => {
      const until = clock.currentTimeMillisUnsafe() + 1_100
      while (clock.currentTimeMillisUnsafe() < until) {}
    }).pipe(Effect.andThen(connection.ping), Effect.andThen(emit({ type: "stall-survived" })))
  if (command === "reconnect-interactive")
    return connection
      .run(
        { _tag: "Interactive", prompt: [], ephemeral: false, workspace },
        {
          interactive: (_input, session) =>
            Effect.gen(function* () {
              yield* emit({ type: "interactive-callback", callbacks: 1 })
              const events = yield* Queue.unbounded<string>()
              const feed = yield* Effect.forkChild(session.events((event) => Queue.offerUnsafe(events, event._tag)))
              yield* emit({ type: "initial-read", tag: yield* Queue.take(events) })
              const pid = yield* Ref.get(hostPid)
              yield* kill(pid)
              yield* emit({ type: "replacement-read", tag: yield* Queue.take(events) })
              yield* session.submit("ambiguous")
              let mutationFailed = false
              let replacementRead = false
              while (!mutationFailed || !replacementRead) {
                const tag = yield* Queue.take(events)
                if (tag === "ExecutionFailed" && !mutationFailed) {
                  mutationFailed = true
                  yield* emit({ type: "mutation-failed", tag })
                } else if (tag === "ThreadsListed" && !replacementRead) {
                  replacementRead = true
                  yield* emit({ type: "post-mutation-read", tag })
                }
              }
              const attempts = (yield* fs
                .readFileString(path.join(dataRoot, "mutation-attempts.log"))
                .pipe(Effect.orDie))
                .trim()
                .split("\n")
              yield* emit({ type: "mutation-attempts", text: String(attempts.length) })
              yield* Fiber.interrupt(feed)
            }),
        },
      )
      .pipe(Effect.catch((error) => emit({ type: "reconnect-failed", error: error.message })))
  if (command === "flap-interactive")
    return connection
      .run(
        { _tag: "Interactive", prompt: [], ephemeral: false, workspace },
        {
          interactive: (_input, session) =>
            Effect.gen(function* () {
              yield* emit({ type: "interactive-callback", callbacks: 1 })
              const attachedFeeds = yield* Queue.unbounded<void>()
              const feed = yield* Effect.forkChild(session.events(() => Queue.offerUnsafe(attachedFeeds, undefined)))
              let killed = 0
              while (killed < 20) {
                yield* Queue.take(attachedFeeds)
                const acquisitions = (yield* fs
                  .readFileString(path.join(dataRoot, "owner-acquisitions.log"))
                  .pipe(Effect.orDie))
                  .trim()
                  .split("\n")
                const pid = Number(acquisitions.at(-1))
                killed += 1
                yield* kill(pid)
              }
              yield* Fiber.interrupt(feed)
            }),
        },
      )
      .pipe(
        Effect.catch((error) =>
          fs.readFileString(path.join(dataRoot, "owner-acquisitions.log")).pipe(
            Effect.flatMap((text) =>
              emit({
                type: "flap-failed",
                callbacks: text.trim().split("\n").length,
                error: error.message,
              }),
            ),
            Effect.orDie,
          ),
        ),
      )
  if (command === "interactive")
    return connection
      .run(
        { _tag: "Interactive", prompt: [], ephemeral: false, workspace },
        {
          interactive: (_, session) =>
            Effect.gen(function* () {
              yield* emit({ type: "interactive-callback" })
              const events = yield* Queue.unbounded<string>()
              const feed = yield* Effect.forkChild(session.events((value) => Queue.offerUnsafe(events, value._tag)))
              yield* emit({ type: "interactive-event", tag: yield* Queue.take(events) })
              yield* Fiber.interrupt(feed)
            }),
        },
      )
      .pipe(Effect.andThen(emit({ type: "interactive-completed" })))
  if (command === "child-execution-interactive")
    return connection.run(
      { _tag: "Interactive", prompt: ["child-execution-events"], ephemeral: false, workspace },
      {
        interactive: (_, session) =>
          Effect.gen(function* () {
            const events = yield* Queue.unbounded<string>()
            const feed = yield* Effect.forkChild(
              session.events((event) => {
                if (event._tag !== "TranscriptPatched") return
                Queue.offerUnsafe(events, `${event.turnId}:${event.event.type}`)
              }),
            )
            const tags = [yield* Queue.take(events), yield* Queue.take(events), yield* Queue.take(events)]
            yield* Fiber.interrupt(feed)
            yield* emit({ type: "child-execution-events-completed", tags })
          }),
      },
    )
  if (command === "timed-tool-interactive")
    return connection.run(
      { _tag: "Interactive", prompt: ["timed-tool-events"], ephemeral: false, workspace },
      {
        interactive: (_, session) =>
          Effect.gen(function* () {
            const events = yield* Queue.unbounded<string>()
            const eventClock = yield* Clock.Clock
            const startedAt = eventClock.currentTimeMillisUnsafe()
            const threadId = Thread.ThreadId.make("timed-tool-thread")
            const turn = {
              id: Turn.TurnId.make("timed-tool-turn"),
              threadId,
              prompt: "timed tools",
              executionRoute: Turn.testExecutionRoute(),
              status: "running" as const,
              createdAt: startedAt,
              updatedAt: startedAt,
            }
            let state: InteractiveController.State = {
              model: {
                ...ViewState.initial(workspace, "medium"),
                currentThreadId: String(threadId),
                activeTurnId: turn.id,
                busy: true,
                activity: { _tag: "Waiting" },
              },
              selectionEpoch: 0,
              replayTurns: new Map([[turn.id, turn]]),
              entries: [],
              revisions: new Map(),
              projections: new Map([[turn.id, Transcript.empty(turn.id, turn.prompt)]]),
              threadCostUsd: 0,
            }
            const feed = yield* Effect.forkChild(
              session.events((event) => {
                if (event._tag !== "TranscriptPatched") return
                state = InteractiveController.update(state, event).state
                Queue.offerUnsafe(
                  events,
                  `${event.event.type}:${eventClock.currentTimeMillisUnsafe() - startedAt}:${ViewState.formatActivity(state.model.activity)}`,
                )
              }),
            )
            const tags = [
              yield* Queue.take(events),
              yield* Queue.take(events),
              yield* Queue.take(events),
              yield* Queue.take(events),
            ]
            yield* Fiber.interrupt(feed)
            yield* emit({ type: "timed-tool-events-completed", tags })
          }),
      },
    )
  if (command === "serialized-interactive")
    return connection
      .run(
        { _tag: "Interactive", prompt: ["serialized-commands"], ephemeral: false, workspace },
        {
          interactive: (_input, session) =>
            Effect.gen(function* () {
              yield* Effect.all(
                Array.from({ length: 4 }, (_, index) => session.submit(`serialized-${index}`)),
                { concurrency: "unbounded", discard: true },
              )
              while (!(yield* fs.exists(path.join(dataRoot, "interactive-serialization.json")).pipe(Effect.orDie)))
                yield* Effect.sleep("1 millis")
              const result = yield* fs
                .readFileString(path.join(dataRoot, "interactive-serialization.json"))
                .pipe(Effect.orDie)
              yield* emit({ type: "serialized-interactive-completed", text: result })
            }),
        },
      )
      .pipe(Effect.catch((error) => emit({ type: "serialized-interactive-failed", error: error.message })))
  if (command === "oversized-submit")
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        connection.run(
          { _tag: "Interactive", prompt: [], ephemeral: false, workspace },
          {
            interactive: (_input, session) =>
              Effect.gen(function* () {
                yield* session.submit("oversized-submit", undefined, [
                  { type: "text", text: "look at this" },
                  { type: "image", mediaType: "image/png", data: "x".repeat(2_000_000), filename: "shot.png" },
                ])
                while (!(yield* fs.exists(path.join(dataRoot, "oversized-submit.json")).pipe(Effect.orDie)))
                  yield* Effect.sleep("1 millis")
                const text = yield* fs.readFileString(path.join(dataRoot, "oversized-submit.json")).pipe(Effect.orDie)
                const acquisitions = (yield* fs
                  .readFileString(path.join(dataRoot, "owner-acquisitions.log"))
                  .pipe(Effect.orDie))
                  .trim()
                  .split("\n")
                yield* emit({ type: "oversized-submit-completed", text, callbacks: acquisitions.length })
              }),
          },
        ),
      )
      if (exit._tag === "Failure") yield* emit({ type: "oversized-submit-failed", error: String(exit.cause) })
    })
  if (command === "over-ceiling-submit")
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        connection.run(
          { _tag: "Interactive", prompt: [], ephemeral: false, workspace },
          {
            interactive: (_input, session) =>
              Effect.gen(function* () {
                const events = yield* Queue.unbounded<{ readonly tag: string; readonly message: string }>()
                const feed = yield* Effect.forkChild(
                  session.events((event) =>
                    Queue.offerUnsafe(events, {
                      tag: event._tag,
                      message: event._tag === "ExecutionFailed" ? event.message : "",
                    }),
                  ),
                )
                yield* Queue.take(events)
                yield* session.submit("over-ceiling", undefined, [
                  { type: "image", mediaType: "image/png", data: "x".repeat(17_000_000), filename: "big.png" },
                ])
                let failure = ""
                while (failure === "") {
                  const next = yield* Queue.take(events)
                  if (next.tag === "ExecutionFailed") failure = next.message
                }
                yield* session.submit("oversized-submit", undefined, [
                  { type: "image", mediaType: "image/png", data: "y".repeat(2_000_000), filename: "ok.png" },
                ])
                while (!(yield* fs.exists(path.join(dataRoot, "oversized-submit.json")).pipe(Effect.orDie)))
                  yield* Effect.sleep("1 millis")
                const text = yield* fs.readFileString(path.join(dataRoot, "oversized-submit.json")).pipe(Effect.orDie)
                yield* Fiber.interrupt(feed)
                yield* emit({ type: "over-ceiling-submit-completed", error: failure, text })
              }),
          },
        ),
      )
      if (exit._tag === "Failure") yield* emit({ type: "over-ceiling-submit-failed", error: String(exit.cause) })
    })
  if (command === "rejected-interactive")
    return connection
      .run(
        { _tag: "Interactive", prompt: ["reject-before-start"], ephemeral: false, workspace },
        { interactive: () => Effect.void },
      )
      .pipe(Effect.catch((error) => emit({ type: "interactive-rejected", error: error.message })))
  if (command === "burst-interactive")
    return Effect.gen(function* () {
      let count = 0
      const completed = yield* Queue.unbounded<void>()
      const exit = yield* Effect.exit(
        connection.run(
          { _tag: "Interactive", prompt: ["burst-events"], ephemeral: false, workspace },
          {
            interactive: (_, session) =>
              Effect.gen(function* () {
                const feed = yield* Effect.forkChild(
                  session.events(() => {
                    count += 1
                    if (count === 1_000) Queue.offerUnsafe(completed, undefined)
                  }),
                )
                yield* Queue.take(completed)
                yield* Fiber.interrupt(feed)
              }),
          },
        ),
      )
      yield* emit(
        exit._tag === "Success"
          ? { type: "burst-completed", text: String(count) }
          : { type: "burst-failed", error: String(exit.cause) },
      )
    })
  if (command === "oversized-interactive-event")
    return Effect.gen(function* () {
      const events = yield* Queue.unbounded<string>()
      const exit = yield* Effect.exit(
        connection.run(
          { _tag: "Interactive", prompt: ["oversized-event"], ephemeral: false, workspace },
          {
            interactive: (_, session) =>
              Effect.gen(function* () {
                const feed = yield* Effect.forkChild(
                  session.events((event) => {
                    if (event._tag === "ExecutionFailed") Queue.offerUnsafe(events, event.message)
                  }),
                )
                const message = yield* Queue.take(events)
                yield* Fiber.interrupt(feed)
                yield* emit({ type: "oversized-interactive-event-completed", text: String(message.length) })
              }),
          },
        ),
      )
      if (exit._tag === "Failure")
        yield* emit({ type: "oversized-interactive-event-failed", error: String(exit.cause) })
    })
  if (command === "wire-limit-reattach")
    return Effect.gen(function* () {
      const messages = yield* Queue.unbounded<string>()
      const exit = yield* Effect.exit(
        connection.run(
          { _tag: "Interactive", prompt: ["wire-limit-event"], ephemeral: false, workspace },
          {
            interactive: (_, session) =>
              Effect.gen(function* () {
                const feed = yield* Effect.forkChild(
                  session.events((event) => {
                    if (
                      event._tag === "ExecutionFailed" &&
                      event.message.includes("omitted an event larger than 16 MiB")
                    )
                      Queue.offerUnsafe(messages, event.message)
                  }),
                )
                yield* Queue.take(messages)
                const residentPid = yield* Ref.get(hostPid)
                yield* kill(residentPid)
                yield* Queue.take(messages)
                yield* Fiber.interrupt(feed)
              }),
          },
        ),
      )
      yield* emit({
        type: exit._tag === "Failure" ? "wire-limit-reattach-failed" : "wire-limit-reattach-completed",
        callbacks: 2,
        ...(exit._tag === "Failure" ? { error: String(exit.cause) } : {}),
      })
    })
  return undefined
}

export const internal = { handleResidentCommand }
